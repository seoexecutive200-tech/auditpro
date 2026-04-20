const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const { runCampaign, getJob, requestCancel } = require('../utils/dailyPipeline');

const router = express.Router();

// authenticateToken + resolveTenant are applied at mount time in server.js.

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function smtpConfigured(user) {
  if (!user) return false;
  return !!(user.gmail_email || user.smtp_email);
}

function campaignRowToApi(row, leadCount) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    niche: row.niche,
    location: row.location,
    target_emails: row.target_emails,
    status: row.status,
    leads_found: row.leads_found || 0,
    emails_found: row.emails_found || 0,
    emails_sent: row.emails_sent || 0,
    audits_completed: row.audits_completed || 0,
    follow_ups_scheduled: row.follow_ups_scheduled || 0,
    avg_score: row.avg_score || 0,
    pdf_path: row.pdf_path,
    pdfAvailable: !!(row.pdf_path && fs.existsSync(row.pdf_path)),
    auto_audit: !!row.auto_audit,
    auto_email: !!row.auto_email,
    auto_followup: !!row.auto_followup,
    started_by: row.started_by,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    lead_count: leadCount != null ? leadCount : undefined,
  };
}

// POST /api/pipeline/start
router.post('/start', requireAdmin, async (req, res) => {
  try {
    const {
      niche,
      location,
      targetEmails,
      autoAudit,
      autoEmail,
      autoFollowup,
    } = req.body || {};

    if (!niche || typeof niche !== 'string' || !niche.trim()) {
      return res.status(400).json({ error: 'niche is required' });
    }
    if (!location || typeof location !== 'string' || !location.trim()) {
      return res.status(400).json({ error: 'location is required' });
    }
    const n = Number(targetEmails);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return res.status(400).json({ error: 'targetEmails must be 1..500' });
    }

    const adminUser = db
      .prepare(
        `SELECT gmail_email, smtp_email FROM users
         WHERE tenant_id = ? AND role = 'admin'
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(req.tenantId);

    const warnings = [];
    let effectiveAutoEmail = autoEmail !== false;
    const effectiveAutoFollowup = autoFollowup !== false;
    if (effectiveAutoEmail && !smtpConfigured(adminUser)) {
      effectiveAutoEmail = false;
      warnings.push(
        'SMTP not configured — emails disabled. Configure in Profile to enable.'
      );
    }

    const { jobId, campaignId, campaignName } = await runCampaign(
      {
        niche: niche.trim(),
        location: location.trim(),
        targetEmails: n,
        autoAudit: autoAudit !== false,
        autoEmail: effectiveAutoEmail,
        autoFollowup: effectiveAutoFollowup,
      },
      req.tenantId,
      req.user.id
    );

    return res.json({ jobId, campaignId, campaignName, warnings });
  } catch (err) {
    console.error('pipeline /start failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/job/:jobId
router.get('/job/:jobId', (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    // Shape: return only what the client should see.
    return res.json({
      jobId: req.params.jobId,
      campaignId: job.campaignId,
      campaignName: job.campaignName,
      step: job.step,
      message: job.message,
      percent: job.percent || 0,
      status: job.status,
      leadsFound: job.leadsFound || 0,
      emailsFound: job.emailsFound || 0,
      emailsSent: job.emailsSent || 0,
      auditsCompleted: job.auditsCompleted || 0,
      currentSite: job.currentSite || null,
      startedAt: job.startedAt,
      summary: job.summary || null,
      cancelled: !!job.cancelled,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/pipeline/cancel/:jobId
router.post('/cancel/:jobId', requireAdmin, (req, res) => {
  const ok = requestCancel(req.params.jobId);
  if (!ok) return res.status(404).json({ error: 'Job not found' });
  return res.json({ message: 'Campaign cancellation requested' });
});

// GET /api/pipeline/campaigns
router.get('/campaigns', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const rows = db
      .prepare(
        `SELECT * FROM campaigns
         WHERE tenant_id = ? AND (deleted_at IS NULL)
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(req.tenantId, limit, offset);
    const total = db
      .prepare(
        `SELECT COUNT(*) AS c FROM campaigns
         WHERE tenant_id = ? AND (deleted_at IS NULL)`
      )
      .get(req.tenantId).c;
    return res.json({
      campaigns: rows.map((r) => campaignRowToApi(r)),
      total,
      limit,
      offset,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/campaigns/:id
router.get('/campaigns/:id', (req, res) => {
  try {
    const row = db
      .prepare(
        `SELECT * FROM campaigns
         WHERE id = ? AND tenant_id = ? AND (deleted_at IS NULL)`
      )
      .get(req.params.id, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Campaign not found' });

    const leads = db
      .prepare(
        `SELECT id, business_name, website, email, phone, city, status, audit_sent,
                audit_sent_at, last_email_at, contact_name, created_at
         FROM leads
         WHERE campaign_id = ? AND tenant_id = ?
         ORDER BY created_at ASC`
      )
      .all(req.params.id, req.tenantId);

    return res.json({
      ...campaignRowToApi(row, leads.length),
      leads,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/campaigns/:id/pdf
router.get('/campaigns/:id/pdf', (req, res) => {
  try {
    const row = db
      .prepare(
        `SELECT pdf_path, name FROM campaigns
         WHERE id = ? AND tenant_id = ? AND (deleted_at IS NULL)`
      )
      .get(req.params.id, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Campaign not found' });
    if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
      return res.status(404).json({ error: 'Campaign PDF not available yet' });
    }
    const safeName = String(row.name || 'campaign')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName || 'campaign'}.pdf"`
    );
    const stream = fs.createReadStream(row.pdf_path);
    stream.on('error', (err) => {
      console.error('campaign pdf stream failed:', err.message);
      if (!res.headersSent) res.status(500).end();
    });
    return stream.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pipeline/campaigns/:id  (soft delete)
router.delete('/campaigns/:id', requireAdmin, (req, res) => {
  try {
    const row = db
      .prepare('SELECT id FROM campaigns WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Campaign not found' });
    db.prepare(
      `UPDATE campaigns SET deleted_at = datetime('now') WHERE id = ?`
    ).run(req.params.id);
    return res.json({ message: 'Campaign deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
