// =================================================================
// AuditPro — Automated Pipeline (3-step wizard)
// =================================================================
(function () {
  const STEP_ORDER = [
    'crawling',
    'finding_emails',
    'auditing',
    'generating_email',
    'sending',
    'generating_pdf',
  ];

  const state = {
    jobId: null,
    campaignId: null,
    pollTimer: null,
    timerInterval: null,
    startedAt: null,
    wired: false,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function show(stepId) {
    ['plStep1', 'plStep2', 'plStep3'].forEach((id) => {
      const node = el(id);
      if (!node) return;
      if (id === stepId) node.classList.remove('hidden');
      else node.classList.add('hidden');
    });
  }

  function estimateMinutes(count) {
    // 10 → 15min, 25 → 35min, 50 → 70min, 100 → 140min
    return Math.round(count * 1.4);
  }

  function updateEstimate() {
    const n = parseInt(el('plcTargetEmails')?.value, 10) || 0;
    const mins = estimateMinutes(n);
    const t = el('plcEstimate');
    if (t) t.textContent = `Estimated time: ~${mins} minutes`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  function fmtClock(secs) {
    if (secs < 0 || !Number.isFinite(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------- Step 1: form ----------
  function wireCountPresets() {
    const inputEl = el('plcTargetEmails');
    document.querySelectorAll('[data-plc-count]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.getAttribute('data-plc-count'), 10);
        if (inputEl) inputEl.value = n;
        document
          .querySelectorAll('[data-plc-count]')
          .forEach((b) => b.classList.toggle('active', b === btn));
        updateEstimate();
      });
    });
    if (inputEl) inputEl.addEventListener('input', updateEstimate);
  }

  async function startCampaign() {
    const niche = (el('plcNiche')?.value || '').trim();
    const location = (el('plcLocation')?.value || '').trim();
    const targetEmails = Math.max(
      1,
      Math.min(500, parseInt(el('plcTargetEmails')?.value, 10) || 25)
    );
    if (!niche) return Toast.error('Enter a niche');
    if (!location) return Toast.error('Enter a location');

    const payload = {
      niche,
      location,
      targetEmails,
      autoAudit: el('plcAutoAudit')?.checked !== false,
      autoEmail: el('plcAutoEmail')?.checked !== false,
      autoFollowup: el('plcAutoFollowup')?.checked !== false,
    };

    try {
      const r = await API.post('/pipeline/start', payload);
      state.jobId = r.jobId;
      state.campaignId = r.campaignId;
      state.startedAt = Date.now();
      renderWarnings(r.warnings);
      enterStep2(r.campaignName || `${niche} ${location}`);
      beginPolling();
      if (r.warnings && r.warnings.length) {
        Toast.show('Campaign started with warnings', 'warning');
      } else {
        Toast.success('Campaign started');
      }
    } catch (err) {
      Toast.error('Start failed: ' + err.message);
    }
  }

  function renderWarnings(warnings) {
    const node = el('plcWarnings');
    if (!node) return;
    if (!warnings || !warnings.length) {
      node.classList.add('hidden');
      node.innerHTML = '';
      return;
    }
    node.classList.remove('hidden');
    node.innerHTML = warnings
      .map((w) => `<div><span style="color:#C084FC;">⚠️</span> ${escapeHtml(w)}</div>`)
      .join('');
  }

  // ---------- Step 2: live progress ----------
  function enterStep2(campaignName) {
    show('plStep2');
    const nameEl = el('plRunName');
    if (nameEl) nameEl.textContent = campaignName;
    setProgress(0);
    ['plcFound', 'plcEmails', 'plcSent'].forEach((id) => {
      const n = el(id);
      if (n) n.textContent = '0';
    });
    resetSteps();
    startTimer();
  }

  function resetSteps() {
    document.querySelectorAll('.pl-step').forEach((node) => {
      node.classList.remove('done', 'active');
      const dot = node.querySelector('.pl-dot');
      if (dot) dot.textContent = '○';
      const detail = node.querySelector('.pl-detail');
      if (detail) detail.textContent = '';
    });
  }

  function updateStepIndicators(currentStep) {
    if (!currentStep || currentStep === 'starting') return;
    if (currentStep === 'completed' || currentStep === 'cancelled') {
      document.querySelectorAll('.pl-step').forEach((node) => {
        node.classList.remove('active');
        node.classList.add('done');
        const dot = node.querySelector('.pl-dot');
        if (dot) dot.textContent = currentStep === 'completed' ? '✓' : '—';
      });
      return;
    }
    const idx = STEP_ORDER.indexOf(currentStep);
    document.querySelectorAll('.pl-step').forEach((node) => {
      const step = node.getAttribute('data-pl-step');
      const i = STEP_ORDER.indexOf(step);
      node.classList.remove('done', 'active');
      const dot = node.querySelector('.pl-dot');
      if (i === -1) return;
      if (idx === -1) return;
      if (i < idx) {
        node.classList.add('done');
        if (dot) dot.textContent = '✓';
      } else if (i === idx) {
        node.classList.add('active');
        if (dot) dot.textContent = '⟳';
      } else {
        if (dot) dot.textContent = '○';
      }
    });
  }

  function setProgress(percent) {
    const p = Math.max(0, Math.min(100, percent || 0));
    const bar = el('plProgressBar');
    const txt = el('plProgressText');
    if (bar) bar.style.width = p + '%';
    if (txt) txt.textContent = p + '%';
  }

  function startTimer() {
    stopTimer();
    state.timerInterval = setInterval(() => {
      const secs = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
      const t = el('plcTimer');
      if (t) t.textContent = fmtClock(secs);
    }, 1000);
  }
  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function beginPolling() {
    stopPolling();
    pollOnce();
    state.pollTimer = setInterval(pollOnce, 3000);
  }
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function pollOnce() {
    if (!state.jobId) return;
    try {
      const j = await API.get('/pipeline/job/' + encodeURIComponent(state.jobId));
      setProgress(j.percent || 0);
      updateStepIndicators(j.step);

      const setCount = (id, n) => {
        const node = el(id);
        if (node) node.textContent = String(n || 0);
      };
      setCount('plcFound', j.leadsFound);
      setCount('plcEmails', j.emailsFound);
      setCount('plcSent', j.emailsSent);

      const current = el('plCurrentSite');
      if (current) {
        current.textContent = j.currentSite
          ? `Currently: ${j.currentSite}`
          : j.message || '';
      }

      // Per-step detail labels
      const setDetail = (step, text) => {
        const node = document.querySelector(`.pl-step[data-pl-step="${step}"] .pl-detail`);
        if (node) node.textContent = text || '';
      };
      setDetail('crawling', j.leadsFound ? `(${j.leadsFound} found)` : '');
      setDetail('finding_emails', j.emailsFound ? `(${j.emailsFound} found)` : '');
      setDetail(
        'auditing',
        j.auditsCompleted && j.emailsFound
          ? `(${j.auditsCompleted}/${j.emailsFound})`
          : ''
      );
      setDetail('sending', j.emailsSent ? `(${j.emailsSent} sent)` : '');

      if (j.status === 'completed') {
        stopPolling();
        stopTimer();
        showCompleted(j);
      } else if (j.status === 'failed') {
        stopPolling();
        stopTimer();
        Toast.error('Campaign failed: ' + (j.message || 'unknown'));
        show('plStep1');
      } else if (j.status === 'cancelled') {
        stopPolling();
        stopTimer();
        Toast.show('Campaign cancelled', 'warning');
        show('plStep1');
        loadCampaignHistory();
      }
    } catch (err) {
      // 404 on expired job — stop polling silently
      if (/not found/i.test(err.message)) {
        stopPolling();
      }
    }
  }

  async function cancelCampaign() {
    if (!state.jobId) return;
    if (!confirm('Cancel this campaign? Work already done will be preserved.')) return;
    try {
      await API.post('/pipeline/cancel/' + encodeURIComponent(state.jobId), {});
      Toast.show('Cancellation requested', 'warning');
    } catch (err) {
      Toast.error('Cancel failed: ' + err.message);
    }
  }

  // ---------- Step 3: completed ----------
  function showCompleted(j) {
    show('plStep3');
    const nameEl = el('plDoneName');
    if (nameEl) nameEl.textContent = j.campaignName || '';
    const s = j.summary || {};
    const set = (id, v) => {
      const node = el(id);
      if (node) node.textContent = String(v || 0);
    };
    set('plDoneFound', s.leadsFound);
    set('plDoneEmails', s.emailsFound);
    set('plDoneSent', s.emailsSent);

    // Download PDF: route requires Authorization header, so we fetch as blob.
    const dl = el('plDownloadPdfBtn');
    if (dl && j.campaignId) {
      dl.onclick = (e) => {
        e.preventDefault();
        downloadCampaignPdf(j.campaignId, j.campaignName);
      };
    }
    const viewCrm = el('plViewCrmBtn');
    if (viewCrm && j.campaignId) {
      viewCrm.onclick = () => {
        // Navigate to CRM + set campaign filter by remembering it.
        sessionStorage.setItem('pendingCrmCampaignId', j.campaignId);
        if (window.Router) Router.navigate('lead-crm');
      };
    }
    loadCampaignHistory();
  }

  async function downloadCampaignPdf(campaignId, name) {
    try {
      const token = Auth.getToken();
      const res = await fetch(
        (window.CONFIG ? CONFIG.API_BASE : '/api') +
          '/pipeline/campaigns/' +
          encodeURIComponent(campaignId) +
          '/pdf',
        { headers: token ? { Authorization: 'Bearer ' + token } : {} }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (name || 'campaign').replace(/[^a-z0-9]+/gi, '-') + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (err) {
      Toast.error(err.message);
    }
  }

  function startNewCampaign() {
    state.jobId = null;
    state.campaignId = null;
    state.startedAt = null;
    show('plStep1');
    const inputs = ['plcNiche', 'plcLocation'];
    inputs.forEach((id) => {
      const node = el(id);
      if (node) node.value = '';
    });
    renderWarnings(null);
  }

  // ---------- Campaign history ----------
  async function loadCampaignHistory() {
    const body = el('plHistoryBody');
    if (!body) return;
    try {
      const r = await API.get('/pipeline/campaigns?limit=50');
      const rows = (r && r.campaigns) || [];
      if (!rows.length) {
        body.innerHTML =
          '<tr><td colspan="6" style="padding:10px 6px;color:var(--muted);">No campaigns yet.</td></tr>';
        return;
      }
      body.innerHTML = rows
        .map((c) => {
          const statusColor =
            c.status === 'completed'
              ? '#10b981'
              : c.status === 'failed'
              ? '#ef4444'
              : c.status === 'cancelled'
              ? '#9ca3af'
              : '#f59e0b';
          const pdfBtn = c.pdfAvailable
            ? `<button class="btn btn-sm" data-pl-pdf="${escapeHtml(c.id)}" data-pl-name="${escapeHtml(c.name)}">PDF</button>`
            : `<button class="btn btn-sm" disabled>PDF</button>`;
          return `<tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px 6px;"><div style="font-weight:600;">${escapeHtml(c.name)}</div><div style="font-size:11px;color:var(--muted);">${escapeHtml(c.niche || '')} / ${escapeHtml(c.location || '')}</div></td>
            <td style="padding:8px 6px;">${escapeHtml(fmtDate(c.started_at))}</td>
            <td style="padding:8px 6px;">${c.emails_sent || 0}</td>
            <td style="padding:8px 6px;">${c.avg_score || 0}</td>
            <td style="padding:8px 6px;color:${statusColor};font-weight:600;">${escapeHtml(c.status || '')}</td>
            <td style="padding:8px 6px;">
              <button class="btn btn-sm" data-pl-view="${escapeHtml(c.id)}">View</button>
              ${pdfBtn}
              <button class="btn btn-sm" data-pl-del="${escapeHtml(c.id)}">Delete</button>
            </td>
          </tr>`;
        })
        .join('');

      body.querySelectorAll('[data-pl-view]').forEach((b) =>
        b.addEventListener('click', () => {
          sessionStorage.setItem('pendingCrmCampaignId', b.getAttribute('data-pl-view'));
          if (window.Router) Router.navigate('lead-crm');
        })
      );
      body.querySelectorAll('[data-pl-pdf]').forEach((b) =>
        b.addEventListener('click', () =>
          downloadCampaignPdf(b.getAttribute('data-pl-pdf'), b.getAttribute('data-pl-name'))
        )
      );
      body.querySelectorAll('[data-pl-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Delete this campaign?')) return;
          try {
            await API.delete('/pipeline/campaigns/' + encodeURIComponent(b.getAttribute('data-pl-del')));
            Toast.success('Campaign deleted');
            loadCampaignHistory();
          } catch (err) {
            Toast.error(err.message);
          }
        })
      );
    } catch (err) {
      body.innerHTML = `<tr><td colspan="6" style="padding:10px 6px;color:#ef4444;">Failed to load history: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function wireOnce() {
    if (state.wired) return;
    state.wired = true;
    wireCountPresets();
    updateEstimate();
    el('plcStartBtn') && el('plcStartBtn').addEventListener('click', startCampaign);
    el('plCancelBtn') && el('plCancelBtn').addEventListener('click', cancelCampaign);
    el('plStartNewBtn') && el('plStartNewBtn').addEventListener('click', startNewCampaign);
  }

  function initPipeline() {
    wireOnce();
    // If we land on the page mid-run, resume polling.
    if (state.jobId && state.pollTimer == null) {
      beginPolling();
    } else if (!state.jobId) {
      show('plStep1');
    }
    loadCampaignHistory();
  }

  window.initPipeline = initPipeline;
})();
