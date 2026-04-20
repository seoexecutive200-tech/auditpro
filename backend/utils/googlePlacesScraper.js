const axios = require('axios');

const ENDPOINT = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';
const TIMEOUT = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cityFromLocation(location) {
  if (!location) return '';
  return String(location).split(',')[0].trim();
}

async function fetchDetails(placeId, apiKey) {
  try {
    const res = await axios.get(DETAILS, {
      timeout: TIMEOUT,
      params: {
        place_id: placeId,
        fields: 'website,formatted_phone_number,international_phone_number,name,formatted_address',
        key: apiKey,
      },
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const r = res.data && res.data.result;
    return r || null;
  } catch {
    return null;
  }
}

async function searchGooglePlaces(niche, location, limit = 20, apiKey) {
  console.log(
    `🔍 GooglePlaces searching: niche="${niche}" location="${location}" limit=${limit}`
  );
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    console.log('❌ GooglePlaces: no API key configured');
    return { results: [], callsUsed: 0, error: 'Google Places API key not configured' };
  }

  const city = cityFromLocation(location);
  const query = `${niche || ''} in ${location || ''}`.trim();

  let callsUsed = 0;
  let results = [];
  let nextPageToken = null;
  let pages = 0;

  try {
    do {
      const params = nextPageToken
        ? { pagetoken: nextPageToken, key: apiKey.trim() }
        : { query, key: apiKey.trim() };

      const res = await axios.get(ENDPOINT, {
        timeout: TIMEOUT,
        params,
        validateStatus: () => true,
      });
      callsUsed += 1;

      console.log(
        `📄 GooglePlaces response status: HTTP ${res.status} googleStatus=${
          res.data && res.data.status
        }`
      );

      if (res.status < 200 || res.status >= 300) {
        return {
          results: [],
          callsUsed,
          error: `Google Places API error: HTTP ${res.status}`,
        };
      }

      const status = res.data && res.data.status;
      if (status && status !== 'OK' && status !== 'ZERO_RESULTS') {
        const msg = (res.data && res.data.error_message) || status;
        console.log('❌ GooglePlaces API error:', msg);
        return { results: [], callsUsed, error: msg };
      }

      const batch = (res.data && res.data.results) || [];
      for (const p of batch) {
        if (results.length >= limit) break;
        results.push({
          placeId: p.place_id,
          businessName: p.name || '',
          address: p.formatted_address || '',
          rating: p.rating != null ? String(p.rating) : '',
          city,
          source: 'google_places',
        });
      }

      nextPageToken =
        results.length < limit ? res.data && res.data.next_page_token : null;
      pages += 1;
      if (nextPageToken) await sleep(2000);
    } while (nextPageToken && results.length < limit && pages < 3);

    console.log(
      `📊 GooglePlaces textsearch returned ${results.length} places (pages=${pages}, callsUsed=${callsUsed})`
    );

    const enriched = [];
    for (const r of results) {
      const d = await fetchDetails(r.placeId, apiKey.trim());
      callsUsed += 1;
      enriched.push({
        businessName: r.businessName,
        website: (d && d.website) || '',
        phone:
          (d && (d.international_phone_number || d.formatted_phone_number)) || '',
        address: (d && d.formatted_address) || r.address,
        city: r.city,
        rating: r.rating,
        source: 'google_places',
      });
      await sleep(120);
    }

    const withWebsite = enriched.filter((e) => e.website).length;
    console.log(
      `📊 GooglePlaces final: ${enriched.length} businesses, ${withWebsite} have websites, callsUsed=${callsUsed}`
    );

    return { results: enriched, callsUsed };
  } catch (err) {
    console.log('❌ GooglePlaces error:', err.message);
    return { results: [], callsUsed, error: err.message };
  }
}

module.exports = {
  searchGooglePlaces,
};
