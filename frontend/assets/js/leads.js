// =================================================================
// AuditPro — Lead Finder / CRM / Follow-ups / Niches / Notifications
// Depends on: app.js (API, Auth, Toast, Utils), theme.js (Router)
// =================================================================

(function () {
  'use strict';

  const esc = (s) => (window.Utils && Utils.escapeHtml) ? Utils.escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDate = (d) => (window.Utils && Utils.formatDate) ? Utils.formatDate(d) : (d ? new Date(d).toLocaleDateString() : '—');
  const fmtDateTime = (d) => (window.Utils && Utils.formatDateTime) ? Utils.formatDateTime(d) : (d ? new Date(d).toLocaleString() : '—');

  // ==================== DYNAMIC MODAL ====================
  function openModal({ title, body, footer, maxWidth }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" style="${maxWidth ? 'max-width:' + maxWidth + ';' : ''}">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="btn btn-ghost btn-sm" data-modal-close>✕</button>
        </div>
        <div class="modal-body">${body || ''}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>`;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
    const close = () => {
      backdrop.classList.remove('show');
      setTimeout(() => backdrop.remove(), 200);
    };
    backdrop.querySelectorAll('[data-modal-close]').forEach(b => b.addEventListener('click', close));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    return { backdrop, close };
  }

  // ==================== LEAD FINDER ====================
  let lfJobId = null;
  let lfPollTimer = null;
  let lfResults = [];
  let lfSelected = new Set();
  let lfNichesCache = null;
  let lfUsersCache = null;

  function sourceBadge(src) {
    const s = String(src || '').toLowerCase();
    if (s === 'bing') return `<span class="src-badge bing">Bing</span>`;
    if (s === 'google_places') return `<span class="src-badge google">Google</span>`;
    // Directory-provided source names like "Cylex UK", "Hotfrog", etc.
    return `<span class="src-badge yelp">${esc(src || 'Directory')}</span>`;
  }

  function updateEstimate() {
    const target = parseInt(document.getElementById('lfLimit').value, 10) || 20;
    const el = document.getElementById('lfEstimate');
    if (el) {
      el.textContent = `Will search until ${target} email address${target === 1 ? ' is' : 'es are'} found (searches multiple pages automatically).`;
    }
  }

  function renderTokenStatus(status) {
    const wrap = document.getElementById('lfTokenStatus');
    if (!wrap) return;
    status = status || {};

    const bing = status.bing || {};
    const bingConfigured = !!bing.configured;
    const bingMonthly = bing.monthlyLimit || status.monthlyLimit || 0;
    const bingUsed = bing.tokensUsedMonth != null ? bing.tokensUsedMonth : (status.tokensUsedMonth || 0);
    const bingRemaining = bing.remainingMonth != null ? bing.remainingMonth : (status.remainingMonth || 0);
    const bingPct = bing.percentUsed != null ? bing.percentUsed : (status.percentUsed || 0);
    const bingStatus = bing.status || status.status;

    const gEnabled = !!(status.googlePlaces && status.googlePlaces.configured);

    wrap.innerHTML = `
      <div class="token-card">
        <div class="th"><span class="dot"></span> 🕷️ Web Crawler <span style="margin-left:auto;font-size:11px;color:var(--success, #10b981);font-weight:700;">✅ Always Active</span></div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px;">Searches UK / US / UAE / India directories</div>
        <div style="font-size:12px;color:var(--muted);">Unlimited · No setup needed</div>
      </div>
      <div class="token-card" style="margin-top:10px;${bingConfigured ? '' : 'opacity:0.75;'}">
        <div class="th"><span class="dot"></span> 🔵 Bing <span style="margin-left:auto;font-size:11px;font-weight:700;color:${bingConfigured ? 'var(--text)' : 'var(--warn, #f59e0b)'};">${bingConfigured ? `${bingRemaining} / ${bingMonthly} left` : '⚠️ Add API key'}</span></div>
        ${bingConfigured ? `
          <div class="pbar" style="margin-top:8px;"><div class="fill ${bingPct < 50 ? '' : (bingPct < 80 ? 'warn' : 'bad')}" style="width:${Math.min(100, bingPct)}%;"></div></div>
          <div class="foot">${bingPct}% used · resets ${esc(bing.resetsOn || status.resetsOn || '')} (${bing.daysUntilReset || status.daysUntilReset || 0} days)</div>
        ` : `
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">+1,000 results/month when configured</div>
          <div class="foot"><a href="#settings" style="color:var(--primary);font-weight:700;">Add Bing key in Settings →</a></div>
        `}
      </div>
      <div class="token-card" style="margin-top:10px;${gEnabled ? '' : 'opacity:0.75;'}">
        <div class="th"><span class="dot"></span> 🟣 Google Places <span style="margin-left:auto;font-size:11px;font-weight:700;color:${gEnabled ? 'var(--text)' : 'var(--warn, #f59e0b)'};">${gEnabled ? 'Ready (100/day free)' : '⚠️ Add API key'}</span></div>
        ${gEnabled ? `
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">Uses your PageSpeed API key · 100 free calls/day</div>
        ` : `
          <div style="font-size:12px;color:var(--muted);margin-top:4px;">+100 results/day when configured</div>
          <div class="foot"><a href="#settings" style="color:var(--primary);font-weight:700;">Add PageSpeed key in Settings →</a></div>
        `}
      </div>`;

    const bingToggle = document.getElementById('lfSrcBing');
    if (bingToggle) {
      bingToggle.disabled = !bingConfigured || bingStatus === 'exhausted';
      if (bingToggle.disabled) bingToggle.checked = false;
    }
    const bingSub = document.getElementById('lfBingSub');
    if (bingSub) {
      bingSub.innerHTML = bingConfigured
        ? `${bingRemaining} tokens remaining this month`
        : '<a href="#settings" style="color:var(--primary);">Add key in Settings</a>';
    }

    const gToggle = document.getElementById('lfSrcGoogle');
    if (gToggle) {
      gToggle.disabled = !gEnabled;
      if (!gEnabled) gToggle.checked = false;
    }
    const gSub = document.getElementById('lfGoogleSub');
    if (gSub) {
      gSub.innerHTML = gEnabled
        ? 'Uses your PageSpeed API key (100 free/day)'
        : '<a href="#settings" style="color:var(--primary);">Add PageSpeed API key in Settings</a>';
    }
  }

  async function loadTokenStatus() {
    try {
      const s = await API.get('/leads/tokens');
      renderTokenStatus(s);
    } catch {
      renderTokenStatus(null);
    }
  }

  function renderSuggestions(suggestions) {
    const wrap = document.getElementById('lfSuggestions');
    if (!wrap) return;
    if (!suggestions || suggestions.length === 0) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <div class="card pad">
        <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px;">💡 Find more leads</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${suggestions.map((s, i) => `
            <button class="btn btn-outline btn-sm" data-suggest="${i}">${esc(s.label)}</button>
          `).join('')}
        </div>
      </div>`;
    wrap.querySelectorAll('[data-suggest]').forEach(b => b.addEventListener('click', () => {
      const s = suggestions[parseInt(b.dataset.suggest, 10)];
      if (!s) return;
      document.getElementById('lfNiche').value = s.niche;
      document.getElementById('lfLocation').value = s.location;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      handleSearch();
    }));
  }

  async function loadSearchHistory() {
    const wrap = document.getElementById('lfHistory');
    if (!wrap) return;
    try {
      const r = await API.get('/leads/search/history');
      const hist = (r.history || []).slice(0, 5);
      if (hist.length === 0) { wrap.style.display = 'none'; return; }
      wrap.style.display = 'block';
      wrap.innerHTML = 'Recent: ' + hist.map((h, i) =>
        `<a href="#" data-hist="${i}" style="color:var(--primary);font-weight:600;">${esc(h.niche)} ${esc(h.location)}</a> <span>(${h.emails_found || 0} leads)</span>`
      ).join(' · ');
      wrap.querySelectorAll('[data-hist]').forEach(a => a.addEventListener('click', (e) => {
        e.preventDefault();
        const h = hist[parseInt(a.dataset.hist, 10)];
        if (!h) return;
        document.getElementById('lfNiche').value = h.niche || '';
        document.getElementById('lfLocation').value = h.location || '';
      }));
    } catch {
      wrap.style.display = 'none';
    }
  }

  function setLfStep(step, state) {
    document.querySelectorAll('#lfSteps .running-step').forEach(el => {
      if (el.dataset.step === step) {
        el.classList.remove('active', 'done');
        if (state) el.classList.add(state);
      }
    });
  }

  function resetLfProgress() {
    document.getElementById('lfProgressCard').style.display = 'none';
    document.getElementById('lfProgressFill').style.width = '0%';
    document.getElementById('lfProgressText').textContent = 'Starting search...';
    document.querySelectorAll('#lfSteps .running-step').forEach(el => {
      el.classList.remove('active', 'done');
    });
  }

  // Remembers the last search the UI ran so "Search Next Page" can
  // re-issue it with an incremented offset.
  let lfLastSearch = null;

  async function handleSearch(overrides = {}) {
    const niche = (overrides.niche || document.getElementById('lfNiche').value).trim();
    const location = (overrides.location || document.getElementById('lfLocation').value).trim();
    const limit = overrides.limit || parseInt(document.getElementById('lfLimit').value, 10) || 20;
    const sources = overrides.sources || (() => {
      const s = ['directory'];
      const bingEl = document.getElementById('lfSrcBing');
      if (bingEl && bingEl.checked && !bingEl.disabled) s.push('bing');
      const gEl = document.getElementById('lfSrcGoogle');
      if (gEl && gEl.checked && !gEl.disabled) s.push('google_places');
      return s;
    })();
    const businessEmailsOnly =
      overrides.businessEmailsOnly != null
        ? !!overrides.businessEmailsOnly
        : !!(document.getElementById('lfBusinessOnly') && document.getElementById('lfBusinessOnly').checked);
    const offset = Math.max(1, parseInt(overrides.offset, 10) || 1);

    if (!niche) return Toast.error('Enter a business niche');
    if (!location) return Toast.error('Enter a location');

    lfLastSearch = { niche, location, limit, sources, businessEmailsOnly, offset };

    lfResults = [];
    lfSelected.clear();
    document.getElementById('lfResultsSection').style.display = 'none';
    document.getElementById('lfProgressCard').style.display = 'block';
    setLfStep('scraping', 'active');
    document.getElementById('lfProgressText').textContent =
      `Searching ${sources.join(', ')}${offset > 1 ? ` (page ${offset})` : ''}...`;

    try {
      const { jobId } = await API.post('/leads/search/start', {
        niche,
        location,
        limit,
        sources,
        offset,
        businessEmailsOnly,
      });
      lfJobId = jobId;
      pollLfStatus();
    } catch (err) {
      document.getElementById('lfProgressCard').style.display = 'none';
      Toast.error('Search failed: ' + err.message);
    }
  }

  function searchNextPage() {
    if (!lfLastSearch) return Toast.error('No previous search to continue');
    const next = (lfLastSearch.offset || 1) + 1;
    handleSearch({ ...lfLastSearch, offset: next });
  }

  async function pollLfStatus() {
    if (!lfJobId) return;
    try {
      const s = await API.get('/leads/search/' + lfJobId + '/status');
      console.log('[LeadFinder] poll:', s.status, s.progress);
      const p = s.progress || {};
      const fill = document.getElementById('lfProgressFill');
      if (fill) fill.style.width = (p.percent || 0) + '%';
      const txt = document.getElementById('lfProgressText');
      if (txt) {
        if (p.phase === 'scraping') {
          txt.textContent = p.currentSite
            ? `🕷️ ${p.currentSite}`
            : 'Searching directories...';
        } else if (p.phase === 'deduplicating') {
          txt.textContent = 'Removing duplicates...';
        } else if (p.phase === 'finding_emails') {
          txt.textContent = `📧 Finding emails... (${p.current}/${p.total})` + (p.currentSite ? ' — ' + p.currentSite : '');
        }
      }
      const dirWrap = document.getElementById('lfDirStatus');
      if (dirWrap && p.directoryStatus) {
        const items = Object.values(p.directoryStatus);
        dirWrap.innerHTML = items.map((d) => {
          let label = '';
          if (d.stage === 'done') {
            label = `✅ ${d.count} found`;
          } else if (d.stage === 'fetching-page') {
            label = `📄 page ${d.page}/${d.pages}`;
          } else if (d.stage === 'enriching') {
            label = d.current ? `🔗 ${d.current}/${d.total}` : `🔗 ${d.total} listings`;
          } else {
            label = '…';
          }
          return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border,#eee);"><span>${esc(d.directory)}</span><span style="color:var(--muted);">${esc(label)}</span></div>`;
        }).join('');
      }
      if (p.phase === 'scraping') setLfStep('scraping', 'active');
      if (p.phase === 'deduplicating') { setLfStep('scraping', 'done'); setLfStep('deduplicating', 'active'); }
      if (p.phase === 'finding_emails') { setLfStep('scraping', 'done'); setLfStep('deduplicating', 'done'); setLfStep('finding_emails', 'active'); }

      if (s.status === 'completed') {
        console.log('[LeadFinder] completed. result:', s.results);
        document.querySelectorAll('#lfSteps .running-step').forEach(el => el.classList.add('done'));
        const result = s.results || {};
        renderResults(result);
        renderSuggestions(result.suggestions || []);
        if (s.tokenStatus) renderTokenStatus(s.tokenStatus);
        loadSearchHistory();
        lfJobId = null;
        return;
      }
      if (s.status === 'failed') {
        document.getElementById('lfProgressCard').style.display = 'none';
        console.error('[LeadFinder] search failed:', s.error);
        Toast.error('Search failed: ' + (s.error || 'unknown error'));
        lfJobId = null;
        return;
      }
      lfPollTimer = setTimeout(pollLfStatus, 2000);
    } catch (err) {
      console.error('[LeadFinder] poll error:', err);
      Toast.error('Status check failed: ' + err.message);
    }
  }

  function renderResults(result) {
    document.getElementById('lfProgressCard').style.display = 'none';
    lfResults = result.results || [];
    lfSelected = new Set(lfResults.map((_, i) => i));
    console.log('[LeadFinder] renderResults:', {
      leads: lfResults.length,
      discarded: result.discarded,
      duplicatesSkipped: result.duplicatesSkipped,
      sourceCounts: result.sourceCounts,
    });

    const sec = document.getElementById('lfResultsSection');
    sec.style.display = 'block';

    const warnings = (result.warnings || []).map(w =>
      `<div class="banner warn" style="margin-bottom:10px;">⚠ ${esc(w)}</div>`).join('');
    const sc = result.sourceCounts || {};
    const dirBreakdown = result.directoryBreakdown || {};
    const country = result.detectedCountry || '';
    document.getElementById('lfSourceBreakdown').innerHTML = `
      ${country ? `<span class="src-badge yelp">🌍 ${esc(country)}</span>` : ''}
      ${sc.directory != null ? `<span class="src-badge yelp">🕷️ Crawler: ${sc.directory}</span>` : ''}
      ${Object.entries(dirBreakdown).map(([n, c]) =>
        `<span class="src-badge yelp" style="opacity:0.85;">${esc(n)}: ${c}</span>`
      ).join('')}
      ${sc.bing ? `<span class="src-badge bing">Bing: ${sc.bing}</span>` : ''}
      ${sc.google_places ? `<span class="src-badge google">Google: ${sc.google_places}</span>` : ''}`;

    const totalFound = lfResults.length + (result.discarded || 0) + (result.duplicatesSkipped || 0);

    if (lfResults.length === 0) {
      const rows = [];
      if (sc.directory != null) {
        rows.push(`<li>🕷️ Web crawler${country ? ` (${esc(country)})` : ''}: <b>${sc.directory}</b> found${sc.directory > 0 ? ', 0 had emails on website' : ''}</li>`);
        for (const [n, c] of Object.entries(dirBreakdown)) {
          rows.push(`<li style="margin-left:16px;opacity:0.85;">${esc(n)}: ${c}</li>`);
        }
      }
      if (sc.bing != null) rows.push(`<li>Bing: <b>${sc.bing}</b> found${sc.bing > 0 ? ', 0 had emails on website' : ''}</li>`);
      if (sc.google_places != null) rows.push(`<li>Google Places: <b>${sc.google_places}</b> found${sc.google_places > 0 ? ', 0 had emails on website' : ''}</li>`);
      const sourceRows = rows.join('');
      const dbDupes0 = result.duplicatesInDb || 0;
      const allDupes = dbDupes0 > 0 && lfResults.length === 0;
      const heading = allDupes
        ? `ℹ️ All ${dbDupes0} lead${dbDupes0 === 1 ? '' : 's'} already in your CRM`
        : '😕 No leads found with emails';
      document.getElementById('lfResultsSummary').innerHTML = `
        ${warnings}
        <div class="card pad" style="text-align:left;">
          <div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:10px;">${heading}</div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:10px;">We searched:</div>
          <ul style="font-size:13px;color:var(--text);margin:0 0 14px 20px;line-height:1.7;">
            ${sourceRows || '<li>No sources returned results</li>'}
          </ul>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <button class="btn btn-primary btn-sm" id="lfNextPageBtn">🔄 Search Next Page</button>
            <button class="btn btn-outline btn-sm" id="lfNewSearchBtn">🔍 Try New Search</button>
            <button class="btn btn-outline btn-sm" id="lfViewCrmBtn">👥 View in CRM</button>
          </div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">Or try:</div>
          <ul style="font-size:13px;color:var(--text);margin:0 0 0 20px;line-height:1.7;">
            <li>Different niche keywords</li>
            <li>A broader location</li>
            <li>Enabling more sources (Bing, Google Places)</li>
          </ul>
        </div>`;
      const np = document.getElementById('lfNextPageBtn');
      if (np) np.addEventListener('click', searchNextPage);
      const ns = document.getElementById('lfNewSearchBtn');
      if (ns) ns.addEventListener('click', () => {
        document.getElementById('lfResultsSection').style.display = 'none';
        document.getElementById('lfNiche').focus();
      });
      const vc = document.getElementById('lfViewCrmBtn');
      if (vc) vc.addEventListener('click', () => {
        if (window.Router) Router.navigate('lead-crm');
      });
      const body = document.getElementById('lfResultsBody');
      body.innerHTML = `<tr><td colspan="7" class="empty-state">No new leads with emails found.</td></tr>`;
      updateSelectedCount();
      return;
    }

    const scanned = result.totalScanned != null ? result.totalScanned : totalFound;
    const noEmail = result.noEmailCount != null ? result.noEmailCount : (result.discarded || 0);
    const dbDupes = result.duplicatesInDb != null ? result.duplicatesInDb : 0;
    const target = result.targetEmails || lfResults.length;
    const reached = result.targetReached === true;
    const personalFiltered = result.personalEmailsFiltered || 0;
    const businessCount = lfResults.filter((l) => l.emailQuality === 'business').length;
    document.getElementById('lfResultsSummary').innerHTML = `
      ${warnings}
      <div class="results-summary" style="display:flex;flex-direction:column;gap:4px;">
        <div style="font-size:15px;font-weight:700;color:${reached ? '#10b981' : 'var(--text)'};">
          ${reached ? '✅' : 'ℹ️'} Found <b>${lfResults.length}</b> lead${lfResults.length === 1 ? '' : 's'} with emails${target ? ` (target: ${target})` : ''}
        </div>
        <div style="font-size:13px;color:var(--muted);">
          ${businessCount} business · ${lfResults.length - businessCount} personal
          · searched ${scanned} business${scanned === 1 ? '' : 'es'}
          · ${noEmail} had no email
          · ${dbDupes} already in your database
          ${personalFiltered ? ` · ${personalFiltered} personal emails filtered out` : ''}
        </div>
      </div>`;

    const body = document.getElementById('lfResultsBody');
    {
      body.innerHTML = lfResults.map((l, i) => `
        <tr data-idx="${i}">
          <td><input type="checkbox" class="lf-checkbox" data-idx="${i}" checked /></td>
          <td><div style="font-weight:700;color:var(--text);">${esc(l.businessName || '—')}</div>${l.contactName ? `<div style="font-size:11px;color:var(--muted);">${esc(l.contactName)}</div>` : ''}</td>
          <td><a href="${esc(l.website || '#')}" target="_blank" rel="noopener" style="color:var(--primary);">${esc((l.website || '').replace(/^https?:\/\//, '').slice(0, 40))}</a></td>
          <td>${esc(l.email || '—')} ${emailQualityBadge(l.emailQuality)}</td>
          <td>${esc(l.phone || '—')}</td>
          <td>${sourceBadge(l.source)}</td>
          <td><button class="action-btn danger" data-remove="${i}" title="Remove"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></td>
        </tr>`).join('');
    }

    body.querySelectorAll('.lf-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.dataset.idx, 10);
        if (cb.checked) lfSelected.add(i); else lfSelected.delete(i);
        updateSelectedCount();
      });
    });
    body.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.remove, 10);
        lfSelected.delete(i);
        const row = body.querySelector(`tr[data-idx="${i}"]`);
        if (row) row.remove();
        updateSelectedCount();
      });
    });
    applyLfQualityFilter();
  }

  function updateSelectedCount() {
    const el = document.getElementById('lfSelectedCount');
    if (el) el.textContent = `${lfSelected.size} selected`;
  }

  function emailQualityBadge(q) {
    if (q === 'business') {
      return '<span style="display:inline-block;padding:1px 6px;border-radius:999px;background:#DCFCE7;color:#166534;font-size:10px;font-weight:700;margin-left:6px;">Business</span>';
    }
    if (q === 'personal') {
      return '<span style="display:inline-block;padding:1px 6px;border-radius:999px;background:#FEF3C7;color:#92400E;font-size:10px;font-weight:700;margin-left:6px;">Personal</span>';
    }
    return '';
  }

  function getSelectedLeads() {
    return [...lfSelected].sort((a,b)=>a-b).map(i => lfResults[i]).filter(Boolean);
  }

  async function loadNichesAndUsers() {
    if (!lfNichesCache) {
      try { const r = await API.get('/niches'); lfNichesCache = r.niches || []; } catch { lfNichesCache = []; }
    }
    if (!lfUsersCache) {
      try { const u = await API.get('/users').catch(() => []); lfUsersCache = Array.isArray(u) ? u : (u.users || []); } catch { lfUsersCache = []; }
    }
    return { niches: lfNichesCache, users: lfUsersCache };
  }

  async function openSaveToCrmModal(onSaved) {
    const leads = getSelectedLeads();
    if (leads.length === 0) return Toast.error('Select at least one lead');

    const { niches, users } = await loadNichesAndUsers();
    const renderNicheOpts = (list) =>
      list
        .map(
          (n) =>
            `<option value="${esc(n.id)}">${esc(n.icon || '')} ${esc(n.name)}</option>`
        )
        .join('');
    const userOpts = users
      .map(
        (u) =>
          `<option value="${esc(u.id)}">${esc(u.name)} (${esc(u.role)})</option>`
      )
      .join('');

    const emojiGrid = ['🔧', '🦷', '⚖️', '🏥', '💼', '🏠', '🍽️', '✂️', '🚗', '📸', '🐶', '💪']
      .map(
        (e) =>
          `<button type="button" class="scrm-emoji" data-emoji="${e}" style="padding:6px 8px;font-size:18px;border:1px solid var(--border);border-radius:6px;background:var(--bg);cursor:pointer;">${e}</button>`
      )
      .join('');
    const colorGrid = ['#6C2BD9', '#8B5CF6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6']
      .map(
        (c) =>
          `<button type="button" class="scrm-color" data-color="${c}" style="width:28px;height:28px;border-radius:50%;border:2px solid transparent;background:${c};cursor:pointer;"></button>`
      )
      .join('');

    const body = `
      <div class="field"><label>Niche</label>
        <select class="select" id="scrmNiche">
          <option value="">— No niche —</option>
          ${renderNicheOpts(niches)}
          <option value="__create__">+ Create new niche</option>
        </select>
      </div>
      <div id="scrmCreateNiche" class="hidden" style="padding:12px;border:1px dashed var(--border);border-radius:8px;margin-bottom:12px;">
        <div style="font-weight:600;margin-bottom:8px;">New niche</div>
        <div class="field"><label>Name</label>
          <input class="input" id="scrmNewNicheName" placeholder="e.g. Plumbers" />
        </div>
        <div class="field"><label>Icon</label>
          <div id="scrmEmojiGrid" style="display:flex;gap:6px;flex-wrap:wrap;">${emojiGrid}</div>
          <input type="hidden" id="scrmNewNicheIcon" value="🔧" />
        </div>
        <div class="field"><label>Color</label>
          <div id="scrmColorGrid" style="display:flex;gap:8px;flex-wrap:wrap;">${colorGrid}</div>
          <input type="hidden" id="scrmNewNicheColor" value="#6C2BD9" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="btn btn-outline" id="scrmCancelNiche">Cancel</button>
          <button type="button" class="btn btn-primary" id="scrmCreateNicheBtn">Create & Select</button>
        </div>
      </div>
      <div class="field"><label>Assign to</label>
        <select class="select" id="scrmAssignee"><option value="">— Unassigned —</option>${userOpts}</select>
      </div>
      <label class="lf-toggle" style="margin-top:6px;">
        <input type="checkbox" id="scrmFollowups" checked /><span class="track"></span>
        <div class="t-label">Schedule follow-ups automatically</div>
      </label>`;
    const footer = `
      <button class="btn btn-outline" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="scrmSaveBtn">Save ${leads.length} lead${leads.length === 1 ? '' : 's'}</button>`;
    const { close } = openModal({ title: 'Save Leads to CRM', body, footer });

    // Local cache of niches for this modal instance.
    let modalNiches = niches.slice();

    function markSelected(container, selector, attrName, selectedVal) {
      const nodes = container.querySelectorAll(selector);
      nodes.forEach((n) => {
        const match = n.getAttribute(attrName) === selectedVal;
        n.style.borderColor = match ? '#6C2BD9' : (attrName === 'data-color' ? 'transparent' : 'var(--border)');
        n.style.borderWidth = '2px';
        n.style.borderStyle = 'solid';
      });
    }

    const nicheSel = document.getElementById('scrmNiche');
    const createForm = document.getElementById('scrmCreateNiche');
    const iconHidden = document.getElementById('scrmNewNicheIcon');
    const colorHidden = document.getElementById('scrmNewNicheColor');

    nicheSel.addEventListener('change', () => {
      if (nicheSel.value === '__create__') {
        createForm.classList.remove('hidden');
        nicheSel.value = '';
        const nameInput = document.getElementById('scrmNewNicheName');
        if (nameInput) nameInput.focus();
      }
    });

    const emojiGridEl = document.getElementById('scrmEmojiGrid');
    emojiGridEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.scrm-emoji');
      if (!btn) return;
      iconHidden.value = btn.getAttribute('data-emoji');
      markSelected(emojiGridEl, '.scrm-emoji', 'data-emoji', iconHidden.value);
    });
    markSelected(emojiGridEl, '.scrm-emoji', 'data-emoji', iconHidden.value);

    const colorGridEl = document.getElementById('scrmColorGrid');
    colorGridEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.scrm-color');
      if (!btn) return;
      colorHidden.value = btn.getAttribute('data-color');
      markSelected(colorGridEl, '.scrm-color', 'data-color', colorHidden.value);
    });
    markSelected(colorGridEl, '.scrm-color', 'data-color', colorHidden.value);

    document.getElementById('scrmCancelNiche').addEventListener('click', () => {
      createForm.classList.add('hidden');
      document.getElementById('scrmNewNicheName').value = '';
    });

    document.getElementById('scrmCreateNicheBtn').addEventListener('click', async () => {
      const nameInput = document.getElementById('scrmNewNicheName');
      const name = (nameInput.value || '').trim();
      if (!name) return Toast.error('Enter a niche name');
      try {
        const r = await API.post('/niches', {
          name,
          icon: iconHidden.value,
          color: colorHidden.value,
        });
        const niche = r && r.niche;
        if (!niche) throw new Error('Unexpected response');
        modalNiches.push(niche);
        // Rebuild dropdown options
        nicheSel.innerHTML =
          '<option value="">— No niche —</option>' +
          renderNicheOpts(modalNiches) +
          '<option value="__create__">+ Create new niche</option>';
        nicheSel.value = niche.id;
        // Update outer cache so reopening the modal sees it too
        if (Array.isArray(lfNichesCache)) lfNichesCache.push(niche);
        createForm.classList.add('hidden');
        nameInput.value = '';
        Toast.success(`Niche "${niche.name}" created`);
      } catch (err) {
        Toast.error('Create failed: ' + err.message);
      }
    });

    document.getElementById('scrmSaveBtn').addEventListener('click', async () => {
      const nicheId = nicheSel.value && nicheSel.value !== '__create__' ? nicheSel.value : null;
      const assignedTo = document.getElementById('scrmAssignee').value || null;
      const scheduleFollowUps = !!document.getElementById('scrmFollowups').checked;
      const payload = { leads, nicheId, assignedTo, scheduleFollowUps };
      console.log('[saveToCRM] sending', {
        count: leads.length,
        nicheId,
        assignedTo,
        scheduleFollowUps,
      });
      try {
        const res = await API.post('/leads/save-results', payload);
        console.log('[saveToCRM] response', res);
        const saved = res.saved || 0;
        const skipped = res.skipped || 0;
        if (saved > 0 && skipped > 0) {
          Toast.success(`✅ ${saved} new lead${saved === 1 ? '' : 's'} saved · ℹ️ ${skipped} already in your CRM`);
        } else if (saved > 0) {
          Toast.success(`✅ ${saved} new lead${saved === 1 ? '' : 's'} saved`);
        } else if (skipped > 0) {
          Toast.show(
            `ℹ️ All ${skipped} lead${skipped === 1 ? ' is' : 's are'} already in your CRM (no duplicates created). Try a different location or niche.`,
            'warning'
          );
        } else {
          Toast.show('No leads saved', 'warning');
        }
        close();
        if (typeof onSaved === 'function') onSaved(res);
      } catch (err) {
        console.error('[saveToCRM] failed', err);
        Toast.error('Save failed: ' + err.message);
      }
    });
  }

  async function handleSendToBulk() {
    const leads = getSelectedLeads();
    if (leads.length === 0) return Toast.error('Select at least one lead');
    const withEmail = leads.filter(l => l.email && l.website);
    if (withEmail.length === 0) {
      return Toast.error('Selected leads need both a website and an email');
    }
    console.log('[sendToBulkAudit] sending', { count: withEmail.length });
    try {
      const res = await API.post('/leads/send-to-bulk', { leads: withEmail });
      console.log('[sendToBulkAudit] response', res);
      const jobId = res && res.jobId;
      if (!jobId) throw new Error('No jobId returned');
      Toast.success(`Bulk audit started for ${res.total || withEmail.length} site${(res.total || 1) === 1 ? '' : 's'}`);
      sessionStorage.setItem('activeBulkJobId', jobId);
      Router.navigate('bulk-audit');
    } catch (err) {
      console.error('[sendToBulkAudit] failed', err);
      Toast.error('Bulk send failed: ' + err.message);
    }
  }

  function applyLfQualityFilter() {
    const sel = document.getElementById('lfQualityFilter');
    const mode = sel ? sel.value : 'all';
    const body = document.getElementById('lfResultsBody');
    if (!body) return;
    body.querySelectorAll('tr[data-idx]').forEach((tr) => {
      const idx = parseInt(tr.dataset.idx, 10);
      const lead = lfResults[idx];
      if (!lead) return;
      const show = mode === 'all' || lead.emailQuality === mode;
      tr.style.display = show ? '' : 'none';
      // Deselect hidden rows so the "Save" count reflects what's visible.
      if (!show) {
        lfSelected.delete(idx);
        const cb = tr.querySelector('.lf-checkbox');
        if (cb) cb.checked = false;
      }
    });
    updateSelectedCount();
  }

  function wireLeadFinder() {
    if (document.getElementById('lfSearchBtn').dataset.wired) return;
    document.getElementById('lfSearchBtn').dataset.wired = '1';
    document.getElementById('lfSearchBtn').addEventListener('click', () => handleSearch({ offset: 1 }));
    const qf = document.getElementById('lfQualityFilter');
    if (qf) qf.addEventListener('change', applyLfQualityFilter);
    document.getElementById('lfCancelBtn').addEventListener('click', () => {
      if (lfPollTimer) clearTimeout(lfPollTimer);
      lfJobId = null;
      resetLfProgress();
      Toast.info('Search cancelled');
    });
    ['lfSrcBing', 'lfSrcGoogle', 'lfLimit'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updateEstimate);
      if (el && id === 'lfLimit') el.addEventListener('input', updateEstimate);
    });
    document.querySelectorAll('[data-lf-count]').forEach(btn => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.getAttribute('data-lf-count'), 10);
        const input = document.getElementById('lfLimit');
        if (input) input.value = n;
        document.querySelectorAll('[data-lf-count]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        updateEstimate();
      });
    });
    document.getElementById('lfSelectAllBtn').addEventListener('click', () => {
      document.querySelectorAll('#lfResultsBody .lf-checkbox').forEach(cb => {
        cb.checked = true; lfSelected.add(parseInt(cb.dataset.idx, 10));
      });
      updateSelectedCount();
    });
    document.getElementById('lfDeselectAllBtn').addEventListener('click', () => {
      document.querySelectorAll('#lfResultsBody .lf-checkbox').forEach(cb => {
        cb.checked = false;
      });
      lfSelected.clear();
      updateSelectedCount();
    });
    document.getElementById('lfSaveBtn').addEventListener('click', () => openSaveToCrmModal());
    document.getElementById('lfBulkBtn').addEventListener('click', handleSendToBulk);
  }

  async function initLeadFinder() {
    wireLeadFinder();
    updateEstimate();
    await loadTokenStatus();
    loadSearchHistory();
  }

  // ==================== LEAD CRM ====================
  let lcState = { page: 1, limit: 20, search: '', status: '', niche: '', campaign: '' };

  function leadStatusBadge(s) {
    const map = { new: '🆕', opened: '👁', replied: '💬', audited: '📧', converted: '✅', cold: '❌' };
    return `<span class="lead-status ${esc(s)}">${map[s] || ''} ${esc(s)}</span>`;
  }

  function renderCrmStats(st) {
    const row = document.getElementById('lcStatsRow');
    if (!row) return;
    const bs = st.byStatus || {};
    row.innerHTML = [
      statCard('users', 'purple', 'Total', st.total || 0),
      statCard('star', 'blue', 'New', bs.new || 0),
      statCard('mail', 'green', 'Audited', bs.audited || 0),
      statCard('check', 'orange', 'This Month', st.thisMonth || 0),
    ].join('');
  }

  function statCard(iconKind, cls, label, num) {
    const icons = {
      users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
      mail: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 5L2 7"/></svg>',
      check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
      star: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    };
    return `
      <div class="card stat-card">
        <div class="top">
          <div class="icon-circle ${cls}">${icons[iconKind] || ''}</div>
        </div>
        <div class="num">${num}</div>
        <div class="label">${esc(label)}</div>
      </div>`;
  }

  async function loadCrmStats() {
    try {
      const st = await API.get('/leads/stats');
      renderCrmStats(st);
    } catch (err) {
      const row = document.getElementById('lcStatsRow');
      if (row) row.innerHTML = '';
    }
  }

  async function populateNicheFilter() {
    try {
      const r = await API.get('/niches');
      const sel = document.getElementById('lcNiche');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">All niches</option>' +
        (r.niches || []).map(n => `<option value="${esc(n.id)}">${esc(n.icon || '')} ${esc(n.name)}</option>`).join('');
      if (current) sel.value = current;
    } catch {}
  }

  async function populateCampaignFilter() {
    try {
      const sel = document.getElementById('lcCampaign');
      if (!sel) return;
      const r = await API.get('/pipeline/campaigns?limit=100');
      const current = sel.value;
      sel.innerHTML = '<option value="">All campaigns</option>' +
        (r.campaigns || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      if (current) sel.value = current;
    } catch {}
  }

  async function loadLeads() {
    const params = new URLSearchParams();
    params.set('page', lcState.page);
    params.set('limit', lcState.limit);
    if (lcState.search) params.set('search', lcState.search);
    if (lcState.status) params.set('status', lcState.status);
    if (lcState.niche) params.set('niche', lcState.niche);
    if (lcState.campaign) params.set('campaign_id', lcState.campaign);

    const body = document.getElementById('lcTableBody');
    if (body) body.innerHTML = '<tr><td colspan="8" class="empty-state">Loading...</td></tr>';

    try {
      const r = await API.get('/leads?' + params.toString());
      renderLeadsTable(r.leads || []);
      renderLeadsCards(r.leads || []);
      renderPagination(r);
    } catch (err) {
      if (body) body.innerHTML = `<tr><td colspan="8" class="empty-state">${esc(err.message)}</td></tr>`;
    }
  }

  function renderLeadsTable(leads) {
    const body = document.getElementById('lcTableBody');
    if (!body) return;
    if (leads.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="empty-state">No leads match your filters.</td></tr>';
      return;
    }
    const isAdmin = Auth.getUser().role === 'admin';
    body.innerHTML = leads.map(l => `
      <tr>
        <td><div style="font-weight:700;color:var(--text);">${esc(l.business_name || '—')}</div><div style="font-size:11px;color:var(--muted);">${esc((l.website || '').replace(/^https?:\/\//,'').slice(0,40))}</div></td>
        <td>${esc(l.email || '—')}</td>
        <td>${esc(l.phone || '—')}</td>
        <td>${nicheCell(l)}</td>
        <td>${leadStatusBadge(l.status || 'new')}</td>
        <td>${fmtDate(l.last_email_at || l.updated_at)}</td>
        <td>${esc(l.assigned_name || '—')}</td>
        <td><div class="actions">
          <button class="action-btn" data-view-lead="${esc(l.id)}" title="View"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="action-btn" data-audit-lead="${esc(l.id)}" data-audit-url="${esc(l.website || '')}" data-audit-name="${esc(l.business_name || '')}" data-audit-email="${esc(l.email || '')}" title="Run audit"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></button>
          ${isAdmin ? `<button class="action-btn danger" data-delete-lead="${esc(l.id)}" title="Delete"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>` : ''}
        </div></td>
      </tr>`).join('');
    body.querySelectorAll('[data-view-lead]').forEach(b => b.addEventListener('click', () => openLeadDetail(b.dataset.viewLead)));
    body.querySelectorAll('[data-audit-lead]').forEach(b => b.addEventListener('click', () => runLeadAudit({
      id: b.dataset.auditLead,
      website: b.dataset.auditUrl,
      businessName: b.dataset.auditName,
      email: b.dataset.auditEmail,
      btn: b,
    })));
    body.querySelectorAll('[data-delete-lead]').forEach(b => b.addEventListener('click', () => deleteLead(b.dataset.deleteLead)));
  }

  // Renders the niche column with safe icon handling:
  // when no niche, shows "—"; if the stored icon is ASCII garbage
  // (e.g. "??" from a mojibaked emoji), we drop the icon rather than
  // render "?? Name".
  function nicheCell(l) {
    if (!l || !l.niche_name) return '<span style="color:var(--muted);">—</span>';
    const rawIcon = l.niche_icon || '';
    const iconOk = rawIcon && /[^\x00-\x7F]/.test(rawIcon); // has any non-ASCII
    const icon = iconOk ? rawIcon : '';
    return esc((icon ? icon + ' ' : '') + l.niche_name);
  }

  async function runLeadAudit(info) {
    if (!info || !info.website) {
      return Toast.error('This lead has no website — cannot audit');
    }
    const bn = info.businessName || info.website;
    const email = info.email || '(no email)';
    if (!confirm(`Run audit for ${bn} and send report to ${email}?`)) return;

    const btn = info.btn;
    const originalHtml = btn ? btn.innerHTML : null;
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '…';
      }
      const res = await API.post('/audit/single', {
        websiteUrl: info.website,
        clientName: info.businessName || null,
        clientEmail: info.email || null,
      });
      try {
        await API.put('/leads/' + info.id, { status: 'audited' });
      } catch {}
      Toast.success(`✅ Audit complete (score ${res.overallScore}).`);
      loadLeads();
      loadCrmStats();
    } catch (err) {
      Toast.error('Audit failed: ' + err.message);
    } finally {
      if (btn && originalHtml != null) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    }
  }

  function renderLeadsCards(leads) {
    const wrap = document.getElementById('lcCardsWrap');
    if (!wrap) return;
    if (leads.length === 0) {
      wrap.innerHTML = '<div class="empty-state">No leads match your filters.</div>';
      return;
    }
    wrap.innerHTML = leads.map(l => `
      <div class="lead-card" data-view-lead="${esc(l.id)}">
        <div class="top">
          <div><div class="name">${esc(l.business_name || '—')}</div>
          <div class="meta">${esc(l.email || '—')} · ${esc(l.phone || '—')}</div></div>
          ${leadStatusBadge(l.status || 'new')}
        </div>
        <div class="row">
          ${l.niche_name ? `<span style="font-size:11px;color:var(--muted);">${nicheCell(l)}</span>` : ''}
          <span style="font-size:11px;color:var(--muted);margin-left:auto;">${fmtDate(l.updated_at)}</span>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('[data-view-lead]').forEach(c => c.addEventListener('click', () => openLeadDetail(c.dataset.viewLead)));
  }

  function renderPagination(r) {
    const el = document.getElementById('lcPagination');
    if (!el) return;
    const page = r.page || 1, pages = r.pages || 1, total = r.total || 0;
    el.innerHTML = `
      <div>Showing page ${page} of ${pages} (${total} leads)</div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-outline btn-sm" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">Previous</button>
        <button class="btn btn-outline btn-sm" ${page >= pages ? 'disabled' : ''} data-page="${page + 1}">Next</button>
      </div>`;
    el.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {
      if (b.disabled) return;
      lcState.page = parseInt(b.dataset.page, 10);
      loadLeads();
    }));
  }

  async function openLeadDetail(id) {
    const body = `<div id="ldContent" style="font-size:13px;color:var(--muted);">Loading lead...</div>`;
    const { close, backdrop } = openModal({ title: 'Lead Details', body, maxWidth: '640px' });
    try {
      const res = await API.get('/leads/' + id);
      const l = res.lead;
      const isAdmin = Auth.getUser().role === 'admin';
      const tracking = res.tracking || [];
      const followUps = res.followUps || [];
      const statusOpts = ['new','opened','replied','audited','converted','cold']
        .map(s => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${s}</option>`).join('');

      const timeline = (() => {
        const items = [];
        if (l.audit_sent) {
          items.push({ title: 'Audit report sent', sub: fmtDateTime(l.audit_sent_at), t: l.audit_sent_at });
        }
        for (const t of tracking) {
          const opens = t.open_count ? `opened ${t.open_count}×` : 'not opened';
          items.push({ title: esc(t.email_type), sub: `${fmtDateTime(t.sent_at)} — ${opens}`, t: t.sent_at });
        }
        for (const q of followUps) {
          items.push({ title: `Follow-up #${q.email_number} — ${q.status}`, sub: fmtDateTime(q.scheduled_at), t: q.scheduled_at });
        }
        if (items.length === 0) return '<div style="font-size:12px;color:var(--muted);">No email activity yet.</div>';
        return '<div class="timeline">' + items.map(i =>
          `<div class="timeline-item"><div class="ti-dot"></div><div class="ti-body"><div class="ti-title">${esc(i.title)}</div><div class="ti-sub">${esc(i.sub)}</div></div></div>`
        ).join('') + '</div>';
      })();

      backdrop.querySelector('#ldContent').innerHTML = `
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">Business</div>
        <div style="font-size:16px;font-weight:700;color:var(--text);margin-bottom:2px;">${esc(l.business_name || '—')}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px;">${esc(l.website || '')}</div>
        <div class="grid-2">
          <div class="field"><label>Email</label><div style="font-size:13px;color:var(--text);">${esc(l.email || '—')}</div></div>
          <div class="field"><label>Phone</label><div style="font-size:13px;color:var(--text);">${esc(l.phone || '—')}</div></div>
          <div class="field"><label>Niche</label><div style="font-size:13px;color:var(--text);">${esc(l.niche_name || '—')}</div></div>
          <div class="field"><label>Assigned to</label><div style="font-size:13px;color:var(--text);">${esc(l.assigned_name || '—')}</div></div>
        </div>
        <div class="field"><label>Status</label>
          <select class="select" id="ldStatus">${statusOpts}</select>
        </div>
        <div class="field"><label>Notes</label>
          <textarea class="input" id="ldNotes" style="min-height:90px;">${esc(l.notes || '')}</textarea>
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--text);margin:8px 0 6px 0;">Email history</div>
        ${timeline}
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;">
          ${l.email && l.website ? `<button class="btn btn-primary btn-sm" id="ldSendAudit">Send to Audit</button>` : ''}
          <button class="btn btn-outline btn-sm" id="ldConvert">Mark Converted</button>
          <button class="btn btn-outline btn-sm" id="ldCold">Mark Cold</button>
          <button class="btn btn-primary btn-sm" id="ldSaveBtn" style="margin-left:auto;">Save changes</button>
        </div>`;

      backdrop.querySelector('#ldSaveBtn').addEventListener('click', async () => {
        try {
          await API.put('/leads/' + id, {
            status: document.getElementById('ldStatus').value,
            notes: document.getElementById('ldNotes').value,
          });
          Toast.success('Lead updated');
          close();
          loadLeads();
          loadCrmStats();
        } catch (err) { Toast.error(err.message); }
      });
      const convert = backdrop.querySelector('#ldConvert');
      if (convert) convert.addEventListener('click', async () => {
        try { await API.put('/leads/' + id, { status: 'converted' }); Toast.success('Marked converted'); close(); loadLeads(); loadCrmStats(); }
        catch (e) { Toast.error(e.message); }
      });
      const cold = backdrop.querySelector('#ldCold');
      if (cold) cold.addEventListener('click', async () => {
        try { await API.put('/leads/' + id, { status: 'cold' }); Toast.success('Marked cold'); close(); loadLeads(); loadCrmStats(); }
        catch (e) { Toast.error(e.message); }
      });
      const send = backdrop.querySelector('#ldSendAudit');
      if (send) send.addEventListener('click', async () => {
        try {
          const { jobId } = await API.post('/leads/send-to-bulk', { leadIds: [id] });
          Toast.success('Audit queued');
          sessionStorage.setItem('activeBulkJobId', jobId);
          close();
          Router.navigate('bulk-audit');
        } catch (e) { Toast.error(e.message); }
      });
    } catch (err) {
      backdrop.querySelector('#ldContent').innerHTML = `<div style="color:var(--bad);">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  async function deleteLead(id) {
    if (!confirm('Delete this lead and all related tracking data?')) return;
    try {
      await API.delete('/leads/' + id);
      Toast.success('Lead deleted');
      loadLeads();
      loadCrmStats();
    } catch (err) { Toast.error(err.message); }
  }

  async function clearAllLeads() {
    const user = Auth.getUser();
    if (!user || user.role !== 'admin') return;
    let total = 0;
    try {
      const st = await API.get('/leads/stats');
      total = (st && st.total) || 0;
    } catch {}
    if (total === 0) {
      Toast.show('No leads to delete', 'warning');
      return;
    }
    if (!confirm(`Delete all ${total} lead${total === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try {
      const r = await API.delete('/leads/clear-all');
      Toast.success(`Deleted ${r.deleted || 0} lead${r.deleted === 1 ? '' : 's'}`);
      loadLeads();
      loadCrmStats();
    } catch (err) {
      Toast.error('Clear failed: ' + err.message);
    }
  }

  function wireLeadCRM() {
    if (document.getElementById('lcSearch').dataset.wired) return;
    document.getElementById('lcSearch').dataset.wired = '1';

    const clearBtn = document.getElementById('lcClearAllBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearAllLeads);

    let searchDebounce;
    document.getElementById('lcSearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        lcState.search = e.target.value.trim();
        lcState.page = 1;
        loadLeads();
      }, 300);
    });
    document.getElementById('lcStatus').addEventListener('change', (e) => {
      lcState.status = e.target.value; lcState.page = 1; loadLeads();
    });
    document.getElementById('lcNiche').addEventListener('change', (e) => {
      lcState.niche = e.target.value; lcState.page = 1; loadLeads();
    });
    const campaignSel = document.getElementById('lcCampaign');
    if (campaignSel) {
      campaignSel.addEventListener('change', (e) => {
        lcState.campaign = e.target.value; lcState.page = 1; loadLeads();
      });
    }
    document.getElementById('lcResetBtn').addEventListener('click', () => {
      document.getElementById('lcSearch').value = '';
      document.getElementById('lcStatus').value = '';
      document.getElementById('lcNiche').value = '';
      if (campaignSel) campaignSel.value = '';
      lcState = { page: 1, limit: 20, search: '', status: '', niche: '', campaign: '' };
      loadLeads();
    });
  }

  async function initLeadCRM() {
    wireLeadCRM();
    await populateNicheFilter();
    await populateCampaignFilter();
    const pending = sessionStorage.getItem('pendingCrmCampaignId');
    if (pending) {
      sessionStorage.removeItem('pendingCrmCampaignId');
      const sel = document.getElementById('lcCampaign');
      if (sel) sel.value = pending;
      lcState.campaign = pending;
      lcState.page = 1;
    }
    loadCrmStats();
    loadLeads();
  }

  // ==================== FOLLOW-UPS ====================
  let fuTab = 'pending';

  async function loadFollowUps() {
    const body = document.getElementById('fuTableBody');
    if (body) body.innerHTML = '<tr><td colspan="6" class="empty-state">Loading...</td></tr>';
    try {
      const r = await API.get('/followups?status=' + fuTab);
      renderFollowUps(r.followUps || []);
      renderFuStats(r.followUps || []);
    } catch (err) {
      if (body) body.innerHTML = `<tr><td colspan="6" class="empty-state">${esc(err.message)}</td></tr>`;
    }
  }

  function renderFuStats(rows) {
    const row = document.getElementById('fuStatsRow');
    if (!row) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const endOfToday = new Date(today); endOfToday.setDate(endOfToday.getDate() + 1);
    const scheduledToday = rows.filter(r => r.status === 'pending' && r.scheduled_at && new Date(r.scheduled_at) < endOfToday).length;
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
    const sentWeek = rows.filter(r => r.status === 'sent' && r.sent_at && new Date(r.sent_at) >= weekAgo).length;
    const total = rows.length;
    const sent = rows.filter(r => r.status === 'sent').length;
    const successRate = total ? Math.round((sent / total) * 100) : 0;
    const tracking = new Set(rows.map(r => r.lead_id)).size;
    row.innerHTML = [
      statCard('users', 'purple', 'Leads Tracking', tracking),
      statCard('mail', 'blue', 'Scheduled Today', scheduledToday),
      statCard('check', 'green', 'Sent This Week', sentWeek),
      statCard('star', 'orange', 'Success Rate', successRate + '%'),
    ].join('');
  }

  function relativeWhen(ts) {
    if (!ts) return '—';
    const d = new Date(ts); const now = new Date();
    const diffMs = d - now; const days = Math.round(diffMs / 86400000);
    if (days < 0) return `overdue by ${Math.abs(days)}d`;
    if (days === 0) return 'today';
    return `in ${days}d`;
  }

  function renderFollowUps(rows) {
    const body = document.getElementById('fuTableBody');
    if (!body) return;
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="empty-state">No follow-ups in this tab.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(r => `
      <tr>
        <td><div style="font-weight:700;color:var(--text);">${esc(r.business_name || '—')}</div></td>
        <td>${esc(r.email || '—')}</td>
        <td><span class="fu-badge n${r.email_number}">#${r.email_number}</span></td>
        <td><div>${fmtDate(r.scheduled_at)}</div><div style="font-size:11px;color:var(--muted);">${relativeWhen(r.scheduled_at)}</div></td>
        <td><span class="lead-status ${r.status === 'pending' ? 'new' : (r.status === 'sent' ? 'audited' : 'cold')}">${esc(r.status)}</span></td>
        <td>${r.status === 'pending' ? `<button class="btn btn-outline btn-sm" data-cancel-fu="${esc(r.id)}">Cancel</button>` : ''}</td>
      </tr>`).join('');
    body.querySelectorAll('[data-cancel-fu]').forEach(b => b.addEventListener('click', async () => {
      try { await API.post('/followups/' + b.dataset.cancelFu + '/cancel'); Toast.success('Follow-up cancelled'); loadFollowUps(); }
      catch (e) { Toast.error(e.message); }
    }));
  }

  async function loadFuSettings() {
    try {
      const s = await API.get('/settings');
      if (!s) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      set('fuDelay1', s.follow_up_delay_1);
      set('fuDelay2', s.follow_up_delay_2);
      set('fuDelay3', s.follow_up_delay_3);
      set('fuDelay4', s.follow_up_delay_4);
      const enabled = document.getElementById('fuEnabled');
      if (enabled) enabled.checked = s.follow_up_enabled !== 'false';
    } catch {}
  }

  async function saveFuSettings() {
    const payload = {
      follow_up_delay_1: document.getElementById('fuDelay1').value || '3',
      follow_up_delay_2: document.getElementById('fuDelay2').value || '5',
      follow_up_delay_3: document.getElementById('fuDelay3').value || '7',
      follow_up_delay_4: document.getElementById('fuDelay4').value || '10',
      follow_up_enabled: document.getElementById('fuEnabled').checked ? 'true' : 'false',
    };
    try { await API.put('/settings', payload); Toast.success('Follow-up settings saved'); }
    catch (err) { Toast.error(err.message); }
  }

  function wireFollowUps() {
    const tabs = document.getElementById('fuTabs');
    if (!tabs || tabs.dataset.wired) return;
    tabs.dataset.wired = '1';
    tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      tabs.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      fuTab = b.dataset.tab;
      loadFollowUps();
    }));
    const save = document.getElementById('fuSaveBtn');
    if (save) save.addEventListener('click', saveFuSettings);
  }

  async function initFollowUps() {
    wireFollowUps();
    loadFuSettings();
    loadFollowUps();
  }

  // ==================== NICHES ====================
  const ICON_SET = ['🔧','🏥','⚖️','🏠','🦷','💇','🍕','🚗','💻','📱','🏋️','🌿','🎓','💰','🏗️','🔌','🚿','🌸','👗','🏪'];
  const COLOR_SET = ['#6C2BD9','#DC2626','#16A34A','#F59E0B','#2563EB','#0D9488','#EA580C','#DB2777'];

  async function loadNiches() {
    const grid = document.getElementById('nicheGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="empty-state">Loading niches...</div>';
    try {
      const r = await API.get('/niches');
      const niches = r.niches || [];
      if (niches.length === 0) {
        grid.innerHTML = '<div class="empty-state"><h3>No niches yet</h3><p>Create your first niche to group leads by industry.</p></div>';
        return;
      }
      grid.innerHTML = niches.map(n => {
        const leadCount = n.lead_count || 0;
        const color = n.color || '#6C2BD9';
        return `
          <div class="niche-card" style="border-left-color:${esc(color)};">
            <div class="top">
              <div class="ico">${esc(n.icon || '📌')}</div>
              <div style="flex:1;min-width:0;">
                <div class="name">${esc(n.name)}</div>
                <div class="sub">${n.assigned_name ? 'Assigned: ' + esc(n.assigned_name) : 'Unassigned'}</div>
              </div>
            </div>
            <div class="counts"><span><b>${leadCount}</b>leads</span></div>
            <div class="foot">
              <button class="btn btn-outline btn-sm" data-edit-niche="${esc(n.id)}">Edit</button>
              <button class="btn btn-outline btn-sm" data-delete-niche="${esc(n.id)}" style="color:var(--bad);border-color:#FEE2E2;">Delete</button>
            </div>
          </div>`;
      }).join('');
      grid.querySelectorAll('[data-edit-niche]').forEach(b => b.addEventListener('click', () => {
        const n = niches.find(x => x.id === b.dataset.editNiche);
        if (n) openNicheModal(n);
      }));
      grid.querySelectorAll('[data-delete-niche]').forEach(b => b.addEventListener('click', () => deleteNiche(b.dataset.deleteNiche)));
    } catch (err) {
      grid.innerHTML = `<div class="empty-state" style="color:var(--bad);">${esc(err.message)}</div>`;
    }
  }

  async function openNicheModal(existing) {
    let users = [];
    try { const u = await API.get('/users').catch(() => []); users = Array.isArray(u) ? u : (u.users || []); } catch {}
    const userOpts = '<option value="">— Unassigned —</option>' + users.map(u =>
      `<option value="${esc(u.id)}" ${existing && existing.assigned_to === u.id ? 'selected' : ''}>${esc(u.name)}</option>`
    ).join('');

    const iconButtons = ICON_SET.map(i =>
      `<button type="button" data-icon="${i}" class="${existing && existing.icon === i ? 'selected' : ''}">${i}</button>`
    ).join('');
    const colorButtons = COLOR_SET.map(c =>
      `<button type="button" data-color="${c}" style="background:${c};" class="${existing && existing.color === c ? 'selected' : ''}"></button>`
    ).join('');

    const body = `
      <div class="field"><label>Niche name</label><input class="input" id="nmName" value="${esc(existing ? existing.name : '')}" placeholder="e.g. Plumbers" /></div>
      <div class="field"><label>Icon</label><div class="icon-picker" id="nmIcons">${iconButtons}</div></div>
      <div class="field"><label>Color</label><div class="color-picker" id="nmColors">${colorButtons}</div></div>
      <div class="field"><label>Assign to</label><select class="select" id="nmAssignee">${userOpts}</select></div>`;
    const footer = `
      <button class="btn btn-outline" data-modal-close>Cancel</button>
      <button class="btn btn-primary" id="nmSaveBtn">${existing ? 'Save' : 'Create'}</button>`;
    const { backdrop, close } = openModal({ title: existing ? 'Edit Niche' : 'Add Niche', body, footer });

    let selIcon = existing ? existing.icon : null;
    let selColor = existing ? existing.color : null;
    backdrop.querySelectorAll('#nmIcons button').forEach(b => b.addEventListener('click', () => {
      backdrop.querySelectorAll('#nmIcons button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected'); selIcon = b.dataset.icon;
    }));
    backdrop.querySelectorAll('#nmColors button').forEach(b => b.addEventListener('click', () => {
      backdrop.querySelectorAll('#nmColors button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected'); selColor = b.dataset.color;
    }));
    backdrop.querySelector('#nmSaveBtn').addEventListener('click', async () => {
      const name = document.getElementById('nmName').value.trim();
      if (!name) return Toast.error('Name is required');
      const payload = {
        name,
        icon: selIcon || null,
        color: selColor || null,
        assigned_to: document.getElementById('nmAssignee').value || null,
      };
      try {
        if (existing) await API.put('/niches/' + existing.id, payload);
        else await API.post('/niches', payload);
        Toast.success(existing ? 'Niche updated' : 'Niche created');
        close();
        loadNiches();
      } catch (err) { Toast.error(err.message); }
    });
  }

  async function deleteNiche(id) {
    if (!confirm('Delete this niche?')) return;
    try {
      await API.delete('/niches/' + id);
      Toast.success('Niche deleted');
      loadNiches();
    } catch (err) { Toast.error(err.message); }
  }

  function wireNiches() {
    const btn = document.getElementById('nicheAddBtn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => openNicheModal(null));
  }

  async function initNiches() {
    wireNiches();
    loadNiches();
  }

  // ==================== NOTIFICATIONS ====================
  let notifItems = [];
  let notifSSE = null;

  function renderNotifBadge() {
    const dot = document.getElementById('notifDot');
    if (!dot) return;
    const unread = notifItems.filter(n => !n.read).length;
    if (unread > 0) {
      dot.textContent = unread > 99 ? '99+' : String(unread);
      dot.style.display = 'flex';
    } else {
      dot.style.display = 'none';
    }
  }

  function renderNotifList() {
    const list = document.getElementById('notifList');
    if (!list) return;
    if (notifItems.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }
    list.innerHTML = notifItems.slice(0, 30).map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" data-lead-id="${esc(n.leadId || '')}">
        <div class="dot"></div>
        <div class="msg">${esc(n.message)}
          <div class="meta">${fmtDateTime(n.createdAt)}</div>
        </div>
      </div>`).join('');
    list.querySelectorAll('.notif-item').forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.leadId;
      if (id) {
        Router.navigate('lead-crm');
        setTimeout(() => openLeadDetail(id), 300);
      }
    }));
  }

  function addNotif(n) {
    notifItems.unshift({ ...n, read: false });
    if (notifItems.length > 50) notifItems.length = 50;
    renderNotifBadge();
    renderNotifList();
    Toast.info(n.message);
  }

  async function markAllNotifsRead() {
    try { await API.post('/notifications/read'); } catch {}
    notifItems.forEach(n => n.read = true);
    renderNotifBadge();
    renderNotifList();
  }

  function connectNotifSSE() {
    if (notifSSE) return;
    const token = Auth.getToken();
    if (!token) return;
    const base = (window.CONFIG && CONFIG.API_BASE) || '/api';
    try {
      notifSSE = new EventSource(base + '/notifications/stream?token=' + encodeURIComponent(token));
      notifSSE.onmessage = (ev) => {
        if (!ev.data) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'notification' && msg.notification) addNotif(msg.notification);
          else if (msg.type === 'pending' && Array.isArray(msg.notifications)) {
            msg.notifications.forEach(n => notifItems.unshift({ ...n, read: false }));
            renderNotifBadge(); renderNotifList();
          }
        } catch {}
      };
      notifSSE.onerror = () => {
        if (notifSSE) { notifSSE.close(); notifSSE = null; }
        setTimeout(connectNotifSSE, 5000);
      };
    } catch {}
  }

  async function loadInitialNotifs() {
    try {
      const r = await API.get('/notifications');
      (r.notifications || []).forEach(n => notifItems.unshift({ ...n, read: false }));
      renderNotifBadge();
      renderNotifList();
    } catch {}
  }

  function initNotifications() {
    const bell = document.getElementById('notifBell');
    const dropdown = document.getElementById('notifDropdown');
    const markAll = document.getElementById('notifMarkAllBtn');
    if (!bell || !dropdown) return;
    if (bell.dataset.wired) return;
    bell.dataset.wired = '1';

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== bell) dropdown.classList.remove('open');
    });
    if (markAll) markAll.addEventListener('click', markAllNotifsRead);

    loadInitialNotifs();
    connectNotifSSE();
  }

  // ==================== EXPORTS ====================
  window.initLeadFinder = initLeadFinder;
  window.initLeadCRM = initLeadCRM;
  window.initFollowUps = initFollowUps;
  window.initNiches = initNiches;
  window.initNotifications = initNotifications;
})();
