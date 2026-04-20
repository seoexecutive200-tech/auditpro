const axios = require('axios');
const cheerio = require('cheerio');

const TIMEOUT = 20000;
const HOTFROG_PAGES = 3; // 1, 2, 3

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
];

const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|pdf|mp4|mp3)(\?|$)/i;

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return sleep(Math.floor(min + Math.random() * (max - min)));
}

function buildHeaders(refererHost) {
  const h = {
    'User-Agent': pickUA(),
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (refererHost) h.Referer = `https://${refererHost}/`;
  return h;
}

async function fetchHtml(url, host) {
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT,
      headers: buildHeaders(host),
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
      decompress: true,
    });
    return {
      html: typeof res.data === 'string' ? res.data : '',
      status: res.status,
    };
  } catch (err) {
    return { html: '', status: err.response ? err.response.status : 0, error: err.message };
  }
}

function cleanText(t) {
  return (t || '').replace(/\s+/g, ' ').trim();
}

function normalizeWebsite(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const target = u.searchParams.get('url') || u.searchParams.get('to') || u.searchParams.get('target');
    if (target && /^https?:\/\//i.test(target)) s = target;
  } catch {
    if (!/^https?:\/\//i.test(s) && /\./.test(s)) s = 'https://' + s;
  }
  if (!/^https?:\/\//i.test(s)) return '';
  if (IMAGE_EXT_RE.test(s)) return '';
  return s;
}

function hostKey(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const NON_BUSINESS_HOSTS = [
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com',
  'youtube.com', 'pinterest.com', 'tiktok.com', 'google.com', 'maps.google.com',
  'apple.com', 'wikipedia.org', 'yelp.com', 'yelp.co.uk', 'yellowpages.com',
  'yell.com', 'cylex.co.uk', 'cylex-uk.co.uk', 'cylex.com', 'freeindex.co.uk',
  'thomsonlocal.com', 'manta.com', 'superpages.com', 'yellowpages.ae',
  'sulekha.com', 'doubleclick.net', 'googletagmanager.com',
  'googlesyndication.com', 'jooble.org', 'here.com', 'share.here.com',
  'locafy.com', 'newfold.com', 'wa.me', 'whatsapp.com', 'bing.com',
  'tupalo.com', 'n49.com', 'findopen.co.uk',
];

const NON_BUSINESS_SUBSTRINGS = ['hotfrog'];

function isBusinessUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (NON_BUSINESS_SUBSTRINGS.some((s) => h.includes(s))) return false;
    return !NON_BUSINESS_HOSTS.some((bad) => h === bad || h.endsWith('.' + bad));
  } catch {
    return false;
  }
}

// ================== HOTFROG ==================

function extractHotfrogWebsite(detailHtml) {
  if (!detailHtml) return '';
  const $ = cheerio.load(detailHtml);
  let website = '';
  $('a[href^="http"]').each(function () {
    if (website) return false;
    const cleaned = normalizeWebsite($(this).attr('href') || '');
    if (cleaned && isBusinessUrl(cleaned)) website = cleaned;
  });
  return website;
}

function parseHotfrogPage($, host, sourceName) {
  const stubs = [];
  const seen = new Set();
  $('h3 a[href*="/company/"]').each((_, a) => {
    const $a = $(a);
    const name = cleanText($a.text());
    if (!name || name.length < 2) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const detailHref = $a.attr('href') || '';
    if (/^javascript:/i.test(detailHref) || !detailHref) return;
    const detailUrl = /^https?:/i.test(detailHref)
      ? detailHref
      : `https://${host}${detailHref}`;

    let $row = $a.closest('.row');
    if (!$row.length) $row = $a.closest('li, article');
    if (!$row.length) $row = $a.parent().parent().parent();

    let phone = '';
    const telLink = $row.find('a[href^="tel:"]').first().attr('href') || '';
    if (telLink) phone = telLink.replace(/^tel:/i, '').trim();
    if (!phone) {
      const m = $row.text().match(PHONE_RE);
      phone = m ? m[0].trim() : '';
    }

    stubs.push({
      businessName: name,
      website: '',
      phone,
      address: '',
      source: sourceName,
      detailUrl,
    });
  });
  return stubs;
}

async function crawlHotfrog(directory, niche, location, onProgress, options = {}) {
  const { host, sourceName, pages: pagesCount = HOTFROG_PAGES } = directory;
  const startPage = Math.max(1, options.startPage || 1);
  const endPage = startPage + pagesCount - 1;
  const base = `https://${host}/search/${encodeURIComponent(location)}/${encodeURIComponent(niche)}`;
  const allStubs = [];
  const seenNames = new Set();

  for (let p = startPage; p <= endPage; p += 1) {
    const url = p === 1 ? base : `${base}/${p}`;
    if (onProgress) {
      onProgress({
        directory: sourceName,
        stage: 'fetching-page',
        page: p,
        pages: endPage,
      });
    }
    console.log(`🕷️ Crawling: ${sourceName} page ${p} (batch ${startPage}-${endPage}) → ${url}`);
    await randomDelay(800, 1800);
    const { html, status } = await fetchHtml(url, host);
    console.log(`📄 ${sourceName} p${p} → HTTP ${status} (${html.length} chars)`);
    if (!html) break;
    if (/captcha|are you a human|access denied|request blocked|cloudflare/i.test(html.slice(0, 4000))) {
      console.log(`⚠️ ${sourceName} blocked on page ${p}`);
      break;
    }
    const $ = cheerio.load(html);
    const pageStubs = parseHotfrogPage($, host, sourceName);
    const newly = pageStubs.filter((s) => {
      const k = s.businessName.toLowerCase();
      if (seenNames.has(k)) return false;
      seenNames.add(k);
      return true;
    });
    allStubs.push(...newly);
    console.log(`🕷️ ${sourceName} p${p} → ${newly.length} new (cumulative ${allStubs.length})`);
    if (pageStubs.length === 0) break; // no more pages
  }

  if (onProgress) {
    onProgress({
      directory: sourceName,
      stage: 'enriching',
      total: allStubs.length,
    });
  }
  console.log(`🔗 ${sourceName}: enriching websites for ${allStubs.length} listings`);

  const out = [];
  let enrichIndex = 0;
  for (const stub of allStubs) {
    enrichIndex += 1;
    const { html } = await fetchHtml(stub.detailUrl, host);
    const website = extractHotfrogWebsite(html);
    if (website) console.log(`  ↪ ${stub.businessName} → ${website}`);
    out.push({
      businessName: stub.businessName,
      website,
      phone: stub.phone,
      address: '',
      source: sourceName,
    });
    if (onProgress) {
      onProgress({
        directory: sourceName,
        stage: 'enriching',
        current: enrichIndex,
        total: allStubs.length,
      });
    }
    await sleep(250 + Math.random() * 350);
  }

  if (onProgress) {
    onProgress({ directory: sourceName, stage: 'done', count: out.length });
  }
  return out;
}

// ================== GENERIC SELECTOR CRAWLER ==================

function parseGeneric($, sel, sourceName, limit) {
  const cards = $(sel.listings);
  const out = [];
  const seen = new Set();
  cards.each((_, el) => {
    if (out.length >= limit) return false;
    const $card = $(el);
    const businessName = cleanText($card.find(sel.name).first().text());
    if (!businessName || businessName.length < 2) return;
    const key = businessName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    let website = '';
    $card.find(sel.website).each(function () {
      const href = $(this).attr('href') || '';
      if (!website && href) {
        const cleaned = normalizeWebsite(href);
        if (cleaned && (!sel.websiteBlock || !new RegExp(sel.websiteBlock, 'i').test(cleaned))) {
          website = cleaned;
        }
      }
    });

    let phone = cleanText($card.find(sel.phone).first().text());
    if (!phone) {
      const m = $card.text().match(PHONE_RE);
      phone = m ? m[0].trim() : '';
    }

    const address = cleanText($card.find(sel.address).first().text());

    out.push({
      businessName,
      website,
      phone,
      address,
      source: sourceName,
    });
  });
  return out;
}

async function crawlGeneric(directory, niche, location, onProgress) {
  const url = directory.searchUrl(niche, location);
  if (onProgress) onProgress({ directory: directory.name, stage: 'fetching' });
  console.log(`🕷️ Crawling: ${directory.name} → ${url}`);
  await randomDelay(1000, 2500);
  const { html, status } = await fetchHtml(url, directory.host);
  console.log(`📄 ${directory.name} → HTTP ${status} (${html.length} chars)`);
  if (!html || /captcha|access denied|cloudflare|request blocked/i.test(html.slice(0, 4000))) {
    if (onProgress) onProgress({ directory: directory.name, stage: 'done', count: 0 });
    return [];
  }
  const $ = cheerio.load(html);
  const results = parseGeneric($, directory.selectors, directory.name, 50);
  console.log(`🕷️ ${directory.name} → ${results.length} found`);
  if (onProgress) onProgress({ directory: directory.name, stage: 'done', count: results.length });
  return results;
}

// ================== DIRECTORIES ==================

function hotfrogDir(name, host) {
  return { name, host, type: 'hotfrog', sourceName: name };
}

const directories = {
  UK: [
    hotfrogDir('Hotfrog UK', 'www.hotfrog.co.uk'),
    {
      name: 'FreeIndex',
      host: 'www.freeindex.co.uk',
      searchUrl: (n, l) =>
        `https://www.freeindex.co.uk/search.htm?what=${encodeURIComponent(n)}&where=${encodeURIComponent(l)}`,
      selectors: {
        listings: '.listing, .result, [class*="listing"], .company, article',
        name: '.business-name, .company-name, h2 a, h3 a, h2, h3',
        website: '.website a, a[href^="http"]',
        websiteBlock: 'freeindex',
        phone: '.telephone, [class*="phone"], .tel',
        address: '.address, [class*="address"]',
      },
    },
    {
      name: 'Thomson Local',
      host: 'www.thomsonlocal.com',
      searchUrl: (n, l) =>
        `https://www.thomsonlocal.com/search/${encodeURIComponent(n)}/${encodeURIComponent(l)}`,
      selectors: {
        listings: '.result-item, .listing, article, [class*="result"]',
        name: '.company-name, h2 a, h2, h3',
        website: 'a.website, a[href^="http"]',
        websiteBlock: 'thomsonlocal',
        phone: '.phone-number, [class*="phone"]',
        address: '.address, [class*="address"]',
      },
    },
  ],
  US: [hotfrogDir('Hotfrog US', 'www.hotfrog.com')],
  CA: [hotfrogDir('Hotfrog Canada', 'www.hotfrog.ca')],
  AU: [hotfrogDir('Hotfrog Australia', 'www.hotfrog.com.au')],
  INDIA: [
    hotfrogDir('Hotfrog India', 'www.hotfrog.in'),
    {
      name: 'Sulekha',
      host: 'www.sulekha.com',
      searchUrl: (n, l) =>
        `https://www.sulekha.com/${encodeURIComponent(String(n).replace(/ /g, '-'))}/${encodeURIComponent(String(l).replace(/ /g, '-'))}`,
      selectors: {
        listings: '.companylist, .listing-card, article, [class*="listing"]',
        name: '.comp-name, h2 a, h2, h3',
        website: 'a.website-link, a[href^="http"]',
        websiteBlock: 'sulekha',
        phone: '.contact-no, [class*="phone"]',
        address: '.address, [class*="address"]',
      },
    },
  ],
  IE: [hotfrogDir('Hotfrog Ireland', 'www.hotfrog.ie')],
  ZA: [hotfrogDir('Hotfrog South Africa', 'www.hotfrog.co.za')],
  UAE: [
    {
      name: 'Yellow Pages UAE',
      host: 'www.yellowpages.ae',
      searchUrl: (n, l) =>
        `https://www.yellowpages.ae/en/search?q=${encodeURIComponent(n)}&l=${encodeURIComponent(l)}`,
      selectors: {
        listings: '.listing, .result, article, [class*="listing"]',
        name: '.name, h2 a, h3 a, h2, h3',
        website: 'a.website, a[href^="http"]',
        websiteBlock: 'yellowpages.ae',
        phone: '.phone, [class*="phone"]',
        address: '.address, [class*="address"]',
      },
    },
  ],
  GLOBAL: [],
};

function detectCountry(location) {
  const loc = String(location || '').toLowerCase();

  const matchers = [
    {
      code: 'UK',
      cities: [
        'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh',
        'bristol', 'liverpool', 'sheffield', 'newcastle', 'nottingham', 'cardiff',
        'uk', 'england', 'scotland', 'wales', 'britain', 'belfast', 'brighton',
        'oxford', 'cambridge', 'southampton',
      ],
    },
    {
      code: 'US',
      cities: [
        'new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
        'san antonio', 'san diego', 'dallas', 'san jose', 'usa', 'america',
        'brooklyn', 'queens', 'miami', 'boston', 'seattle', 'atlanta', 'denver',
      ],
    },
    {
      code: 'CA',
      cities: [
        'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'winnipeg',
        'canada', 'edmonton', 'quebec', 'halifax',
      ],
    },
    {
      code: 'AU',
      cities: [
        'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'australia',
        'canberra', 'gold coast',
      ],
    },
    {
      code: 'INDIA',
      cities: [
        'mumbai', 'delhi', 'bangalore', 'hyderabad', 'chennai', 'kolkata',
        'pune', 'india', 'ahmedabad', 'jaipur',
      ],
    },
    {
      code: 'IE',
      cities: ['dublin', 'cork', 'galway', 'ireland'],
    },
    {
      code: 'ZA',
      cities: [
        'johannesburg', 'cape town', 'durban', 'pretoria', 'south africa',
      ],
    },
    {
      code: 'UAE',
      cities: ['dubai', 'abu dhabi', 'sharjah', 'ajman', 'uae', 'emirates'],
    },
  ];

  for (const m of matchers) {
    if (m.cities.some((c) => loc.includes(c))) return m.code;
  }
  return 'GLOBAL';
}

async function crawlDirectory(directory, niche, location, onProgress, options = {}) {
  try {
    if (directory.type === 'hotfrog') {
      return await crawlHotfrog(directory, niche, location, onProgress, options);
    }
    // Generic single-page directories don't paginate — on startPage > 1 we
    // return [] to signal exhaustion rather than re-scraping the same page.
    if (options.startPage && options.startPage > 1) return [];
    return await crawlGeneric(directory, niche, location, onProgress);
  } catch (err) {
    console.log(`❌ ${directory.name} error: ${err.message}`);
    if (onProgress) onProgress({ directory: directory.name, stage: 'done', count: 0 });
    return [];
  }
}

async function searchAllDirectories(niche, location, limit = 20, onProgress, options = {}) {
  const country = detectCountry(location);
  console.log(`🌍 Detected country: ${country} for location "${location}" (startPage=${options.startPage || 1})`);

  const pool = [...(directories[country] || []), ...(directories.GLOBAL || [])];
  if (pool.length === 0) {
    console.log('⚠️ No directories configured for country, falling back to UK pool');
    pool.push(...directories.UK);
  }
  console.log(`🕷️ Running ${pool.length} directories: ${pool.map((d) => d.name).join(', ')}`);

  if (onProgress) onProgress({ stage: 'starting', pool: pool.map((d) => d.name), country });

  const settled = await Promise.all(
    pool.map((d) => crawlDirectory(d, niche, location, onProgress, options))
  );

  const combined = [];
  const sources = {};
  pool.forEach((d, i) => {
    const arr = settled[i] || [];
    sources[d.name] = arr.length;
    combined.push(...arr);
  });

  const seen = new Set();
  const unique = [];
  for (const item of combined) {
    const website = normalizeWebsite(item.website);
    const cleaned = { ...item, website };
    if (website && !isBusinessUrl(website)) continue;
    const key = (website ? hostKey(website) : '') ||
      `name:${(item.businessName || '').toLowerCase()}`;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
    if (unique.length >= limit) break;
  }

  console.log(
    `📊 Directory crawler: ${combined.length} raw → ${unique.length} after dedupe/limit`
  );

  if (onProgress) {
    onProgress({ stage: 'complete', total: unique.length, sources });
  }

  return { results: unique, sources, total: unique.length, country };
}

module.exports = {
  detectCountry,
  crawlDirectory,
  searchAllDirectories,
  directories,
};
