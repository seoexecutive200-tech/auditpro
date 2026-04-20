const axios = require('axios');

const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';
const TIMEOUT = 15000;

function cityFromLocation(location) {
  if (!location) return '';
  return String(location).split(',')[0].trim();
}

async function searchBing(niche, location, limit = 20, apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    return { results: [], tokensUsed: 0, error: 'Bing API key not configured' };
  }

  try {
    const query = `${niche || ''} ${location || ''}`.trim();
    const res = await axios.get(BING_ENDPOINT, {
      timeout: TIMEOUT,
      headers: { 'Ocp-Apim-Subscription-Key': apiKey.trim() },
      params: {
        q: query,
        count: Math.min(Math.max(1, limit), 50),
        mkt: 'en-US',
      },
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      return {
        results: [],
        tokensUsed: 0,
        error: `Bing API error: HTTP ${res.status}`,
      };
    }

    const city = cityFromLocation(location);
    const pages = (res.data && res.data.webPages && res.data.webPages.value) || [];
    const results = pages.slice(0, limit).map((p) => ({
      businessName: p.name || '',
      website: p.url || '',
      snippet: p.snippet || '',
      city,
      source: 'bing',
    }));

    return { results, tokensUsed: 1 };
  } catch (err) {
    return {
      results: [],
      tokensUsed: 0,
      error: err && err.message ? err.message : 'Bing request failed',
    };
  }
}

module.exports = {
  searchBing,
};
