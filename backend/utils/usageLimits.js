const { db } = require('./../db/database');

// Count rows in `table` for the tenant that were created this calendar month.
// `createdCol` defaults to 'created_at'.
function countThisMonth(tenantId, table, createdCol = 'created_at') {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const monthStart = `${yyyy}-${mm}-01 00:00:00`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${table}
       WHERE tenant_id = ? AND ${createdCol} >= ?`
    )
    .get(tenantId, monthStart);
  return row ? row.c : 0;
}

function countTotal(tenantId, table) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = ?`)
    .get(tenantId);
  return row ? row.c : 0;
}

function getTenantLimits(tenantId) {
  const row = db
    .prepare(
      `SELECT max_users, max_leads_per_month, max_audits_per_month
       FROM tenants WHERE id = ?`
    )
    .get(tenantId);
  if (!row) return null;
  return {
    maxUsers: row.max_users,
    maxLeadsPerMonth: row.max_leads_per_month,
    maxAuditsPerMonth: row.max_audits_per_month,
  };
}

// Returns { allowed, used, limit, remaining }.
// `type` is one of 'lead' | 'audit' | 'user'.
function checkUsageLimits(tenantId, type) {
  const limits = getTenantLimits(tenantId);
  if (!limits) {
    return { allowed: false, used: 0, limit: 0, remaining: 0 };
  }

  let used = 0;
  let limit = 0;
  if (type === 'lead') {
    used = countThisMonth(tenantId, 'leads');
    limit = limits.maxLeadsPerMonth;
  } else if (type === 'audit') {
    used = countThisMonth(tenantId, 'reports');
    limit = limits.maxAuditsPerMonth;
  } else if (type === 'user') {
    used = countTotal(tenantId, 'users');
    limit = limits.maxUsers;
  } else {
    return { allowed: true, used: 0, limit: 0, remaining: 0 };
  }

  const remaining = Math.max(0, (limit || 0) - used);
  const allowed = !limit || used < limit; // 0/null limit = unlimited
  return { allowed, used, limit: limit || 0, remaining };
}

// Middleware factory that blocks the request with HTTP 429 when the tenant
// has exhausted its monthly quota for the given resource type. Super admins
// bypass quota checks.
function enforceUsageLimits(type) {
  return function (req, res, next) {
    if (req.user && req.user.role === 'super_admin') return next();
    const tenantId = req.tenantId || (req.user && req.user.tenant_id) || 'default';
    const status = checkUsageLimits(tenantId, type);
    if (!status.allowed) {
      return res.status(429).json({
        error: 'Monthly limit reached',
        type,
        used: status.used,
        limit: status.limit,
        upgradeMessage: 'Contact support to upgrade',
      });
    }
    next();
  };
}

module.exports = {
  checkUsageLimits,
  enforceUsageLimits,
};
