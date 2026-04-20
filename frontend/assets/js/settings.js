// =================================================================
// AuditPro — Settings / Team / Profile module
// Depends on: app.js (Auth, API, Toast, Utils, Modal)
// =================================================================

// =================================================================
// SETTINGS (admin)
// =================================================================
async function loadSettings() {
  try {
    const s = await API.get('/settings').catch(() => null);
    if (!s) return;
    setInputValue('psApiKey', s.pagespeed_api_key);
    setInputValue('agName', s.agency_name);
    setInputValue('agContact', s.agency_contact);
    setInputValue('agLogo', s.agency_logo);
    setInputValue('agWebsite', s.agency_website);
    setInputValue('agPhone', s.agency_phone);
    setInputValue('bingApiKey', s.bing_api_key);
    setInputValue('groqApiKey', s.groq_api_key);
    updateLogoPreview();
    wireBingKeyControls();
    wireGroqKeyControls();
    if (s.bing_api_key) setBingStatus('saved');
    if (s.groq_api_key) setGroqStatus('saved');
  } catch (err) {
    Toast.error('Failed to load settings: ' + err.message);
  }
}

function setBingStatus(kind) {
  const el = document.getElementById('bingKeyStatus');
  if (!el) return;
  if (kind === 'connected') {
    el.style.display = 'inline-block';
    el.style.background = '#DCFCE7';
    el.style.color = '#166534';
    el.textContent = 'Connected';
  } else if (kind === 'saved') {
    el.style.display = 'inline-block';
    el.style.background = '#DBEAFE';
    el.style.color = '#1E3A8A';
    el.textContent = 'Saved';
  } else if (kind === 'failed') {
    el.style.display = 'inline-block';
    el.style.background = '#FEE2E2';
    el.style.color = '#B91C1C';
    el.textContent = 'Failed';
  } else {
    el.style.display = 'none';
  }
}

let bingControlsWired = false;
function wireBingKeyControls() {
  if (bingControlsWired) return;
  bingControlsWired = true;

  const toggle = document.getElementById('bingKeyToggle');
  const input = document.getElementById('bingApiKey');
  if (toggle && input) {
    toggle.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }
  const save = document.getElementById('saveBingBtn');
  if (save) save.addEventListener('click', saveBingKey);
  const test = document.getElementById('testBingBtn');
  if (test) test.addEventListener('click', testBingKey);
}

function setGroqStatus(kind) {
  const el = document.getElementById('groqKeyStatus');
  if (!el) return;
  if (kind === 'saved') {
    el.style.display = 'inline-block';
    el.style.background = '#DBEAFE';
    el.style.color = '#1E3A8A';
    el.textContent = 'Saved';
  } else {
    el.style.display = 'none';
  }
}

let groqControlsWired = false;
function wireGroqKeyControls() {
  if (groqControlsWired) return;
  groqControlsWired = true;
  const toggle = document.getElementById('groqKeyToggle');
  const input = document.getElementById('groqApiKey');
  if (toggle && input) {
    toggle.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }
  const save = document.getElementById('saveGroqBtn');
  if (save) save.addEventListener('click', saveGroqKey);
}

async function saveGroqKey() {
  const key = getInputValue('groqApiKey') || '';
  try {
    await API.put('/settings', { groq_api_key: key });
    Toast.success('Groq API key saved');
    setGroqStatus(key ? 'saved' : null);
  } catch (err) {
    Toast.error('Save failed: ' + err.message);
  }
}

async function saveBingKey() {
  const key = getInputValue('bingApiKey') || '';
  try {
    await API.put('/settings', { bing_api_key: key });
    Toast.success('Bing API key saved');
    setBingStatus(key ? 'saved' : null);
  } catch (err) {
    Toast.error('Save failed: ' + err.message);
  }
}

async function testBingKey() {
  const btn = document.getElementById('testBingBtn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  try {
    const res = await API.get('/leads/tokens');
    if (res && typeof res.monthlyLimit === 'number') {
      Toast.success(`Bing OK — ${res.remainingMonth} / ${res.monthlyLimit} remaining`);
      setBingStatus('connected');
    } else {
      Toast.warning('Unexpected response from token endpoint');
    }
  } catch (err) {
    Toast.error('Test failed: ' + err.message);
    setBingStatus('failed');
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  }
}

async function saveSettings(section) {
  const payload = {};
  if (section === 'api') {
    payload.pagespeed_api_key = getInputValue('psApiKey');
  } else if (section === 'agency') {
    payload.agency_name = getInputValue('agName');
    payload.agency_contact = getInputValue('agContact');
    payload.agency_logo = getInputValue('agLogo');
    payload.agency_website = getInputValue('agWebsite');
    payload.agency_phone = getInputValue('agPhone');
  }
  try {
    await API.put('/settings', payload);
    Toast.success('Settings saved');
  } catch (err) {
    Toast.error('Save failed: ' + err.message);
  }
}

async function testPagespeedKey() {
  const btn = document.getElementById('testApiBtn');
  if (btn) { btn.disabled = true; btn.classList.add('btn-loading'); }
  try {
    const res = await API.get('/audit/test');
    Toast.success(res.message || 'API key looks good');
  } catch (err) {
    Toast.error('Test failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('btn-loading'); }
  }
}

function updateLogoPreview() {
  const url = getInputValue('agLogo');
  const el = document.getElementById('agLogoPreview');
  if (!el) return;
  el.innerHTML = url
    ? `<img src="${Utils.escapeHtml(url)}" alt="logo" style="height:36px;width:auto;border:1px solid var(--border);border-radius:6px;padding:4px 8px;background:#FFFFFF;" onerror="this.style.display='none'" />`
    : '';
}

// =================================================================
// TEAM MANAGEMENT (admin)
// =================================================================
async function loadTeam() {
  const wrap = document.getElementById('teamTableWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div style="padding:24px;">${Skeleton.text('100%')}${Skeleton.text('80%')}</div>`;

  try {
    const users = await API.get('/users');
    if (!users.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="empty-title">No team members yet</div><div class="empty-desc">Invite someone to get started.</div></div>`;
      return;
    }

    const me = Auth.getUser();
    const rows = users.map(u => `
      <tr data-user-row="${u.id}">
        <td>
          <div class="flex items-center gap-12">
            <div style="width:36px;height:36px;border-radius:50%;background:var(--gradient);color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${Utils.getInitials(u.name)}</div>
            <div>
              <div style="font-weight:600;color:var(--text-heading);">${Utils.escapeHtml(u.name)}</div>
              <div class="form-hint">${Utils.escapeHtml(u.email)}</div>
            </div>
          </div>
        </td>
        <td><span class="badge badge-${u.role}">${Utils.escapeHtml(u.role)}</span></td>
        <td>${Utils.formatDate(u.created_at)}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn-icon btn-secondary" title="Reset password" data-action="reset-pw" data-id="${u.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>
            ${u.id !== me.id ? `<button class="btn btn-icon btn-danger" title="Delete" data-action="delete-user" data-id="${u.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');

    wrap.innerHTML = `<div class="table-wrapper"><table><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;

    wrap.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'reset-pw') resetPassword(btn.dataset.id);
        if (btn.dataset.action === 'delete-user') deleteUser(btn.dataset.id);
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-title">Failed to load team</div><div class="empty-desc">${Utils.escapeHtml(err.message)}</div></div>`;
  }
}

async function inviteUser(name, email, password, role) {
  try {
    await API.post('/users', { name, email, password, role });
    Toast.success('Team member added');
    loadTeam();
  } catch (err) {
    Toast.error(err.message);
  }
}

async function resetPassword(userId) {
  const newPw = prompt('Enter new password for this user:');
  if (!newPw) return;
  try {
    await API.put(`/users/${userId}/reset-password`, { newPassword: newPw });
    Toast.success('Password reset');
  } catch (err) {
    Toast.error(err.message);
  }
}

async function deleteUser(userId) {
  if (!confirm('Delete this member? This cannot be undone.')) return;
  try {
    await API.delete(`/users/${userId}`);
    const row = document.querySelector(`[data-user-row="${userId}"]`);
    if (row) {
      row.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      row.style.opacity = '0';
      row.style.transform = 'translateX(20px)';
      setTimeout(() => row.remove(), 300);
    }
    Toast.success('Member deleted');
  } catch (err) {
    Toast.error(err.message);
  }
}

// =================================================================
// PROFILE
// =================================================================
async function loadProfile() {
  try {
    const p = await API.get('/profile');
    setInputValue('profName', p.name);
    setInputValue('profEmail', p.email);

    const nameEl = document.getElementById('profileHeadName');
    if (nameEl) nameEl.textContent = p.name || '';
    const avatarEl = document.getElementById('profileAvatar');
    if (avatarEl) avatarEl.textContent = Utils.getInitials(p.name);
    const roleEl = document.getElementById('profileRoleBadge');
    if (roleEl) roleEl.innerHTML = `<span class="badge badge-${p.role}">${Utils.escapeHtml(p.role)}</span>`;

    setInputValue('gmailEmail', p.gmail_email);
    setInputValue('smtpHost', p.smtp_host);
    setInputValue('smtpPort', p.smtp_port);
    setInputValue('smtpEmail', p.smtp_email);

    if (p.smtp_type === 'hostinger') showSmtpTab('hostinger');
    else showSmtpTab('gmail');

    const configured = p.smtp_type && (p.gmail_app_password_set || p.smtp_password_set);
    const badge = document.getElementById('smtpStatusBadge');
    if (badge) {
      badge.innerHTML = configured
        ? '<span class="badge badge-pass">Configured ✓</span>'
        : '<span class="badge badge-warning">Not configured</span>';
    }
  } catch (err) {
    Toast.error(err.message);
  }
}

async function saveProfile(name) {
  try {
    await API.put('/profile', { name });
    const u = Auth.getUser();
    u.name = name;
    Auth.setUser(u);
    // Update sidebar chrome
    document.querySelectorAll('[data-user-name]').forEach(el => { el.textContent = name; });
    document.querySelectorAll('[data-user-initials]').forEach(el => { el.textContent = Utils.getInitials(name); });
    Toast.success('Profile saved');
  } catch (err) {
    Toast.error(err.message);
  }
}

async function changePassword(current, newPass, confirm) {
  if (!current || !newPass) { Toast.error('Fill all password fields'); return; }
  if (newPass !== confirm) { Toast.error('Passwords do not match'); return; }
  if (newPass.length < 8 || !/[A-Z]/.test(newPass) || !/[0-9]/.test(newPass)) {
    Toast.error('Password must be 8+ chars with an uppercase letter and a number');
    return;
  }
  try {
    await API.put('/auth/change-password', { currentPassword: current, newPassword: newPass });
    Toast.success('Password updated');
    ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(id => setInputValue(id, ''));
    renderPasswordStrength(0);
  } catch (err) {
    Toast.error(err.message);
  }
}

// ---------- SMTP ----------
function showSmtpTab(type) {
  document.querySelectorAll('#smtpTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.stab === type);
  });
  const gmail = document.getElementById('smtpTab-gmail');
  const host = document.getElementById('smtpTab-hostinger');
  if (gmail) gmail.style.display = type === 'gmail' ? 'block' : 'none';
  if (host)  host.style.display  = type === 'hostinger' ? 'block' : 'none';
}

async function testSmtpConnection() {
  try {
    const v = await API.post('/email/verify');
    if (v.valid) Toast.success('Connection successful');
    else Toast.error('Failed: ' + (v.message || 'unknown'));
  } catch (err) {
    Toast.error(err.message);
  }
}

async function saveSmtpConfig(type) {
  try {
    let payload = { smtp_type: type };
    if (type === 'gmail') {
      payload.gmail_email = getInputValue('gmailEmail');
      payload.gmail_app_password = getInputValue('gmailPw');
    } else if (type === 'hostinger') {
      payload.smtp_host = getInputValue('smtpHost');
      payload.smtp_port = parseInt(getInputValue('smtpPort'), 10);
      payload.smtp_email = getInputValue('smtpEmail');
      payload.smtp_password = getInputValue('smtpPw');
    }
    await API.put('/profile', payload);
    const v = await API.post('/email/verify');
    if (!v.valid) throw new Error(v.message || 'Verification failed');
    Toast.success('Email configuration saved');
    loadProfile();
  } catch (err) {
    Toast.error(err.message);
  }
}

// ---------- Password strength ----------
function checkPasswordStrength(pw) {
  let strength = 0;
  if (!pw) return 0;
  if (pw.length >= 8) strength++;
  if (/[A-Z]/.test(pw)) strength++;
  if (/[0-9]/.test(pw)) strength++;
  if (/[^A-Za-z0-9]/.test(pw)) strength++;
  return strength;
}

function renderPasswordStrength(strength) {
  const bar = document.getElementById('pwStrength');
  if (!bar) return;
  const pct = (strength / 4) * 100;
  const colors = ['#DC2626', '#F59E0B', '#EAB308', '#16A34A'];
  const labels = ['Weak', 'Fair', 'Good', 'Strong'];
  bar.style.width = pct + '%';
  bar.style.background = strength === 0 ? 'var(--border)' : colors[Math.max(0, strength - 1)];
  const label = document.getElementById('pwStrengthLabel');
  if (label) label.textContent = strength === 0 ? '' : labels[strength - 1];
}

// ---------- Helpers ----------
function setInputValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}
function getInputValue(id) {
  const el = document.getElementById(id);
  return el ? (el.value || '').trim() : '';
}

// ---------- Bootstrap ----------
document.addEventListener('DOMContentLoaded', () => {
  // Settings
  const saveApi = document.getElementById('saveApiBtn');
  if (saveApi) saveApi.addEventListener('click', () => saveSettings('api'));
  const saveAgency = document.getElementById('saveAgencyBtn');
  if (saveAgency) saveAgency.addEventListener('click', () => saveSettings('agency'));
  const testApi = document.getElementById('testApiBtn');
  if (testApi) testApi.addEventListener('click', testPagespeedKey);
  const agLogo = document.getElementById('agLogo');
  if (agLogo) agLogo.addEventListener('input', updateLogoPreview);

  // Team
  const inviteBtn = document.getElementById('inviteBtn');
  if (inviteBtn) {
    inviteBtn.addEventListener('click', () => {
      const name = prompt('Name:');
      if (!name) return;
      const email = prompt('Email:');
      if (!email) return;
      const password = prompt('Temporary password (8+ chars, uppercase + number):');
      if (!password) return;
      const role = (prompt('Role (admin or sales):') || 'sales').toLowerCase();
      inviteUser(name, email, password, role === 'admin' ? 'admin' : 'sales');
    });
  }

  // Profile
  const saveProfileBtn = document.getElementById('saveProfileBtn');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', () => saveProfile(getInputValue('profName')));
  }
  const savePwBtn = document.getElementById('savePwBtn');
  if (savePwBtn) {
    savePwBtn.addEventListener('click', () =>
      changePassword(getInputValue('pwCurrent'), getInputValue('pwNew'), getInputValue('pwConfirm'))
    );
  }
  const pwNew = document.getElementById('pwNew');
  if (pwNew) pwNew.addEventListener('input', (e) => renderPasswordStrength(checkPasswordStrength(e.target.value)));

  // SMTP
  document.querySelectorAll('#smtpTabs button').forEach(b => {
    b.addEventListener('click', () => showSmtpTab(b.dataset.stab));
  });
  const gmailSave = document.getElementById('gmailSaveBtn');
  if (gmailSave) gmailSave.addEventListener('click', () => saveSmtpConfig('gmail'));
  const gmailTest = document.getElementById('gmailTestBtn');
  if (gmailTest) gmailTest.addEventListener('click', testSmtpConnection);
  const smtpSave = document.getElementById('smtpSaveBtn');
  if (smtpSave) smtpSave.addEventListener('click', () => saveSmtpConfig('hostinger'));
  const smtpTest = document.getElementById('smtpTestBtn');
  if (smtpTest) smtpTest.addEventListener('click', testSmtpConnection);
});

// Expose for inline handlers
window.resetPassword = resetPassword;
window.deleteUser = deleteUser;
