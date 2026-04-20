const express = require('express');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { db, encrypt, decrypt } = require('../db/database');
const { hashPassword, authenticateToken, requireAdmin } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');
const { enforceUsageLimits } = require('../utils/usageLimits');

const usersRouter = express.Router();
const profileRouter = express.Router();

usersRouter.use(authenticateToken, resolveTenant, requireAdmin);
profileRouter.use(authenticateToken, resolveTenant);

usersRouter.get('/', (req, res) => {
  try {
    const users = db
      .prepare(
        'SELECT id, name, email, role, smtp_type, created_at FROM users WHERE tenant_id = ? ORDER BY created_at DESC'
      )
      .all(req.tenantId);
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

usersRouter.post('/', enforceUsageLimits('user'), (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password || !role) {
      return res
        .status(400)
        .json({ error: 'name, email, password, and role are required' });
    }
    if (role !== 'admin' && role !== 'sales') {
      return res.status(400).json({ error: "role must be 'admin' or 'sales'" });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const id = uuidv4();
    const passwordHash = hashPassword(password);

    db.prepare(
      `INSERT INTO users (id, name, email, password_hash, role, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, name, email, passwordHash, role, req.tenantId);

    return res.status(201).json({ id, name, email, role });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

usersRouter.delete('/:id', (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const result = db
      .prepare('DELETE FROM users WHERE id = ? AND tenant_id = ?')
      .run(req.params.id, req.tenantId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ message: 'User deleted' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

usersRouter.put('/:id/reset-password', (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword) {
      return res.status(400).json({ error: 'newPassword is required' });
    }

    const hash = hashPassword(newPassword);
    const result = db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
      .run(hash, req.params.id, req.tenantId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ message: 'Password reset successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

profileRouter.get('/', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      smtp_type: user.smtp_type || null,
      gmail_email: user.gmail_email || null,
      gmail_app_password_set: !!user.gmail_app_password,
      smtp_host: user.smtp_host || null,
      smtp_port: user.smtp_port || null,
      smtp_email: user.smtp_email || null,
      smtp_password_set: !!user.smtp_password,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load profile' });
  }
});

profileRouter.put('/', (req, res) => {
  try {
    const {
      name,
      smtp_type,
      gmail_email,
      gmail_app_password,
      smtp_host,
      smtp_port,
      smtp_email,
      smtp_password,
    } = req.body || {};

    if (smtp_type && smtp_type !== 'gmail' && smtp_type !== 'hostinger') {
      return res.status(400).json({ error: "smtp_type must be 'gmail' or 'hostinger'" });
    }

    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!current) return res.status(404).json({ error: 'User not found' });

    const encGmailPw =
      gmail_app_password !== undefined && gmail_app_password !== ''
        ? encrypt(gmail_app_password)
        : current.gmail_app_password;
    const encSmtpPw =
      smtp_password !== undefined && smtp_password !== ''
        ? encrypt(smtp_password)
        : current.smtp_password;

    db.prepare(
      `UPDATE users SET
         name = ?,
         smtp_type = ?,
         gmail_email = ?,
         gmail_app_password = ?,
         smtp_host = ?,
         smtp_port = ?,
         smtp_email = ?,
         smtp_password = ?
       WHERE id = ?`
    ).run(
      name ?? current.name,
      smtp_type ?? current.smtp_type,
      gmail_email ?? current.gmail_email,
      encGmailPw ?? null,
      smtp_host ?? current.smtp_host,
      smtp_port ?? current.smtp_port,
      smtp_email ?? current.smtp_email,
      encSmtpPw ?? null,
      req.user.id
    );

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    return res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      smtp_type: updated.smtp_type || null,
      gmail_email: updated.gmail_email || null,
      gmail_app_password_set: !!updated.gmail_app_password,
      smtp_host: updated.smtp_host || null,
      smtp_port: updated.smtp_port || null,
      smtp_email: updated.smtp_email || null,
      smtp_password_set: !!updated.smtp_password,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

profileRouter.post('/test-email', async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let transporter;
    let fromAddress;

    if (user.smtp_type === 'gmail') {
      if (!user.gmail_email || !user.gmail_app_password) {
        return res.status(400).json({ error: 'Gmail SMTP is not configured' });
      }
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: user.gmail_email,
          pass: decrypt(user.gmail_app_password),
        },
      });
      fromAddress = user.gmail_email;
    } else if (user.smtp_type === 'hostinger') {
      if (!user.smtp_host || !user.smtp_port || !user.smtp_email || !user.smtp_password) {
        return res.status(400).json({ error: 'SMTP is not configured' });
      }
      transporter = nodemailer.createTransport({
        host: user.smtp_host,
        port: user.smtp_port,
        secure: user.smtp_port === 465,
        auth: {
          user: user.smtp_email,
          pass: decrypt(user.smtp_password),
        },
      });
      fromAddress = user.smtp_email;
    } else {
      return res.status(400).json({ error: 'No SMTP type configured' });
    }

    await transporter.sendMail({
      from: fromAddress,
      to: user.email,
      subject: 'AuditPro test email',
      text: 'This is a test email from AuditPro. If you received this, your SMTP is working.',
    });

    return res.json({ success: true, message: 'Test email sent' });
  } catch (err) {
    return res
      .status(500)
      .json({ error: `Failed to send test email: ${err.message}` });
  }
});

// Default export is the main users router, with profileRouter attached as a
// property so server.js can destructure or access `.profileRouter` directly.
module.exports = usersRouter;
module.exports.usersRouter = usersRouter;
module.exports.profileRouter = profileRouter;
