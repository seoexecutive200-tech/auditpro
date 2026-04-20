const express = require('express');
const { db } = require('../db/database');

const router = express.Router();

// Public — no auth. Frontend calls this on load to fetch per-agency branding.
router.get('/:subdomain/config', (req, res) => {
  try {
    const subdomain = String(req.params.subdomain || '').toLowerCase();
    const tenant = db
      .prepare(
        `SELECT id, subdomain, brand_name, logo_url, primary_color,
                gradient_start, gradient_end, status
         FROM tenants WHERE subdomain = ?`
      )
      .get(subdomain);

    if (!tenant) {
      return res.status(404).json({ error: 'Agency not found or suspended' });
    }
    if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
      return res.status(403).json({ error: 'Agency not found or suspended' });
    }

    return res.json({
      tenantId: tenant.id,
      subdomain: tenant.subdomain,
      brandName: tenant.brand_name,
      logoUrl: tenant.logo_url,
      primaryColor: tenant.primary_color,
      gradientStart: tenant.gradient_start,
      gradientEnd: tenant.gradient_end,
      status: tenant.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
