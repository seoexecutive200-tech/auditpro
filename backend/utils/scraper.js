const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 AuditPro/1.0';

const TIMEOUT = 15000;

const client = axios.create({
  timeout: TIMEOUT,
  headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
  maxRedirects: 5,
  validateStatus: () => true,
});

function safeOrigin(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function isHttpUrl(href) {
  return /^https?:\/\//i.test(href);
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function checkUrlExists(url) {
  try {
    const res = await client.get(url, { timeout: 8000, maxRedirects: 3 });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

async function checkLinkBroken(url) {
  try {
    const res = await client.head(url, { timeout: 6000 });
    if (res.status >= 200 && res.status < 400) return false;
    const getRes = await client.get(url, { timeout: 6000, maxRedirects: 3 });
    return !(getRes.status >= 200 && getRes.status < 400);
  } catch {
    return true;
  }
}

function analyzeSeo($, html, baseUrl) {
  const title = $('title').first().text().trim() || null;
  const titleLength = title ? title.length : 0;

  const metaDescription =
    $('meta[name="description"]').attr('content')?.trim() || null;
  const metaDescriptionLength = metaDescription ? metaDescription.length : 0;

  const h1s = $('h1');
  const h1Count = h1s.length;
  const h1Text = h1Count > 0 ? $(h1s[0]).text().trim() : null;
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;

  const canonicalUrl = $('link[rel="canonical"]').attr('href') || null;

  const ogTitle = $('meta[property="og:title"]').attr('content') || null;
  const ogDescription = $('meta[property="og:description"]').attr('content') || null;
  const ogImage = $('meta[property="og:image"]').attr('content') || null;

  const imgs = $('img');
  const totalImages = imgs.length;
  let imagesWithAlt = 0;
  imgs.each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt !== undefined && alt.trim() !== '') imagesWithAlt++;
  });
  const altTextCoverage =
    totalImages === 0 ? 100 : Math.round((imagesWithAlt / totalImages) * 100);

  const origin = safeOrigin(baseUrl);
  let internalLinks = 0;
  let externalLinks = 0;
  const linkUrls = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const abs = absolutize(href, baseUrl);
    if (!abs) return;
    const linkOrigin = safeOrigin(abs);
    if (linkOrigin && origin && linkOrigin === origin) internalLinks++;
    else if (isHttpUrl(abs)) externalLinks++;
    if (isHttpUrl(abs) && linkUrls.length < 20) linkUrls.push(abs);
  });

  return {
    title,
    titleLength,
    titleValid: titleLength >= 50 && titleLength <= 60,
    metaDescription,
    metaDescriptionLength,
    metaDescriptionValid: metaDescriptionLength >= 150 && metaDescriptionLength <= 160,
    h1Count,
    h1Valid: h1Count === 1,
    h1Text,
    h2Count,
    h3Count,
    canonicalUrl,
    hasCanonical: !!canonicalUrl,
    ogTitle,
    ogDescription,
    ogImage,
    hasOpenGraph: !!(ogTitle || ogDescription || ogImage),
    totalImages,
    imagesWithAlt,
    altTextCoverage,
    internalLinks,
    externalLinks,
    linkUrls,
  };
}

function analyzeSecurity(finalUrl, headers, html) {
  const isHttps = finalUrl.startsWith('https://');
  const hasXFrameOptions = !!headers['x-frame-options'];
  const hasCSP = !!headers['content-security-policy'];
  const hasXContentType = !!headers['x-content-type-options'];
  const hasHSTS = !!headers['strict-transport-security'];

  let hasMixedContent = false;
  if (isHttps && html) {
    const mixed =
      /(?:src|href)=["']http:\/\//i.test(html) ||
      /url\(\s*http:\/\//i.test(html);
    hasMixedContent = mixed;
  }

  let score = 0;
  if (isHttps) score += 30;
  if (hasHSTS) score += 20;
  if (hasCSP) score += 20;
  if (hasXFrameOptions) score += 10;
  if (hasXContentType) score += 10;
  if (!hasMixedContent) score += 10;

  return {
    isHttps,
    sslValid: isHttps,
    hasXFrameOptions,
    hasCSP,
    hasXContentType,
    hasHSTS,
    hasMixedContent,
    securityScore: Math.min(100, score),
  };
}

async function scrapeSite(url) {
  const out = {
    seo: null,
    security: null,
    errors: {},
  };

  let pageRes;
  try {
    pageRes = await client.get(url);
  } catch (err) {
    out.errors.fetch = err.message;
    out.security = {
      isHttps: url.startsWith('https://'),
      sslValid: false,
      hasXFrameOptions: false,
      hasCSP: false,
      hasXContentType: false,
      hasHSTS: false,
      hasMixedContent: false,
      securityScore: 0,
    };
    return out;
  }

  const finalUrl = pageRes.request?.res?.responseUrl || url;
  const html = typeof pageRes.data === 'string' ? pageRes.data : '';
  const $ = cheerio.load(html || '');

  const seoBase = analyzeSeo($, html, finalUrl);

  const origin = safeOrigin(finalUrl);
  let robotsTxt = false;
  let sitemapXml = false;
  if (origin) {
    [robotsTxt, sitemapXml] = await Promise.all([
      checkUrlExists(`${origin}/robots.txt`),
      checkUrlExists(`${origin}/sitemap.xml`),
    ]);
  }

  const linksToCheck = seoBase.linkUrls.slice(0, 10);
  const brokenResults = await Promise.all(
    linksToCheck.map(async (link) => ((await checkLinkBroken(link)) ? link : null))
  );
  const brokenLinks = brokenResults.filter(Boolean);

  delete seoBase.linkUrls;

  out.seo = {
    ...seoBase,
    robotsTxt,
    sitemapXml,
    brokenLinks,
  };

  out.security = analyzeSecurity(finalUrl, pageRes.headers || {}, html);

  return out;
}

module.exports = { scrapeSite };
