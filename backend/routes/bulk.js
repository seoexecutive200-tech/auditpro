const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticateToken, verifyToken } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { enforceUsageLimits } = require('../utils/usageLimits');
const queue = require('../utils/queue');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getPageSpeedKey() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pagespeed_api_key');
  return row?.value || process.env.PAGESPEED_API_KEY || null;
}

function hasSmtpConfigured(user) {
  if (!user || !user.smtp_type) return false;
  if (user.smtp_type === 'gmail') {
    return !!(user.gmail_email && user.gmail_app_password);
  }
  if (user.smtp_type === 'hostinger') {
    return !!(user.smtp_host && user.smtp_port && user.smtp_email && user.smtp_password);
  }
  return false;
}

// ---- SSE progress endpoint — defined BEFORE router.use(authenticateToken)
// so we can accept the JWT via ?token= query param (EventSource can't set headers).
router.get('/:jobId/progress', (req, res) => {
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = headerToken || req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  try {
    req.user = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  queue.addClient(req.params.jobId, res);
});

router.use(authenticateToken, resolveTenant);

router.post('/start', enforceUsageLimits('audit'), async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }
    if (items.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 items per job' });
    }

    for (const it of items) {
      if (!it.websiteUrl || !isValidUrl(it.websiteUrl)) {
        return res.status(400).json({ error: `Invalid websiteUrl: ${it.websiteUrl}` });
      }
      if (!it.clientEmail) {
        return res.status(400).json({ error: `Missing clientEmail for ${it.websiteUrl}` });
      }
      if (it.competitorUrl && !isValidUrl(it.competitorUrl)) {
        return res.status(400).json({ error: `Invalid competitorUrl: ${it.competitorUrl}` });
      }
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!hasSmtpConfigured(user)) {
      return res
        .status(400)
        .json({ error: 'Please configure your email settings in your profile first' });
    }

    const jobId = uuidv4();
    const tenantId = req.tenantId;
    db.prepare(
      `INSERT INTO bulk_jobs (id, user_id, total_sites, completed, failed, status, tenant_id)
       VALUES (?, ?, ?, 0, 0, 'pending', ?)`
    ).run(jobId, user.id, items.length, tenantId);

    const itemsWithIds = items.map((it) => ({
      id: uuidv4(),
      websiteUrl: it.websiteUrl,
      clientName: it.clientName || null,
      clientEmail: it.clientEmail,
      competitorUrl: it.competitorUrl || null,
    }));

    const insertItem = db.prepare(
      `INSERT INTO bulk_job_items (id, job_id, website_url, client_name, client_email, competitor_url, status, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    const insertMany = db.transaction((arr) => {
      for (const it of arr) {
        insertItem.run(it.id, jobId, it.websiteUrl, it.clientName, it.clientEmail, it.competitorUrl, tenantId);
      }
    });
    insertMany(itemsWithIds);

    queue.addJob(jobId, itemsWithIds);

    const apiKey = getPageSpeedKey();
    const agencySettings = loadAgencySettings();

    queue.processJob(jobId, apiKey, user, agencySettings, user.name).catch((err) => {
      console.error('bulk job error:', err);
    });

    return res.json({ jobId, message: 'Bulk audit started', total: items.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/history', (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      rows = db
        .prepare(
          `SELECT bj.*, u.name as user_name
           FROM bulk_jobs bj
           LEFT JOIN users u ON u.id = bj.user_id
           WHERE bj.tenant_id = ?
           ORDER BY bj.created_at DESC
           LIMIT 100`
        )
        .all(req.tenantId);
    } else {
      rows = db
        .prepare(
          `SELECT * FROM bulk_jobs WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100`
        )
        .all(req.tenantId, req.user.id);
    }
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:jobId/status', (req, res) => {
  try {
    const memJob = queue.getJob(req.params.jobId);
    if (memJob) {
      return res.json({
        jobId: memJob.jobId,
        status: memJob.status,
        total: memJob.total,
        completed: memJob.completed,
        failed: memJob.failed,
        items: memJob.items,
      });
    }
    const dbJob = db
      .prepare('SELECT * FROM bulk_jobs WHERE id = ? AND tenant_id = ?')
      .get(req.params.jobId, req.tenantId);
    if (!dbJob) return res.status(404).json({ error: 'Job not found' });
    const dbItems = db
      .prepare('SELECT * FROM bulk_job_items WHERE job_id = ?')
      .all(req.params.jobId);
    return res.json({
      jobId: dbJob.id,
      status: dbJob.status,
      total: dbJob.total_sites,
      completed: dbJob.completed,
      failed: dbJob.failed,
      items: dbItems.map((r) => ({
        id: r.id,
        websiteUrl: r.website_url,
        clientName: r.client_name,
        clientEmail: r.client_email,
        competitorUrl: r.competitor_url,
        status: r.status,
        reportId: r.report_id,
        error: r.error_message,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:jobId/retry-failed', async (req, res) => {
  try {
    const failedItems = queue.getFailedItems(req.params.jobId);
    if (failedItems.length === 0) {
      return res.status(400).json({ error: 'No failed items to retry' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!hasSmtpConfigured(user)) {
      return res
        .status(400)
        .json({ error: 'Please configure your email settings first' });
    }

    const newJobId = uuidv4();
    const tenantId = req.tenantId;
    db.prepare(
      `INSERT INTO bulk_jobs (id, user_id, total_sites, completed, failed, status, tenant_id)
       VALUES (?, ?, ?, 0, 0, 'pending', ?)`
    ).run(newJobId, user.id, failedItems.length, tenantId);

    const newItems = failedItems.map((it) => ({
      id: uuidv4(),
      websiteUrl: it.websiteUrl,
      clientName: it.clientName,
      clientEmail: it.clientEmail,
      competitorUrl: it.competitorUrl,
    }));

    const insertItem = db.prepare(
      `INSERT INTO bulk_job_items (id, job_id, website_url, client_name, client_email, competitor_url, status, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    const insertMany = db.transaction((arr) => {
      for (const it of arr) {
        insertItem.run(it.id, newJobId, it.websiteUrl, it.clientName, it.clientEmail, it.competitorUrl, tenantId);
      }
    });
    insertMany(newItems);

    queue.addJob(newJobId, newItems);

    const apiKey = getPageSpeedKey();
    const agencySettings = loadAgencySettings();

    queue.processJob(newJobId, apiKey, user, agencySettings, user.name).catch((err) => {
      console.error('retry job error:', err);
    });

    return res.json({ jobId: newJobId, message: 'Retry started', total: newItems.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/upload-csv', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const content = req.file.buffer.toString('utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV is empty or missing data rows' });
    }

    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const colIdx = {
      website: header.indexOf('website'),
      clientName: header.indexOf('client_name'),
      clientEmail: header.indexOf('client_email'),
      competitorUrl: header.indexOf('competitor_url'),
    };
    if (colIdx.website === -1 || colIdx.clientEmail === -1) {
      return res
        .status(400)
        .json({ error: 'CSV must have "website" and "client_email" columns' });
    }

    const items = [];
    const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const websiteUrl = cols[colIdx.website] || '';
      const clientEmail = cols[colIdx.clientEmail] || '';
      const clientName = colIdx.clientName >= 0 ? cols[colIdx.clientName] || '' : '';
      const competitorUrl = colIdx.competitorUrl >= 0 ? cols[colIdx.competitorUrl] || '' : '';

      if (!websiteUrl || !isValidUrl(websiteUrl)) {
        errors.push({ line: i + 1, error: `Invalid website URL: ${websiteUrl}` });
        continue;
      }
      if (!clientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail)) {
        errors.push({ line: i + 1, error: `Invalid client_email: ${clientEmail}` });
        continue;
      }
      if (competitorUrl && !isValidUrl(competitorUrl)) {
        errors.push({ line: i + 1, error: `Invalid competitor_url: ${competitorUrl}` });
        continue;
      }

      items.push({
        websiteUrl,
        clientName: clientName || null,
        clientEmail,
        competitorUrl: competitorUrl || null,
      });
    }

    return res.json({ items, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
