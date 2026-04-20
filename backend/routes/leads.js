const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { enforceUsageLimits } = require('../utils/usageLimits');
const { normalizeUrl } = require('../utils/leadDeduplicator');
const queue = require('../utils/queue');

const router = express.Router();

const VALID_STATUSES = ['new', 'opened', 'replied', 'audited', 'converted', 'cold'];

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

function formatDateForDb(d) {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function hasSmtpConfigured(user) {
  if (!user || !user.smtp_type) return false;
  if (user.smtp_type === 'gmail') return !!(user.gmail_email && user.gmail_app_password);
  if (user.smtp_type === 'hostinger') {
    return !!(user.smtp_host && user.smtp_port && user.smtp_email && user.smtp_password);
  }
  return false;
}

router.use(authenticateToken, resolveTenant);

router.get('/stats', (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const tenantId = req.tenantId;
    const whereParts = ['tenant_id = ?'];
    const userArgs = [tenantId];
    if (!isAdmin) {
      whereParts.push('assigned_to = ?');
      userArgs.push(req.user.id);
    }
    const whereUser = 'WHERE ' + whereParts.join(' AND ');

    const total = db
      .prepare(`SELECT COUNT(*) as c FROM leads ${whereUser}`)
      .get(...userArgs).c;

    const byStatus = { new: 0, opened: 0, replied: 0, audited: 0, converted: 0, cold: 0 };
    const statusRows = db
      .prepare(`SELECT status, COUNT(*) as c FROM leads ${whereUser} GROUP BY status`)
      .all(...userArgs);
    for (const r of statusRows) {
      if (r.status in byStatus) byStatus[r.status] = r.c;
    }

    const whereUserAliased = whereUser
      .replace(/\btenant_id = \?/, 'l.tenant_id = ?')
      .replace(/\bassigned_to = \?/, 'l.assigned_to = ?');
    const byNicheRows = db
      .prepare(
        `SELECT n.name as nicheName, COUNT(l.id) as count
         FROM leads l
         LEFT JOIN niches n ON n.id = l.niche_id
         ${whereUserAliased}
         GROUP BY l.niche_id`
      )
      .all(...userArgs);

    const converted = byStatus.converted;
    const conversionRate = total > 0 ? Math.round((converted / total) * 1000) / 10 : 0;

    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    firstOfMonth.setHours(0, 0, 0, 0);
    const thisMonth = db
      .prepare(
        `SELECT COUNT(*) as c FROM leads ${whereUser} AND created_at >= ?`
      )
      .get(...userArgs, formatDateForDb(firstOfMonth)).c;

    return res.json({
      total,
      byStatus,
      byNiche: byNicheRows.map((r) => ({ nicheName: r.nicheName || 'Unassigned', count: r.count })),
      conversionRate,
      thisMonth,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/save-results', requireAdmin, enforceUsageLimits('lead'), (req, res) => {
  try {
    console.log('[save-results] incoming', {
      tenantId: req.tenantId,
      userId: req.user && req.user.id,
      body: { ...(req.body || {}), leads: Array.isArray(req.body && req.body.leads) ? `(${req.body.leads.length} leads)` : null },
    });
    const { leads, nicheId, assignedTo, campaignId, scheduleFollowUps } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      console.warn('[save-results] rejected: empty leads array');
      return res.status(400).json({ error: 'leads array is required' });
    }

    const tenantId = req.tenantId;
    const existingRows = db
      .prepare(
        "SELECT website FROM leads WHERE tenant_id = ? AND website IS NOT NULL AND website != ''"
      )
      .all(tenantId);
    const existing = new Set(existingRows.map((r) => normalizeUrl(r.website)));

    const delay1 = Number(getSetting('follow_up_delay_1')) || 3;
    // Allow explicit opt-out via scheduleFollowUps=false; otherwise fall back to tenant setting.
    const followUpEnabled =
      scheduleFollowUps === false
        ? false
        : getSetting('follow_up_enabled') !== 'false';

    // Column order is fixed; values below follow the same order.
    // INSERT OR IGNORE makes UNIQUE(website) collisions silent instead of throwing.
    const insertLead = db.prepare(`
      INSERT OR IGNORE INTO leads
        (id, tenant_id, campaign_id, niche_id, assigned_to,
         business_name, website, email, phone, address, city, country,
         source, contact_name, status, follow_up_count, audit_sent,
         created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, 'new', 0, 0,
         datetime('now'), datetime('now'))
    `);
    const insertQueue = db.prepare(
      `INSERT INTO follow_up_queue (id, lead_id, email_number, scheduled_at, status, tenant_id)
       VALUES (?, ?, 1, ?, 'pending', ?)`
    );

    let saved = 0;
    let skipped = 0;
    const tx = db.transaction(() => {
      for (const l of leads) {
        const rawWebsite = l.website || '';
        const normalized = normalizeUrl(rawWebsite);
        if (normalized && existing.has(normalized)) {
          skipped += 1;
          continue;
        }
        if (normalized) existing.add(normalized);

        const leadId = uuidv4();
        let result;
        try {
          // Store the normalized URL so the UNIQUE(website) index collapses
          // "http://www.foo.com", "https://foo.com", "foo.com/" etc. into one row.
          result = insertLead.run(
            leadId,
            tenantId,
            campaignId || null,
            nicheId || null,
            assignedTo || null,
            l.businessName || l.business_name || '',
            normalized || rawWebsite || '',
            l.email || '',
            l.phone || '',
            l.address || '',
            l.city || '',
            l.country || '',
            l.source || 'manual',
            l.contactName || l.contact_name || null
          );
        } catch (e) {
          console.error('save-results insert failed:', e.message);
          skipped += 1;
          continue;
        }

        // INSERT OR IGNORE returns changes=0 on UNIQUE conflict — treat as skipped.
        if (!result || result.changes === 0) {
          skipped += 1;
          continue;
        }

        if (followUpEnabled) {
          const scheduled = formatDateForDb(addDays(new Date(), delay1));
          insertQueue.run(uuidv4(), leadId, scheduled, tenantId);
        }
        saved += 1;
      }
    });
    tx();

    console.log('[save-results] done', { saved, skipped, tenantId });
    return res.json({ saved, skipped });
  } catch (err) {
    console.error('[save-results] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/send-to-bulk', requireAdmin, async (req, res) => {
  try {
    console.log('[send-to-bulk] incoming', {
      tenantId: req.tenantId,
      userId: req.user && req.user.id,
      leadIds: Array.isArray(req.body?.leadIds) ? req.body.leadIds.length : 0,
      leads: Array.isArray(req.body?.leads) ? req.body.leads.length : 0,
    });
    const { leadIds, leads } = req.body || {};
    const hasIds = Array.isArray(leadIds) && leadIds.length > 0;
    const hasLeads = Array.isArray(leads) && leads.length > 0;
    if (!hasIds && !hasLeads) {
      return res.status(400).json({ error: 'leadIds or leads array is required' });
    }
    const totalCount = hasIds ? leadIds.length : leads.length;
    if (totalCount > 50) {
      return res.status(400).json({ error: 'Maximum 50 leads per bulk job' });
    }

    let rows = [];
    if (hasIds) {
      const placeholders = leadIds.map(() => '?').join(',');
      rows = db
        .prepare(
          `SELECT * FROM leads WHERE tenant_id = ? AND id IN (${placeholders})`
        )
        .all(req.tenantId, ...leadIds);
    } else {
      // Inline leads: upsert into the CRM first (respect the unique website
      // constraint) so progress can be tied back to a lead row.
      const existingRows = db
        .prepare("SELECT id, website FROM leads WHERE tenant_id = ? AND website IS NOT NULL AND website != ''")
        .all(req.tenantId);
      const existingByNorm = new Map();
      for (const r of existingRows) existingByNorm.set(normalizeUrl(r.website), r.id);

      const insertLead = db.prepare(`
        INSERT OR IGNORE INTO leads
          (id, tenant_id, niche_id, assigned_to,
           business_name, website, email, phone, address, city, country,
           source, contact_name, status, follow_up_count, audit_sent,
           created_at, updated_at)
        VALUES
          (?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, 'new', 0, 0,
           datetime('now'), datetime('now'))
      `);
      const upsertTx = db.transaction(() => {
        for (const l of leads) {
          const raw = l.website || '';
          const norm = normalizeUrl(raw);
          if (!norm && !raw) continue;
          if (existingByNorm.has(norm)) continue;
          const id = uuidv4();
          insertLead.run(
            id,
            req.tenantId,
            null,
            req.user.id || null,
            l.businessName || l.business_name || '',
            norm || raw || '',
            l.email || '',
            l.phone || '',
            l.address || '',
            l.city || '',
            l.country || '',
            l.source || 'manual',
            l.contactName || l.contact_name || null
          );
          existingByNorm.set(norm, id);
        }
      });
      upsertTx();

      // Re-fetch the rows we care about by normalized website.
      const want = leads
        .map((l) => normalizeUrl(l.website || ''))
        .filter(Boolean);
      if (want.length > 0) {
        const placeholders = want.map(() => '?').join(',');
        rows = db
          .prepare(
            `SELECT * FROM leads WHERE tenant_id = ? AND website IN (${placeholders})`
          )
          .all(req.tenantId, ...want);
      }
    }

    const items = rows
      .filter((r) => r.website && r.email)
      .map((r) => ({
        id: uuidv4(),
        websiteUrl: r.website,
        clientName: r.contact_name || r.business_name || null,
        clientEmail: r.email,
        competitorUrl: null,
        _leadId: r.id,
      }));

    if (items.length === 0) {
      return res.status(400).json({ error: 'No leads with website and email to send' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!hasSmtpConfigured(user)) {
      return res
        .status(400)
        .json({ error: 'Please configure your email settings in your profile first' });
    }

    const jobId = uuidv4();
    db.prepare(
      `INSERT INTO bulk_jobs (id, user_id, total_sites, completed, failed, status, tenant_id)
       VALUES (?, ?, ?, 0, 0, 'pending', ?)`
    ).run(jobId, user.id, items.length, req.tenantId);

    const insertItem = db.prepare(
      `INSERT INTO bulk_job_items (id, job_id, website_url, client_name, client_email, competitor_url, status, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    const now = nowIso();
    const updateLead = db.prepare(
      `UPDATE leads SET audit_sent = 1, audit_sent_at = ?, status = 'audited', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );
    const tx = db.transaction(() => {
      for (const it of items) {
        insertItem.run(it.id, jobId, it.websiteUrl, it.clientName, it.clientEmail, it.competitorUrl, req.tenantId);
        updateLead.run(now, it._leadId);
      }
    });
    tx();

    queue.addJob(jobId, items);

    const settingsRows = db.prepare('SELECT key, value FROM settings').all();
    const agencySettings = {};
    for (const r of settingsRows) agencySettings[r.key] = r.value;
    const pagespeedRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('pagespeed_api_key');
    const apiKey = pagespeedRow?.value || process.env.PAGESPEED_API_KEY || null;

    queue.processJob(jobId, apiKey, user, agencySettings, user.name).catch((err) => {
      console.error('lead->bulk job error:', err);
    });

    console.log('[send-to-bulk] started', { jobId, total: items.length });
    return res.json({ jobId, message: 'Bulk audit started from leads', total: items.length });
  } catch (err) {
    console.error('[send-to-bulk] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const where = ['l.tenant_id = ?'];
    const args = [req.tenantId];
    if (!isAdmin) {
      where.push('l.assigned_to = ?');
      args.push(req.user.id);
    }
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      where.push('l.status = ?');
      args.push(req.query.status);
    }
    if (req.query.niche) {
      where.push('l.niche_id = ?');
      args.push(req.query.niche);
    }
    if (req.query.campaign_id) {
      where.push('l.campaign_id = ?');
      args.push(req.query.campaign_id);
    }
    if (req.query.assigned) {
      where.push('l.assigned_to = ?');
      args.push(req.query.assigned);
    }
    if (req.query.search) {
      const s = `%${req.query.search}%`;
      where.push('(l.business_name LIKE ? OR l.website LIKE ? OR l.email LIKE ?)');
      args.push(s, s, s);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = db
      .prepare(`SELECT COUNT(*) as c FROM leads l ${whereSql}`)
      .get(...args).c;

    const rows = db
      .prepare(
        `SELECT l.*, n.name as niche_name, n.icon as niche_icon, n.color as niche_color,
                u.name as assigned_name, u.email as assigned_email
         FROM leads l
         LEFT JOIN niches n ON n.id = l.niche_id
         LEFT JOIN users u ON u.id = l.assigned_to
         ${whereSql}
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset);

    return res.json({
      leads: rows,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/clear-all — removes every lead for this tenant.
// Admin only; also clears dependent follow-ups and tracking rows for them.
// Must be registered BEFORE /:id so the param handler doesn't shadow it.
router.delete('/clear-all', requireAdmin, (req, res) => {
  try {
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM leads WHERE tenant_id = ?')
      .get(req.tenantId).c;
    const tx = db.transaction(() => {
      db.prepare(
        `DELETE FROM follow_up_queue
         WHERE lead_id IN (SELECT id FROM leads WHERE tenant_id = ?)`
      ).run(req.tenantId);
      db.prepare(
        `DELETE FROM email_tracking
         WHERE lead_id IN (SELECT id FROM leads WHERE tenant_id = ?)`
      ).run(req.tenantId);
      db.prepare('DELETE FROM leads WHERE tenant_id = ?').run(req.tenantId);
    });
    tx();
    return res.json({ deleted: count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const lead = db
      .prepare(
        `SELECT l.*, n.name as niche_name, u.name as assigned_name
         FROM leads l
         LEFT JOIN niches n ON n.id = l.niche_id
         LEFT JOIN users u ON u.id = l.assigned_to
         WHERE l.id = ? AND l.tenant_id = ?`
      )
      .get(req.params.id, req.tenantId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    if (req.user.role !== 'admin' && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to view this lead' });
    }

    const tracking = db
      .prepare('SELECT * FROM email_tracking WHERE lead_id = ? ORDER BY sent_at DESC')
      .all(req.params.id);
    const followUps = db
      .prepare('SELECT * FROM follow_up_queue WHERE lead_id = ? ORDER BY scheduled_at ASC')
      .all(req.params.id);

    return res.json({ lead, tracking, followUps });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const website = b.website ? String(b.website).trim() : '';
    if (website) {
      const normalized = normalizeUrl(website);
      const existing = db
        .prepare('SELECT website FROM leads WHERE tenant_id = ? AND website IS NOT NULL')
        .all(req.tenantId);
      for (const r of existing) {
        if (normalizeUrl(r.website || '') === normalized) {
          return res.status(400).json({ error: 'A lead with this website already exists' });
        }
      }
    }

    const id = uuidv4();
    const status = VALID_STATUSES.includes(b.status) ? b.status : 'new';

    db.prepare(
      `INSERT INTO leads
       (id, business_name, website, email, phone, address, city, country, niche_id,
        assigned_to, source, contact_name, status, notes, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      b.businessName || b.business_name || null,
      website || null,
      b.email || null,
      b.phone || null,
      b.address || null,
      b.city || null,
      b.country || null,
      b.nicheId || b.niche_id || null,
      b.assignedTo || b.assigned_to || null,
      b.source || 'manual',
      b.contactName || b.contact_name || null,
      status,
      b.notes || null,
      req.tenantId
    );

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    return res.status(201).json({ lead });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const lead = db
      .prepare('SELECT * FROM leads WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && lead.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this lead' });
    }

    const b = req.body || {};
    const updates = [];
    const args = [];

    if (b.status !== undefined) {
      if (!VALID_STATUSES.includes(b.status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.push('status = ?'); args.push(b.status);
    }
    if (b.notes !== undefined) { updates.push('notes = ?'); args.push(b.notes); }

    if (b.assignedTo !== undefined || b.assigned_to !== undefined) {
      if (!isAdmin) {
        return res.status(403).json({ error: 'Only admin can reassign leads' });
      }
      updates.push('assigned_to = ?');
      args.push(b.assignedTo ?? b.assigned_to ?? null);
    }

    if (isAdmin) {
      const adminFields = {
        business_name: b.businessName ?? b.business_name,
        email: b.email,
        phone: b.phone,
        address: b.address,
        city: b.city,
        country: b.country,
        niche_id: b.nicheId ?? b.niche_id,
        contact_name: b.contactName ?? b.contact_name,
      };
      for (const [col, val] of Object.entries(adminFields)) {
        if (val !== undefined) { updates.push(`${col} = ?`); args.push(val); }
      }
    }

    if (updates.length === 0) {
      return res.json({ lead });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    args.push(req.params.id);
    db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...args);

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    return res.json({ lead: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const lead = db
      .prepare('SELECT id FROM leads WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM email_tracking WHERE lead_id = ?').run(req.params.id);
      db.prepare('DELETE FROM follow_up_queue WHERE lead_id = ?').run(req.params.id);
      db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
    });
    tx();

    return res.json({ message: 'Lead deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
