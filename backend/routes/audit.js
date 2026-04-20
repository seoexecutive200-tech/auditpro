const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticateToken } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { enforceUsageLimits } = require('../utils/usageLimits');
const { runAudit } = require('../utils/auditEngine');
const { generatePDF } = require('../utils/pdfGenerator');
const { generatePersonalizedEmail } = require('../utils/aiEmailGenerator');

function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

const router = express.Router();

router.use(authenticateToken, resolveTenant);

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getPageSpeedKey() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pagespeed_api_key');
  return row?.value || process.env.PAGESPEED_API_KEY || null;
}

router.get('/test', (req, res) => {
  res.json({ message: 'Audit engine ready' });
});

router.post('/single', enforceUsageLimits('audit'), async (req, res) => {
  try {
    const { websiteUrl, competitorUrl, clientName, clientEmail } = req.body || {};
    if (!websiteUrl || !isValidUrl(websiteUrl)) {
      return res.status(400).json({ error: 'Valid websiteUrl is required' });
    }
    if (competitorUrl && !isValidUrl(competitorUrl)) {
      return res.status(400).json({ error: 'competitorUrl is not a valid URL' });
    }

    const apiKey = getPageSpeedKey();
    const result = await runAudit(websiteUrl, competitorUrl || null, apiKey);

    const reportId = uuidv4();
    db.prepare(
      `INSERT INTO reports (
         id, user_id, client_name, client_email, website_url, competitor_url,
         overall_score, grade, seo_score, performance_score, accessibility_score,
         security_score, mobile_score, issues_json, recommendations_json, competitor_data_json,
         tenant_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reportId,
      req.user.id,
      clientName || null,
      clientEmail || null,
      websiteUrl,
      competitorUrl || null,
      result.overallScore,
      result.grade,
      result.scores.seo,
      result.scores.performance,
      result.scores.accessibility,
      result.scores.security,
      result.scores.mobile,
      JSON.stringify(result.issues),
      JSON.stringify(result.recommendations),
      result.competitorData ? JSON.stringify(result.competitorData) : null,
      req.tenantId
    );

    const agencySettings = loadAgencySettings();

    let pdfPath = null;
    try {
      const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
      const reportForPdf = { ...result, preparedBy: owner?.name || 'AuditPro' };
      pdfPath = await generatePDF(reportForPdf, agencySettings);
      db.prepare('UPDATE reports SET pdf_path = ? WHERE id = ?').run(pdfPath, reportId);
    } catch (pdfErr) {
      console.error('PDF generation failed (audit still saved):', pdfErr.message);
    }

    let aiEmail = null;
    try {
      aiEmail = await generatePersonalizedEmail({
        businessName: clientName || websiteUrl,
        websiteUrl,
        clientName,
        industry: 'business',
        location: '',
        auditData: {
          overallScore: result.overallScore,
          grade: result.grade,
          scores: result.scores,
          topIssues: (result.issues || [])
            .filter((i) => i && i.severity === 'critical')
            .slice(0, 3),
          recommendations: (result.recommendations || []).slice(0, 3),
          competitorData: result.competitorData,
        },
        agencySettings,
        emailNumber: 1,
      });
      db.prepare('UPDATE reports SET ai_email_json = ? WHERE id = ?').run(
        JSON.stringify(aiEmail),
        reportId
      );
    } catch (aiErr) {
      console.error('AI email generation failed (audit still saved):', aiErr.message);
    }

    return res.json({ reportId, pdfPath, aiEmail, ...result });
  } catch (err) {
    console.error('audit failed:', err);
    return res.status(500).json({ error: `Audit failed: ${err.message}` });
  }
});

module.exports = router;
