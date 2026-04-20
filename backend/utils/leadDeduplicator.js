const { db } = require('../db/database');

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let u = url.trim().toLowerCase();
  if (!u) return '';
  u = u.replace(/^https?:\/\//, '');
  u = u.replace(/^www\./, '');
  u = u.replace(/\/+$/, '');
  return u;
}

function deduplicateLeads(newLeads) {
  const leads = Array.isArray(newLeads) ? newLeads : [];

  const existing = new Set();
  try {
    const rows = db
      .prepare("SELECT website FROM leads WHERE website IS NOT NULL AND website != ''")
      .all();
    for (const r of rows) {
      const n = normalizeUrl(r.website);
      if (n) existing.add(n);
    }
  } catch {
    // table missing or read failed — treat as no existing
  }

  const unique = [];
  const duplicates = [];
  const seenInBatch = new Set();

  for (const lead of leads) {
    const website = (lead && lead.website) || '';
    const normalized = normalizeUrl(website);

    if (!normalized) {
      unique.push(lead);
      continue;
    }

    if (existing.has(normalized)) {
      duplicates.push(lead);
      continue;
    }

    if (seenInBatch.has(normalized)) {
      duplicates.push(lead);
      continue;
    }

    seenInBatch.add(normalized);
    unique.push(lead);
  }

  return {
    unique,
    duplicates,
    duplicateCount: duplicates.length,
    uniqueCount: unique.length,
  };
}

module.exports = {
  deduplicateLeads,
  normalizeUrl,
};
