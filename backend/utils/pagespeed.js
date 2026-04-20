const axios = require('axios');

const API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function buildUrl(url, apiKey, strategy) {
  const qs = new URLSearchParams();
  qs.append('url', url);
  qs.append('strategy', strategy);
  qs.append('category', 'performance');
  qs.append('category', 'accessibility');
  qs.append('category', 'seo');
  qs.append('category', 'best-practices');
  if (apiKey) qs.append('key', apiKey);
  return `${API_URL}?${qs.toString()}`;
}

async function fetchStrategy(url, apiKey, strategy) {
  const res = await axios.get(buildUrl(url, apiKey, strategy), { timeout: 90000 });
  return res.data;
}

function toPct(score) {
  if (score === null || score === undefined) return 0;
  return Math.round(score * 100);
}

function auditBool(audit) {
  if (!audit) return false;
  return audit.score === 1;
}

function audit(lh, id) {
  return lh?.audits?.[id];
}

function extractPerformance(lh) {
  const perfCat = lh?.categories?.performance;
  const totalByteWeight = audit(lh, 'total-byte-weight');
  const pageSizeKB = totalByteWeight?.numericValue
    ? Math.round(totalByteWeight.numericValue / 1024)
    : 0;

  return {
    score: toPct(perfCat?.score),
    firstContentfulPaint: audit(lh, 'first-contentful-paint')?.displayValue || 'N/A',
    largestContentfulPaint: audit(lh, 'largest-contentful-paint')?.displayValue || 'N/A',
    timeToInteractive: audit(lh, 'interactive')?.displayValue || 'N/A',
    totalBlockingTime: audit(lh, 'total-blocking-time')?.displayValue || 'N/A',
    cumulativeLayoutShift: audit(lh, 'cumulative-layout-shift')?.displayValue || 'N/A',
    speedIndex: audit(lh, 'speed-index')?.displayValue || 'N/A',
    pageSize: `${pageSizeKB} KB`,
  };
}

function extractAccessibility(lh) {
  const cat = lh?.categories?.accessibility;
  const issues = [];
  const refs = cat?.auditRefs || [];

  for (const ref of refs) {
    const a = lh?.audits?.[ref.id];
    if (!a) continue;
    if (a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'informative') continue;
    if (a.score !== null && a.score < 1) {
      issues.push({
        title: a.title,
        description: (a.description || '').replace(/\s*\[Learn.*?\]\(.*?\)\s*/g, '').trim(),
        severity: a.score === 0 ? 'critical' : 'warning',
      });
    }
  }

  return {
    score: toPct(cat?.score),
    issues,
  };
}

function extractMobile(mobileLh) {
  const perfCat = mobileLh?.categories?.performance;
  return {
    score: toPct(perfCat?.score),
    usesViewport: auditBool(audit(mobileLh, 'viewport')),
    fontSizeLegible: auditBool(audit(mobileLh, 'font-size')),
    tapTargetsValid: auditBool(audit(mobileLh, 'tap-targets')),
  };
}

async function runPageSpeed(url, apiKey) {
  const result = {
    performance: null,
    accessibility: null,
    seo_score: null,
    mobile: null,
    errors: {},
  };

  let mobileData = null;
  try {
    const data = await fetchStrategy(url, apiKey, 'mobile');
    mobileData = data?.lighthouseResult;
  } catch (err) {
    result.errors.mobile = err.message;
  }

  await new Promise((r) => setTimeout(r, 1000));

  let desktopData = null;
  try {
    const data = await fetchStrategy(url, apiKey, 'desktop');
    desktopData = data?.lighthouseResult;
  } catch (err) {
    result.errors.desktop = err.message;
  }

  const primary = desktopData || mobileData;

  if (primary) {
    result.performance = extractPerformance(primary);
    result.accessibility = extractAccessibility(primary);
    result.seo_score = toPct(primary?.categories?.seo?.score);
  }

  if (mobileData) {
    result.mobile = extractMobile(mobileData);
  } else if (primary) {
    result.mobile = extractMobile(primary);
  }

  return result;
}

module.exports = { runPageSpeed };
