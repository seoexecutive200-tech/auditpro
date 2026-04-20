// =================================================================
// AuditPro — Auth module
// Handles index.html login form and dashboard-level auth checks.
// Depends on: app.js (CONFIG, Auth, API, Toast, Theme)
// =================================================================

// ---------- Login page ----------
async function initLoginPage() {
  Theme.init();

  // If a token already exists, try to bounce straight to the dashboard.
  if (Auth.isLoggedIn()) {
    try {
      await API.get('/auth/me');
      window.location.href = 'dashboard.html';
      return;
    } catch {
      Auth.clear();
      // stay on the login page
    }
  }

  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const errorBox = document.getElementById('loginError') || document.getElementById('errorMsg');
  const submitBtn = document.getElementById('submitBtn') || (form && form.querySelector('button[type="submit"]'));

  if (!form) return;

  // Password show/hide toggle
  const pwToggle = document.getElementById('pwToggle') || document.querySelector('[data-pw-toggle]');
  if (pwToggle && passwordInput) {
    pwToggle.addEventListener('click', () => {
      passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
      pwToggle.classList.toggle('showing');
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (emailInput && emailInput.value || '').trim();
    const password = (passwordInput && passwordInput.value) || '';

    if (errorBox) { errorBox.classList.remove('show'); errorBox.textContent = ''; }

    if (!email || !password) {
      showLoginError(errorBox, form, 'Please enter your email and password.');
      return;
    }

    setLoginButtonLoading(submitBtn, true);

    try {
      const res = await API.post('/auth/login', { email, password });
      if (res && res.token) {
        Auth.setToken(res.token);
        Auth.setUser(res.user);
        window.location.href = 'dashboard.html';
        return;
      }
      throw new Error('Login failed');
    } catch (err) {
      setLoginButtonLoading(submitBtn, false);
      const msg = err && err.message ? err.message : 'Unable to sign in.';
      showLoginError(errorBox, form, msg);
    }
  });

  // Forgot password link
  const forgot = document.getElementById('forgotLink');
  if (forgot) {
    forgot.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Contact your administrator to reset your password.');
    });
  }
}

function setLoginButtonLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('btn-loading', !!loading);
  btn.classList.toggle('loading', !!loading);
}

function showLoginError(box, form, message) {
  if (box) {
    box.textContent = message;
    box.classList.add('show');
  } else {
    Toast.error(message);
  }
  if (form) {
    form.classList.remove('animate-shake');
    void form.offsetWidth; // force reflow so the animation can replay
    form.classList.add('animate-shake');
  }
}

// ---------- Dashboard auth check ----------
async function checkAuth() {
  if (!Auth.isLoggedIn()) {
    window.location.href = 'index.html';
    return null;
  }
  try {
    const me = await API.get('/auth/me');
    Auth.setUser(me);
    updateUserDisplay(me);
    applyRoleVisibility(me);
    return me;
  } catch (err) {
    Auth.clear();
    window.location.href = 'index.html';
    return null;
  }
}

function updateUserDisplay(user) {
  if (!user) return;
  const ini = Utils.getInitials(user.name);

  document.querySelectorAll('[data-user-initials]').forEach(el => { el.textContent = ini; });
  document.querySelectorAll('[data-user-name]').forEach(el => { el.textContent = user.name || 'User'; });
  document.querySelectorAll('[data-user-role]').forEach(el => { el.textContent = (user.role || '').toUpperCase(); });
  document.querySelectorAll('[data-user-email]').forEach(el => { el.textContent = user.email || ''; });
}

function applyRoleVisibility(user) {
  const isAdmin = user && user.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  document.querySelectorAll('[data-sales-only]').forEach(el => {
    el.style.display = !isAdmin ? '' : 'none';
  });
}

async function logout() {
  try { await API.post('/auth/logout'); } catch {}
  Auth.clear();
  window.location.href = 'index.html';
}

// Auto-init login page if we're on index.html
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('loginForm')) {
    initLoginPage();
  }
});
