const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const { db, decrypt } = require('../db/database');
const {
  authenticateSuperAdmin,
  generateSuperAdminToken,
  hashPassword,
  comparePassword,
} = require('../utils/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

function monthStartStr() {
  const n = new Date();
  const yyyy = n.getFullYear();
  const mm = String(n.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}-01 00:00:00`;
}

function randomPassword(len = 12) {
  // 9 random bytes = 12 chars of URL-safe base64.
  return crypto
    .randomBytes(Math.ceil((len * 3) / 4))
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, len);
}

function tenantRowWithCounts(row) {
  if (!row) return null;
  const userCount = db
    .prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ?')
    .get(row.id).c;
  const leadCount = db
    .prepare('SELECT COUNT(*) c FROM leads WHERE tenant_id = ?')
    .get(row.id).c;
  const reportCount = db
    .prepare('SELECT COUNT(*) c FROM reports WHERE tenant_id = ?')
    .get(row.id).c;
  const lastActivity = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(created_at) AS t FROM leads WHERE tenant_id = ?
         UNION ALL SELECT MAX(created_at) FROM reports WHERE tenant_id = ?
         UNION ALL SELECT MAX(created_at) FROM bulk_jobs WHERE tenant_id = ?
       )`
    )
    .get(row.id, row.id, row.id);
  return {
    ...row,
    userCount,
    leadCount,
    reportCount,
    lastActivity: lastActivity && lastActivity.t ? lastActivity.t : null,
  };
}

// ---------------------------------------------------------------
// Public: super admin auth (login), no middleware so login works.
// ---------------------------------------------------------------
router.post('/auth/login', loginLimiter, (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const admin = db
      .prepare('SELECT * FROM super_admins WHERE email = ?')
      .get(email);
    if (!admin || !comparePassword(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateSuperAdminToken(admin);
    return res.json({
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed' });
  }
});

// ---------------------------------------------------------------
// Everything below requires a valid super_admin JWT.
// ---------------------------------------------------------------
router.get('/auth/me', authenticateSuperAdmin, (req, res) => {
  const row = db
    .prepare('SELECT id, name, email, created_at FROM super_admins WHERE id = ?')
    .get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json(row);
});

router.use(authenticateSuperAdmin);

// Quick DB health check — useful after a deploy to confirm no data was lost.
// Returns aggregate counts across all tenants for the core tables.
router.get('/check-db', (req, res) => {
  try {
    const counts = {
      users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      tenants: db.prepare('SELECT COUNT(*) AS c FROM tenants').get().c,
      leads: db.prepare('SELECT COUNT(*) AS c FROM leads').get().c,
      reports: db.prepare('SELECT COUNT(*) AS c FROM reports').get().c,
      settings: db.prepare('SELECT COUNT(*) AS c FROM settings').get().c,
      niches: db.prepare('SELECT COUNT(*) AS c FROM niches').get().c,
      super_admins: db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c,
      bulk_jobs: db.prepare('SELECT COUNT(*) AS c FROM bulk_jobs').get().c,
      campaigns: db.prepare('SELECT COUNT(*) AS c FROM campaigns').get().c,
    };
    const tenantBreakdown = db
      .prepare(
        `SELECT t.id, t.name, t.subdomain, t.status,
                (SELECT COUNT(*) FROM users WHERE tenant_id = t.id) AS users,
                (SELECT COUNT(*) FROM leads WHERE tenant_id = t.id) AS leads,
                (SELECT COUNT(*) FROM reports WHERE tenant_id = t.id) AS reports
         FROM tenants t
         ORDER BY t.created_at ASC`
      )
      .all();
    return res.json({ counts, tenants: tenantBreakdown });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/stats', (req, res) => {
  try {
    const totalAgencies = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
    const activeAgencies = db
      .prepare("SELECT COUNT(*) c FROM tenants WHERE status = 'active'")
      .get().c;
    const suspendedAgencies = db
      .prepare("SELECT COUNT(*) c FROM tenants WHERE status = 'suspended'")
      .get().c;
    const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const totalLeads = db.prepare('SELECT COUNT(*) c FROM leads').get().c;
    const totalReports = db.prepare('SELECT COUNT(*) c FROM reports').get().c;
    const mrrRow = db
      .prepare(
        "SELECT COALESCE(SUM(monthly_price), 0) AS s FROM tenants WHERE status = 'active'"
      )
      .get();
    const since = monthStartStr();
    const newAgenciesThisMonth = db
      .prepare('SELECT COUNT(*) c FROM tenants WHERE created_at >= ?')
      .get(since).c;
    const reportsThisMonth = db
      .prepare('SELECT COUNT(*) c FROM reports WHERE created_at >= ?')
      .get(since).c;

    return res.json({
      totalAgencies,
      activeAgencies,
      suspendedAgencies,
      totalUsers,
      totalLeads,
      totalReports,
      totalAudits: totalReports,
      mrr: mrrRow.s || 0,
      newAgenciesThisMonth,
      reportsThisMonth,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/agencies', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    const where = [];
    const args = [];
    if (search) {
      where.push(
        '(name LIKE ? OR subdomain LIKE ? OR owner_email LIKE ? OR brand_name LIKE ?)'
      );
      const s = `%${search}%`;
      args.push(s, s, s, s);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db
      .prepare(`SELECT COUNT(*) c FROM tenants ${whereSql}`)
      .get(...args).c;

    const rows = db
      .prepare(
        `SELECT * FROM tenants ${whereSql}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset);

    return res.json({
      agencies: rows.map(tenantRowWithCounts),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/agencies/:id', (req, res) => {
  try {
    const tenant = db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });
    const settings = db
      .prepare('SELECT key, value FROM agency_settings WHERE tenant_id = ?')
      .all(tenant.id);
    const usage = {
      userCount: db
        .prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ?')
        .get(tenant.id).c,
      leadCount: db
        .prepare('SELECT COUNT(*) c FROM leads WHERE tenant_id = ?')
        .get(tenant.id).c,
      reportCount: db
        .prepare('SELECT COUNT(*) c FROM reports WHERE tenant_id = ?')
        .get(tenant.id).c,
      leadsThisMonth: db
        .prepare(
          'SELECT COUNT(*) c FROM leads WHERE tenant_id = ? AND created_at >= ?'
        )
        .get(tenant.id, monthStartStr()).c,
      reportsThisMonth: db
        .prepare(
          'SELECT COUNT(*) c FROM reports WHERE tenant_id = ? AND created_at >= ?'
        )
        .get(tenant.id, monthStartStr()).c,
    };
    const settingsObj = {};
    for (const s of settings) settingsObj[s.key] = s.value;
    return res.json({ tenant, settings: settingsObj, usage });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/agencies', async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    const subdomain = (b.subdomain || '').trim().toLowerCase();
    const ownerEmail = (b.owner_email || b.ownerEmail || '').trim().toLowerCase();
    const ownerName = (b.owner_name || b.ownerName || '').trim();
    if (!name || !subdomain || !ownerEmail || !ownerName) {
      return res
        .status(400)
        .json({ error: 'name, subdomain, owner_name, owner_email are required' });
    }
    if (!/^[a-z0-9-]{3,40}$/.test(subdomain)) {
      return res
        .status(400)
        .json({ error: 'subdomain must be 3–40 lowercase letters, digits, or dashes' });
    }

    if (db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(subdomain)) {
      return res.status(409).json({ error: 'Subdomain already in use' });
    }
    if (db.prepare('SELECT id FROM tenants WHERE owner_email = ?').get(ownerEmail)) {
      return res.status(409).json({ error: 'Owner email already in use' });
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail)) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    const tenantId = uuidv4();
    const tempPassword = randomPassword(12);
    const passwordHash = hashPassword(tempPassword);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO tenants (
           id, name, subdomain, brand_name, owner_name, owner_email,
           plan, status, monthly_price, max_users, max_leads_per_month,
           max_audits_per_month, subscription_start
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        tenantId,
        name,
        subdomain,
        b.brand_name || b.brandName || name,
        ownerName,
        ownerEmail,
        b.plan || 'pro',
        b.monthly_price != null ? Number(b.monthly_price) : 300,
        b.max_users != null ? Number(b.max_users) : 10,
        b.max_leads_per_month != null ? Number(b.max_leads_per_month) : 5000,
        b.max_audits_per_month != null ? Number(b.max_audits_per_month) : 1000
      );

      db.prepare(
        `INSERT INTO users (id, name, email, password_hash, role, tenant_id)
         VALUES (?, ?, ?, ?, 'admin', ?)`
      ).run(uuidv4(), ownerName, ownerEmail, passwordHash, tenantId);

      const setting = db.prepare(
        `INSERT OR IGNORE INTO agency_settings (id, tenant_id, key, value) VALUES (?, ?, ?, ?)`
      );
      const defaults = {
        agency_name: name,
        agency_logo: '',
        agency_contact: ownerEmail,
        pagespeed_api_key: '',
        follow_up_enabled: 'true',
        tracking_pixel_enabled: 'true',
      };
      for (const [k, v] of Object.entries(defaults)) {
        setting.run(uuidv4(), tenantId, k, v);
      }

      db.prepare(
        `INSERT OR IGNORE INTO pipeline_configs (
           id, tenant_id, enabled, run_time, niches_json, locations_json,
           max_leads_per_run, auto_audit, auto_email, auto_followup
         ) VALUES (?, ?, 0, '09:00', '[]', '[]', 50, 1, 1, 1)`
      ).run(uuidv4(), tenantId);
    });
    tx();

    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);

    // Best-effort welcome email. If no admin has SMTP configured we just skip
    // and rely on the returned tempPassword in the response.
    let emailSent = false;
    let emailError = null;
    try {
      emailSent = await sendWelcomeEmail({
        tenant,
        ownerName,
        ownerEmail,
        tempPassword,
      });
    } catch (err) {
      emailError = err.message;
      console.warn('Welcome email failed:', err.message);
    }

    return res.status(201).json({ tenant, tempPassword, emailSent, emailError });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/agencies/:id', (req, res) => {
  try {
    const tenant = db
      .prepare('SELECT * FROM tenants WHERE id = ?')
      .get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });

    const b = req.body || {};
    const allowed = [
      'name', 'brand_name', 'logo_url', 'primary_color',
      'gradient_start', 'gradient_end', 'monthly_price', 'plan',
      'status', 'max_users', 'max_leads_per_month',
      'max_audits_per_month', 'notes',
    ];
    const updates = [];
    const args = [];
    for (const col of allowed) {
      if (b[col] !== undefined) {
        updates.push(`${col} = ?`);
        args.push(b[col]);
      }
    }
    if (updates.length === 0) return res.json({ tenant });
    if (b.status !== undefined && !['active', 'suspended', 'cancelled'].includes(b.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    args.push(req.params.id);
    db.prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`).run(...args);

    const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    return res.json({ tenant: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/agencies/:id', (req, res) => {
  try {
    if (req.params.id === 'default') {
      return res.status(400).json({ error: 'Cannot delete the default tenant' });
    }
    const tenant = db
      .prepare('SELECT id FROM tenants WHERE id = ?')
      .get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });
    db.prepare(
      "UPDATE tenants SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(req.params.id);
    return res.json({ message: 'Agency cancelled' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/agencies/:id/suspend', (req, res) => {
  try {
    if (req.params.id === 'default') {
      return res.status(400).json({ error: 'Cannot suspend the default tenant' });
    }
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });
    db.prepare(
      "UPDATE tenants SET status = 'suspended', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(req.params.id);
    return res.json({ message: 'Agency suspended' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/agencies/:id/activate', (req, res) => {
  try {
    const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });
    db.prepare(
      "UPDATE tenants SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(req.params.id);
    return res.json({ message: 'Agency activated' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/agencies/:id/reset-password', async (req, res) => {
  try {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });
    const owner = db
      .prepare(
        "SELECT id, name, email FROM users WHERE tenant_id = ? AND role = 'admin' ORDER BY created_at ASC LIMIT 1"
      )
      .get(tenant.id);
    if (!owner) return res.status(404).json({ error: 'No admin user for this agency' });

    const tempPassword = randomPassword(12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(tempPassword),
      owner.id
    );

    let emailSent = false;
    let emailError = null;
    try {
      emailSent = await sendWelcomeEmail({
        tenant,
        ownerName: owner.name,
        ownerEmail: owner.email,
        tempPassword,
        reset: true,
      });
    } catch (err) {
      emailError = err.message;
    }

    return res.json({ message: 'Password reset sent', tempPassword, emailSent, emailError });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/agencies/:id/users', (req, res) => {
  try {
    const tenant = db
      .prepare('SELECT id FROM tenants WHERE id = ?')
      .get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });
    const users = db
      .prepare(
        `SELECT id, name, email, role, created_at FROM users WHERE tenant_id = ? ORDER BY created_at DESC`
      )
      .all(tenant.id);
    const withAuditCount = users.map((u) => {
      const auditCount = db
        .prepare('SELECT COUNT(*) c FROM reports WHERE user_id = ?')
        .get(u.id).c;
      return { ...u, audit_count: auditCount };
    });
    return res.json({ users: withAuditCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/agencies/:id/reports', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const tenant = db
      .prepare('SELECT id FROM tenants WHERE id = ?')
      .get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Agency not found' });

    const total = db
      .prepare('SELECT COUNT(*) c FROM reports WHERE tenant_id = ?')
      .get(tenant.id).c;
    const rows = db
      .prepare(
        `SELECT r.id, r.website_url, r.client_name, r.client_email, r.overall_score,
                r.grade, r.email_sent, r.created_at, u.name AS user_name
         FROM reports r LEFT JOIN users u ON u.id = r.user_id
         WHERE r.tenant_id = ?
         ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(tenant.id, limit, offset);
    return res.json({
      reports: rows,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Welcome email helper — best-effort, uses the default tenant's first admin
// with configured SMTP. Silent no-op if no SMTP is available.
// ---------------------------------------------------------------
async function sendWelcomeEmail({ tenant, ownerName, ownerEmail, tempPassword, reset }) {
  const sender = db
    .prepare(
      `SELECT * FROM users
       WHERE tenant_id = 'default' AND role = 'admin'
         AND smtp_type IS NOT NULL
       ORDER BY created_at ASC LIMIT 1`
    )
    .get();
  if (!sender) return false;

  let transporter;
  let fromAddress;
  if (sender.smtp_type === 'gmail') {
    if (!sender.gmail_email || !sender.gmail_app_password) return false;
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: sender.gmail_email, pass: decrypt(sender.gmail_app_password) },
    });
    fromAddress = sender.gmail_email;
  } else if (sender.smtp_type === 'hostinger') {
    if (!sender.smtp_host || !sender.smtp_port || !sender.smtp_email || !sender.smtp_password) {
      return false;
    }
    transporter = nodemailer.createTransport({
      host: sender.smtp_host,
      port: sender.smtp_port,
      secure: sender.smtp_port === 465,
      auth: { user: sender.smtp_email, pass: decrypt(sender.smtp_password) },
    });
    fromAddress = sender.smtp_email;
  } else {
    return false;
  }

  const vpsIp = process.env.VPS_IP || 'localhost';
  const vpsPort = process.env.VPS_PORT || 4000;
  const loginUrl = `http://${vpsIp}:${vpsPort}/agency/${tenant.subdomain}`;

  const subject = reset
    ? 'Your AuditPro password has been reset'
    : 'Your AuditPro account is ready!';
  const greeting = reset
    ? `Hi ${ownerName},\n\nYour AuditPro password was reset by your administrator.`
    : `Welcome ${ownerName}!\n\nYour white-label audit platform is ready.`;

  await transporter.sendMail({
    from: fromAddress,
    to: ownerEmail,
    subject,
    text: `${greeting}

Login:             ${loginUrl}
Email:             ${ownerEmail}
Temporary Password: ${tempPassword}

Please change your password after first login.
`,
  });
  return true;
}

module.exports = router;
