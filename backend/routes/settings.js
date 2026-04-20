const express = require('express');
const { db } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../utils/auth');

const router = express.Router();

// Allow-list to prevent arbitrary key injection.
const ALLOWED_KEYS = [
  'agency_name',
  'agency_logo',
  'agency_contact',
  'agency_website',
  'agency_phone',
  'pagespeed_api_key',
  'bing_api_key',
  'groq_api_key',
];

function loadAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((row) => (settings[row.key] = row.value));
  return settings;
}

// GET /api/settings — any authenticated user
router.get('/', authenticateToken, (req, res) => {
  try {
    return res.json(loadAllSettings());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — admin only
// Accepts any of:
//   1. { key: "agency_name", value: "Foo" }             — single pair
//   2. { settings: { agency_name: "Foo", ... } }         — wrapped object
//   3. { agency_name: "Foo", pagespeed_api_key: "..." } — flat object
function writeHandler(req, res) {
  try {
    const body = req.body || {};
    let toWrite = {};

    if (typeof body.key === 'string' && 'value' in body) {
      toWrite = { [body.key]: body.value };
    } else if (body.settings && typeof body.settings === 'object') {
      toWrite = body.settings;
    } else {
      toWrite = body;
    }

    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const updateMany = db.transaction((entries) => {
      for (const [key, value] of entries) {
        if (!ALLOWED_KEYS.includes(key)) continue;
        if (value === undefined) continue;
        upsert.run(key, value === null ? '' : String(value));
      }
    });
    updateMany(Object.entries(toWrite));

    return res.json({ success: true, message: 'Settings saved', settings: loadAllSettings() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

router.put('/', authenticateToken, requireAdmin, writeHandler);
router.post('/', authenticateToken, requireAdmin, writeHandler);

module.exports = router;
