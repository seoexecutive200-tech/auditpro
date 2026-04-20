const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db, DEFAULT_TENANT_ID } = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_env';

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id || DEFAULT_TENANT_ID,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function generateSuperAdminToken(admin) {
  return jwt.sign(
    {
      id: admin.id,
      email: admin.email,
      role: 'super_admin',
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  try {
    const payload = verifyToken(token);
    req.user = {
      ...payload,
      tenant_id: payload.tenant_id || DEFAULT_TENANT_ID,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function authenticateSuperAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (payload.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }

  const row = db
    .prepare('SELECT id, email FROM super_admins WHERE id = ? AND email = ?')
    .get(payload.id, payload.email);
  if (!row) {
    return res.status(403).json({ error: 'Super admin access required' });
  }

  req.user = { id: row.id, email: row.email, role: 'super_admin' };
  next();
}

module.exports = {
  generateToken,
  generateSuperAdminToken,
  verifyToken,
  hashPassword,
  comparePassword,
  authenticateToken,
  requireAdmin,
  authenticateSuperAdmin,
};
