const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/database');
const {
  generateToken,
  hashPassword,
  comparePassword,
  authenticateToken,
} = require('../utils/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/login', loginLimiter, (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !comparePassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const tenant = db
      .prepare(
        `SELECT id, name, subdomain, brand_name, logo_url, primary_color,
                gradient_start, gradient_end, plan, status
         FROM tenants WHERE id = ?`
      )
      .get(user.tenant_id || 'default');

    if (tenant && tenant.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended' });
    }

    const token = generateToken(user);
    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id || 'default',
      },
      tenant: tenant
        ? {
            id: tenant.id,
            brandName: tenant.brand_name,
            logoUrl: tenant.logo_url,
            primaryColor: tenant.primary_color,
            gradientStart: tenant.gradient_start,
            gradientEnd: tenant.gradient_end,
            subdomain: tenant.subdomain,
            plan: tenant.plan,
          }
        : null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', authenticateToken, (req, res) => {
  return res.json({ message: 'Logged out successfully' });
});

router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = db
      .prepare(
        'SELECT id, name, email, role, smtp_type, gmail_email, smtp_email FROM users WHERE id = ?'
      )
      .get(req.user.id);

    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load user' });
  }
});

router.put('/change-password', authenticateToken, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: 'currentPassword and newPassword are required' });
    }

    if (
      newPassword.length < 8 ||
      !/[A-Z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword)
    ) {
      return res.status(400).json({
        error:
          'New password must be at least 8 characters and include an uppercase letter and a number',
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!comparePassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      newHash,
      user.id
    );

    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update password' });
  }
});

module.exports = router;
