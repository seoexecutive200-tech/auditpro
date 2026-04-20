const { db, DEFAULT_TENANT_ID } = require('../db/database');

// Resolve tenant for the current request and attach `req.tenantId` + `req.tenant`.
// Priority order: x-tenant-id header > ?tenant_id= > JWT tenant_id > 'default'.
// Non-super-admins can only scope to the tenant in their JWT. Super admins may
// freely override via header/query.
function resolveTenant(req, res, next) {
  const user = req.user || {};
  const isSuper = user.role === 'super_admin';

  let tenantId;
  if (isSuper) {
    tenantId =
      req.headers['x-tenant-id'] ||
      (req.query && req.query.tenant_id) ||
      user.tenant_id ||
      DEFAULT_TENANT_ID;
  } else {
    tenantId = user.tenant_id || DEFAULT_TENANT_ID;
  }
  tenantId = String(tenantId);

  const tenant = db
    .prepare(
      `SELECT id, name, subdomain, brand_name, logo_url, primary_color,
              gradient_start, gradient_end, plan, status, monthly_price,
              max_users, max_leads_per_month, max_audits_per_month
       FROM tenants WHERE id = ?`
    )
    .get(tenantId);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  // Super admins can view/manage any tenant including suspended ones.
  if (!isSuper) {
    if (tenant.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended' });
    }
    if (tenant.status === 'cancelled') {
      return res.status(403).json({ error: 'Account cancelled' });
    }
  }

  req.tenantId = tenant.id;
  req.tenant = tenant;
  next();
}

module.exports = {
  resolveTenant,
};
