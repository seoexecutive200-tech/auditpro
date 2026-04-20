const { scrapeSite } = require('./scraper');
const { runPageSpeed } = require('./pagespeed');

function calcSeoScore(seo) {
  if (!seo) return 0;
  let score = 0;
  if (seo.title && seo.titleValid) score += 15;
  if (seo.metaDescription && seo.metaDescriptionValid) score += 15;
  if (seo.h1Valid) score += 10;
  if (seo.hasCanonical) score += 10;
  if (seo.hasOpenGraph) score += 10;
  if (seo.robotsTxt) score += 10;
  if (seo.sitemapXml) score += 10;
  if (seo.altTextCoverage > 80) score += 10;
  if (!seo.brokenLinks || seo.brokenLinks.length === 0) score += 10;
  return Math.min(100, score);
}

function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function weightedOverall(scores) {
  const overall =
    scores.seo * 0.25 +
    scores.performance * 0.25 +
    scores.security * 0.2 +
    scores.accessibility * 0.15 +
    scores.mobile * 0.15;
  return Math.round(overall);
}

function makeIssue(category, title, description, severity, recommendation, impact, difficulty) {
  return { category, title, description, severity, recommendation, estimatedImpact: impact, difficulty };
}

function buildSeoIssues(seo) {
  if (!seo) return [];
  const issues = [];

  if (seo.title && seo.titleValid) {
    issues.push(makeIssue('SEO', 'Title tag optimized', `Title is ${seo.titleLength} characters.`, 'pass', 'Keep current title length.', 'Low', 'Easy'));
  } else if (!seo.title) {
    issues.push(makeIssue('SEO', 'Missing title tag', 'Page has no <title> tag.', 'critical', 'Add a descriptive 50-60 character title.', 'High', 'Easy'));
  } else {
    issues.push(makeIssue('SEO', 'Title length not ideal', `Title is ${seo.titleLength} characters; ideal is 50-60.`, 'warning', 'Rewrite title to 50-60 characters with target keywords.', 'Medium', 'Easy'));
  }

  if (seo.metaDescription && seo.metaDescriptionValid) {
    issues.push(makeIssue('SEO', 'Meta description optimized', `Description is ${seo.metaDescriptionLength} characters.`, 'pass', 'Keep current meta description.', 'Low', 'Easy'));
  } else if (!seo.metaDescription) {
    issues.push(makeIssue('SEO', 'Missing meta description', 'Page has no meta description.', 'critical', 'Add a compelling 150-160 character meta description.', 'High', 'Easy'));
  } else {
    issues.push(makeIssue('SEO', 'Meta description length not ideal', `Description is ${seo.metaDescriptionLength} characters; ideal is 150-160.`, 'warning', 'Rewrite meta description to 150-160 characters.', 'Medium', 'Easy'));
  }

  if (seo.h1Valid) {
    issues.push(makeIssue('SEO', 'H1 tag correct', 'Page has exactly one H1 tag.', 'pass', 'Keep single H1.', 'Low', 'Easy'));
  } else if (seo.h1Count === 0) {
    issues.push(makeIssue('SEO', 'Missing H1 tag', 'Page has no H1 tag.', 'critical', 'Add exactly one H1 tag describing the page.', 'High', 'Easy'));
  } else {
    issues.push(makeIssue('SEO', 'Multiple H1 tags', `Page has ${seo.h1Count} H1 tags.`, 'warning', 'Use only one H1; demote extras to H2/H3.', 'Medium', 'Easy'));
  }

  issues.push(
    seo.hasCanonical
      ? makeIssue('SEO', 'Canonical URL set', 'Canonical link is present.', 'pass', 'Keep canonical tag.', 'Low', 'Easy')
      : makeIssue('SEO', 'Missing canonical URL', 'No canonical link tag found.', 'warning', 'Add <link rel="canonical"> to prevent duplicate content issues.', 'Medium', 'Easy')
  );

  issues.push(
    seo.hasOpenGraph
      ? makeIssue('SEO', 'Open Graph tags present', 'OG tags detected.', 'pass', 'Keep Open Graph metadata.', 'Low', 'Easy')
      : makeIssue('SEO', 'Missing Open Graph tags', 'Page lacks og:title/og:description/og:image.', 'warning', 'Add Open Graph tags for better social sharing.', 'Medium', 'Easy')
  );

  issues.push(
    seo.robotsTxt
      ? makeIssue('SEO', 'robots.txt found', '/robots.txt responded.', 'pass', 'Keep robots.txt updated.', 'Low', 'Easy')
      : makeIssue('SEO', 'Missing robots.txt', '/robots.txt was not reachable.', 'warning', 'Create /robots.txt to guide crawlers.', 'Medium', 'Easy')
  );

  issues.push(
    seo.sitemapXml
      ? makeIssue('SEO', 'sitemap.xml found', '/sitemap.xml responded.', 'pass', 'Keep sitemap updated.', 'Low', 'Easy')
      : makeIssue('SEO', 'Missing sitemap.xml', '/sitemap.xml was not reachable.', 'warning', 'Generate and submit a sitemap.xml.', 'Medium', 'Easy')
  );

  if (seo.totalImages === 0) {
    issues.push(makeIssue('SEO', 'No images on page', 'No <img> elements found.', 'pass', 'N/A', 'Low', 'Easy'));
  } else if (seo.altTextCoverage > 80) {
    issues.push(makeIssue('SEO', 'Image alt text coverage good', `${seo.altTextCoverage}% of images have alt text.`, 'pass', 'Keep alt text on images.', 'Low', 'Easy'));
  } else {
    issues.push(makeIssue('SEO', 'Poor image alt text coverage', `${seo.altTextCoverage}% of ${seo.totalImages} images have alt text.`, 'warning', 'Add descriptive alt text to every image.', 'Medium', 'Easy'));
  }

  if (!seo.brokenLinks || seo.brokenLinks.length === 0) {
    issues.push(makeIssue('SEO', 'No broken links detected', 'Checked links responded OK.', 'pass', 'Keep monitoring for broken links.', 'Low', 'Easy'));
  } else {
    issues.push(makeIssue('SEO', `${seo.brokenLinks.length} broken link(s)`, `Broken: ${seo.brokenLinks.slice(0, 3).join(', ')}`, 'critical', 'Fix or remove broken links.', 'High', 'Medium'));
  }

  return issues;
}

function buildSecurityIssues(sec) {
  if (!sec) return [];
  const issues = [];

  issues.push(
    sec.isHttps
      ? makeIssue('Security', 'HTTPS enabled', 'Site served over HTTPS.', 'pass', 'Keep SSL current.', 'Low', 'Easy')
      : makeIssue('Security', 'HTTPS not used', 'Site does not use HTTPS.', 'critical', 'Install a TLS certificate and force HTTPS.', 'High', 'Medium')
  );

  issues.push(
    sec.hasHSTS
      ? makeIssue('Security', 'HSTS header set', 'Strict-Transport-Security present.', 'pass', 'Keep HSTS enabled.', 'Low', 'Easy')
      : makeIssue('Security', 'Missing HSTS header', 'No Strict-Transport-Security header.', 'warning', 'Add HSTS header to force HTTPS.', 'Medium', 'Easy')
  );

  issues.push(
    sec.hasCSP
      ? makeIssue('Security', 'Content-Security-Policy set', 'CSP header detected.', 'pass', 'Review CSP regularly.', 'Low', 'Easy')
      : makeIssue('Security', 'Missing Content-Security-Policy', 'No CSP header.', 'warning', 'Add a CSP header to mitigate XSS.', 'High', 'Medium')
  );

  issues.push(
    sec.hasXFrameOptions
      ? makeIssue('Security', 'X-Frame-Options set', 'X-Frame-Options header present.', 'pass', 'Keep clickjacking protection.', 'Low', 'Easy')
      : makeIssue('Security', 'Missing X-Frame-Options', 'Page can be framed.', 'warning', 'Add X-Frame-Options: DENY or SAMEORIGIN.', 'Medium', 'Easy')
  );

  issues.push(
    sec.hasXContentType
      ? makeIssue('Security', 'X-Content-Type-Options set', 'Header present.', 'pass', 'Keep MIME sniffing disabled.', 'Low', 'Easy')
      : makeIssue('Security', 'Missing X-Content-Type-Options', 'No nosniff header.', 'warning', 'Add X-Content-Type-Options: nosniff.', 'Low', 'Easy')
  );

  issues.push(
    sec.hasMixedContent
      ? makeIssue('Security', 'Mixed content detected', 'HTTPS page loads HTTP resources.', 'critical', 'Serve all assets over HTTPS.', 'High', 'Medium')
      : makeIssue('Security', 'No mixed content', 'All resources served securely.', 'pass', 'Keep assets on HTTPS.', 'Low', 'Easy')
  );

  return issues;
}

function buildPerformanceIssues(perf) {
  if (!perf) return [];
  const issues = [];
  const score = perf.score ?? 0;

  if (score >= 90) {
    issues.push(makeIssue('Performance', 'Excellent performance', `Score ${score}.`, 'pass', 'Monitor Core Web Vitals.', 'Low', 'Easy'));
  } else if (score >= 50) {
    issues.push(makeIssue('Performance', 'Performance needs work', `Score ${score}.`, 'warning', 'Optimize images, enable caching, minify assets.', 'High', 'Medium'));
  } else {
    issues.push(makeIssue('Performance', 'Poor performance', `Score ${score}.`, 'critical', 'Major optimization needed: images, JS, caching, CDN.', 'High', 'Hard'));
  }

  issues.push(makeIssue('Performance', 'Largest Contentful Paint', `LCP: ${perf.largestContentfulPaint}.`, 'warning', 'Target LCP under 2.5s.', 'High', 'Medium'));
  issues.push(makeIssue('Performance', 'Cumulative Layout Shift', `CLS: ${perf.cumulativeLayoutShift}.`, 'warning', 'Target CLS under 0.1.', 'Medium', 'Medium'));
  issues.push(makeIssue('Performance', 'Total Blocking Time', `TBT: ${perf.totalBlockingTime}.`, 'warning', 'Reduce long JS tasks.', 'High', 'Hard'));

  return issues;
}

function buildAccessibilityIssues(acc) {
  if (!acc) return [];
  const issues = [];
  const score = acc.score ?? 0;

  if (score >= 90) {
    issues.push(makeIssue('Accessibility', 'Strong accessibility', `Score ${score}.`, 'pass', 'Keep testing with screen readers.', 'Low', 'Easy'));
  } else if (score >= 60) {
    issues.push(makeIssue('Accessibility', 'Accessibility gaps', `Score ${score}.`, 'warning', 'Fix color contrast, labels, ARIA issues.', 'High', 'Medium'));
  } else {
    issues.push(makeIssue('Accessibility', 'Serious accessibility issues', `Score ${score}.`, 'critical', 'Address WCAG violations urgently.', 'High', 'Hard'));
  }

  for (const i of (acc.issues || []).slice(0, 10)) {
    issues.push(makeIssue('Accessibility', i.title, i.description, i.severity, 'Follow WCAG guidance for this rule.', 'Medium', 'Medium'));
  }

  return issues;
}

function buildMobileIssues(mob) {
  if (!mob) return [];
  const issues = [];
  const score = mob.score ?? 0;

  if (score >= 90) {
    issues.push(makeIssue('Mobile', 'Mobile performance strong', `Score ${score}.`, 'pass', 'Keep monitoring mobile CWV.', 'Low', 'Easy'));
  } else if (score >= 50) {
    issues.push(makeIssue('Mobile', 'Mobile performance average', `Score ${score}.`, 'warning', 'Reduce mobile payload and JS execution.', 'High', 'Medium'));
  } else {
    issues.push(makeIssue('Mobile', 'Poor mobile performance', `Score ${score}.`, 'critical', 'Optimize images, defer JS, improve TTI.', 'High', 'Hard'));
  }

  issues.push(
    mob.usesViewport
      ? makeIssue('Mobile', 'Viewport meta set', 'Mobile viewport configured.', 'pass', 'Keep viewport tag.', 'Low', 'Easy')
      : makeIssue('Mobile', 'Missing viewport meta', 'No viewport meta tag.', 'critical', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', 'High', 'Easy')
  );
  issues.push(
    mob.fontSizeLegible
      ? makeIssue('Mobile', 'Legible font sizes', 'Text is large enough on mobile.', 'pass', 'Keep font sizes readable.', 'Low', 'Easy')
      : makeIssue('Mobile', 'Illegible font sizes', 'Text too small on mobile.', 'warning', 'Use at least 16px body text on mobile.', 'Medium', 'Easy')
  );
  issues.push(
    mob.tapTargetsValid
      ? makeIssue('Mobile', 'Tap targets sized correctly', 'Buttons/links tappable.', 'pass', 'Keep minimum 48px targets.', 'Low', 'Easy')
      : makeIssue('Mobile', 'Tap targets too small', 'Buttons/links too small or close together.', 'warning', 'Size targets at least 48x48px with spacing.', 'Medium', 'Easy')
  );

  return issues;
}

function sortRecommendations(recs) {
  const impactRank = { High: 0, Medium: 1, Low: 2 };
  const diffRank = { Easy: 0, Medium: 1, Hard: 2 };
  return recs.slice().sort((a, b) => {
    const i = (impactRank[a.estimatedImpact] ?? 3) - (impactRank[b.estimatedImpact] ?? 3);
    if (i !== 0) return i;
    return (diffRank[a.difficulty] ?? 3) - (diffRank[b.difficulty] ?? 3);
  });
}

function computeScores(scrape, pagespeed) {
  const seo = calcSeoScore(scrape?.seo);
  const security = scrape?.security?.securityScore ?? 0;
  const performance = pagespeed?.performance?.score ?? 0;
  const accessibility = pagespeed?.accessibility?.score ?? 0;
  const mobile = pagespeed?.mobile?.score ?? 0;
  return { seo, performance, security, accessibility, mobile };
}

async function auditOne(url, apiKey) {
  const [scrape, pagespeed] = await Promise.all([
    scrapeSite(url).catch((e) => ({ seo: null, security: null, errors: { fatal: e.message } })),
    runPageSpeed(url, apiKey).catch((e) => ({
      performance: null,
      accessibility: null,
      seo_score: null,
      mobile: null,
      errors: { fatal: e.message },
    })),
  ]);
  return { scrape, pagespeed };
}

function pickWinner(you, them) {
  if (you > them) return 'you';
  if (them > you) return 'competitor';
  return 'tie';
}

async function runAudit(websiteUrl, competitorUrl, apiKey) {
  const auditWarnings = [];
  if (!apiKey) {
    auditWarnings.push('PageSpeed API key not configured — performance, accessibility, and mobile metrics unavailable.');
  }

  const primary = await auditOne(websiteUrl, apiKey);
  const primaryScores = computeScores(primary.scrape, primary.pagespeed);
  const overallScore = weightedOverall(primaryScores);
  const grade = gradeFor(overallScore);

  if (primary.pagespeed?.errors && Object.keys(primary.pagespeed.errors).length) {
    auditWarnings.push('PageSpeed Insights request failed — some metrics may be missing.');
  }
  if (primary.scrape?.errors && primary.scrape.errors.fetch) {
    auditWarnings.push(`Scraper could not fetch the site: ${primary.scrape.errors.fetch}`);
  }

  const issues = [
    ...buildSeoIssues(primary.scrape?.seo),
    ...buildPerformanceIssues(primary.pagespeed?.performance),
    ...buildSecurityIssues(primary.scrape?.security),
    ...buildAccessibilityIssues(primary.pagespeed?.accessibility),
    ...buildMobileIssues(primary.pagespeed?.mobile),
  ];

  const recommendations = sortRecommendations(
    issues.filter((i) => i.severity === 'critical' || i.severity === 'warning')
  );

  let competitorData = null;
  if (competitorUrl) {
    try {
      const comp = await auditOne(competitorUrl, apiKey);
      const compScores = computeScores(comp.scrape, comp.pagespeed);
      const compOverall = weightedOverall(compScores);
      competitorData = {
        url: competitorUrl,
        scores: { ...compScores, overall: compOverall },
        grade: gradeFor(compOverall),
        winner: {
          seo: pickWinner(primaryScores.seo, compScores.seo),
          performance: pickWinner(primaryScores.performance, compScores.performance),
          security: pickWinner(primaryScores.security, compScores.security),
          accessibility: pickWinner(primaryScores.accessibility, compScores.accessibility),
          mobile: pickWinner(primaryScores.mobile, compScores.mobile),
          overall: pickWinner(overallScore, compOverall),
        },
      };
    } catch (err) {
      competitorData = { url: competitorUrl, error: err.message };
    }
  }

  return {
    websiteUrl,
    competitorUrl: competitorUrl || null,
    overallScore,
    grade,
    scores: primaryScores,
    pagespeedData: primary.pagespeed,
    scrapeData: primary.scrape,
    issues,
    recommendations,
    competitorData,
    auditWarnings,
    auditedAt: new Date().toISOString(),
  };
}

module.exports = { runAudit };
