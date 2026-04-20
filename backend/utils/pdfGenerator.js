const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { db } = require('../db/database');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'report-pdf.html');
const PDF_DIR = path.join(__dirname, '..', '..', 'pdfs');

// =================================================================
// HELPERS
// =================================================================
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scoreColor(score) {
  if (score >= 80) return '#16A34A';
  if (score >= 60) return '#F59E0B';
  return '#DC2626';
}

function scoreBgColor(score) {
  if (score >= 80) return '#DCFCE7';
  if (score >= 60) return '#FEF3C7';
  return '#FEE2E2';
}

function gradeColor(grade) {
  const g = String(grade || 'F').toUpperCase();
  return {
    A: '#16A34A',
    B: '#0D9488',
    C: '#F59E0B',
    D: '#EA580C',
    F: '#DC2626',
  }[g] || '#DC2626';
}

function severityColors(severity) {
  if (severity === 'critical') return { bg: '#FEE2E2', fg: '#DC2626', label: 'Critical' };
  if (severity === 'warning')  return { bg: '#FEF3C7', fg: '#B45309', label: 'Warning' };
  return { bg: '#DCFCE7', fg: '#16A34A', label: 'Pass' };
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function sanitizeFilename(url) {
  return (String(url)
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)) || 'website';
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function cwvStatus(metric, value) {
  if (!value || value === 'N/A') return { color: '#9CA3AF', label: 'N/A' };
  const num = parseFloat(value);
  if (Number.isNaN(num)) return { color: '#9CA3AF', label: 'N/A' };
  const thresholds = {
    fcp: [1.8, 3], lcp: [2.5, 4], tti: [3.8, 7.3],
    tbt: [200, 600], cls: [0.1, 0.25], si: [3.4, 5.8],
  };
  const [good, poor] = thresholds[metric] || [Infinity, Infinity];
  if (num <= good) return { color: '#16A34A', label: 'Good' };
  if (num <= poor) return { color: '#F59E0B', label: 'Needs work' };
  return { color: '#DC2626', label: 'Poor' };
}

// =================================================================
// SUMMARY TEXT
// =================================================================
function getSummaryText(scores) {
  const overall = Math.round(
    (scores.seo || 0) * 0.25 +
    (scores.performance || 0) * 0.25 +
    (scores.security || 0) * 0.2 +
    (scores.accessibility || 0) * 0.15 +
    (scores.mobile || 0) * 0.15
  );
  const grade =
    overall >= 90 ? 'A' :
    overall >= 80 ? 'B' :
    overall >= 70 ? 'C' :
    overall >= 60 ? 'D' : 'F';

  const entries = Object.entries(scores);
  const worst = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  const best  = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const names = {
    seo: 'SEO', performance: 'Performance', security: 'Security',
    accessibility: 'Accessibility', mobile: 'Mobile',
  };

  const intros = {
    A: 'Your website is performing exceptionally well across the board with strong fundamentals in place.',
    B: 'Your website is in solid shape overall, with a handful of opportunities to reach top-tier performance.',
    C: 'Your website has a reasonable foundation but several important areas need attention to compete effectively.',
    D: 'Your website has significant issues that are likely costing you traffic, conversions, and credibility.',
    F: 'Your website has critical problems that require urgent attention to protect visitors, rankings, and revenue.',
  };

  return [
    intros[grade],
    `The biggest opportunity is ${names[worst[0]]}, which currently scores ${worst[1]}/100 and should be addressed first.`,
    `Your strongest area is ${names[best[0]]} at ${best[1]}/100 — preserve and build on this advantage.`,
  ].join(' ');
}

// =================================================================
// ROW-BASED RENDERERS (match the table-based template)
// =================================================================
function renderTopCriticalRows(issues) {
  const crit = (issues || []).filter(i => i.severity === 'critical').slice(0, 3);
  if (crit.length === 0) {
    return `<tr><td style="padding:14px 18px;background-color:#F0FDF4;border:1px solid #BBF7D0;border-left:4px solid #16A34A;border-radius:8px;font-size:12px;color:#166534;">No critical issues found. Your site is in good shape.</td></tr>`;
  }
  return crit.map(i => `
    <tr><td style="padding:0 0 10px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FEF2F2;border:1px solid #FECACA;border-left:4px solid #DC2626;border-radius:8px;">
        <tr><td style="padding:12px 16px;">
          <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;font-weight:bold;">${esc(i.category)}</div>
          <div style="font-size:13px;color:#111827;font-weight:bold;margin:3px 0 4px 0;">${esc(i.title)}</div>
          <div style="font-size:11px;color:#4B5563;">${esc(i.description)}</div>
        </td></tr>
      </table>
    </td></tr>
  `).join('');
}

function renderQuickWinsRows(recs) {
  const wins = (recs || []).filter(r => r.difficulty === 'Easy').slice(0, 3);
  if (wins.length === 0) {
    return `<tr><td style="padding:14px 18px;background-color:#F9FAFB;border:1px solid #E5E7EB;border-left:4px solid #9CA3AF;border-radius:8px;font-size:12px;color:#6B7280;">No easy wins identified — remaining recommendations require medium-to-hard effort.</td></tr>`;
  }
  return wins.map(r => `
    <tr><td style="padding:0 0 10px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F0FDF4;border:1px solid #BBF7D0;border-left:4px solid #16A34A;border-radius:8px;">
        <tr><td style="padding:12px 16px;">
          <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.8px;font-weight:bold;">${esc(r.category)}</div>
          <div style="font-size:13px;color:#111827;font-weight:bold;margin:3px 0 4px 0;">${esc(r.title)}</div>
          <div style="font-size:11px;color:#4B5563;">${esc(r.recommendation)}</div>
        </td></tr>
      </table>
    </td></tr>
  `).join('');
}

function checkCell(good) {
  return good
    ? '<span style="color:#16A34A;font-weight:bold;font-size:14px;">&#10003;</span>'
    : '<span style="color:#DC2626;font-weight:bold;font-size:14px;">&#10007;</span>';
}

function renderSeoChecksRows(seo) {
  if (!seo) {
    return `<tr><td colspan="2" style="padding:16px;text-align:center;color:#9CA3AF;font-size:11px;">No SEO data available</td></tr>`;
  }
  const rows = [
    ['Title tag', seo.title ? esc(truncate(seo.title, 70)) : checkCell(false)],
    [`Title length (${seo.titleLength} chars, ideal 50-60)`, checkCell(seo.titleValid)],
    ['Meta description', seo.metaDescription ? esc(truncate(seo.metaDescription, 80)) : checkCell(false)],
    [`Meta description length (${seo.metaDescriptionLength} chars, ideal 150-160)`, checkCell(seo.metaDescriptionValid)],
    [`H1 tag (${seo.h1Count} found, ideal 1)`, checkCell(seo.h1Valid)],
    ['H2 count', seo.h2Count],
    ['Canonical URL', checkCell(seo.hasCanonical)],
    ['Open Graph tags', checkCell(seo.hasOpenGraph)],
    ['robots.txt', checkCell(seo.robotsTxt)],
    ['sitemap.xml', checkCell(seo.sitemapXml)],
    [`Image alt text coverage (${seo.totalImages} images)`, `${seo.altTextCoverage}%`],
    ['Internal links', seo.internalLinks],
    ['External links', seo.externalLinks],
    ['Broken links (checked up to 10)', seo.brokenLinks && seo.brokenLinks.length
      ? `<span style="color:#DC2626;font-weight:bold;">${seo.brokenLinks.length}</span>`
      : checkCell(true)],
  ];
  return rows.map(([k, v]) => `
    <tr>
      <td style="padding:10px 14px;font-size:11px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${esc(k)}</td>
      <td style="padding:10px 14px;font-size:11px;color:#111827;border-bottom:1px solid #E5E7EB;">${v}</td>
    </tr>
  `).join('');
}

function renderCoreWebVitalsRows(perf) {
  if (!perf) {
    return `<tr><td colspan="3" style="padding:16px;text-align:center;color:#9CA3AF;font-size:11px;font-style:italic;">Core Web Vitals not available &mdash; PageSpeed Insights data was not returned for this audit.</td></tr>`;
  }
  const metrics = [
    ['fcp', 'First Contentful Paint', perf.firstContentfulPaint],
    ['lcp', 'Largest Contentful Paint', perf.largestContentfulPaint],
    ['tti', 'Time to Interactive', perf.timeToInteractive],
    ['tbt', 'Total Blocking Time', perf.totalBlockingTime],
    ['cls', 'Cumulative Layout Shift', perf.cumulativeLayoutShift],
    ['si', 'Speed Index', perf.speedIndex],
  ];
  return metrics.map(([k, name, v]) => {
    const s = cwvStatus(k, v);
    return `
      <tr>
        <td style="padding:10px 14px;font-size:11px;color:#111827;font-weight:bold;border-bottom:1px solid #E5E7EB;">${esc(name)}</td>
        <td style="padding:10px 14px;font-size:12px;color:#111827;border-bottom:1px solid #E5E7EB;">${esc(v || 'N/A')}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;">
          <span style="display:inline-block;padding:3px 10px;font-size:10px;font-weight:bold;color:${s.color};background-color:${s.color}22;border-radius:999px;">${s.label}</span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderSecurityChecksRows(sec) {
  if (!sec) {
    return `<tr><td style="padding:16px;text-align:center;color:#9CA3AF;font-size:11px;">Security data unavailable</td></tr>`;
  }
  const items = [
    ['HTTPS enabled', sec.isHttps],
    ['SSL valid', sec.sslValid],
    ['HSTS header', sec.hasHSTS],
    ['Content-Security-Policy', sec.hasCSP],
    ['X-Frame-Options', sec.hasXFrameOptions],
    ['X-Content-Type-Options', sec.hasXContentType],
    ['No mixed content', !sec.hasMixedContent],
  ];
  return items.map(([name, ok]) => `
    <tr>
      <td style="padding:10px 14px;font-size:11px;color:#111827;border-bottom:1px solid #E5E7EB;">${esc(name)}</td>
      <td style="padding:10px 14px;text-align:right;border-bottom:1px solid #E5E7EB;">
        ${ok
          ? '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#16A34A;background-color:#DCFCE7;border-radius:999px;">PASS</span>'
          : '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#DC2626;background-color:#FEE2E2;border-radius:999px;">FAIL</span>'}
      </td>
    </tr>
  `).join('');
}

function renderAccessibilityIssuesRows(acc) {
  if (!acc) {
    return `<tr><td style="padding:16px;text-align:center;color:#9CA3AF;font-size:11px;font-style:italic;">Accessibility data unavailable.</td></tr>`;
  }
  const issues = acc.issues || [];
  if (issues.length === 0) {
    return `<tr><td style="padding:14px 16px;font-size:12px;color:#166534;background-color:#F0FDF4;">No accessibility issues detected. Score: ${acc.score}/100.</td></tr>`;
  }
  return issues.slice(0, 8).map(i => `
    <tr>
      <td style="padding:10px 14px;font-size:11px;color:#111827;border-bottom:1px solid #E5E7EB;">
        <div style="font-weight:bold;margin-bottom:2px;">${esc(i.title)}</div>
        <div style="color:#6B7280;font-size:10px;">${esc(truncate(i.description, 140))}</div>
      </td>
    </tr>
  `).join('');
}

function renderMobileChecksRows(mob) {
  if (!mob) {
    return `<tr><td style="padding:16px;text-align:center;color:#9CA3AF;font-size:11px;">Mobile data unavailable</td></tr>`;
  }
  const items = [
    ['Viewport meta tag', mob.usesViewport],
    ['Legible font sizes', mob.fontSizeLegible],
    ['Tap targets sized correctly', mob.tapTargetsValid],
  ];
  return items.map(([name, ok]) => `
    <tr>
      <td style="padding:10px 14px;font-size:11px;color:#111827;border-bottom:1px solid #E5E7EB;">${esc(name)}</td>
      <td style="padding:10px 14px;text-align:right;border-bottom:1px solid #E5E7EB;">
        ${ok
          ? '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#16A34A;background-color:#DCFCE7;border-radius:999px;">PASS</span>'
          : '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#DC2626;background-color:#FEE2E2;border-radius:999px;">FAIL</span>'}
      </td>
    </tr>
  `).join('');
}

function renderIssuesTableRows(issues) {
  const sevOrder = { critical: 0, warning: 1, pass: 2 };
  const sorted = (issues || []).slice().sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
  if (sorted.length === 0) {
    return `<tr><td colspan="6" style="padding:16px;text-align:center;color:#9CA3AF;font-size:11px;">No issues recorded.</td></tr>`;
  }
  return sorted.map(i => {
    const s = severityColors(i.severity);
    return `
      <tr>
        <td style="padding:8px 12px;font-size:10px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${esc(i.category)}</td>
        <td style="padding:8px 12px;font-size:10px;color:#111827;font-weight:bold;border-bottom:1px solid #E5E7EB;">${esc(i.title)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">
          <span style="display:inline-block;padding:2px 8px;font-size:9px;font-weight:bold;color:${s.fg};background-color:${s.bg};border-radius:999px;">${s.label}</span>
        </td>
        <td style="padding:8px 12px;font-size:10px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${esc(i.estimatedImpact)}</td>
        <td style="padding:8px 12px;font-size:10px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${esc(i.difficulty)}</td>
        <td style="padding:8px 12px;font-size:10px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${esc(truncate(i.recommendation, 110))}</td>
      </tr>
    `;
  }).join('');
}

function renderCompetitorSection(reportData) {
  const c = reportData.competitorData;
  if (!c || c.error || !c.scores) {
    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:50px 20px;color:#9CA3AF;font-size:12px;">
          <div style="font-size:15px;font-weight:bold;color:#111827;margin-bottom:6px;">No competitor analyzed</div>
          <div>No competitor URL was provided for this audit.</div>
        </td></tr>
      </table>`;
  }

  const cats = ['seo', 'performance', 'security', 'accessibility', 'mobile'];
  const names = { seo: 'SEO', performance: 'Performance', security: 'Security', accessibility: 'Accessibility', mobile: 'Mobile' };
  const winCount = cats.filter(k => c.winner && c.winner[k] === 'you').length;

  const rows = cats.map(k => {
    const you = reportData.scores[k];
    const them = c.scores[k];
    const w = c.winner ? c.winner[k] : 'tie';
    const winCell = w === 'you'
      ? '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#16A34A;background-color:#DCFCE7;border-radius:999px;">You</span>'
      : w === 'competitor'
      ? '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#DC2626;background-color:#FEE2E2;border-radius:999px;">Competitor</span>'
      : '<span style="display:inline-block;padding:3px 12px;font-size:10px;font-weight:bold;color:#6B7280;background-color:#F3F4F6;border-radius:999px;">Tie</span>';
    return `
      <tr>
        <td style="padding:10px 14px;font-size:11px;color:#111827;font-weight:bold;border-bottom:1px solid #E5E7EB;">${names[k]}</td>
        <td style="padding:10px 14px;font-size:11px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${you} / 100</td>
        <td style="padding:10px 14px;font-size:11px;color:#4B5563;border-bottom:1px solid #E5E7EB;">${them} / 100</td>
        <td style="padding:10px 14px;border-bottom:1px solid #E5E7EB;">${winCell}</td>
      </tr>
    `;
  }).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:16px;">
      <tr>
        <td width="45%" style="padding:14px 18px;">
          <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Your site</div>
          <div style="font-size:12px;font-weight:bold;color:#111827;word-break:break-all;">${esc(reportData.websiteUrl)}</div>
        </td>
        <td width="10%" align="center" style="font-size:14px;font-weight:bold;color:#6C2BD9;">VS</td>
        <td width="45%" align="right" style="padding:14px 18px;">
          <div style="font-size:9px;color:#9CA3AF;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Competitor</div>
          <div style="font-size:12px;font-weight:bold;color:#111827;word-break:break-all;">${esc(c.url)}</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="1" bordercolor="#E5E7EB" style="border-collapse:collapse;">
      <thead>
        <tr style="background-color:#F9FAFB;">
          <th align="left" style="padding:10px 14px;font-size:10px;text-transform:uppercase;color:#6B7280;letter-spacing:0.8px;">Category</th>
          <th align="left" style="padding:10px 14px;font-size:10px;text-transform:uppercase;color:#6B7280;letter-spacing:0.8px;">Your Score</th>
          <th align="left" style="padding:10px 14px;font-size:10px;text-transform:uppercase;color:#6B7280;letter-spacing:0.8px;">Competitor</th>
          <th align="left" style="padding:10px 14px;font-size:10px;text-transform:uppercase;color:#6B7280;letter-spacing:0.8px;">Winner</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div style="text-align:center;margin-top:18px;font-size:14px;color:#4B5563;">
      You win <strong style="color:#6C2BD9;font-size:16px;">${winCount} out of 5</strong> categories.
    </div>
  `;
}

// =================================================================
// SETTINGS LOADER — always fetches fresh from the DB
// =================================================================
function loadAgencySettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// =================================================================
// MAIN
// =================================================================
async function generatePDF(reportData, agencySettingsArg) {
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  // Always pull fresh settings from the DB. The arg is only a convenience override.
  const agencySettings = agencySettingsArg || loadAgencySettings();

  let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const issues = reportData.issues || [];
  const recommendations = reportData.recommendations || [];
  const critCount = issues.filter(i => i.severity === 'critical').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;
  const passCount = issues.filter(i => i.severity === 'pass').length;

  const scores = reportData.scores || { seo: 0, performance: 0, security: 0, accessibility: 0, mobile: 0 };

  const vars = {
    // Agency branding — NO hardcoded fallbacks, straight from DB
    agencyLogo: esc(agencySettings.agency_logo),
    agencyName: esc(agencySettings.agency_name),
    agencyContact: esc(agencySettings.agency_contact),
    agencyWebsite: esc(agencySettings.agency_website),
    agencyPhone: esc(agencySettings.agency_phone),

    // Report meta
    websiteUrl: esc(reportData.websiteUrl || ''),
    competitorUrl: esc(reportData.competitorUrl || 'N/A'),
    auditDate: formatDate(reportData.auditedAt),
    grade: esc(reportData.grade || 'F'),
    gradeColor: gradeColor(reportData.grade),
    overallScore: reportData.overallScore ?? 0,
    preparedBy: esc(reportData.preparedBy || ''),

    // Category scores + colors
    seoScore: scores.seo ?? 0,
    performanceScore: scores.performance ?? 0,
    securityScore: scores.security ?? 0,
    accessibilityScore: scores.accessibility ?? 0,
    mobileScore: scores.mobile ?? 0,
    seoColor: scoreColor(scores.seo ?? 0),
    performanceColor: scoreColor(scores.performance ?? 0),
    securityColor: scoreColor(scores.security ?? 0),
    accessibilityColor: scoreColor(scores.accessibility ?? 0),
    mobileColor: scoreColor(scores.mobile ?? 0),
    seoBgColor: scoreBgColor(scores.seo ?? 0),
    performanceBgColor: scoreBgColor(scores.performance ?? 0),
    securityBgColor: scoreBgColor(scores.security ?? 0),
    accessibilityBgColor: scoreBgColor(scores.accessibility ?? 0),
    mobileBgColor: scoreBgColor(scores.mobile ?? 0),

    summaryText: esc(getSummaryText(scores)),

    topCriticalRowsHtml: renderTopCriticalRows(issues),
    quickWinsRowsHtml: renderQuickWinsRows(recommendations),
    seoChecksRowsHtml: renderSeoChecksRows(reportData.scrapeData && reportData.scrapeData.seo),
    coreWebVitalsRowsHtml: renderCoreWebVitalsRows(reportData.pagespeedData && reportData.pagespeedData.performance),
    securityChecksRowsHtml: renderSecurityChecksRows(reportData.scrapeData && reportData.scrapeData.security),
    accessibilityIssuesRowsHtml: renderAccessibilityIssuesRows(reportData.pagespeedData && reportData.pagespeedData.accessibility),
    mobileChecksRowsHtml: renderMobileChecksRows(reportData.pagespeedData && reportData.pagespeedData.mobile),
    issuesTableRowsHtml: renderIssuesTableRows(issues),
    criticalCount: critCount,
    warningCount: warnCount,
    passCount: passCount,
    competitorSectionHtml: renderCompetitorSection(reportData),
  };

  for (const [k, v] of Object.entries(vars)) {
    template = template.split(`{{${k}}}`).join(v == null ? '' : String(v));
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setContent(template, { waitUntil: 'networkidle0' });

    const filename = `audit-${sanitizeFilename(reportData.websiteUrl)}-${Date.now()}.pdf`;
    const fullPath = path.join(PDF_DIR, filename);

    await page.pdf({
      path: fullPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    return fullPath;
  } catch (err) {
    console.error('PDF generation failed:', err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { generatePDF, getSummaryText, loadAgencySettings };
