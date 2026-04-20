// =================================================================
// AuditPro — Theme + Router + Navigation + Dashboard
// Depends on: app.js (Theme, Auth, API, Toast, Modal, Utils, Skeleton)
// =================================================================

// Short nav name → full view section ID.
// (nav items use `data-view="dashboard"` etc. but section ids are `view-*`)
function resolveViewId(viewId) {
  if (!viewId) return null;
  if (document.getElementById(viewId)) return viewId;
  if (viewId === 'dashboard') {
    const u = Auth.getUser();
    return u.role === 'admin' ? 'view-dashboard-admin' : 'view-dashboard-sales';
  }
  const prefixed = 'view-' + viewId;
  if (document.getElementById(prefixed)) return prefixed;
  return null;
}

function viewKeyFor(sectionId) {
  if (sectionId === 'view-dashboard-admin' || sectionId === 'view-dashboard-sales') return 'dashboard';
  if (sectionId && sectionId.startsWith('view-')) return sectionId.slice(5);
  return sectionId;
}

// =================================================================
// ROUTER
// =================================================================
const Router = {
  views: {},

  register(viewId, loadFn) {
    this.views[viewId] = loadFn;
  },

  navigate(requested) {
    const sectionId = resolveViewId(requested);
    if (!sectionId) return;

    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
      v.classList.add('hidden');
    });

    const target = document.getElementById(sectionId);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('active', 'animate-fadeInUp');
      setTimeout(() => target.classList.remove('animate-fadeInUp'), 300);
    }

    // Highlight matching nav items (by short key, e.g. "dashboard")
    const navKey = viewKeyFor(sectionId);
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.view === navKey);
    });
    document.querySelectorAll('.tab-bar-item, .bottom-tabs button').forEach(item => {
      item.classList.toggle('active', item.dataset.view === navKey);
    });

    const titles = {
      'dashboard': 'Dashboard',
      'new-audit': 'New Audit',
      'bulk-audit': 'Bulk Audit',
      'reports': 'Reports',
      'team': 'Team',
      'settings': 'Settings',
      'profile': 'Profile',
      'lead-finder': 'Lead Finder',
      'lead-crm': 'Lead CRM',
      'follow-ups': 'Follow-ups',
      'niches': 'Niches',
      'pipeline': 'Auto Pipeline',
    };
    const titleEl = document.getElementById('page-title') || document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = titles[navKey] || 'AuditPro';

    if (window.location.hash !== '#' + navKey) {
      window.location.hash = navKey;
    }

    const loader = this.views[sectionId] || this.views[navKey];
    if (typeof loader === 'function') {
      try { loader(); } catch (err) { console.error('View loader error:', err); }
    }

    // Close mobile sidebar
    if (window.innerWidth < 768) {
      const sb = document.querySelector('.sidebar');
      const ov = document.querySelector('.sidebar-overlay') || document.getElementById('drawerBackdrop');
      if (sb) sb.classList.remove('open');
      if (ov) ov.classList.remove('open', 'show');
    }
  },

  init() {
    const hash = window.location.hash.replace('#', '');
    document.querySelectorAll('[data-view]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (el.tagName === 'A') e.preventDefault();
        this.navigate(el.dataset.view);
      });
    });

    if (hash) this.navigate(hash);
    else this.navigate('dashboard');

    window.addEventListener('hashchange', () => {
      const h = window.location.hash.replace('#', '');
      if (h) this.navigate(h);
    });
  },
};

// Expose Router on window so DevTools + other scripts can reach it,
// and provide a `navigateTo` alias for legacy HTML that used the inline router.
window.Router = Router;
window.navigateTo = (v) => Router.navigate(v);

// =================================================================
// MOBILE SIDEBAR
// =================================================================
function initMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay') || document.getElementById('drawerBackdrop');
  const hamburger = document.querySelector('.hamburger') || document.getElementById('hamburger');

  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => {
      sidebar.classList.add('open');
      if (overlay) overlay.classList.add('open', 'show');
    });
  }
  if (overlay && sidebar) {
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('open', 'show');
    });
  }

  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;
  document.addEventListener('touchstart', (e) => {
    if (e.touches[0].clientX < 20) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      tracking = true;
    }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (dx > 60 && dy < 40 && sidebar) {
      sidebar.classList.add('open');
      if (overlay) overlay.classList.add('open', 'show');
    }
  }, { passive: true });
}

// =================================================================
// USER DISPLAY
// =================================================================
function updateUserDisplay(user) {
  if (!user) return;
  const ini = Utils.getInitials(user.name);

  // data-user-* attribute targets
  document.querySelectorAll('[data-user-initials]').forEach(el => { el.textContent = ini; });
  document.querySelectorAll('[data-user-name]').forEach(el => { el.textContent = user.name || 'User'; });
  document.querySelectorAll('[data-user-role]').forEach(el => { el.textContent = (user.role || '').toUpperCase(); });
  document.querySelectorAll('[data-user-email]').forEach(el => { el.textContent = user.email || ''; });

  // Direct ID targets from dashboard.html
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('sideAvatar', ini);
  set('sideName', user.name || 'User');
  set('sideRole', (user.role || '').toUpperCase());
  set('topAvatar', ini);
  set('topName', user.name || 'User');

  // Hide admin-only nav items for non-admins
  const isAdmin = user.role === 'admin';
  document.querySelectorAll('[data-admin-only], .admin-only').forEach(el => { el.style.display = isAdmin ? '' : 'none'; });
}

// =================================================================
// KEYBOARD SHORTCUTS
// =================================================================
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const search = document.querySelector('.top-header input, .topbar input, [data-search-input]');
      if (search) search.focus();
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      Router.navigate('new-audit');
    }
    if (e.key === 'Escape') {
      Modal.closeAll();
      document.querySelectorAll('.modal-backdrop.show').forEach(m => m.classList.remove('show'));
    }
  });
}

// =================================================================
// DASHBOARD RENDERING
// =================================================================
const DASHBOARD_ICONS = {
  chart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>',
  mail:  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 5L2 7"/></svg>',
  users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
  fileText: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function buildStatCard(icon, iconClass, label, num) {
  return `
    <div class="card stat-card">
      <div class="stat-icon ${iconClass}">${icon}</div>
      <div class="stat-value">${num}</div>
      <div class="stat-label">${Utils.escapeHtml(label)}</div>
    </div>`;
}

function buildRecentReportsCards(reports) {
  if (!reports || reports.length === 0) {
    return `<div class="empty-state">
      <div class="empty-icon">${DASHBOARD_ICONS.fileText}</div>
      <div class="empty-title">No reports yet</div>
      <div class="empty-desc">Run your first audit to see it here.</div>
    </div>`;
  }
  return reports.map(r => {
    const score = r.overall_score || 0;
    const color = Utils.getScoreColor(score);
    return `
      <div class="report-card" data-view-id="${r.id}">
        <div class="rc-top">
          <div class="rc-info">
            <div class="rc-url">${Utils.escapeHtml(Utils.truncateUrl(r.website_url, 40))}</div>
            <div class="rc-client">${Utils.escapeHtml(r.client_name || r.client_email || '—')}</div>
            <div class="rc-meta">
              <span class="badge-grade grade-${Utils.escapeHtml(r.grade || 'F')}">${Utils.escapeHtml(r.grade || 'F')}</span>
              <span>${Utils.formatDate(r.created_at)}</span>
            </div>
          </div>
          <div class="rc-score" style="border-color:${color};">
            <div class="num" style="color:${color};">${score}</div>
            <div class="lbl">/100</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function wireRecentCardClicks(container) {
  if (!container) return;
  container.querySelectorAll('.report-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.viewId;
      if (id && typeof window.viewReport === 'function') window.viewReport(id);
    });
  });
}

function buildRecentReportsTable(reports, opts = {}) {
  if (!reports || reports.length === 0) {
    return `<div class="empty-state">
      <div class="empty-icon">${DASHBOARD_ICONS.fileText}</div>
      <div class="empty-title">No reports yet</div>
      <div class="empty-desc">Run your first audit to see it here.</div>
    </div>`;
  }
  const showUser = opts.showUser;
  const rows = reports.map(r => {
    const score = r.overall_score ?? 0;
    return `
      <tr>
        <td><div style="font-weight:700;color:var(--text,#111827);">${Utils.escapeHtml(Utils.truncateUrl(r.website_url, 40))}</div></td>
        <td>${Utils.escapeHtml(r.client_name || '—')}</td>
        <td>
          <div style="display:flex;flex-direction:column;gap:4px;min-width:80px;">
            <div style="font-size:13px;font-weight:700;">${score}/100</div>
            <div style="height:6px;background:#F3F4F6;border-radius:999px;overflow:hidden;">
              <div style="height:100%;width:${score}%;background:${Utils.getScoreColor(score)};"></div>
            </div>
          </div>
        </td>
        <td><span class="badge ${Utils.getGradeBadgeClass(r.grade)}">${Utils.escapeHtml(r.grade || 'F')}</span></td>
        ${showUser ? `<td>${Utils.escapeHtml(r.user_name || '—')}</td>` : ''}
        <td>${Utils.formatDate(r.created_at)}</td>
        <td>
          <div class="table-actions">
            <button class="action-btn" onclick="window.resendEmail && window.resendEmail('${r.id}')" title="Resend">${DASHBOARD_ICONS.send}</button>
            <button class="action-btn" onclick="window.downloadReport && window.downloadReport('${r.id}')" title="Download">${DASHBOARD_ICONS.download}</button>
          </div>
        </td>
      </tr>`;
  }).join('');
  return `<div class="table-wrapper" style="border:none;border-radius:0;">
    <table class="tbl">
      <thead><tr>
        <th>Website</th><th>Client</th><th>Score</th><th>Grade</th>
        ${showUser ? '<th>Sent By</th>' : ''}
        <th>Date</th><th style="width:100px;">Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

async function loadDashboard() {
  const u = Auth.getUser();
  if (u.role === 'admin') return loadAdminDashboard();
  return loadSalesDashboard();
}

async function loadAdminDashboard() {
  const statsRow = document.getElementById('statsRow');
  if (statsRow) statsRow.innerHTML = Skeleton.stats();

  try {
    const [reportsRes, usersRes] = await Promise.all([
      API.get('/reports?limit=100'),
      API.get('/users').catch(() => []),
    ]);
    const reports = reportsRes.reports || [];
    const totalAudits = reportsRes.total || reports.length;
    const emailsSent = reports.filter(r => r.email_sent).length;
    const members = (usersRes || []).length;
    const now = new Date();
    const thisMonth = reports.filter(r => {
      if (!r.created_at) return false;
      const d = new Date(r.created_at);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;

    if (statsRow) statsRow.innerHTML = [
      buildStatCard(DASHBOARD_ICONS.chart, 'purple', 'Total Audits', totalAudits),
      buildStatCard(DASHBOARD_ICONS.mail,  'green',  'Emails Sent',  emailsSent),
      buildStatCard(DASHBOARD_ICONS.users, 'blue',   'Team Members', members),
      buildStatCard(DASHBOARD_ICONS.fileText, 'orange', 'This Month', thisMonth),
    ].join('');

    const tableWrap = document.getElementById('recentTableWrap');
    if (tableWrap) tableWrap.innerHTML = buildRecentReportsTable(reports.slice(0, 6), { showUser: true });
    const cardsWrap = document.getElementById('recentCardsWrap');
    if (cardsWrap) {
      cardsWrap.innerHTML = buildRecentReportsCards(reports.slice(0, 6));
      wireRecentCardClicks(cardsWrap);
    }

    const ta = document.getElementById('teamActivity');
    if (ta) {
      if (!usersRes || usersRes.length === 0) {
        ta.innerHTML = '<div style="font-size:12px;color:var(--muted,#9CA3AF);">No team yet.</div>';
      } else {
        ta.innerHTML = usersRes.slice(0, 5).map(user => {
          const count = reports.filter(r => r.user_name === user.name).length;
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;background:var(--section,#F9FAFB);">
            <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6C2BD9,#8B5CF6);color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${Utils.getInitials(user.name)}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12px;font-weight:700;color:var(--text,#111827);">${Utils.escapeHtml(user.name)}</div>
              <div style="font-size:10px;color:var(--muted,#9CA3AF);">${count} audits</div>
            </div>
            <span class="badge badge-${user.role}">${Utils.escapeHtml(user.role)}</span>
          </div>`;
        }).join('');
      }
    }
  } catch (err) {
    Toast.error('Failed to load dashboard: ' + err.message);
  }
}

async function loadSalesDashboard() {
  const banner = document.getElementById('smtpBanner');
  try {
    const profile = await API.get('/profile');
    const configured = profile.smtp_type && (profile.gmail_app_password_set || profile.smtp_password_set);
    if (banner) {
      banner.innerHTML = configured
        ? ''
        : `<div class="banner warn">${DASHBOARD_ICONS.alert}<div>Set up your email to send reports — <a href="#profile">Go to Profile</a></div></div>`;
    }
  } catch {}

  const row = document.getElementById('salesStatsRow');
  if (row) row.innerHTML = Skeleton.stats();

  try {
    const rrs = await API.get('/reports?limit=100');
    const reports = rrs.reports || [];
    const total = rrs.total || reports.length;
    const sent = reports.filter(r => r.email_sent).length;
    const now = new Date();
    const thisMonth = reports.filter(r => {
      if (!r.created_at) return false;
      const d = new Date(r.created_at);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    const successRate = total ? Math.round((sent / total) * 100) : 0;

    if (row) row.innerHTML = [
      buildStatCard(DASHBOARD_ICONS.chart, 'purple', 'My Audits', total),
      buildStatCard(DASHBOARD_ICONS.mail,  'green',  'Emails Sent', sent),
      buildStatCard(DASHBOARD_ICONS.fileText, 'orange', 'This Month', thisMonth),
      buildStatCard(DASHBOARD_ICONS.chart, 'blue', 'Success Rate', successRate + '%'),
    ].join('');

    const tableWrap = document.getElementById('salesRecentTableWrap');
    if (tableWrap) tableWrap.innerHTML = buildRecentReportsTable(reports.slice(0, 6), { showUser: false });
    const cardsWrap = document.getElementById('salesRecentCardsWrap');
    if (cardsWrap) {
      cardsWrap.innerHTML = buildRecentReportsCards(reports.slice(0, 6));
      wireRecentCardClicks(cardsWrap);
    }
  } catch (err) {
    Toast.error('Failed to load dashboard: ' + err.message);
  }
}

// Quick-audit widgets on the dashboard
function wireQuickAuditWidgets() {
  const pairs = [['quickUrl', 'quickAuditBtn'], ['quickUrl2', 'quickAuditBtn2']];
  for (const [inputId, btnId] of pairs) {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (btn && input) {
      btn.addEventListener('click', () => {
        const url = input.value.trim();
        if (url) sessionStorage.setItem('prefillAuditUrl', url);
        Router.navigate('new-audit');
      });
    }
  }
}

// =================================================================
// THEME SWITCH (dashboard.html uses a custom #themeSwitch element, not .theme-toggle)
// =================================================================
function wireThemeSwitch() {
  const sw = document.getElementById('themeSwitch');
  if (sw) sw.addEventListener('click', () => Theme.toggle());
}

// =================================================================
// MORE DRAWER (mobile bottom-sheet triggered by the "More" tab)
// =================================================================
function initMoreDrawer() {
  const drawer = document.getElementById('moreDrawer');
  const backdrop = document.getElementById('moreDrawerBackdrop');
  const moreBtn = document.getElementById('moreTabBtn');
  if (!drawer) return;

  const openDrawer = () => {
    drawer.classList.add('open');
    const label = document.getElementById('drawerThemeLabel');
    if (label) label.textContent = document.body.classList.contains('dark') ? 'Dark' : 'Light';
  };
  const closeDrawer = () => drawer.classList.remove('open');

  if (moreBtn) moreBtn.addEventListener('click', openDrawer);
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  drawer.querySelectorAll('[data-drawer-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.drawerNav;
      closeDrawer();
      setTimeout(() => Router.navigate(view), 200);
    });
  });

  const themeBtn = document.getElementById('drawerThemeBtn');
  if (themeBtn) themeBtn.addEventListener('click', () => {
    Theme.toggle();
    const label = document.getElementById('drawerThemeLabel');
    if (label) label.textContent = document.body.classList.contains('dark') ? 'Dark' : 'Light';
  });

  const drawerLogoutBtn = document.getElementById('drawerLogoutBtn');
  if (drawerLogoutBtn) drawerLogoutBtn.addEventListener('click', () => {
    closeDrawer();
    if (typeof logout === 'function') logout();
  });
}

// =================================================================
// BOOTSTRAP
// =================================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Skip on the login page — index.html has no sidebar
  if (!document.querySelector('.sidebar')) return;

  Theme.init();
  wireThemeSwitch();

  let user = null;
  if (typeof checkAuth === 'function') {
    user = await checkAuth();
    if (!user) return; // checkAuth already redirected
  }
  updateUserDisplay(user || Auth.getUser());

  initMobileSidebar();
  initKeyboardShortcuts();
  initMoreDrawer();

  // Register view loaders from the feature modules
  Router.register('dashboard', loadDashboard);
  Router.register('view-dashboard-admin', loadDashboard);
  Router.register('view-dashboard-sales', loadDashboard);
  if (typeof loadReports === 'function') {
    Router.register('reports', loadReports);
    Router.register('view-reports', loadReports);
  }
  if (typeof loadTeam === 'function') {
    Router.register('team', loadTeam);
    Router.register('view-team', loadTeam);
  }
  if (typeof loadSettings === 'function') {
    Router.register('settings', loadSettings);
    Router.register('view-settings', loadSettings);
  }
  if (typeof loadProfile === 'function') {
    Router.register('profile', loadProfile);
    Router.register('view-profile', loadProfile);
  }
  if (typeof window.initBulkAudit === 'function') {
    Router.register('bulk-audit', window.initBulkAudit);
    Router.register('view-bulk-audit', window.initBulkAudit);
  }
  if (typeof window.initLeadFinder === 'function') {
    Router.register('lead-finder', window.initLeadFinder);
    Router.register('view-lead-finder', window.initLeadFinder);
  }
  if (typeof window.initLeadCRM === 'function') {
    Router.register('lead-crm', window.initLeadCRM);
    Router.register('view-lead-crm', window.initLeadCRM);
  }
  if (typeof window.initFollowUps === 'function') {
    Router.register('follow-ups', window.initFollowUps);
    Router.register('view-follow-ups', window.initFollowUps);
  }
  if (typeof window.initNiches === 'function') {
    Router.register('niches', window.initNiches);
    Router.register('view-niches', window.initNiches);
  }
  if (typeof window.initPipeline === 'function') {
    Router.register('pipeline', window.initPipeline);
    Router.register('view-pipeline', window.initPipeline);
  }
  if (typeof window.initNotifications === 'function') {
    window.initNotifications();
  }

  wireQuickAuditWidgets();

  Router.init();

  const logoutBtn = document.getElementById('logoutBtn') || document.querySelector('[data-logout]');
  if (logoutBtn && typeof logout === 'function') {
    logoutBtn.addEventListener('click', logout);
  }

  // Consume any `?url=` prefill set by quick-audit widgets
  const prefill = sessionStorage.getItem('prefillAuditUrl');
  if (prefill) {
    const input = document.getElementById('naWebsite');
    if (input) input.value = prefill;
    sessionStorage.removeItem('prefillAuditUrl');
  }
});
