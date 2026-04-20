const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const { verifyToken } = require('../utils/auth');
const { generatePDF } = require('../utils/pdfGenerator');

const router = express.Router();

// NOTE: no router.use(authenticateToken) — we need to accept the JWT either
// in the Authorization header OR in ?token= so that window.open() works over
// plain HTTP without triggering the "insecure download blocked" warning.

function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function reportRowToReportData(row, preparedBy) {
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
    preparedBy,
  };
}

function authFromHeaderOrQuery(req) {
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = header || req.query.token;
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

router.get('/:id/pdf', async (req, res) => {
  try {
    const user = authFromHeaderOrQuery(req);
    if (!user) return res.status(401).json({ error: 'Missing or invalid token' });

    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Report not found' });

    if (user.role !== 'admin' && row.user_id !== user.id) {
      return res.status(403).json({ error: 'You do not have access to this report' });
    }

    let pdfPath = row.pdf_path;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id);
      const agencySettings = loadAgencySettings();
      const reportData = reportRowToReportData(row, owner && owner.name);
      pdfPath = await generatePDF(reportData, agencySettings);
      db.prepare('UPDATE reports SET pdf_path = ? WHERE id = ?').run(pdfPath, row.id);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Use inline so the browser's built-in PDF viewer displays it in a new tab,
    // which bypasses the HTTP "insecure download" warning Chrome applies to
    // Content-Disposition: attachment over non-HTTPS.
    res.setHeader('Content-Disposition', `inline; filename="audit-report.pdf"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error('PDF route error:', err);
    return res.status(500).json({ error: `Failed to generate PDF: ${err.message}` });
  }
});

module.exports = router;
