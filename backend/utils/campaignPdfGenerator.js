const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PDF_DIR = path.join(__dirname, '..', '..', 'pdfs');

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLongDate(d) {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function gradeColor(grade) {
  const g = String(grade || 'F').toUpperCase();
  return (
    {
      A: '#16A34A',
      B: '#0D9488',
      C: '#F59E0B',
      D: '#EA580C',
      F: '#DC2626',
      'N/A': '#6B7280',
    }[g] || '#DC2626'
  );
}

function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function distribution(leads) {
  const buckets = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const l of leads) {
    if (!l || typeof l.score !== 'number' || l.score <= 0) continue;
    buckets[gradeFor(l.score)] += 1;
  }
  return buckets;
}

function renderScoreBars(buckets) {
  const entries = [
    { label: 'A (90–100)', key: 'A' },
    { label: 'B (80–89)', key: 'B' },
    { label: 'C (70–79)', key: 'C' },
    { label: 'D (60–69)', key: 'D' },
    { label: 'F (<60)', key: 'F' },
  ];
  const max = Math.max(1, ...entries.map((e) => buckets[e.key] || 0));
  return entries
    .map((e) => {
      const count = buckets[e.key] || 0;
      const width = Math.round((count / max) * 100);
      const color = gradeColor(e.key);
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <div style="width:96px;font-weight:600;color:#374151;">${esc(e.label)}</div>
          <div style="flex:1;height:22px;background:#F3F4F6;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${width}%;background:${color};"></div>
          </div>
          <div style="width:36px;text-align:right;font-weight:600;color:#111827;">${count}</div>
        </div>`;
    })
    .join('');
}

function renderTopOpportunities(leads) {
  const scored = leads
    .filter((l) => l && typeof l.score === 'number' && l.score > 0)
    .slice()
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
  if (!scored.length) {
    return '<div style="color:#6B7280;font-style:italic;">No scored leads yet.</div>';
  }
  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#F3F4F6;">
          <th style="text-align:left;padding:8px 10px;color:#6B7280;font-weight:600;">#</th>
          <th style="text-align:left;padding:8px 10px;color:#6B7280;font-weight:600;">Business</th>
          <th style="text-align:left;padding:8px 10px;color:#6B7280;font-weight:600;">Website</th>
          <th style="text-align:center;padding:8px 10px;color:#6B7280;font-weight:600;">Score</th>
          <th style="text-align:center;padding:8px 10px;color:#6B7280;font-weight:600;">Grade</th>
        </tr>
      </thead>
      <tbody>
        ${scored
          .map(
            (l, idx) => `
          <tr style="border-bottom:1px solid #E5E7EB;">
            <td style="padding:10px;color:#374151;">${idx + 1}</td>
            <td style="padding:10px;color:#111827;font-weight:600;">${esc(l.businessName || '—')}</td>
            <td style="padding:10px;color:#6B7280;">${esc((l.website || '').replace(/^https?:\/\//, '').slice(0, 46))}</td>
            <td style="padding:10px;text-align:center;font-weight:700;color:#111827;">${l.score}</td>
            <td style="padding:10px;text-align:center;"><span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${gradeColor(l.grade)};color:#fff;font-weight:700;">${esc(l.grade)}</span></td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function renderSentTable(leads) {
  if (!leads.length) {
    return '<div style="color:#6B7280;font-style:italic;">No leads processed.</div>';
  }
  return `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#6C2BD9;color:#fff;">
          <th style="text-align:left;padding:8px 10px;">#</th>
          <th style="text-align:left;padding:8px 10px;">Business</th>
          <th style="text-align:left;padding:8px 10px;">Website</th>
          <th style="text-align:left;padding:8px 10px;">Email</th>
          <th style="text-align:center;padding:8px 10px;">Score</th>
          <th style="text-align:center;padding:8px 10px;">Grade</th>
          <th style="text-align:center;padding:8px 10px;">Status</th>
        </tr>
      </thead>
      <tbody>
        ${leads
          .map(
            (l, idx) => `
          <tr style="background:${idx % 2 === 0 ? '#FFFFFF' : '#F9FAFB'};border-bottom:1px solid #E5E7EB;">
            <td style="padding:8px 10px;color:#6B7280;">${idx + 1}</td>
            <td style="padding:8px 10px;color:#111827;font-weight:600;">${esc(l.businessName || '—')}</td>
            <td style="padding:8px 10px;color:#6B7280;">${esc((l.website || '').replace(/^https?:\/\//, '').slice(0, 40))}</td>
            <td style="padding:8px 10px;color:#6B7280;">${esc(l.email || '—')}</td>
            <td style="padding:8px 10px;text-align:center;font-weight:700;">${l.score || '—'}</td>
            <td style="padding:8px 10px;text-align:center;"><span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${gradeColor(l.grade)};color:#fff;font-weight:700;">${esc(l.grade)}</span></td>
            <td style="padding:8px 10px;text-align:center;color:${l.emailSent ? '#16A34A' : '#DC2626'};font-weight:600;">${l.emailSent ? '✓ Sent' : '✗ Failed'}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function buildHtml(data) {
  const {
    campaignName,
    niche,
    location,
    date,
    stats,
    leads = [],
    agencySettings = {},
  } = data;

  const agencyName = agencySettings.agency_name || 'AuditPro';
  const agencyLogo = agencySettings.agency_logo || '';
  const agencyWebsite = agencySettings.agency_website || '';
  const buckets = distribution(leads);

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(campaignName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; background: #fff; }
  .page { padding: 48px; min-height: 1100px; position: relative; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 48px; margin: 0 0 6px 0; font-weight: 800; color: #111827; }
  h2 { font-size: 22px; margin: 0 0 16px 0; color: #111827; font-weight: 700; }
  h3 { font-size: 16px; margin: 0 0 10px 0; color: #374151; font-weight: 600; }
  .gradient-text { background: linear-gradient(135deg, #6C2BD9 0%, #8B5CF6 100%); -webkit-background-clip: text; background-clip: text; color: transparent; font-size: 32px; font-weight: 700; margin: 12px 0 24px 0; }
  .info-row { display: flex; gap: 12px; margin-bottom: 28px; flex-wrap: wrap; }
  .info-box { flex: 1; min-width: 180px; padding: 14px 16px; background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 8px; }
  .info-label { font-size: 12px; color: #6B7280; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
  .info-value { font-size: 15px; color: #111827; font-weight: 600; }
  .stat-row { display: flex; gap: 12px; margin-top: 28px; }
  .stat-box { flex: 1; background: linear-gradient(135deg, #6C2BD9 0%, #8B5CF6 100%); color: #fff; border-radius: 12px; padding: 20px; text-align: center; }
  .stat-num { font-size: 36px; font-weight: 800; line-height: 1; }
  .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-top: 6px; opacity: 0.9; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 28px; }
  .stat-card { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 10px; padding: 18px 20px; }
  .stat-card .n { font-size: 28px; font-weight: 800; color: #111827; }
  .stat-card .l { font-size: 13px; color: #6B7280; margin-top: 4px; }
  .footer { position: absolute; bottom: 24px; left: 48px; right: 48px; font-size: 11px; color: #9CA3AF; display: flex; justify-content: space-between; border-top: 1px solid #E5E7EB; padding-top: 10px; }
  .agency-brand { display: flex; align-items: center; gap: 10px; }
  .agency-brand img { max-height: 36px; }
</style></head>
<body>

  <div class="page">
    <div class="agency-brand">
      ${agencyLogo ? `<img src="${esc(agencyLogo)}" alt="logo"/>` : ''}
      <div style="font-weight:700;color:#6C2BD9;">${esc(agencyName)}</div>
    </div>
    <div style="margin-top:48px;">
      <h1>Campaign Report</h1>
      <div class="gradient-text">${esc(campaignName)}</div>
    </div>
    <div class="info-row">
      <div class="info-box"><div class="info-label">📍 Location</div><div class="info-value">${esc(location)}</div></div>
      <div class="info-box"><div class="info-label">🎯 Niche</div><div class="info-value">${esc(niche)}</div></div>
      <div class="info-box"><div class="info-label">📅 Date</div><div class="info-value">${esc(formatLongDate(date))}</div></div>
    </div>
    <div class="stat-row">
      <div class="stat-box"><div class="stat-num">${stats.leadsFound || 0}</div><div class="stat-label">Found</div></div>
      <div class="stat-box"><div class="stat-num">${stats.emailsSent || 0}</div><div class="stat-label">Emails</div></div>
      <div class="stat-box"><div class="stat-num">${stats.avgScore || 0}</div><div class="stat-label">Avg Score</div></div>
    </div>
    <div class="footer"><span>${esc(agencyName)}</span><span>${esc(agencyWebsite)}</span></div>
  </div>

  <div class="page">
    <h2>Campaign Overview</h2>
    <div class="stat-grid">
      <div class="stat-card"><div class="n">${stats.leadsFound || 0}</div><div class="l">Leads Found</div></div>
      <div class="stat-card"><div class="n">${stats.emailsSent || 0}</div><div class="l">Emails Sent</div></div>
      <div class="stat-card"><div class="n">${stats.avgScore || 0}/100</div><div class="l">Avg Website Score</div></div>
      <div class="stat-card"><div class="n">${stats.followUpsScheduled || 0}</div><div class="l">Follow-ups Scheduled</div></div>
    </div>
    <h3>Score Distribution</h3>
    <div style="margin-bottom:28px;">${renderScoreBars(buckets)}</div>
    <h3>Top Opportunities</h3>
    <p style="color:#6B7280;font-size:13px;margin:0 0 12px 0;">These businesses have the lowest scores — highest need for your services.</p>
    ${renderTopOpportunities(leads)}
    <div class="footer"><span>${esc(agencyName)}</span><span>Page 2</span></div>
  </div>

  <div class="page">
    <h2>Emails Sent (${(leads || []).filter((l) => l.emailSent).length})</h2>
    ${renderSentTable(leads)}
    <div class="footer"><span>Generated by ${esc(agencyName)}</span><span>Page 3</span></div>
  </div>

</body></html>`;
}

async function generateCampaignPDF(data) {
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
  const filename = `campaign-${data.campaignId || Date.now()}.pdf`;
  const outPath = path.join(PDF_DIR, filename);

  const html = buildHtml(data);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    return outPath;
  } catch (err) {
    console.error('Campaign PDF generation failed:', err);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { generateCampaignPDF };
