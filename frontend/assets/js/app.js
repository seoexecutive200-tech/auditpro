// =================================================================
// AuditPro — Core application module
// Exposes globals: CONFIG, Auth, API, Toast, Modal, Theme, Utils, Skeleton
// =================================================================

const CONFIG = {
  // Use the same origin the page was served from, so the frontend works
  // whether it's running on localhost, a VPS IP, or a real domain.
  API_BASE: window.location.origin + '/api',
  TOKEN_KEY: 'auditpro_token',
  USER_KEY: 'auditpro_user',
  THEME_KEY: 'auditpro_theme',
};

// =================================================================
// AUTH HELPERS
// =================================================================
const Auth = {
  getToken: () => localStorage.getItem(CONFIG.TOKEN_KEY),
  getUser: () => {
    try { return JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || '{}'); }
    catch { return {}; }
  },
  setToken: (token) => localStorage.setItem(CONFIG.TOKEN_KEY, token),
  setUser: (user) => localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user)),
  clear: () => {
    localStorage.removeItem(CONFIG.TOKEN_KEY);
    localStorage.removeItem(CONFIG.USER_KEY);
  },
  isAdmin: () => Auth.getUser().role === 'admin',
  isSales: () => Auth.getUser().role === 'sales',
  isLoggedIn: () => !!Auth.getToken(),
};

// =================================================================
// API HELPER
// =================================================================
const API = {
  async request(method, endpoint, data, isFormData) {
    const headers = {};
    const tk = Auth.getToken();
    if (tk) headers['Authorization'] = `Bearer ${tk}`;
    if (!isFormData) headers['Content-Type'] = 'application/json';

    const options = { method, headers };
    if (data && !isFormData) options.body = JSON.stringify(data);
    if (data && isFormData) options.body = data;

    try {
      const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, options);

      if (res.status === 401) {
        Auth.clear();
        window.location.href = 'index.html';
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      const json = contentType.includes('application/json') ? await res.json() : null;

      if (!res.ok) {
        throw new Error((json && (json.error || json.message)) || 'Request failed');
      }
      return json;
    } catch (err) {
      if (err && err.message && /fetch/i.test(err.message) && !err.message.includes('Request failed')) {
        throw new Error('Cannot connect to server. Make sure the backend is running.');
      }
      throw err;
    }
  },
  get: (endpoint) => API.request('GET', endpoint),
  post: (endpoint, data) => API.request('POST', endpoint, data),
  put: (endpoint, data) => API.request('PUT', endpoint, data),
  delete: (endpoint) => API.request('DELETE', endpoint),
  upload: (endpoint, formData) => API.request('POST', endpoint, formData, true),
};

// =================================================================
// TOAST NOTIFICATIONS
// =================================================================
const Toast = {
  container: null,

  init() {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'default', duration = 4000) {
    if (!this.container) this.init();
    const icons = {
      success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
      error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
      warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
      default: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `${icons[type] || icons.default}<span>${message}</span>`;
    this.container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'fadeIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  success: (msg) => Toast.show(msg, 'success'),
  error:   (msg) => Toast.show(msg, 'error'),
  warning: (msg) => Toast.show(msg, 'warning'),
  info:    (msg) => Toast.show(msg, 'default'),
};

// =================================================================
// MODAL SYSTEM
// =================================================================
const Modal = {
  open(id) {
    const overlay = document.getElementById(id);
    if (overlay) {
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  },
  close(id) {
    const overlay = document.getElementById(id);
    if (overlay) {
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }
  },
  closeAll() {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    document.body.style.overflow = '';
  },
};

// =================================================================
// THEME SYSTEM
// =================================================================
const Theme = {
  init() {
    const saved = localStorage.getItem(CONFIG.THEME_KEY);
    if (saved === 'dark') this.setDark();
    else this.setLight();
  },
  setDark() {
    document.body.classList.add('dark');
    localStorage.setItem(CONFIG.THEME_KEY, 'dark');
    this.updateToggleButtons();
  },
  setLight() {
    document.body.classList.remove('dark');
    localStorage.setItem(CONFIG.THEME_KEY, 'light');
    this.updateToggleButtons();
  },
  toggle() {
    if (document.body.classList.contains('dark')) this.setLight();
    else this.setDark();
  },
  updateToggleButtons() {
    const isDark = document.body.classList.contains('dark');
    document.querySelectorAll('.theme-toggle').forEach(btn => {
      btn.innerHTML = isDark
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
    });
  },
};

// =================================================================
// UTILITIES
// =================================================================
const Utils = {
  formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  },

  formatDateTime(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },

  getGradeBadgeClass(grade) {
    const map = { A: 'badge-grade-a', B: 'badge-grade-b', C: 'badge-grade-c', D: 'badge-grade-d', F: 'badge-grade-f' };
    return map[grade] || 'badge-gray';
  },

  getScoreClass(score) {
    if (score >= 90) return 'score-high';
    if (score >= 80) return 'score-good';
    if (score >= 70) return 'score-medium';
    if (score >= 60) return 'score-low';
    return 'score-poor';
  },

  getScoreColor(score) {
    if (score >= 90) return '#16A34A';
    if (score >= 80) return '#0D9488';
    if (score >= 70) return '#F59E0B';
    if (score >= 60) return '#EA580C';
    return '#DC2626';
  },

  getSeverityClass(severity) {
    const map = { critical: 'badge-critical', warning: 'badge-warning', pass: 'badge-pass' };
    return map[severity] || 'badge-gray';
  },

  truncateUrl(url, maxLen = 35) {
    if (!url) return '';
    url = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return url.length > maxLen ? url.substring(0, maxLen) + '...' : url;
  },

  getInitials(name) {
    if (!name) return 'U';
    return name.split(/\s+/).map(n => n[0]).join('').toUpperCase().slice(0, 2);
  },

  isValidUrl(url) {
    if (!url) return false;
    try {
      new URL(url.startsWith('http') ? url : 'https://' + url);
      return true;
    } catch { return false; }
  },

  normalizeUrl(url) {
    if (!url) return '';
    return url.startsWith('http') ? url : 'https://' + url;
  },

  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  downloadFile(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => Toast.success('Copied to clipboard'));
  },

  buildScoreCircleSVG(score, size = 120, strokeWidth = 8) {
    const safeScore = Math.max(0, Math.min(100, Number(score) || 0));
    const color = Utils.getScoreColor(safeScore);
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (safeScore / 100) * circumference;
    const center = size / 2;
    const fontSize = size > 80 ? 24 : 14;

    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${center}" cy="${center}" r="${radius}"
          fill="none" stroke="#E5E7EB" stroke-width="${strokeWidth}"/>
        <circle cx="${center}" cy="${center}" r="${radius}"
          fill="none" stroke="${color}" stroke-width="${strokeWidth}"
          stroke-linecap="round"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}"
          transform="rotate(-90 ${center} ${center})"
          style="transition: stroke-dashoffset 1s ease"/>
        <text x="${center}" y="${center}" text-anchor="middle"
          dominant-baseline="central"
          fill="${color}" font-size="${fontSize}" font-weight="700"
          font-family="Inter, sans-serif">${safeScore}</text>
      </svg>
    `;
  },

  escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
};

// =================================================================
// SKELETON LOADERS
// =================================================================
const Skeleton = {
  card: () => `<div class="skeleton skeleton-card" style="height:100px"></div>`,
  text: (width = '100%') => `<div class="skeleton skeleton-text" style="width:${width}"></div>`,
  row: () => `<tr>${Array(6).fill('<td><div class="skeleton skeleton-text"></div></td>').join('')}</tr>`,
  stats: () => Array(4).fill(`
    <div class="stat-card">
      <div class="skeleton" style="width:42px;height:42px;border-radius:10px;margin-bottom:12px"></div>
      <div class="skeleton skeleton-text" style="width:60px;height:28px;margin-bottom:4px"></div>
      <div class="skeleton skeleton-text" style="width:100px"></div>
    </div>
  `).join(''),
};

// =================================================================
// EXPOSE ON window SO OTHER SCRIPTS (AND DEVTOOLS) CAN SEE THEM
// Non-module <script> const/let declarations do NOT attach to window.
// Explicitly mirror every global so `window.API`, `window.Toast`, etc. work
// and DevTools can inspect them directly.
// =================================================================
window.CONFIG   = CONFIG;
window.Auth     = Auth;
window.API      = API;
window.Toast    = Toast;
window.Modal    = Modal;
window.Theme    = Theme;
window.Utils    = Utils;
window.Skeleton = Skeleton;

// =================================================================
// BOOTSTRAP
// =================================================================
document.addEventListener('DOMContentLoaded', () => {
  Toast.init();
  Theme.init();

  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.addEventListener('click', () => Theme.toggle());
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) Modal.close(overlay.id);
    });
  });
});
