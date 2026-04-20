// =================================================================
// AuditPro — Bulk audit module
// Depends on: app.js (Auth, API, Toast, Utils)
// =================================================================

let currentJobId = null;
let eventSource = null;
let bulkItems = [];

// ---------- CSV parsing ----------
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const valid = [];
  const errors = [];
  if (lines.length < 2) {
    return { valid, errors: [{ line: 1, error: 'CSV appears to be empty or missing header row.' }] };
  }

  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {
    website: header.indexOf('website'),
    clientName: header.indexOf('client_name'),
    clientEmail: header.indexOf('client_email'),
    competitorUrl: header.indexOf('competitor_url'),
  };

  if (idx.website === -1 || idx.clientEmail === -1) {
    return { valid, errors: [{ line: 1, error: 'CSV must contain "website" and "client_email" columns.' }] };
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const websiteUrl = cols[idx.website] || '';
    const clientEmail = cols[idx.clientEmail] || '';
    const clientName = idx.clientName >= 0 ? cols[idx.clientName] || '' : '';
    const competitorUrl = idx.competitorUrl >= 0 ? cols[idx.competitorUrl] || '' : '';

    if (!websiteUrl || !Utils.isValidUrl(websiteUrl)) {
      errors.push({ line: i + 1, error: `Invalid website URL: ${websiteUrl || '(empty)'}` });
      continue;
    }
    if (!clientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmail)) {
      errors.push({ line: i + 1, error: `Invalid client_email: ${clientEmail || '(empty)'}` });
      continue;
    }
    if (competitorUrl && !Utils.isValidUrl(competitorUrl)) {
      errors.push({ line: i + 1, error: `Invalid competitor_url: ${competitorUrl}` });
      continue;
    }

    valid.push({
      websiteUrl: Utils.normalizeUrl(websiteUrl),
      clientName: clientName || null,
      clientEmail,
      competitorUrl: competitorUrl ? Utils.normalizeUrl(competitorUrl) : null,
    });
  }

  return { valid, errors };
}

function generateSampleCSV() {
  const csv =
    'website,client_name,client_email,competitor_url\n' +
    'https://example.com,Example Inc,client@example.com,https://competitor.com\n' +
    'https://foo.com,Foo Corp,foo@example.com,\n' +
    'https://bar.com,Bar LLC,bar@example.com,https://rival.com\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  Utils.downloadFile(url, 'auditpro-sample.csv');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Manual entry table ----------
function addRow(initial = {}) {
  const tbody = document.querySelector('#manualTable tbody');
  if (!tbody) return;
  const rowId = 'row-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const tr = document.createElement('tr');
  tr.id = rowId;
  tr.innerHTML = `
    <td><input class="form-input" placeholder="https://..." value="${Utils.escapeHtml(initial.websiteUrl || '')}" data-field="websiteUrl" /></td>
    <td><input class="form-input" placeholder="Client Name" value="${Utils.escapeHtml(initial.clientName || '')}" data-field="clientName" /></td>
    <td><input class="form-input" placeholder="client@example.com" value="${Utils.escapeHtml(initial.clientEmail || '')}" data-field="clientEmail" /></td>
    <td><input class="form-input" placeholder="Optional" value="${Utils.escapeHtml(initial.competitorUrl || '')}" data-field="competitorUrl" /></td>
    <td><button class="btn btn-icon btn-danger" data-remove-row="${rowId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelectorAll('input').forEach(i => i.addEventListener('input', getManualItems));
  tr.querySelector('[data-remove-row]').addEventListener('click', () => removeRow(rowId));
}

function removeRow(rowId) {
  const row = document.getElementById(rowId);
  if (row) row.remove();
  getManualItems();
}

function getManualItems() {
  const rows = document.querySelectorAll('#manualTable tbody tr');
  const items = [];
  const errors = [];
  rows.forEach((tr, idx) => {
    const inputs = tr.querySelectorAll('input');
    const data = {};
    inputs.forEach(i => { data[i.dataset.field] = (i.value || '').trim(); });
    if (!data.websiteUrl && !data.clientEmail) return;
    if (!data.websiteUrl || !Utils.isValidUrl(data.websiteUrl)) {
      errors.push({ line: idx + 1, error: 'Invalid website URL' });
      tr.classList.add('has-error');
      return;
    }
    if (!data.clientEmail) {
      errors.push({ line: idx + 1, error: 'Missing client email' });
      tr.classList.add('has-error');
      return;
    }
    tr.classList.remove('has-error');
    items.push({
      websiteUrl: Utils.normalizeUrl(data.websiteUrl),
      clientName: data.clientName || null,
      clientEmail: data.clientEmail,
      competitorUrl: data.competitorUrl ? Utils.normalizeUrl(data.competitorUrl) : null,
    });
  });
  bulkItems = items;
  renderBulkPreview(items, errors);
  return { items, errors };
}

// ---------- CSV drag & drop wiring ----------
function initBulkUploader() {
  const dropzone = document.getElementById('dropzone') || document.querySelector('.dropzone');
  const input = document.getElementById('csvInput');
  if (!dropzone) return;

  dropzone.addEventListener('click', () => input && input.click());
  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover', 'hover');
  }));
  ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover', 'hover');
  }));
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) handleCsvFile(e.dataTransfer.files[0]);
  });
  if (input) {
    input.addEventListener('change', (e) => {
      if (e.target.files[0]) handleCsvFile(e.target.files[0]);
    });
  }
}

async function handleCsvFile(file) {
  const nameEl = document.getElementById('csvName');
  if (nameEl) nameEl.textContent = file.name;

  try {
    const text = await file.text();
    const { valid, errors } = parseCSV(text);
    bulkItems = valid;
    renderBulkPreview(valid, errors);
  } catch (err) {
    Toast.error('Could not read CSV: ' + err.message);
  }
}

function renderBulkPreview(items, errors) {
  const wrap = document.getElementById('bulkPreview');
  if (!wrap) return;
  const countEl = document.getElementById('previewCount');
  const estEl = document.getElementById('estimatedTime');
  const listEl = document.getElementById('previewList');
  const errEl = document.getElementById('previewErrors');

  if ((!items || items.length === 0) && (!errors || errors.length === 0)) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  if (countEl) countEl.textContent = items.length;
  if (estEl) estEl.textContent = items.length > 0 ? `~${Math.ceil(items.length * 0.8)} minutes` : '';

  if (listEl) {
    const rows = items.map(it => `
      <tr>
        <td style="font-weight:600;color:var(--text-heading);">${Utils.escapeHtml(it.websiteUrl)}</td>
        <td>${Utils.escapeHtml(it.clientName || '—')}</td>
        <td>${Utils.escapeHtml(it.clientEmail)}</td>
        <td>${Utils.escapeHtml(it.competitorUrl || '—')}</td>
      </tr>
    `).join('');
    listEl.innerHTML = `<div class="table-wrapper"><table><thead><tr><th>Website</th><th>Client</th><th>Email</th><th>Competitor</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  if (errEl) {
    if (errors && errors.length) {
      errEl.innerHTML = `<div class="alert alert-warning">${errors.length} row(s) skipped: ${errors.map(e => `line ${e.line}: ${Utils.escapeHtml(e.error)}`).join('; ')}</div>`;
    } else {
      errEl.innerHTML = '';
    }
  }
}

// ---------- Start job ----------
async function startBulkAudit() {
  if (!bulkItems.length) {
    const { items } = getManualItems();
    if (!items.length) { Toast.error('Add at least one valid site'); return; }
    bulkItems = items;
  }
  if (bulkItems.length > 50) { Toast.error('Maximum 50 items per job'); return; }
  if (!confirm(`Start audit for ${bulkItems.length} website(s)?`)) return;

  try {
    const res = await API.post('/bulk/start', { items: bulkItems });
    currentJobId = res.jobId;

    const preview = document.getElementById('bulkPreview');
    const tracker = document.getElementById('bulkTracker');
    if (preview) preview.style.display = 'none';
    if (tracker) tracker.style.display = 'block';

    initProgressUI(bulkItems);
    connectSSE(currentJobId);
  } catch (err) {
    Toast.error('Failed to start: ' + err.message);
  }
}

function initProgressUI(items) {
  const list = document.getElementById('bulkProgressList');
  if (!list) return;
  list.innerHTML = items.map(it => `
    <div class="bulk-item pending" data-bulk-url="${Utils.escapeHtml(it.websiteUrl)}">
      <div class="bulk-item-status pending"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg></div>
      <div class="bulk-item-url">${Utils.escapeHtml(it.websiteUrl)}</div>
      <div class="bulk-item-client">${Utils.escapeHtml(it.clientName || it.clientEmail || '')}</div>
      <div class="bulk-item-score" data-bulk-score>Pending</div>
    </div>
  `).join('');
  setCounter('bpTotal', items.length);
  setCounter('bpCurrent', 0);
  setCounter('bpFailed', 0);
  setCounter('bpPercent', 0);
  setFillWidth('bpFill', 0);
}

// ---------- SSE progress ----------
function connectSSE(jobId) {
  closeSSE();
  const tk = encodeURIComponent(Auth.getToken() || '');
  eventSource = new EventSource(`${CONFIG.API_BASE}/bulk/${jobId}/progress?token=${tk}`);

  eventSource.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    handleSseEvent(data);
  };
  eventSource.onerror = () => { /* browser will auto-reconnect */ };
}

function closeSSE() {
  if (eventSource) {
    try { eventSource.close(); } catch {}
    eventSource = null;
  }
}

function handleSseEvent(data) {
  switch (data.type) {
    case 'started':
      setCounter('bpTotal', data.total);
      break;

    case 'state':
      setCounter('bpCurrent', data.completed || 0);
      setCounter('bpFailed', data.failed || 0);
      setCounter('bpTotal', data.total || 0);
      break;

    case 'item_started': {
      const row = findRowByUrl(data.websiteUrl);
      if (row) {
        row.className = 'bulk-item running';
        const icon = row.querySelector('.bulk-item-status');
        if (icon) {
          icon.className = 'bulk-item-status running';
          icon.innerHTML = '<div class="spinner" style="border-top-color:var(--primary);width:14px;height:14px;"></div>';
        }
        const score = row.querySelector('[data-bulk-score]');
        if (score) score.textContent = 'Running...';
      }
      updateProgressUI(data);
      break;
    }

    case 'item_completed': {
      const row = findRowByUrl(data.websiteUrl);
      if (row) {
        row.className = 'bulk-item completed';
        const icon = row.querySelector('.bulk-item-status');
        if (icon) {
          icon.className = 'bulk-item-status completed';
          icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
        }
        const score = row.querySelector('[data-bulk-score]');
        if (score) score.innerHTML = '<span class="badge badge-pass">Email sent</span>';
      }
      bumpCounter('bpCurrent');
      updateProgressUI(data);
      break;
    }

    case 'item_failed': {
      const row = findRowByUrl(data.websiteUrl);
      if (row) {
        row.className = 'bulk-item failed';
        const icon = row.querySelector('.bulk-item-status');
        if (icon) {
          icon.className = 'bulk-item-status failed';
          icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        }
        const score = row.querySelector('[data-bulk-score]');
        if (score) score.innerHTML = `<span class="form-error">${Utils.escapeHtml(data.error || 'Failed')}</span>`;
      }
      bumpCounter('bpFailed');
      updateProgressUI(data);
      break;
    }

    case 'job_completed':
      setFillWidth('bpFill', 100);
      setCounter('bpPercent', 100);
      renderCompletionActions(data);
      Toast.success(data.summary || 'Bulk audit finished');
      closeSSE();
      break;
  }
}

function updateProgressUI(data) {
  if (typeof data.percent === 'number') {
    setCounter('bpPercent', data.percent);
    setFillWidth('bpFill', data.percent);
  }
}

function findRowByUrl(url) {
  return document.querySelector(`[data-bulk-url="${cssEscape(url)}"]`);
}

function cssEscape(str) {
  return String(str).replace(/["\\]/g, '\\$&');
}

function setCounter(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function bumpCounter(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String((parseInt(el.textContent, 10) || 0) + 1);
}
function setFillWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = pct + '%';
}

function renderCompletionActions(data) {
  const actions = document.getElementById('bulkActions');
  if (!actions) return;
  const failed = data.failed || 0;
  actions.innerHTML = '';
  if (failed > 0) {
    const retry = document.createElement('button');
    retry.className = 'btn btn-secondary';
    retry.textContent = 'Retry Failed';
    retry.addEventListener('click', retryFailed);
    actions.appendChild(retry);
  }
  const view = document.createElement('button');
  view.className = 'btn btn-primary';
  view.textContent = 'View All Reports';
  view.addEventListener('click', () => { window.location.hash = 'view-reports'; });
  actions.appendChild(view);
}

// ---------- Retry failed ----------
async function retryFailed() {
  if (!currentJobId) return;
  try {
    const res = await API.post(`/bulk/${currentJobId}/retry-failed`);
    currentJobId = res.jobId;
    Toast.success('Retry started');
    // Keep existing UI but reconnect SSE — the new job will broadcast item events
    connectSSE(currentJobId);
  } catch (err) {
    Toast.error(err.message);
  }
}

// ---------- Tab switcher ----------
function initBulkTabs() {
  const tabs = document.querySelectorAll('#bulkTabs button');
  if (!tabs.length) return;
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      const csvPane = document.getElementById('bulkTab-csv');
      const manualPane = document.getElementById('bulkTab-manual');
      if (csvPane) csvPane.style.display = tab === 'csv' ? 'block' : 'none';
      if (manualPane) manualPane.style.display = tab === 'manual' ? 'block' : 'none';
    });
  });
}

// ---------- Pick up an already-running job (e.g. triggered from Lead Finder) ----------
async function attachToPendingJob() {
  const pending = sessionStorage.getItem('activeBulkJobId');
  if (!pending) return;
  sessionStorage.removeItem('activeBulkJobId');
  try {
    const res = await API.get(`/bulk/${pending}/status`);
    const items = (res.items || []).map(i => ({
      websiteUrl: i.websiteUrl || i.website_url,
      clientName: i.clientName || i.client_name,
      clientEmail: i.clientEmail || i.client_email,
      competitorUrl: i.competitorUrl || i.competitor_url,
    }));
    currentJobId = pending;
    const preview = document.getElementById('bulkPreview');
    const tracker = document.getElementById('bulkTracker');
    if (preview) preview.style.display = 'none';
    if (tracker) tracker.style.display = 'block';
    initProgressUI(items);
    // Reflect already-completed items before the stream attaches.
    (res.items || []).forEach((i) => {
      const url = i.websiteUrl || i.website_url;
      const row = findRowByUrl(url);
      if (!row) return;
      if (i.status === 'completed') {
        row.className = 'bulk-item completed';
        const score = row.querySelector('[data-bulk-score]');
        if (score) score.innerHTML = '<span class="badge badge-pass">Email sent</span>';
      } else if (i.status === 'failed') {
        row.className = 'bulk-item failed';
      }
    });
    setCounter('bpTotal', res.total || items.length);
    setCounter('bpCurrent', res.completed || 0);
    setCounter('bpFailed', res.failed || 0);
    connectSSE(pending);
  } catch (err) {
    console.error('[bulk] failed to attach to pending job:', err);
  }
}

function initBulkAuditView() {
  initBulkUploader();
  initBulkTabs();

  const addBtn = document.getElementById('addRowBtn');
  if (addBtn && !addBtn.dataset.wired) {
    addBtn.dataset.wired = '1';
    addBtn.addEventListener('click', () => addRow());
  }

  const sample = document.getElementById('downloadSampleCsv');
  if (sample && !sample.dataset.wired) {
    sample.dataset.wired = '1';
    sample.addEventListener('click', generateSampleCSV);
  }

  const startBtn = document.getElementById('startBulkBtn');
  if (startBtn && !startBtn.dataset.wired) {
    startBtn.dataset.wired = '1';
    startBtn.addEventListener('click', startBulkAudit);
  }

  // Seed one manual row if the table is empty
  if (document.querySelector('#manualTable tbody') && !document.querySelector('#manualTable tbody tr')) {
    addRow();
  }

  attachToPendingJob();
}

window.initBulkAudit = initBulkAuditView;

// ---------- Bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  initBulkAuditView();
});
