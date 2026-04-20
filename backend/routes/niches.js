const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');

const router = express.Router();

router.use(authenticateToken, resolveTenant);

router.get('/', (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT n.*, u.name as assigned_name,
           (SELECT COUNT(*) FROM leads l WHERE l.niche_id = n.id AND l.tenant_id = ?) as lead_count
         FROM niches n
         LEFT JOIN users u ON u.id = n.assigned_to
         WHERE n.tenant_id = ?
         ORDER BY n.created_at DESC`
      )
      .all(req.tenantId, req.tenantId);
    return res.json({ niches: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name ? String(b.name) : '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = uuidv4();
    db.prepare(
      `INSERT INTO niches (id, name, icon, color, assigned_to, created_by, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name,
      b.icon || null,
      b.color || null,
      b.assigned_to || b.assignedTo || null,
      req.user.id,
      req.tenantId
    );

    const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(id);
    return res.status(201).json({ niche });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const existing = db
      .prepare('SELECT * FROM niches WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Niche not found' });

    const b = req.body || {};
    const updates = [];
    const args = [];

    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      updates.push('name = ?'); args.push(name);
    }
    if (b.icon !== undefined) { updates.push('icon = ?'); args.push(b.icon || null); }
    if (b.color !== undefined) { updates.push('color = ?'); args.push(b.color || null); }
    if (b.assigned_to !== undefined || b.assignedTo !== undefined) {
      updates.push('assigned_to = ?');
      args.push(b.assigned_to ?? b.assignedTo ?? null);
    }

    if (updates.length === 0) return res.json({ niche: existing });

    args.push(req.params.id);
    db.prepare(`UPDATE niches SET ${updates.join(', ')} WHERE id = ?`).run(...args);

    const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
    return res.json({ niche });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Remove demo/sample niches (broken-icon rows and seeded names). Must come
// BEFORE /:id so the param route doesn't shadow it. Niches with existing
// leads are preserved and reported back as `keptWithLeads`.
router.delete('/clear-demo', requireAdmin, (req, res) => {
  try {
    const rows = db
      .prepare('SELECT id, name, icon FROM niches WHERE tenant_id = ?')
      .all(req.tenantId);

    const demoNames = new Set(['final niche', 'test', 'demo', 'sample', 'test niche', 'sample niche']);
    const isAsciiOnly = (s) => !!s && !/[^\x00-\x7F]/.test(s);

    const toDelete = rows.filter((n) => {
      const name = String(n.name || '').trim().toLowerCase();
      if (demoNames.has(name)) return true;
      // An icon that only has ASCII characters is almost certainly mojibake
      // from a lost UTF-8 emoji (e.g. "??") — treat as a demo row.
      if (n.icon && isAsciiOnly(n.icon)) return true;
      return false;
    });

    let deleted = 0;
    let keptWithLeads = 0;
    const tx = db.transaction(() => {
      for (const n of toDelete) {
        const leadCount = db
          .prepare('SELECT COUNT(*) AS c FROM leads WHERE niche_id = ? AND tenant_id = ?')
          .get(n.id, req.tenantId).c;
        if (leadCount > 0) {
          keptWithLeads += 1;
          continue;
        }
        db.prepare('DELETE FROM niches WHERE id = ? AND tenant_id = ?').run(n.id, req.tenantId);
        deleted += 1;
      }
    });
    tx();

    return res.json({ deleted, keptWithLeads, scanned: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const existing = db
      .prepare('SELECT id FROM niches WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Niche not found' });

    const leadCount = db
      .prepare('SELECT COUNT(*) as c FROM leads WHERE niche_id = ? AND tenant_id = ?')
      .get(req.params.id, req.tenantId).c;

    if (leadCount > 0) {
      return res.status(400).json({
        error: 'Cannot delete niche with existing leads. Reassign or delete leads first.',
      });
    }

    db.prepare('DELETE FROM niches WHERE id = ?').run(req.params.id);
    return res.json({ message: 'Niche deleted' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
