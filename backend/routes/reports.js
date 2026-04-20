const express = require('express');
const fs = require('fs');
const { db } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { generatePDF } = require('../utils/pdfGenerator');
const { sendAuditReport } = require('../utils/mailer');

const router = express.Router();

router.use(authenticateToken, resolveTenant);

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function rowToReportData(row) {
  return {
    websiteUrl: row.website_url,
    competitorUrl: row.competitor_url,
    overallScore: row.overall_score,
    grade: row.grade,
    scores: {
      seo: row.seo_score,
      performance: row.performance_score,
      security: row.security_score,
      accessibility: row.accessibility_score,
      mobile: row.mobile_score,
    },
    issues: safeParse(row.issues_json, []),
    recommendations: safeParse(row.recommendations_json, []),
    competitorData: safeParse(row.competitor_data_json, null),
    scrapeData: null,
    pagespeedData: null,
    auditedAt: row.created_at,
  };
}

function hasSmtpConfigured(user) {
  if (!user || !user.smtp_type) return false;
  if (user.smtp_type === 'gmail') return !!(user.gmail_email && user.gmail_app_password);
  if (user.smtp_type === 'hostinger') {
    return !!(user.smtp_host && user.smtp_port && user.smtp_email && user.smtp_password);
  }
  return false;
}

router.get('/', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const dateFrom = (req.query.dateFrom || '').trim();
    const dateTo = (req.query.dateTo || '').trim();

    const where = ['r.tenant_id = ?'];
    const params = [req.tenantId];

    if (req.user.role !== 'admin') {
      where.push('r.user_id = ?');
      params.push(req.user.id);
    }
    if (search) {
      where.push('(r.website_url LIKE ? OR r.client_name LIKE ? OR r.client_email LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern);
    }
    if (dateFrom) {
      where.push('r.created_at >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push('r.created_at <= ?');
      params.push(dateTo);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = db
      .prepare(`SELECT COUNT(*) as c FROM reports r ${whereSql}`)
      .get(...params).c;

    const rows = db
      .prepare(
        `SELECT r.id, r.website_url, r.client_name, r.client_email, r.competitor_url,
                r.overall_score, r.grade, r.seo_score, r.performance_score, r.security_score,
                r.accessibility_score, r.mobile_score, r.email_sent, r.email_sent_at,
                r.created_at, r.pdf_path, u.name as user_name
         FROM reports r
         LEFT JOIN users u ON u.id = r.user_id
         ${whereSql}
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

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

router.get('/:id', (req, res) => {
  try {
    const row = db
      .prepare('SELECT * FROM reports WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return res.json({
      ...row,
      issues: safeParse(row.issues_json, []),
      recommendations: safeParse(row.recommendations_json, []),
      competitorData: safeParse(row.competitor_data_json, null),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const row = db
      .prepare('SELECT * FROM reports WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Report not found' });

    if (row.pdf_path && fs.existsSync(row.pdf_path)) {
      try {
        fs.unlinkSync(row.pdf_path);
      } catch (e) {
        console.warn('Could not delete PDF file:', e.message);
      }
    }
    db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
    return res.json({ message: 'Report deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id/resend', async (req, res) => {
  try {
    const row = db
      .prepare('SELECT * FROM reports WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!row.client_email) {
      return res.status(400).json({ error: 'This report has no client email' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!hasSmtpConfigured(user)) {
      return res
        .status(400)
        .json({ error: 'Please configure your email settings in your profile first' });
    }

    const agencySettings = loadAgencySettings();
    const reportData = rowToReportData(row);
    reportData.preparedBy = user.name;

    let pdfPath = row.pdf_path;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      pdfPath = await generatePDF(reportData, agencySettings);
      db.prepare('UPDATE reports SET pdf_path = ? WHERE id = ?').run(pdfPath, row.id);
    }

    await sendAuditReport({
      userSmtpConfig: user,
      clientEmail: row.client_email,
      clientName: row.client_name || 'there',
      agencySettings,
      preparedBy: user.name,
      reportData,
      pdfPath,
    });

    db.prepare(
      "UPDATE reports SET email_sent = 1, email_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(row.id);

    return res.json({ success: true, message: `Report resent to ${row.client_email}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
