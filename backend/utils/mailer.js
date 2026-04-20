const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { db, decrypt } = require('../db/database');
const { getSummaryText } = require('./pdfGenerator');

// Always fetch agency settings fresh from the database.
function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'email-template.html');

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function sanitizeFilename(url) {
  return String(url || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'website';
}

function gradeColor(grade) {
  const g = String(grade || 'F').toUpperCase();
  return {
    A: '#16A34A',
    B: '#0D9488',
    C: '#EAB308',
    D: '#F97316',
    F: '#DC2626',
  }[g] || '#DC2626';
}

function severityStyle(severity) {
  if (severity === 'critical') {
    return { border: '#DC2626', badgeBg: '#FEE2E2', badgeColor: '#DC2626', label: 'Critical' };
  }
  if (severity === 'warning') {
    return { border: '#F59E0B', badgeBg: '#FEF3C7', badgeColor: '#B45309', label: 'Warning' };
  }
  return { border: '#16A34A', badgeBg: '#DCFCE7', badgeColor: '#16A34A', label: 'Pass' };
}

function renderIssuesHtml(issues) {
  const sevRank = { critical: 0, warning: 1, pass: 2 };
  const top = (issues || [])
    .slice()
    .sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3))
    .filter((i) => i.severity === 'critical' || i.severity === 'warning')
    .slice(0, 3);

  if (top.length === 0) {
    return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:12px;background-color:#F0FDF4;border-radius:10px;border-left:4px solid #16A34A;">
<tr><td style="padding:16px 18px;">
<p style="margin:0;font-size:14px;color:#111827;font-weight:700;">No critical issues found</p>
<p style="margin:4px 0 0 0;font-size:12px;color:#4B5563;line-height:1.5;">Your site is in good shape. See the attached PDF for the full breakdown.</p>
</td></tr>
</table>`;
  }

  return top
    .map((i) => {
      const s = severityStyle(i.severity);
      return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:12px;background-color:#F9FAFB;border-radius:10px;border-left:4px solid ${s.border};">
<tr><td style="padding:14px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr>
<td style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;font-weight:700;">${esc(i.category)}</td>
<td align="right"><span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:9px;font-weight:700;background-color:${s.badgeBg};color:${s.badgeColor};text-transform:uppercase;letter-spacing:0.5px;">${s.label}</span></td>
</tr>
</table>
<p style="margin:8px 0 4px 0;font-size:14px;color:#111827;font-weight:700;">${esc(i.title)}</p>
<p style="margin:0;font-size:12px;color:#4B5563;line-height:1.55;">${esc(i.description)}</p>
</td></tr>
</table>`;
    })
    .join('');
}

function renderRecsHtml(recs) {
  const top3 = (recs || []).slice(0, 3);
  if (top3.length === 0) {
    return '<li style="margin-bottom:6px;">No critical recommendations at this time.</li>';
  }
  return top3
    .map(
      (r) =>
        `<li style="margin-bottom:8px;"><strong style="color:#111827;">${esc(r.title)}</strong> — ${esc(r.recommendation)}</li>`
    )
    .join('');
}

async function createTransporter(user) {
  if (!user || !user.smtp_type) {
    throw new Error('User has no SMTP configured');
  }

  if (user.smtp_type === 'gmail') {
    if (!user.gmail_email || !user.gmail_app_password) {
      throw new Error('Gmail SMTP credentials are missing');
    }
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: user.gmail_email,
        pass: decrypt(user.gmail_app_password),
      },
    });
  }

  if (user.smtp_type === 'hostinger') {
    if (!user.smtp_host || !user.smtp_port || !user.smtp_email || !user.smtp_password) {
      throw new Error('SMTP credentials are missing');
    }
    const port = Number(user.smtp_port);
    return nodemailer.createTransport({
      host: user.smtp_host,
      port,
      secure: port === 465,
      auth: {
        user: user.smtp_email,
        pass: decrypt(user.smtp_password),
      },
    });
  }

  throw new Error(`Unknown smtp_type: ${user.smtp_type}`);
}

function getSenderEmail(user) {
  if (user.smtp_type === 'gmail') return user.gmail_email;
  return user.smtp_email;
}

async function sendAuditReport(options) {
  const {
    userSmtpConfig,
    clientEmail,
    clientName,
    agencySettings,
    preparedBy,
    reportData,
    pdfPath,
    aiEmail,
  } = options;

  if (!clientEmail) throw new Error('clientEmail is required');
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    throw new Error(`PDF attachment not found at ${pdfPath}`);
  }

  // Always refresh agency settings from the DB so the client sees the latest
  // branding even if it was edited mid-session or mid-bulk-job.
  const freshSettings = loadAgencySettings();
  const settings = { ...freshSettings, ...(agencySettings || {}) };

  const transporter = await createTransporter(userSmtpConfig);
  let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const scores = reportData.scores || {
    seo: 0,
    performance: 0,
    security: 0,
    accessibility: 0,
    mobile: 0,
  };

  const vars = {
    agencyLogo: esc(settings.agency_logo),
    agencyName: esc(settings.agency_name),
    agencyContact: esc(settings.agency_contact),
    agencyWebsite: esc(settings.agency_website),
    agencyPhone: esc(settings.agency_phone),
    clientName: esc(clientName || 'there'),
    websiteUrl: esc(reportData.websiteUrl || ''),
    overallScore: reportData.overallScore ?? 0,
    grade: esc(reportData.grade || 'F'),
    gradeColor: gradeColor(reportData.grade),
    auditDate: formatDate(reportData.auditedAt),
    preparedBy: esc(preparedBy || ''),
    seoScore: scores.seo ?? 0,
    performanceScore: scores.performance ?? 0,
    securityScore: scores.security ?? 0,
    accessibilityScore: scores.accessibility ?? 0,
    mobileScore: scores.mobile ?? 0,
    summaryText: esc(getSummaryText(scores)),
    issuesHtml: renderIssuesHtml(reportData.issues),
    recsHtml: renderRecsHtml(reportData.recommendations),
    year: new Date().getFullYear(),
  };

  for (const [k, v] of Object.entries(vars)) {
    template = template.split(`{{${k}}}`).join(v == null ? '' : String(v));
  }

  const senderEmail = getSenderEmail(userSmtpConfig);
  // No hardcoded fallback — if the agency_name hasn't been configured we
  // send as just the raw email address instead of faking a brand name.
  const agencyName = String(settings.agency_name || '').replace(/"/g, '').trim();
  const fromHeader = agencyName ? `"${agencyName}" <${senderEmail}>` : senderEmail;
  const pdfFilename = `AuditReport-${sanitizeFilename(reportData.websiteUrl)}.pdf`;
  const defaultSubject = `Website Audit Report for ${reportData.websiteUrl} — Score: ${reportData.overallScore}/100`;

  let subject = defaultSubject;
  let html = template;
  if (aiEmail && typeof aiEmail === 'object' && aiEmail.subject && aiEmail.body) {
    subject = String(aiEmail.subject);
    html = renderAiEmailHtml(aiEmail, { agencyName, preparedBy, agencyWebsite: settings.agency_website });
  }

  try {
    const info = await transporter.sendMail({
      from: fromHeader,
      to: clientEmail,
      subject,
      html,
      attachments: [
        { filename: pdfFilename, path: pdfPath, contentType: 'application/pdf' },
      ],
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    throw new Error(`Failed to send audit report: ${err.message}`);
  }
}

function renderAiEmailHtml(aiEmail, ctx = {}) {
  const esc2 = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const paragraphs = String(aiEmail.body || '')
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px 0;">${esc2(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');
  const signature = ctx.preparedBy
    ? `${esc2(ctx.preparedBy)}${ctx.agencyName ? `<br/>${esc2(ctx.agencyName)}` : ''}`
    : esc2(ctx.agencyName || '');
  const signatureBlock = signature
    ? `<p style="margin:22px 0 0 0;">${signature}</p>`
    : '';
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f7;">
  <div style="max-width:620px;margin:0 auto;padding:28px 22px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;">
    <p style="margin:0 0 14px 0;">${esc2(aiEmail.greeting || 'Hi,')}</p>
    ${paragraphs}
    <p style="margin:0 0 14px 0;">${esc2(aiEmail.cta || '')}</p>
    ${signatureBlock}
  </div>
</body></html>`;
}

function getPublicBaseUrl(settings) {
  if (settings && settings.public_base_url) return String(settings.public_base_url).replace(/\/+$/, '');
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

function followUpSubject(emailNumber, businessName, agencyName) {
  const b = businessName || 'your business';
  switch (Number(emailNumber)) {
    case 1:
      return `Quick follow-up: Website audit report for ${b}`;
    case 2:
      return 'Did you get a chance to review your audit?';
    case 3:
      return `One quick question about ${b}'s website`;
    case 4:
      return `Last message from ${agencyName || 'our team'}`;
    default:
      return `Following up about ${b}`;
  }
}

function followUpBody(emailNumber, lead, agency) {
  const greeting = lead.contactName ? `Hi ${esc(lead.contactName)},` : 'Hi there,';
  const businessName = esc(lead.businessName || 'your business');
  const agencyName = esc(agency.agency_name || 'our team');
  const agencyContact = esc(agency.agency_contact || '');
  const agencyWebsite = esc(agency.agency_website || '');

  const intros = {
    1: `I wanted to circle back on the website audit report I sent over for <strong>${businessName}</strong>. I thought you might have some questions about what we found.`,
    2: `Just checking in — were you able to review the audit report for <strong>${businessName}</strong>? Happy to walk you through the key findings whenever works for you.`,
    3: `Out of curiosity: is improving <strong>${businessName}</strong>'s website performance something you're actively looking at right now, or is it more of a long-term priority?`,
    4: `This will be my last note — I don't want to clutter your inbox. If the timing isn't right for <strong>${businessName}</strong>, I completely understand. The audit report is still yours to keep.`,
  };

  const ctas = {
    1: 'Book a 15-minute walkthrough',
    2: 'Review the findings together',
    3: 'Reply and let me know',
    4: 'Reach out when you are ready',
  };

  const intro = intros[emailNumber] || intros[1];
  const cta = ctas[emailNumber] || ctas[1];
  const ctaHref = agencyWebsite || `mailto:${agencyContact}`;

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#FFFFFF;">
  <p style="margin:0 0 16px 0;font-size:15px;color:#111827;">${greeting}</p>
  <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.6;">${intro}</p>
  <p style="margin:24px 0;">
    <a href="${ctaHref}" style="display:inline-block;background:#6C2BD9;color:#FFFFFF;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:600;">${cta}</a>
  </p>
  <p style="margin:0 0 4px 0;font-size:14px;color:#374151;">Best,</p>
  <p style="margin:0;font-size:14px;color:#374151;">${agencyName}</p>
  <hr style="border:none;border-top:1px solid #E5E7EB;margin:28px 0;">
  <p style="margin:0;font-size:11px;color:#9CA3AF;line-height:1.6;">
    You are receiving this follow-up because I previously sent a free website audit. Reply with "unsubscribe" and I will not contact you again.
  </p>
</div>`;
}

async function sendFollowUpEmail(options) {
  const {
    userSmtpConfig,
    lead,
    emailNumber,
    agencySettings,
    preparedBy,
    trackingPixelId,
  } = options || {};

  if (!lead || !lead.email) throw new Error('lead.email is required');
  if (!emailNumber || emailNumber < 1 || emailNumber > 4) {
    throw new Error('emailNumber must be 1, 2, 3, or 4');
  }

  const fresh = loadAgencySettings();
  const settings = { ...fresh, ...(agencySettings || {}) };

  const transporter = await createTransporter(userSmtpConfig);
  const senderEmail = getSenderEmail(userSmtpConfig);
  const agencyName = String(settings.agency_name || '').replace(/"/g, '').trim();
  const fromHeader = agencyName ? `"${agencyName}" <${senderEmail}>` : senderEmail;

  const subject = followUpSubject(emailNumber, lead.businessName, agencyName);
  let html = followUpBody(emailNumber, lead, settings);

  if (trackingPixelId && settings.tracking_pixel_enabled !== 'false') {
    const baseUrl = getPublicBaseUrl(settings);
    const pixelUrl = `${baseUrl}/api/tracking/pixel/${encodeURIComponent(trackingPixelId)}`;
    html += `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;" />`;
  }

  try {
    const info = await transporter.sendMail({
      from: fromHeader,
      to: lead.email,
      subject,
      html,
      headers: preparedBy ? { 'X-Prepared-By': String(preparedBy) } : undefined,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    throw new Error(`Failed to send follow-up: ${err.message}`);
  }
}

async function sendTestEmail(userSmtpConfig, toEmail) {
  const transporter = await createTransporter(userSmtpConfig);
  const sender = getSenderEmail(userSmtpConfig);
  try {
    const info = await transporter.sendMail({
      from: sender,
      to: toEmail,
      subject: 'AuditPro — Test Email Successful',
      html: `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;">
  <h2 style="margin:0 0 12px 0;color:#6C2BD9;font-size:22px;">AuditPro SMTP Working ✓</h2>
  <p style="margin:0 0 12px 0;font-size:14px;color:#4B5563;line-height:1.6;">Your email settings are configured correctly. You can now send audit reports to clients from your AuditPro account.</p>
  <p style="margin:0;font-size:12px;color:#9CA3AF;">If you did not request this test email, you can safely ignore it.</p>
</div>`,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    throw new Error(`Test email failed: ${err.message}`);
  }
}

async function verifyTransporter(userSmtpConfig) {
  try {
    const transporter = await createTransporter(userSmtpConfig);
    await transporter.verify();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  createTransporter,
  sendAuditReport,
  sendFollowUpEmail,
  sendTestEmail,
  verifyTransporter,
  loadAgencySettings,
  getPublicBaseUrl,
};
