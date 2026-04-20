// =================================================================
// AuditPro — Single audit module
// Depends on: app.js (Auth, API, Toast, Utils)
// =================================================================

let currentReport = null;
let isAuditing = false;
let _loadingTimer = null;

const LOADING_MESSAGES = [
  'Fetching website data...',
  'Running PageSpeed analysis...',
  'Checking SEO structure...',
  'Analyzing security headers...',
  'Testing mobile performance...',
  'Comparing with competitor...',
  'Calculating scores...',
  'Generating recommendations...',
  'Building your report...',
];

// ---------- Step management ----------
function showStep(stepNumber) {
  [1, 2, 3].forEach(n => {
    const el = document.getElementById(`auditStep${n}`);
    if (el) el.style.display = n === stepNumber ? 'block' : 'none';
  });
  document.querySelectorAll('[data-audit-step]').forEach(el => {
    const s = parseInt(el.dataset.auditStep, 10);
    el.classList.toggle('active', s === stepNumber);
    el.classList.toggle('done', s < stepNumber);
    el.classList.toggle('pending', s > stepNumber);
  });
}

// ---------- Loading animation ----------
function getLoadingStepEls() {
  const direct = document.querySelectorAll('[data-loading-step]');
  if (direct.length) return direct;
  return document.querySelectorAll('#runningSteps .running-step, .running-steps .running-step');
}

function showLoadingStep(index) {
  const steps = getLoadingStepEls();
  steps.forEach((el, i) => {
    if (i < index) { el.classList.add('done'); el.classList.remove('active'); }
    else if (i === index) { el.classList.add('active'); el.classList.remove('done'); }
    else { el.classList.remove('active', 'done'); }
  });

  // If the audit card exposes a single message slot, update its text.
  const msgEl = document.getElementById('loadingMessage');
  if (msgEl) msgEl.textContent = LOADING_MESSAGES[index] || 'Working...';
}

function runLoadingAnimation() {
  let i = 0;
  showLoadingStep(0);
  _loadingTimer = setInterval(() => {
    i = Math.min(i + 1, LOADING_MESSAGES.length - 1);
    showLoadingStep(i);
  }, 4000);
}

function stopLoadingAnimation() {
  if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
  const steps = getLoadingStepEls();
  steps.forEach(el => { el.classList.remove('active'); el.classList.add('done'); });
}

// ---------- Audit submission ----------
async function submitAudit(websiteUrl, competitorUrl, clientName, clientEmail) {
  if (!websiteUrl || !Utils.isValidUrl(websiteUrl)) {
    Toast.error('Please enter a valid website URL');
    return;
  }
  if (competitorUrl && !Utils.isValidUrl(competitorUrl)) {
    Toast.error('Competitor URL is not valid');
    return;
  }

  websiteUrl = Utils.normalizeUrl(websiteUrl);
  competitorUrl = competitorUrl ? Utils.normalizeUrl(competitorUrl) : undefined;

  isAuditing = true;
  showStep(2);
  runLoadingAnimation();

  try {
    const res = await API.post('/audit/single', {
      websiteUrl,
      competitorUrl,
      clientName: clientName || undefined,
      clientEmail: clientEmail || undefined,
    });
    stopLoadingAnimation();
    currentReport = res;
    showStep(3);
    renderReport(res);
  } catch (err) {
    stopLoadingAnimation();
    showStep(1);
    Toast.error(`Audit failed: ${err.message}`);
  } finally {
    isAuditing = false;
  }
}

// ---------- Report rendering ----------
function renderReport(report) {
  const container = document.getElementById('auditResultContainer') || document.getElementById('auditStep3');
  if (!container) return;

  const scores = report.scores || {};
  const grade = report.grade || 'F';

  const compHtml = renderCompetitorBlock(report, scores);
  const categoryHtml = renderCategoryRow(scores);
  const issuesHtml = renderIssuesCard(report.issues || []);
  const recsHtml = renderRecommendationsCard(report.recommendations || []);

  container.innerHTML = `
    <div class="card text-center" style="margin-bottom:20px;">
      <div class="flex items-center justify-center gap-24" style="flex-wrap:wrap;">
        <div id="overallScoreSlot">${Utils.buildScoreCircleSVG(0, 140, 10)}</div>
        <div>
          <div class="stat-label">Grade</div>
          <span class="badge ${Utils.getGradeBadgeClass(grade)}" style="font-size:28px;padding:12px 24px;margin-top:8px;">${Utils.escapeHtml(grade)}</span>
          <div class="form-hint mt-8">${Utils.escapeHtml(report.websiteUrl || '')}</div>
        </div>
      </div>
    </div>
    <div class="stats-grid" id="categoryScoresRow" style="grid-template-columns:repeat(5,1fr);">${categoryHtml}</div>
    ${compHtml}
    ${issuesHtml}
    ${recsHtml}
    <div class="card flex gap-12" style="flex-wrap:wrap;">
      <button class="btn btn-primary" id="sendReportBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Report</button>
      <button class="btn btn-secondary" id="downloadPdfBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download PDF</button>
      <button class="btn btn-ghost" id="newAuditBtn">New Audit</button>
    </div>
  `;

  animateOverallScore(report.overallScore || 0);

  document.querySelectorAll('#issueTabs button, [data-severity-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-severity-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sev = btn.dataset.severityTab || btn.dataset.sev || 'all';
      filterIssues(report.issues || [], sev);
    });
  });

  const sendBtn = document.getElementById('sendReportBtn');
  const dlBtn = document.getElementById('downloadPdfBtn');
  const newBtn = document.getElementById('newAuditBtn');
  if (sendBtn) sendBtn.addEventListener('click', sendReport);
  if (dlBtn) dlBtn.addEventListener('click', downloadPDF);
  if (newBtn) newBtn.addEventListener('click', resetAuditForm);
}

function animateOverallScore(target) {
  const slot = document.getElementById('overallScoreSlot');
  if (!slot) return;
  const start = performance.now();
  const duration = 1000;
  function tick(now) {
    const pct = Math.min(1, (now - start) / duration);
    const val = Math.round(pct * target);
    slot.innerHTML = Utils.buildScoreCircleSVG(val, 140, 10);
    if (pct < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderCategoryRow(scores) {
  const cats = [
    { key: 'seo', label: 'SEO' },
    { key: 'performance', label: 'Performance' },
    { key: 'security', label: 'Security' },
    { key: 'accessibility', label: 'Accessibility' },
    { key: 'mobile', label: 'Mobile' },
  ];
  return cats.map((c, i) => {
    const val = scores[c.key] ?? 0;
    return `
      <div class="card stat-card text-center" style="animation-delay:${i * 80}ms;">
        <div class="stat-label mb-8">${c.label}</div>
        <div class="flex justify-center mb-8">${Utils.buildScoreCircleSVG(val, 60, 5)}</div>
        <div class="form-hint">${val}/100</div>
      </div>
    `;
  }).join('');
}

function renderCompetitorBlock(report, scores) {
  const comp = report.competitorData;
  if (!comp || !comp.scores) return '';
  const cats = ['seo','performance','security','accessibility','mobile'];
  const labels = { seo:'SEO', performance:'Performance', security:'Security', accessibility:'Accessibility', mobile:'Mobile' };
  const winCount = cats.filter(k => comp.winner && comp.winner[k] === 'you').length;

  const rows = cats.map(k => {
    const you = scores[k] ?? 0;
    const them = comp.scores[k] ?? 0;
    const w = comp.winner ? comp.winner[k] : 'tie';
    const winHtml = w === 'you'
      ? '<span class="badge badge-pass">You</span>'
      : w === 'competitor'
      ? '<span class="badge badge-critical">Competitor</span>'
      : '<span class="badge badge-gray">Tie</span>';
    return `<tr><td>${labels[k]}</td><td>${you}/100</td><td>${them}/100</td><td>${winHtml}</td></tr>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <div class="card-title">Competitor Comparison</div>
        <span class="badge badge-purple">You win ${winCount}/5</span>
      </div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Category</th><th>You</th><th>${Utils.escapeHtml(comp.url || 'Competitor')}</th><th>Winner</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderIssuesCard(issues) {
  const counts = { critical: 0, warning: 0, pass: 0 };
  issues.forEach(i => { if (counts[i.severity] !== undefined) counts[i.severity]++; });
  return `
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header"><div class="card-title">Issues</div></div>
      <div class="tabs" style="margin-bottom:16px;">
        <button class="tab active" data-severity-tab="all">All (${issues.length})</button>
        <button class="tab" data-severity-tab="critical">Critical (${counts.critical})</button>
        <button class="tab" data-severity-tab="warning">Warning (${counts.warning})</button>
        <button class="tab" data-severity-tab="pass">Passed (${counts.pass})</button>
      </div>
      <div class="table-wrapper" id="issuesTableSlot">${renderIssuesTable(issues)}</div>
    </div>
  `;
}

function renderIssuesTable(issues) {
  if (!issues.length) {
    return `<div class="empty-state"><div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div><div class="empty-title">Nothing to show</div><div class="empty-desc">No issues match this filter.</div></div>`;
  }
  const rows = issues.map(i => `
    <tr>
      <td>${Utils.escapeHtml(i.category)}</td>
      <td>
        <div style="font-weight:600;color:var(--text-heading);">${Utils.escapeHtml(i.title)}</div>
        <div class="form-hint">${Utils.escapeHtml(i.description)}</div>
      </td>
      <td><span class="badge ${Utils.getSeverityClass(i.severity)}">${Utils.escapeHtml(i.severity)}</span></td>
      <td>${Utils.escapeHtml(i.estimatedImpact)}</td>
      <td>${Utils.escapeHtml(i.difficulty)}</td>
      <td style="max-width:260px;">${Utils.escapeHtml(i.recommendation)}</td>
    </tr>
  `).join('');
  return `<table><thead><tr><th>Category</th><th>Issue</th><th>Severity</th><th>Impact</th><th>Difficulty</th><th>Fix</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function filterIssues(allIssues, severity) {
  const filtered = severity === 'all' ? allIssues : allIssues.filter(i => i.severity === severity);
  const slot = document.getElementById('issuesTableSlot');
  if (slot) slot.innerHTML = renderIssuesTable(filtered);
}

function renderRecommendationsCard(recs) {
  if (!recs.length) return '';
  const impactRank = { High: 0, Medium: 1, Low: 2 };
  const sorted = recs.slice().sort((a, b) => (impactRank[a.estimatedImpact] ?? 3) - (impactRank[b.estimatedImpact] ?? 3));
  const items = sorted.slice(0, 8).map(r => `
    <div class="card card-sm" style="border-left:4px solid var(--primary);margin-bottom:10px;">
      <div class="flex justify-between gap-8" style="flex-wrap:wrap;margin-bottom:6px;">
        <span class="badge badge-purple">${Utils.escapeHtml(r.category)}</span>
        <div class="flex gap-4">
          <span class="badge badge-warning">${Utils.escapeHtml(r.estimatedImpact)} impact</span>
          <span class="badge badge-gray">${Utils.escapeHtml(r.difficulty)}</span>
        </div>
      </div>
      <h4 style="margin-bottom:4px;">${Utils.escapeHtml(r.title)}</h4>
      <div class="form-hint mb-8">${Utils.escapeHtml(r.description)}</div>
      <div><strong>How to fix:</strong> ${Utils.escapeHtml(r.recommendation)}</div>
    </div>
  `).join('');

  return `
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header"><div class="card-title">Top Recommendations</div></div>
      ${items}
    </div>
  `;
}

function resetAuditForm() {
  currentReport = null;
  ['naWebsite', 'naCompetitor', 'naClientName', 'naClientEmail'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showStep(1);
}

// ---------- Send report ----------
async function sendReport() {
  if (!currentReport || !currentReport.reportId) {
    Toast.error('No report to send');
    return;
  }
  const clientEmailInput = document.getElementById('naClientEmail');
  const clientEmail = (clientEmailInput && clientEmailInput.value.trim()) || (currentReport && currentReport.clientEmail);
  if (!clientEmail) {
    Toast.error('Add a client email to the audit before sending');
    return;
  }
  if (!confirm(`Send report to ${clientEmail}?`)) return;

  const btn = document.getElementById('sendReportBtn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  try {
    await API.post(`/email/send/${currentReport.reportId}`);
    Toast.success(`Report sent to ${clientEmail}`);
  } catch (err) {
    if (/smtp|configure|email setting/i.test(err.message || '')) {
      Toast.error('Please configure your email settings in Profile first');
    } else {
      Toast.error(err.message || 'Send failed');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  }
}

// ---------- Download PDF ----------
// Open the PDF in a new tab. Using window.open + a JWT query param bypasses
// Chrome's "insecure download blocked" warning that fires on blob downloads
// over plain HTTP.
function downloadPDF() {
  if (!currentReport || !currentReport.reportId) return;
  const token = encodeURIComponent(Auth.getToken() || '');
  window.open(`${CONFIG.API_BASE}/reports/${currentReport.reportId}/pdf?token=${token}`, '_blank');
}

// ---------- Prefill from query string ----------
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get('url');
  if (prefill) {
    const input = document.getElementById('naWebsite');
    if (input) input.value = prefill;
  }

  // Wire the "Run Audit" button if present
  const runBtn = document.getElementById('naRunBtn');
  if (runBtn) {
    runBtn.addEventListener('click', () => {
      const w = (document.getElementById('naWebsite')     || {}).value || '';
      const c = (document.getElementById('naCompetitor')  || {}).value || '';
      const n = (document.getElementById('naClientName')  || {}).value || '';
      const e = (document.getElementById('naClientEmail') || {}).value || '';
      submitAudit(w.trim(), c.trim(), n.trim(), e.trim());
    });
  }
});
