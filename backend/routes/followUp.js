const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticateToken, verifyToken } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { sendFollowUpEmail } = require('../utils/mailer');
const {
  addNotification,
  getNotifications,
  markAllRead,
  addNotificationClient,
} = require('../utils/notifications');

const router = express.Router();
const trackingRouter = express.Router();
const notificationsRouter = express.Router();

const VALID_STATUS = ['pending', 'sent', 'cancelled', 'failed'];
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function getSettingsMap() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getDelayDays(settings, emailNumber) {
  const key = `follow_up_delay_${emailNumber}`;
  const n = Number(settings[key]);
  if (!Number.isFinite(n) || n <= 0) {
    const defaults = { 1: 3, 2: 5, 3: 7, 4: 10 };
    return defaults[emailNumber] || 5;
  }
  return n;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days));
  return d;
}

function formatDateForDb(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function isLocalRequest(req) {
  const ip =
    req.ip ||
    (req.socket && req.socket.remoteAddress) ||
    (req.connection && req.connection.remoteAddress) ||
    '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ---- Core follow-up processor, usable from both the HTTP route and tests
async function processFollowUps() {
  let processed = 0;
  let failed = 0;

  const settings = getSettingsMap();
  const now = formatDateForDb(new Date());
  const due = db
    .prepare(
      `SELECT fq.*, l.id as lead_id_check, l.business_name, l.email, l.website,
              l.contact_name, l.assigned_to, l.follow_up_count, l.tenant_id AS lead_tenant_id
       FROM follow_up_queue fq
       LEFT JOIN leads l ON l.id = fq.lead_id
       WHERE fq.status = 'pending' AND fq.scheduled_at <= ?`
    )
    .all(now);

  const markSent = db.prepare(
    `UPDATE follow_up_queue SET status = 'sent', sent_at = ? WHERE id = ?`
  );
  const markFailed = db.prepare(
    `UPDATE follow_up_queue SET status = 'failed', error_message = ? WHERE id = ?`
  );
  const insertTracking = db.prepare(
    `INSERT INTO email_tracking (id, lead_id, email_type, tracking_pixel_id, sent_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertNextQueue = db.prepare(
    `INSERT INTO follow_up_queue (id, lead_id, email_number, scheduled_at, status, tenant_id)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  );
  const updateLeadSent = db.prepare(
    `UPDATE leads SET last_email_at = ?, follow_up_count = follow_up_count + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );
  const markLeadCold = db.prepare(
    `UPDATE leads SET status = 'cold', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  );

  for (const q of due) {
    if (!q.lead_id_check || !q.email) {
      markFailed.run('Lead not found or missing email', q.id);
      failed += 1;
      continue;
    }

    const assignedUser = q.assigned_to
      ? db.prepare('SELECT * FROM users WHERE id = ?').get(q.assigned_to)
      : null;
    if (!assignedUser || !assignedUser.smtp_type) {
      markFailed.run('Assigned user has no SMTP configured', q.id);
      failed += 1;
      continue;
    }

    const pixelId = uuidv4();
    try {
      await sendFollowUpEmail({
        userSmtpConfig: assignedUser,
        lead: {
          businessName: q.business_name,
          email: q.email,
          contactName: q.contact_name,
        },
        emailNumber: q.email_number,
        agencySettings: settings,
        preparedBy: assignedUser.name,
        trackingPixelId: pixelId,
      });

      const sentAt = formatDateForDb(new Date());
      const leadTenantId = q.lead_tenant_id || 'default';
      const tx = db.transaction(() => {
        markSent.run(sentAt, q.id);
        insertTracking.run(
          uuidv4(),
          q.lead_id,
          `follow_up_${q.email_number}`,
          pixelId,
          sentAt,
          leadTenantId
        );
        updateLeadSent.run(sentAt, q.lead_id);

        if (q.email_number < 4) {
          const nextNum = q.email_number + 1;
          const delayDays = getDelayDays(settings, nextNum);
          const nextAt = formatDateForDb(addDays(new Date(), delayDays));
          insertNextQueue.run(uuidv4(), q.lead_id, nextNum, nextAt, leadTenantId);
        } else {
          markLeadCold.run(q.lead_id);
        }
      });
      tx();
      processed += 1;

      if (q.assigned_to) {
        addNotification(q.assigned_to, {
          type: 'follow_up_sent',
          message: `Follow-up #${q.email_number} sent to ${q.business_name || 'lead'}`,
          leadId: q.lead_id,
          businessName: q.business_name,
        });
      }
    } catch (err) {
      markFailed.run(err.message, q.id);
      failed += 1;
    }
  }

  return { processed, failed };
}

// -------- Tracking pixel (PUBLIC — no auth) --------
trackingRouter.get('/pixel/:pixelId', (req, res) => {
  try {
    const row = db
      .prepare('SELECT * FROM email_tracking WHERE tracking_pixel_id = ?')
      .get(req.params.pixelId);

    if (row) {
      const now = formatDateForDb(new Date());
      const firstOpen = !row.opened_at;
      if (firstOpen) {
        db.prepare(
          'UPDATE email_tracking SET opened_at = ?, open_count = open_count + 1 WHERE id = ?'
        ).run(now, row.id);
      } else {
        db.prepare(
          'UPDATE email_tracking SET open_count = open_count + 1 WHERE id = ?'
        ).run(row.id);
      }

      if (row.lead_id) {
        const lead = db
          .prepare('SELECT id, business_name, status, assigned_to FROM leads WHERE id = ?')
          .get(row.lead_id);
        if (lead) {
          if (lead.status === 'new') {
            db.prepare(
              "UPDATE leads SET status = 'opened', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
            ).run(lead.id);
          }
          if (firstOpen && lead.assigned_to) {
            addNotification(lead.assigned_to, {
              type: 'lead_opened',
              message: `${lead.business_name || 'A lead'} opened your email!`,
              leadId: lead.id,
              businessName: lead.business_name,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('tracking pixel error:', err.message);
  }

  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  return res.send(PIXEL_GIF);
});

// -------- POST /process — cron hits this over localhost (no token needed),
// but admins can also call it manually with a bearer token.
router.post('/process', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  let authorized = false;
  if (bearer) {
    try {
      const user = verifyToken(bearer);
      if (user && user.role === 'admin') {
        req.user = user;
        authorized = true;
      }
    } catch {
      // fall through
    }
  }
  if (!authorized && isLocalRequest(req)) authorized = true;
  if (!authorized) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const result = await processFollowUps();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// -------- Everything below requires an authenticated user --------
router.use(authenticateToken, resolveTenant);

router.get('/', (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const where = ['l.tenant_id = ?'];
    const args = [req.tenantId];

    if (!isAdmin) {
      where.push('l.assigned_to = ?');
      args.push(req.user.id);
    }
    if (req.query.status && VALID_STATUS.includes(req.query.status)) {
      where.push('fq.status = ?');
      args.push(req.query.status);
    } else {
      where.push("fq.status IN ('pending','sent','cancelled')");
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db
      .prepare(
        `SELECT fq.*, l.business_name, l.email, l.website, l.assigned_to,
                u.name as assigned_name
         FROM follow_up_queue fq
         LEFT JOIN leads l ON l.id = fq.lead_id
         LEFT JOIN users u ON u.id = l.assigned_to
         ${whereSql}
         ORDER BY fq.scheduled_at ASC
         LIMIT 500`
      )
      .all(...args);

    return res.json({ followUps: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id/cancel', (req, res) => {
  try {
    const row = db
      .prepare(
        `SELECT fq.*, l.assigned_to, l.tenant_id
         FROM follow_up_queue fq
         LEFT JOIN leads l ON l.id = fq.lead_id
         WHERE fq.id = ? AND l.tenant_id = ?`
      )
      .get(req.params.id, req.tenantId);

    if (!row) return res.status(404).json({ error: 'Follow-up not found' });
    if (req.user.role !== 'admin' && row.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (row.status !== 'pending') {
      return res.status(400).json({ error: `Cannot cancel — status is ${row.status}` });
    }

    db.prepare("UPDATE follow_up_queue SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    return res.json({ message: 'Follow-up cancelled' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Manual trigger for development / testing — admin-only.
router.get('/test-cron', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const result = await processFollowUps();
    return res.json({ triggered: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// -------- Notifications router (mounted at /api/notifications) --------
// SSE endpoint FIRST so it can accept ?token=... (EventSource can't set headers).
notificationsRouter.get('/stream', (req, res) => {
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  try {
    req.user = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  addNotificationClient(req.user.id, res);
});

notificationsRouter.use(authenticateToken);

notificationsRouter.get('/', (req, res) => {
  return res.json({ notifications: getNotifications(req.user.id) });
});

notificationsRouter.post('/read', (req, res) => {
  markAllRead(req.user.id);
  return res.json({ success: true });
});

router.trackingRouter = trackingRouter;
router.notificationsRouter = notificationsRouter;
router.processFollowUps = processFollowUps;

module.exports = router;
