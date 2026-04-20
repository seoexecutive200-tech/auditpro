const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const PAGE_TIMEOUT = 8000;
const REQUEST_TIMEOUT = 6000;
const TOTAL_TIMEOUT = 20000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const CONTACT_PAGES = ['/', '/contact', '/contact-us', '/about'];

const BAD_EMAIL_TOKENS = [
  'example.com', 'example.org', 'example.net',
  'test@', '@test.', 'placeholder', 'yourdomain',
  'domain.com', 'email@', 'sentry.io', 'wix.com',
  'wixpress.com', 'squarespace.com', 'godaddy.com',
  'cloudfront.net', 'gravatar.com',
];

// Full-address placeholders copy-pasted from templates. Matched as
// case-insensitive substrings to catch variants inside longer strings.
const FAKE_EMAILS = [
  'your@email.com',
  'youremail@email.com',
  'email@email.com',
  'test@test.com',
  'example@example.com',
  'info@example.com',
  'user@example.com',
  'name@email.com',
  'yourname@domain.com',
  'email@domain.com',
  'john@doe.com',
  'jane@doe.com',
  'admin@admin.com',
  'webmaster@webmaster.com',
  'noreply@',
  'no-reply@',
  'donotreply@',
  'mailer-daemon@',
  'postmaster@',
];

// Usernames so generic they're almost always placeholder copy.
const GENERIC_USERNAMES = new Set([
  'your', 'name', 'test', 'sample', 'placeholder', 'example',
  'user', 'email', 'mail', 'yourname', 'youremail', 'info123',
  'admin123', 'noreply', 'no-reply', 'donotreply',
]);

// TLDs reserved by RFC 2606 / squatted-looking TLDs.
const FAKE_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i;

// Popular personal-email providers (for quality scoring).
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'live.com', 'msn.com', 'ymail.com', 'googlemail.com',
  'me.com', 'mac.com', 'gmx.com', 'protonmail.com', 'proton.me',
]);

function normalizeBase(websiteUrl) {
  try {
    let u = websiteUrl.trim();
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    const url = new URL(u);
    return url.origin;
  } catch {
    return null;
  }
}

function swapProtocol(origin) {
  if (!origin) return null;
  if (/^https:\/\//i.test(origin)) return origin.replace(/^https:/i, 'http:');
  if (/^http:\/\//i.test(origin)) return origin.replace(/^http:/i, 'https:');
  return null;
}

function isFakeEmail(email) {
  const lower = email.toLowerCase();
  if (IMAGE_EXT_RE.test(lower)) return true;

  // Shape sanity first so subsequent split-based checks are safe.
  if (lower.startsWith('.') || lower.endsWith('.')) return true;
  const parts = lower.split('@');
  if (parts.length !== 2) return true;
  const [local, domain] = parts;
  if (!local || local.length > 64) return true;
  if (!domain) return true;

  // Full-address placeholder blacklist (substring match).
  for (const f of FAKE_EMAILS) {
    if (lower.includes(f)) return true;
  }

  // Legacy substring blacklist (bad hosts, boilerplate tokens).
  for (const tok of BAD_EMAIL_TOKENS) {
    if (lower.includes(tok)) return true;
  }

  // Generic username heuristics.
  if (GENERIC_USERNAMES.has(local)) return true;

  // Username + host identical (e.g. email@email.com, admin@admin.com).
  const hostFirstLabel = domain.split('.')[0];
  if (hostFirstLabel && hostFirstLabel === local) return true;

  // Placeholder-y markers anywhere.
  if (lower.includes('placeholder') || lower.includes('example')) return true;

  // Reserved / junk TLD.
  const tld = domain.split('.').pop();
  if (tld && FAKE_TLDS.has(tld)) return true;

  return false;
}

// Returns 'business' | 'personal'.
// Business-domain emails are ones whose domain matches (or is a substring of)
// the site we found them on. Known free-mail providers bucket as 'personal'.
// Everything else defaults to 'business' (usually a custom domain).
function getEmailQuality(email, websiteUrl) {
  if (!email || typeof email !== 'string') return 'personal';
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain) return 'personal';

  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return 'personal';

  if (websiteUrl) {
    const host = String(websiteUrl)
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
    if (host && (host === domain || host.endsWith('.' + domain) || domain.endsWith('.' + host))) {
      return 'business';
    }
  }

  // Unknown free-mail or custom — treat as business by default.
  return 'business';
}

function extractEmailsFromHtml($, html) {
  const out = [];
  const seen = new Set();

  // 1. mailto: links — highest signal
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const raw = href.replace(/^mailto:/i, '').split('?')[0].trim();
    if (!raw) return;
    if (isFakeEmail(raw)) return;
    const lower = raw.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(raw);
  });

  // 2. regex sweep of HTML body for any remaining addresses
  const matches = html.match(EMAIL_REGEX) || [];
  for (const raw of matches) {
    const e = raw.trim();
    if (isFakeEmail(e)) continue;
    const lower = e.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(e);
  }

  return out;
}

function looksLikePersonName(str) {
  if (!str) return false;
  const s = str.trim();
  if (s.length < 3 || s.length > 60) return false;
  if (!/^[A-Z][a-zA-Z]+(\s+[A-Z][a-zA-Z'.-]+){1,3}$/.test(s)) return false;
  const lower = s.toLowerCase();
  if (lower.includes('contact') || lower.includes('home') ||
      lower.includes('about') || lower.includes('welcome')) return false;
  return true;
}

function extractContactName($, html) {
  const contactPatterns = [
    /contact[:\s-]+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3})/,
    /owner[:\s-]+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3})/,
    /manager[:\s-]+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3})/,
  ];
  for (const re of contactPatterns) {
    const m = html.match(re);
    if (m && looksLikePersonName(m[1])) return m[1].trim();
  }

  const meta = $('meta[name="author"]').attr('content');
  if (meta && looksLikePersonName(meta)) return meta.trim();

  const title = $('title').first().text();
  if (title) {
    const parts = title.split(/[|\-–—]/);
    for (const p of parts) {
      if (looksLikePersonName(p.trim())) return p.trim();
    }
  }

  return null;
}

async function fetchPage(base, pathname) {
  try {
    const url = base + pathname;
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    if (typeof res.data !== 'string') return null;
    return res.data;
  } catch {
    return null;
  }
}

async function fetchPageWithDeadline(base, pathname) {
  return Promise.race([
    fetchPage(base, pathname),
    new Promise((resolve) => setTimeout(() => resolve(null), PAGE_TIMEOUT)),
  ]);
}

async function scanOrigin(base) {
  const emails = [];
  const seenEmails = new Set();
  let contactName = null;
  let pagesChecked = 0;

  for (const p of CONTACT_PAGES) {
    let html;
    try {
      html = await fetchPageWithDeadline(base, p);
    } catch (err) {
      console.log(`❌ Email check failed (${base}${p}):`, err.message);
      continue;
    }
    if (!html) continue;
    pagesChecked += 1;

    let $;
    try {
      $ = cheerio.load(html);
    } catch {
      continue;
    }

    const found = extractEmailsFromHtml($, html);
    for (const e of found) {
      const lower = e.toLowerCase();
      if (!seenEmails.has(lower)) {
        seenEmails.add(lower);
        emails.push(e);
      }
    }

    if (!contactName) {
      const name = extractContactName($, html);
      if (name) contactName = name;
    }
  }

  return { emails, contactName, pagesChecked };
}

async function doFindEmails(websiteUrl) {
  console.log('📧 Checking emails for:', websiteUrl);
  const empty = {
    emails: [],
    primaryEmail: null,
    contactName: null,
    pagesChecked: 0,
  };

  const base = normalizeBase(websiteUrl);
  if (!base) {
    console.log('❌ Email check skipped: invalid URL', websiteUrl);
    return empty;
  }

  let { emails, contactName, pagesChecked } = await scanOrigin(base);

  // If we got nothing AND the first scan had no reachable pages, try the other protocol.
  if (emails.length === 0 && pagesChecked === 0) {
    const alt = swapProtocol(base);
    if (alt) {
      console.log(`↪ retrying on ${alt}`);
      const r2 = await scanOrigin(alt);
      emails = r2.emails;
      contactName = contactName || r2.contactName;
      pagesChecked = r2.pagesChecked;
    }
  }

  if (emails.length > 0) {
    console.log(`✅ Emails found (${base}):`, emails);
  } else {
    console.log(`ℹ️ No emails on ${base} (pages checked: ${pagesChecked})`);
  }

  return {
    emails,
    primaryEmail: emails[0] || null,
    contactName,
    pagesChecked,
  };
}

async function findEmailsOnWebsite(websiteUrl) {
  return Promise.race([
    doFindEmails(websiteUrl),
    new Promise((resolve) =>
      setTimeout(() => {
        console.log(`⏱️ Email check timed out (${TOTAL_TIMEOUT}ms): ${websiteUrl}`);
        resolve({
          emails: [],
          primaryEmail: null,
          contactName: null,
          pagesChecked: 0,
          timedOut: true,
        });
      }, TOTAL_TIMEOUT)
    ),
  ]);
}

module.exports = {
  findEmailsOnWebsite,
  isFakeEmail,
  getEmailQuality,
};
