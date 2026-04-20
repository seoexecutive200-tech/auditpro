// =================================================================
// AuditPro — Reports module
// Depends on: app.js (Auth, API, Toast, Utils, Skeleton, Modal)
// =================================================================

let currentPage = 1;
let totalPages = 1;
let filters = { search: '', dateFrom: '', dateTo: '', grade: '', userId: '' };

async function loadReports() {
  const wrap = document.getElementById('reportsTableWrap');
  if (wrap) wrap.innerHTML = `<div style="padding:24px;">${Skeleton.text('100%')}${Skeleton.text('100%')}${Skeleton.text('100%')}</div>`;

  const qs = new URLSearchParams({ page: currentPage, limit: 10 });
  if (filters.search) qs.set('search', filters.search);
  if (filters.dateFrom) qs.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) qs.set('dateTo', filters.dateTo);

  try {
    const res = await API.get(`/reports?${qs.toString()}`);
    let reports = res.reports || [];
    if (filters.grade) reports = reports.filter(r => r.grade === filters.grade);
    if (filters.userId) reports = reports.filter(r => r.user_id === filters.userId);

    totalPages = res.pages || 1;
    renderReportsTable(reports);
    renderPagination(res.total || reports.length, res.page || 1, res.pages || 1);
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div class="empty-state"><div class="empty-title">Failed to load reports</div><div class="empty-desc">${Utils.escapeHtml(err.message)}</div></div>`;
  }
}

function renderReportsTable(reports) {
  const wrap = document.getElementById('reportsTableWrap');
  const cardsWrap = document.getElementById('reportsCardsWrap');
  if (!wrap) return;

  if (!reports.length) {
    const empty = `
      <div class="empty-state">
        <div class="empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
        <div class="empty-title">No reports yet</div>
        <div class="empty-desc">Run your first audit to see it here.</div>
      </div>`;
    wrap.innerHTML = empty;
    if (cardsWrap) cardsWrap.innerHTML = empty;
    return;
  }

  // Mobile cards render
  if (cardsWrap) cardsWrap.innerHTML = renderReportsCardsHtml(reports, Auth.isAdmin());
  wireReportCardClicks(cardsWrap);

  const isAdmin = Auth.isAdmin();
  const rows = reports.map(r => {
    const dots = categoryDots({
      seo: r.seo_score,
      performance: r.performance_score,
      security: r.security_score,
      accessibility: r.accessibility_score,
      mobile: r.mobile_score,
    });
    const sentIcon = r.email_sent
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<span style="color:var(--text-muted);">—</span>';

    return `
      <tr data-report-row="${r.id}">
        <td>
          <div style="font-weight:600;color:var(--text-heading);">${Utils.escapeHtml(Utils.truncateUrl(r.website_url, 40))}</div>
        </td>
        <td>
          <div>${Utils.escapeHtml(r.client_name || '—')}</div>
          <div class="form-hint">${Utils.escapeHtml(r.client_email || '')}</div>
        </td>
        <td>${Utils.buildScoreCircleSVG(r.overall_score || 0, 44, 4)}</td>
        <td><span class="badge ${Utils.getGradeBadgeClass(r.grade)}">${Utils.escapeHtml(r.grade || 'F')}</span></td>
        <td>${dots}</td>
        <td>${sentIcon}</td>
        <td>${Utils.formatDate(r.created_at)}</td>
        ${isAdmin ? `<td>${Utils.escapeHtml(r.user_name || '—')}</td>` : ''}
        <td>
          <div class="table-actions">
            <button class="btn btn-icon btn-secondary" title="View" data-action="view" data-id="${r.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button class="btn btn-icon btn-secondary" title="Resend" data-action="resend" data-id="${r.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
            <button class="btn btn-icon btn-secondary" title="Download" data-action="download" data-id="${r.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
            ${isAdmin ? `<button class="btn btn-icon btn-danger" title="Delete" data-action="delete" data-id="${r.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Website</th><th>Client</th><th>Score</th><th>Grade</th><th>Categories</th>
            <th>Sent</th><th>Date</th>${isAdmin ? '<th>User</th>' : ''}<th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  wrap.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'view') viewReport(id);
      if (action === 'resend') resendEmail(id);
      if (action === 'download') downloadReport(id);
      if (action === 'delete') deleteReport(id);
    });
  });
}

function categoryDots(scores) {
  const cats = ['seo', 'performance', 'security', 'accessibility', 'mobile'];
  return `<div class="flex gap-4">${cats.map(k => {
    const v = scores[k] || 0;
    const color = Utils.getScoreColor(v);
    return `<span title="${k}: ${v}" style="width:20px;height:20px;border-radius:50%;background:${color};display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#FFFFFF;">${v}</span>`;
  }).join('')}</div>`;
}

// Mobile cards variant — shows every report as a tappable card
function renderReportsCardsHtml(reports, isAdmin) {
  return reports.map(r => {
    const score = r.overall_score || 0;
    const color = Utils.getScoreColor(score);
    const gradeClass = Utils.getGradeBadgeClass(r.grade);
    const adminDelete = isAdmin
      ? `<button data-action="delete" data-id="${r.id}" style="background:#FEE2E2;color:#DC2626;">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
         </button>`
      : '';
    return `
      <div class="report-card" data-view-id="${r.id}">
        <div class="rc-top">
          <div class="rc-info">
            <div class="rc-url">${Utils.escapeHtml(Utils.truncateUrl(r.website_url, 40))}</div>
            <div class="rc-client">${Utils.escapeHtml(r.client_name || r.client_email || '—')}</div>
            <div class="rc-meta">
              <span class="badge-grade grade-${Utils.escapeHtml(r.grade || 'F')}">${Utils.escapeHtml(r.grade || 'F')}</span>
              <span>${Utils.formatDate(r.created_at)}</span>
              ${r.email_sent ? '<span style="color:#16A34A;">✓ Sent</span>' : ''}
            </div>
          </div>
          <div class="rc-score" style="border-color:${color};">
            <div class="num" style="color:${color};">${score}</div>
            <div class="lbl">/100</div>
          </div>
        </div>
        <div class="rc-actions">
          <button data-action="view" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            View
          </button>
          <button data-action="download" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            PDF
          </button>
          <button data-action="resend" data-id="${r.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Resend
          </button>
          ${adminDelete}
        </div>
      </div>
    `;
  }).join('');
}

function wireReportCardClicks(container) {
  if (!container) return;
  container.querySelectorAll('.report-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't navigate if user tapped an action button
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const id = actionBtn.dataset.id;
        const action = actionBtn.dataset.action;
        if (action === 'view') viewReport(id);
        if (action === 'download') downloadReport(id);
        if (action === 'resend') resendEmail(id);
        if (action === 'delete') deleteReport(id);
        return;
      }
      // Tap anywhere else on the card → open report
      const id = card.dataset.viewId;
      if (id) viewReport(id);
    });
  });
}

// ---------- Actions ----------
async function viewReport(reportId) {
  try {
    const r = await API.get(`/reports/${reportId}`);
    const scores = {
      seo: r.seo_score, performance: r.performance_score, security: r.security_score,
      accessibility: r.accessibility_score, mobile: r.mobile_score,
    };

    const issues = (r.issues || []).slice(0, 8);
    const recs = (r.recommendations || []).slice(0, 5);
    const comp = r.competitorData;

    const scoreCardsHtml = ['seo','performance','security','accessibility','mobile'].map(k => `
      <div class="report-detail-card">
        <div class="lbl">${k.charAt(0).toUpperCase() + k.slice(1)}</div>
        <div class="num" style="color:${Utils.getScoreColor(scores[k] || 0)};">${scores[k] || 0}</div>
      </div>
    `).join('');

    const issuesHtml = issues.length
      ? issues.map(i => `
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;border-left:4px solid ${i.severity === 'critical' ? '#DC2626' : i.severity === 'warning' ? '#F59E0B' : '#16A34A'};">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.6px;font-weight:700;">${Utils.escapeHtml(i.category)}</div>
            <div style="font-size:13px;color:var(--text);font-weight:700;margin:3px 0 4px 0;">${Utils.escapeHtml(i.title)}</div>
            <div style="font-size:11px;color:var(--text-body);">${Utils.escapeHtml(i.description)}</div>
          </div>
        `).join('')
      : '<div style="color:var(--muted);font-size:12px;text-align:center;padding:12px;">No issues recorded.</div>';

    const recsHtml = recs.length
      ? recs.map(rec => `
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;border-left:4px solid var(--primary);background:var(--section);">
            <div style="font-size:13px;color:var(--text);font-weight:700;margin-bottom:4px;">${Utils.escapeHtml(rec.title)}</div>
            <div style="font-size:11px;color:var(--text-body);">${Utils.escapeHtml(rec.recommendation)}</div>
          </div>
        `).join('')
      : '';

    const compHtml = comp && comp.scores
      ? `<h4 style="font-size:13px;font-weight:700;color:var(--text);margin:18px 0 10px 0;">Competitor Comparison</h4>
         <div class="vs-row" style="display:flex;gap:10px;background:var(--section);border:1px solid var(--border);border-radius:10px;padding:12px;">
           <div style="flex:1;min-width:0;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;">You</div><div style="font-size:13px;font-weight:700;color:var(--text);word-break:break-all;">${Utils.escapeHtml(r.website_url)}</div></div>
           <div class="vs-divider" style="font-weight:800;color:var(--primary);align-self:center;">VS</div>
           <div style="flex:1;min-width:0;"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;">Competitor</div><div style="font-size:13px;font-weight:700;color:var(--text);word-break:break-all;">${Utils.escapeHtml(comp.url)}</div></div>
         </div>`
      : '';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop show';
    backdrop.id = 'reportDetailModal';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(17,24,39,0.55);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;';
    backdrop.innerHTML = `
      <div class="modal" style="background:var(--card);border-radius:16px;width:100%;max-width:640px;max-height:92vh;overflow:hidden;border:1px solid var(--border);display:flex;flex-direction:column;">
        <div class="modal-head" style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;">
          <button class="action-btn" id="reportBackBtn" style="width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--text-body);background:var(--section);border:none;cursor:pointer;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          </button>
          <div style="flex:1;min-width:0;">
            <div style="font-size:15px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${Utils.escapeHtml(Utils.truncateUrl(r.website_url, 50))}</div>
            <div style="font-size:11px;color:var(--muted);">${Utils.formatDate(r.created_at)} — Score ${r.overall_score}/100</div>
          </div>
          <span class="badge-grade grade-${Utils.escapeHtml(r.grade || 'F')}" style="width:36px;height:36px;">${Utils.escapeHtml(r.grade || 'F')}</span>
        </div>
        <div class="modal-body" style="padding:20px;flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;">
          <div class="report-detail-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:18px;">
            ${scoreCardsHtml}
          </div>
          ${compHtml}
          <h4 style="font-size:13px;font-weight:700;color:var(--text);margin:18px 0 10px 0;">Issues</h4>
          ${issuesHtml}
          ${recs.length ? `<h4 style="font-size:13px;font-weight:700;color:var(--text);margin:18px 0 10px 0;">Top Recommendations</h4>${recsHtml}` : ''}
        </div>
        <div class="modal-foot" style="padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;background:var(--card);">
          <button class="btn btn-outline" id="reportCloseBtn">Close</button>
          <button class="btn btn-outline" id="reportDlBtn">Download PDF</button>
          <button class="btn btn-primary" id="reportResendBtn">Resend Email</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    const close = () => {
      backdrop.remove();
      document.body.style.overflow = '';
    };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('#reportBackBtn').addEventListener('click', close);
    backdrop.querySelector('#reportCloseBtn').addEventListener('click', close);
    backdrop.querySelector('#reportDlBtn').addEventListener('click', () => downloadReport(r.id));
    backdrop.querySelector('#reportResendBtn').addEventListener('click', () => resendEmail(r.id));
  } catch (err) {
    Toast.error(err.message);
  }
}

async function resendEmail(reportId) {
  if (!confirm('Resend this report to the client?')) return;
  try {
    await API.post(`/reports/${reportId}/resend`);
    Toast.success('Report resent');
  } catch (err) {
    Toast.error(err.message);
  }
}

function downloadReport(reportId) {
  // Open in a new tab with the token on the query string. Bypasses Chrome's
  // "insecure download" warning that hits blob downloads on plain HTTP.
  const token = encodeURIComponent(Auth.getToken() || '');
  window.open(`${CONFIG.API_BASE}/reports/${reportId}/pdf?token=${token}`, '_blank');
}

async function deleteReport(reportId) {
  if (!confirm('Delete this report? This cannot be undone.')) return;
  try {
    await API.delete(`/reports/${reportId}`);
    const row = document.querySelector(`[data-report-row="${reportId}"]`);
    if (row) {
      row.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      row.style.opacity = '0';
      row.style.transform = 'translateX(20px)';
      setTimeout(() => row.remove(), 300);
    }
    Toast.success('Report deleted');
  } catch (err) {
    Toast.error(err.message);
  }
}

// ---------- Pagination ----------
function renderPagination(total, page, pages) {
  const el = document.getElementById('reportsPagination');
  if (!el) return;
  const from = total === 0 ? 0 : (page - 1) * 10 + 1;
  const to = Math.min(page * 10, total);

  const maxButtons = 5;
  let startPage = Math.max(1, page - Math.floor(maxButtons / 2));
  let endPage = Math.min(pages, startPage + maxButtons - 1);
  if (endPage - startPage < maxButtons - 1) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  const pageBtns = [];
  for (let p = startPage; p <= endPage; p++) {
    pageBtns.push(`<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`);
  }

  el.innerHTML = `
    <div class="pagination-info">Showing ${from}–${to} of ${total} reports</div>
    <div class="pagination-controls">
      <button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="prev">‹</button>
      ${pageBtns.join('')}
      <button class="page-btn" ${page >= pages ? 'disabled' : ''} data-page="next">›</button>
    </div>
  `;

  el.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const p = btn.dataset.page;
      if (p === 'prev') currentPage = Math.max(1, currentPage - 1);
      else if (p === 'next') currentPage = Math.min(totalPages, currentPage + 1);
      else currentPage = parseInt(p, 10);
      loadReports();
    });
  });
}

// ---------- Filters ----------
const debouncedSearch = Utils.debounce(() => { currentPage = 1; loadReports(); }, 400);

function initReportsFilters() {
  const searchEl = document.getElementById('repSearch');
  const fromEl = document.getElementById('repFrom');
  const toEl = document.getElementById('repTo');
  const gradeEl = document.getElementById('repGrade');
  const resetBtn = document.getElementById('repResetBtn');
  const applyBtn = document.getElementById('repApplyBtn');

  if (searchEl) {
    searchEl.addEventListener('input', (e) => { filters.search = e.target.value.trim(); debouncedSearch(); });
  }
  if (fromEl) fromEl.addEventListener('change', (e) => { filters.dateFrom = e.target.value; currentPage = 1; loadReports(); });
  if (toEl) toEl.addEventListener('change', (e) => { filters.dateTo = e.target.value; currentPage = 1; loadReports(); });
  if (gradeEl) gradeEl.addEventListener('change', (e) => { filters.grade = e.target.value; currentPage = 1; loadReports(); });
  if (applyBtn) applyBtn.addEventListener('click', () => { currentPage = 1; loadReports(); });
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      filters = { search: '', dateFrom: '', dateTo: '', grade: '', userId: '' };
      if (searchEl) searchEl.value = '';
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      if (gradeEl) gradeEl.value = '';
      currentPage = 1;
      loadReports();
    });
  }
}

// ---------- Export CSV ----------
async function exportCSV() {
  try {
    const res = await API.get('/reports?limit=9999');
    const reports = res.reports || [];
    const header = ['website', 'client_name', 'client_email', 'overall_score', 'grade', 'seo', 'performance', 'security', 'accessibility', 'mobile', 'email_sent', 'created_at'];
    const rows = reports.map(r => [
      r.website_url, r.client_name || '', r.client_email || '',
      r.overall_score, r.grade,
      r.seo_score, r.performance_score, r.security_score, r.accessibility_score, r.mobile_score,
      r.email_sent ? 'yes' : 'no',
      r.created_at,
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    Utils.downloadFile(url, 'auditpro-reports.csv');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    Toast.success('Reports exported');
  } catch (err) {
    Toast.error(err.message);
  }
}

// Expose view/resend/download/delete globally so inline onclick handlers in
// the modal still work after reports.js is loaded.
window.viewReport = viewReport;
window.resendEmail = resendEmail;
window.downloadReport = downloadReport;
window.deleteReport = deleteReport;
window.exportCSV = exportCSV;

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('reportsTableWrap')) {
    initReportsFilters();
    const exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);
  }
});
