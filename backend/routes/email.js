const express = require('express');
const fs = require('fs');
const { db } = require('../db/database');
const { authenticateToken } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { sendAuditReport, sendTestEmail, verifyTransporter } = require('../utils/mailer');
const { generatePDF } = require('../utils/pdfGenerator');
const { generatePersonalizedEmail } = require('../utils/aiEmailGenerator');

const router = express.Router();

function getSettingsObject() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  return {
    agency_name: settings.agency_name || 'AuditPro',
    agency_logo: settings.agency_logo || '',
    agency_contact: settings.agency_contact || '',
    agency_website: settings.agency_website || '',
    agency_phone: settings.agency_phone || '',
  };
}

router.use(authenticateToken, resolveTenant);

function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
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
  if (user.smtp_type === 'gmail') {
    return !!(user.gmail_email && user.gmail_app_password);
  }
  if (user.smtp_type === 'hostinger') {
    return !!(user.smtp_host && user.smtp_port && user.smtp_email && user.smtp_password);
  }
  return false;
}

router.post('/send/:reportId', async (req, res) => {
  try {
    const reportId = req.params.reportId;
    console.log('📧 Sending email for report:', reportId);
    const row = db
      .prepare('SELECT * FROM reports WHERE id = ? AND tenant_id = ?')
      .get(reportId, req.tenantId);
    if (!row) return res.status(404).json({ error: 'Report not found' });

    if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not have access to this report' });
    }

    if (!row.client_email) {
      return res.status(400).json({ error: 'This report has no client email address' });
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

    console.log('📧 AI email from DB:', row.ai_email_json ? 'EXISTS' : 'MISSING');
    let aiEmail = safeParse(row.ai_email_json, null);
    console.log('📧 Parsed AI email subject:', (aiEmail && aiEmail.subject) || 'NONE');

    if (!aiEmail) {
      console.log('🤖 Regenerating AI email...');
      try {
        const reportForAi = {
          overallScore: row.overall_score,
          grade: row.grade,
          scores: {
            seo: row.seo_score,
            performance: row.performance_score,
            security: row.security_score,
            accessibility: row.accessibility_score,
            mobile: row.mobile_score,
          },
          issues: safeParse(row.issues_json, [])
            .filter((i) => i && i.severity === 'critical')
            .slice(0, 3),
          recommendations: safeParse(row.recommendations_json, []).slice(0, 3),
        };
        const settings = getSettingsObject();
        const freshAiEmail = await generatePersonalizedEmail({
          businessName: row.client_name,
          websiteUrl: row.website_url,
          clientName: row.client_name,
          industry: 'business',
          location: '',
          auditData: reportForAi,
          agencySettings: settings,
          emailNumber: 1,
        });
        if (freshAiEmail) {
          db.prepare('UPDATE reports SET ai_email_json = ? WHERE id = ?').run(
            JSON.stringify(freshAiEmail),
            row.id
          );
          aiEmail = freshAiEmail;
          console.log('✅ Fresh AI email generated:', freshAiEmail.subject);
        }
      } catch (aiErr) {
        console.error('⚠️ AI email regeneration failed:', aiErr.message);
      }
    }

    await sendAuditReport({
      userSmtpConfig: user,
      clientEmail: row.client_email,
      clientName: row.client_name || 'there',
      agencySettings,
      preparedBy: user.name,
      reportData,
      pdfPath,
      aiEmail,
    });

    db.prepare(
      "UPDATE reports SET email_sent = 1, email_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(row.id);

    return res.json({
      success: true,
      message: `Report sent to ${row.client_email}`,
    });
  } catch (err) {
    console.error('Email send failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!hasSmtpConfigured(user)) {
      return res.status(400).json({ error: 'Please configure your email settings first' });
    }
    const result = await sendTestEmail(user, user.email);
    return res.json({ success: true, message: 'Test email sent', messageId: result.messageId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!hasSmtpConfigured(user)) {
      return res.json({ valid: false, message: 'No SMTP configured' });
    }
    const result = await verifyTransporter(user);
    return res.json({
      valid: result.valid,
      message: result.valid ? 'SMTP settings are valid' : result.error,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
