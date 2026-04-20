const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { authenticateToken, requireAdmin } = require('../utils/auth');
const { resolveTenant } = require('../middleware/tenantMiddleware');

const { getTokenStatus, useTokens } = require('../utils/tokenTracker');
const { searchAllDirectories } = require('../utils/directoryCrawler');
const { searchBing } = require('../utils/bingScraper');
const { searchGooglePlaces } = require('../utils/googlePlacesScraper');
const { findEmailsOnWebsite, getEmailQuality } = require('../utils/emailFinder');
const { deduplicateLeads } = require('../utils/leadDeduplicator');

const router = express.Router();

const NICHE_VARIATIONS = {
  plumbers: ['plumbing services', 'drain cleaning', 'pipe repair', 'emergency plumber', 'boiler repair'],
  dentists: ['dental clinic', 'dental surgery', 'teeth whitening', 'orthodontist', 'dental implants'],
  lawyers: ['law firm', 'solicitors', 'legal services', 'attorney', 'legal advice'],
  accountants: ['accounting firm', 'bookkeeping', 'tax services', 'financial advisor', 'CPA'],
  restaurants: ['cafe', 'bistro', 'eatery', 'food delivery', 'takeaway'],
  gyms: ['fitness center', 'personal trainer', 'yoga studio', 'pilates', 'crossfit'],
  salons: ['hair salon', 'beauty salon', 'barber shop', 'nail salon', 'spa'],
  electricians: ['electrical services', 'electrical contractor', 'rewiring', 'electrical repair'],
  cleaners: ['cleaning services', 'commercial cleaning', 'domestic cleaning', 'office cleaning'],
  builders: ['construction company', 'general contractor', 'renovation', 'home improvement'],
};

const NEARBY_CITIES = {
  manchester: ['Salford', 'Bolton', 'Stockport', 'Oldham'],
  london: ['Westminster', 'Croydon', 'Bromley', 'Hackney'],
  birmingham: ['Wolverhampton', 'Coventry', 'Leicester'],
  dubai: ['Abu Dhabi', 'Sharjah', 'Ajman'],
  'new york': ['Brooklyn', 'Queens', 'Newark', 'Jersey City'],
  'los angeles': ['Beverly Hills', 'Santa Monica', 'Pasadena'],
};

function findNicheKey(niche) {
  const lower = String(niche || '').toLowerCase().trim();
  if (NICHE_VARIATIONS[lower]) return lower;
  for (const key of Object.keys(NICHE_VARIATIONS)) {
    if (lower.includes(key) || key.includes(lower)) return key;
    if (NICHE_VARIATIONS[key].some((v) => v.toLowerCase() === lower)) return key;
  }
  return null;
}

function findNearbyKey(location) {
  const lower = String(location || '').toLowerCase().trim();
  if (NEARBY_CITIES[lower]) return lower;
  for (const key of Object.keys(NEARBY_CITIES)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

function generateSearchSuggestions(niche, location) {
  const suggestions = [];
  const nicheKey = findNicheKey(niche);
  if (nicheKey) {
    const variations = NICHE_VARIATIONS[nicheKey].filter(
      (v) => v.toLowerCase() !== String(niche).toLowerCase()
    );
    for (const v of variations.slice(0, 2)) {
      suggestions.push({
        label: `Try ${v} ${location}`,
        niche: v,
        location,
      });
    }
  }
  const nearbyKey = findNearbyKey(location);
  if (nearbyKey) {
    for (const city of NEARBY_CITIES[nearbyKey].slice(0, 3)) {
      suggestions.push({
        label: `Try ${niche} ${city}`,
        niche,
        location: city,
      });
    }
  }
  return suggestions.slice(0, 5);
}

const searchJobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function cleanupOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of searchJobs.entries()) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      searchJobs.delete(id);
    }
  }
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function validateInput(body) {
  const niche = (body && body.niche ? String(body.niche) : '').trim();
  const location = (body && body.location ? String(body.location) : '').trim();
  // `limit` is now the TARGET number of leads *with emails* the user wants.
  // `targetEmails` is also accepted as an alias.
  const raw = Number((body && (body.targetEmails ?? body.limit)) || 20);
  let limit = Number.isFinite(raw) ? raw : 20;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  const allowed = ['directory', 'bing', 'google_places'];
  let sources = Array.isArray(body && body.sources) ? body.sources : [];
  sources = sources.map((s) => String(s).toLowerCase()).filter((s) => allowed.includes(s));
  if (!sources.includes('directory')) sources.unshift('directory');

  // 1-based crawler page offset so the UI can ask for the "next page" of
  // results without repeating the first batch.
  let offset = Number((body && (body.offset ?? body.startPage)) || 1);
  if (!Number.isFinite(offset) || offset < 1) offset = 1;
  if (offset > 50) offset = 50;

  const businessEmailsOnly = !!(body && body.businessEmailsOnly);

  return { niche, location, limit, sources, offset, businessEmailsOnly };
}

function normalizeLeadUrl(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

async function runSearch(params, progress) {
  const {
    niche,
    location,
    limit,
    sources: inputSources,
    userId,
    offset = 1,
    businessEmailsOnly = false,
  } = params;
  console.log(
    `🚀 Lead search: niche="${niche}" location="${location}" limit=${limit} sources=${JSON.stringify(
      inputSources
    )}`
  );
  const warnings = [];
  let sources = [...inputSources];
  let tokenStatus = getTokenStatus('bing');

  if (sources.includes('bing')) {
    if (tokenStatus.status === 'exhausted') {
      if (sources.length === 1) {
        throw Object.assign(new Error('Bing tokens exhausted for this month'), { statusCode: 400 });
      }
      sources = sources.filter((s) => s !== 'bing');
      warnings.push('Bing disabled — monthly token limit exhausted');
    }
  }

  const googleKey = getSetting('pagespeed_api_key');
  if (sources.includes('google_places') && (!googleKey || !googleKey.trim())) {
    if (sources.length === 1) {
      throw Object.assign(
        new Error('Google Places requires a PageSpeed API key in Settings'),
        { statusCode: 400 }
      );
    }
    sources = sources.filter((s) => s !== 'google_places');
    warnings.push('Google Places disabled — no API key set in Settings');
  }

  progress.phase = 'scraping';
  const bingKey = getSetting('bing_api_key');
  const sourceCounts = { directory: 0, bing: 0, google_places: 0 };
  const directoryBreakdown = {};
  let detectedCountry = null;
  let tokensUsed = 0;

  const directoryStatus = {};
  const onDirProgress = (evt) => {
    if (!evt || !evt.directory) return;
    directoryStatus[evt.directory] = evt;
    if (evt.stage === 'fetching-page') {
      progress.currentSite = `${evt.directory} (page ${evt.page}/${evt.pages})`;
    } else if (evt.stage === 'enriching') {
      progress.currentSite = evt.current
        ? `${evt.directory}: enriching ${evt.current}/${evt.total}`
        : `${evt.directory}: enriching ${evt.total} listings`;
    } else if (evt.stage === 'done') {
      progress.currentSite = `${evt.directory}: ${evt.count} found`;
    } else if (evt.stage === 'fetching') {
      progress.currentSite = `${evt.directory}…`;
    }
    progress.directoryStatus = { ...directoryStatus };
  };

  const tasks = sources.map((src) => {
    if (src === 'directory') {
      return searchAllDirectories(niche, location, limit, onDirProgress, { startPage: offset }).then((r) => ({
        src,
        r: r.results || [],
        breakdown: r.sources || {},
        country: r.country,
      }));
    }
    if (src === 'bing') {
      return searchBing(niche, location, limit, bingKey).then((res) => ({
        src,
        r: res.results || [],
        tokensUsed: res.tokensUsed || 0,
        error: res.error,
      }));
    }
    if (src === 'google_places') {
      return searchGooglePlaces(niche, location, limit, googleKey).then((res) => ({
        src,
        r: res.results || [],
        error: res.error,
      }));
    }
    return Promise.resolve({ src, r: [] });
  });

  const settled = await Promise.all(tasks);
  const combined = [];
  for (const out of settled) {
    const arr = Array.isArray(out.r) ? out.r : [];
    sourceCounts[out.src] = arr.length;
    console.log(`📊 Source ${out.src} returned ${arr.length} results`);
    combined.push(...arr);
    if (out.src === 'directory') {
      Object.assign(directoryBreakdown, out.breakdown || {});
      detectedCountry = out.country || null;
    }
    if (out.src === 'bing') {
      tokensUsed += out.tokensUsed || 0;
      if (out.error) warnings.push(`Bing: ${out.error}`);
    }
    if (out.src === 'google_places' && out.error) warnings.push(`Google Places: ${out.error}`);
  }
  console.log(`📊 Combined before dedupe: ${combined.length}`);

  progress.phase = 'deduplicating';
  const { unique: initialUnique, duplicateCount } = deduplicateLeads(combined);
  console.log(`📊 After dedupe: ${initialUnique.length} unique, ${duplicateCount} duplicates`);

  // Pool of candidates grows as we paginate; already-processed websites are
  // tracked so re-crawls don't double-scan.
  const processed = new Set();
  const candidates = [...initialUnique];

  const tenantId = params.tenantId || 'default';
  const existingRowsInDb = db
    .prepare(
      "SELECT website FROM leads WHERE tenant_id = ? AND website IS NOT NULL AND website != ''"
    )
    .all(tenantId);
  const existingInDb = new Set(
    existingRowsInDb.map((r) => normalizeLeadUrl(r.website)).filter(Boolean)
  );

  const targetEmails = limit;
  const maxAttempts = targetEmails * 5;
  const withEmails = [];
  let attempts = 0;
  let totalScanned = 0;
  let noEmailCount = 0;
  let duplicatesInDb = 0;
  // Begin pagination at the caller-supplied offset so "Search Next Page"
  // picks up where the previous search left off.
  let batchStartPage = offset;
  let personalEmailsFiltered = 0;

  progress.phase = 'finding_emails';
  progress.total = targetEmails;
  progress.current = 0;

  console.log(
    `📧 Target: ${targetEmails} leads-with-emails. Initial pool: ${candidates.length}`
  );

  outer: while (withEmails.length < targetEmails && attempts < maxAttempts) {
    // If we've processed everything in the pool, fetch another page-batch.
    const allKeys = candidates
      .map((l) => (l.website ? normalizeLeadUrl(l.website) : ''))
      .filter(Boolean);
    const remaining = allKeys.filter((k) => !processed.has(k));
    if (remaining.length === 0) {
      batchStartPage += 1;
      console.log(`🔁 Fetching more results (batch startPage=${batchStartPage})`);
      progress.currentSite = `fetching more results (batch ${batchStartPage})…`;
      let more;
      try {
        more = await searchAllDirectories(niche, location, targetEmails * 2, onDirProgress, {
          startPage: batchStartPage,
        });
      } catch (err) {
        console.log('❌ Pagination fetch failed:', err.message);
        break;
      }
      const moreResults = (more && more.results) || [];
      if (moreResults.length === 0) {
        console.log('🛑 No more results from directories — stopping pagination');
        break;
      }
      const { unique: moreUnique } = deduplicateLeads(moreResults);
      const fresh = moreUnique.filter((l) => {
        const k = l.website ? normalizeLeadUrl(l.website) : '';
        return k && !processed.has(k) && !candidates.some(
          (c) => normalizeLeadUrl(c.website) === k
        );
      });
      if (fresh.length === 0) {
        console.log('🛑 All paginated results were already seen — stopping');
        break;
      }
      candidates.push(...fresh);
      continue;
    }

    for (const lead of candidates) {
      if (withEmails.length >= targetEmails) break outer;
      if (attempts >= maxAttempts) break outer;
      if (!lead || !lead.website) continue;
      const key = normalizeLeadUrl(lead.website);
      if (!key || processed.has(key)) continue;
      processed.add(key);

      attempts += 1;
      totalScanned += 1;

      if (existingInDb.has(key)) {
        duplicatesInDb += 1;
        continue;
      }

      progress.currentSite = lead.website || lead.businessName || '';

      const emailInfo = await findEmailsOnWebsite(lead.website);
      if (emailInfo && emailInfo.primaryEmail) {
        const quality = getEmailQuality(emailInfo.primaryEmail, lead.website);
        if (businessEmailsOnly && quality !== 'business') {
          personalEmailsFiltered += 1;
          await sleep(800);
          continue;
        }
        withEmails.push({
          ...lead,
          email: emailInfo.primaryEmail,
          emailQuality: quality,
          contactName: emailInfo.contactName || lead.contactName || null,
        });
        progress.current = withEmails.length;
        progress.percent = Math.round((withEmails.length / targetEmails) * 100);
        progress.message = `Found emails: ${withEmails.length}/${targetEmails}`;
      } else {
        noEmailCount += 1;
      }

      await sleep(800);
    }
  }

  const discarded = noEmailCount;
  console.log(
    `✅ Final: ${withEmails.length}/${targetEmails} leads with emails (scanned ${totalScanned}, ${noEmailCount} no email, ${duplicatesInDb} already in DB, ${duplicateCount} source dupes)`
  );
  const targetReached = withEmails.length >= targetEmails;

  if (tokensUsed > 0) {
    tokenStatus = useTokens('bing', tokensUsed);
  } else {
    tokenStatus = getTokenStatus('bing');
  }

  const searchId = uuidv4();
  db.prepare(
    `INSERT INTO lead_searches
     (id, user_id, niche, location, sources_used, total_found, emails_found, tokens_used, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    searchId,
    userId || null,
    niche,
    location,
    JSON.stringify(sources),
    totalScanned,
    withEmails.length,
    tokensUsed,
    params.tenantId || 'default'
  );

  return {
    results: withEmails,
    targetEmails,
    targetReached,
    totalScanned,
    noEmailCount,
    duplicatesInDb,
    personalEmailsFiltered,
    businessEmailsOnly,
    offset,
    nextOffset: Math.max(batchStartPage + 1, offset + 1),
    discarded,
    duplicatesSkipped: duplicateCount,
    sourceCounts,
    directoryBreakdown,
    detectedCountry,
    tokensUsed,
    tokenStatus,
    warnings,
    searchId,
    suggestions: generateSearchSuggestions(niche, location),
  };
}

router.use(authenticateToken, resolveTenant);

router.get('/tokens', requireAdmin, (req, res) => {
  try {
    const bing = getTokenStatus('bing');
    const bingKey = getSetting('bing_api_key');
    const googleKey = getSetting('pagespeed_api_key');
    return res.json({
      crawler: {
        configured: true,
        type: 'free',
        limit: 'Unlimited',
        description: 'Web directory crawler',
      },
      bing: {
        configured: !!(bingKey && bingKey.trim()),
        tokensUsedMonth: bing.tokensUsedMonth,
        remainingMonth: bing.remainingMonth,
        monthlyLimit: bing.monthlyLimit,
        percentUsed: bing.percentUsed,
        status: bing.status,
        resetsOn: bing.resetsOn,
        daysUntilReset: bing.daysUntilReset,
        limit: '1000/month',
      },
      googlePlaces: {
        configured: !!(googleKey && googleKey.trim()),
        limit: '100/day (free tier)',
      },
      // legacy fields kept for any older client code
      monthlyLimit: bing.monthlyLimit,
      tokensUsedMonth: bing.tokensUsedMonth,
      remainingMonth: bing.remainingMonth,
      percentUsed: bing.percentUsed,
      status: bing.status,
      resetsOn: bing.resetsOn,
      daysUntilReset: bing.daysUntilReset,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/search/history', requireAdmin, (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT id, niche, location, sources_used, total_found, emails_found, tokens_used, created_at
         FROM lead_searches
         WHERE tenant_id = ?
         ORDER BY created_at DESC
         LIMIT 10`
      )
      .all(req.tenantId);
    return res.json({ history: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/search', requireAdmin, async (req, res) => {
  try {
    const { niche, location, limit, sources, offset, businessEmailsOnly } = validateInput(req.body);
    if (!niche) return res.status(400).json({ error: 'niche is required' });
    if (!location) return res.status(400).json({ error: 'location is required' });

    const progress = { phase: 'starting', current: 0, total: 0, percent: 0, currentSite: '' };
    const result = await runSearch(
      {
        niche,
        location,
        limit,
        sources,
        offset,
        businessEmailsOnly,
        userId: req.user.id,
        tenantId: req.tenantId,
      },
      progress
    );
    return res.json(result);
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ error: err.message });
  }
});

router.post('/search/start', requireAdmin, (req, res) => {
  try {
    const { niche, location, limit, sources, offset, businessEmailsOnly } = validateInput(req.body);
    if (!niche) return res.status(400).json({ error: 'niche is required' });
    if (!location) return res.status(400).json({ error: 'location is required' });

    cleanupOldJobs();
    const jobId = uuidv4();
    const job = {
      jobId,
      status: 'running',
      progress: { phase: 'starting', current: 0, total: 0, percent: 0, currentSite: '' },
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    searchJobs.set(jobId, job);

    runSearch(
      {
        niche,
        location,
        limit,
        sources,
        offset,
        businessEmailsOnly,
        userId: req.user.id,
        tenantId: req.tenantId,
      },
      job.progress
    )
      .then((result) => {
        job.result = result;
        job.status = 'completed';
        job.finishedAt = Date.now();
      })
      .catch((err) => {
        job.error = err.message;
        job.status = 'failed';
        job.finishedAt = Date.now();
      });

    return res.json({ jobId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/search/:jobId/status', requireAdmin, (req, res) => {
  const job = searchJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const payload = {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    currentSite: job.progress.currentSite || '',
    tokenStatus: getTokenStatus('bing'),
  };
  if (job.status === 'completed') payload.results = job.result;
  if (job.status === 'failed') payload.error = job.error;
  return res.json(payload);
});

module.exports = router;
