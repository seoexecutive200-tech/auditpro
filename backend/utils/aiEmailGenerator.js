const Groq = require('groq-sdk');
const { db } = require('../db/database');

// Resolve the Groq API key: env var wins, then the global settings table.
function getApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'groq_api_key'")
      .get();
    return row && row.value ? row.value : null;
  } catch (_err) {
    return null;
  }
}

function buildPrompt({ lead = {}, report = {}, tone = 'professional', goal = 'book_call' }) {
  const website = lead.website || report.website_url || '';
  const business = lead.name || lead.business_name || lead.client_name || report.client_name || '';
  const contact = lead.contact_name || lead.owner_name || '';
  const niche = lead.niche || lead.category || '';
  const city = lead.city || lead.location || '';
  const score = report.overall_score != null ? report.overall_score : '';
  const grade = report.grade || '';
  const issues = Array.isArray(report.issues) ? report.issues.slice(0, 3) : [];

  return [
    `You are writing a cold outreach email to a local business owner based on their website audit.`,
    ``,
    `Business: ${business}`,
    `Contact: ${contact || 'Owner'}`,
    `Niche: ${niche}`,
    `City: ${city}`,
    `Website: ${website}`,
    `Audit score: ${score} (${grade})`,
    issues.length ? `Top issues: ${issues.map((i) => i.title || i).join('; ')}` : '',
    ``,
    `Tone: ${tone}. Goal: ${goal === 'book_call' ? 'book a 15-minute call' : goal}.`,
    ``,
    `Return ONLY a JSON object with exactly these keys:`,
    `{ "subject": "...", "body": "..." }`,
    `- subject: under 70 chars, no emoji, no clickbait.`,
    `- body: 3-5 short paragraphs, plaintext, personalized to the business and audit score,`,
    `  mentions one specific issue, ends with a clear ask and a plain-text signature placeholder "{{sender_name}}".`,
    `- No markdown, no code fences, no commentary — JSON object only.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Strip leading/trailing ```json fences in case the model adds them.
function stripFences(text) {
  if (!text) return '';
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function generateEmail(options = {}) {
  const apiKey = options.apiKey || getApiKey();
  if (!apiKey) {
    throw new Error('Groq API key not configured (set GROQ_API_KEY or groq_api_key in settings)');
  }

  const client = new Groq({ apiKey });
  const prompt = options.prompt || buildPrompt(options);

  const response = await client.chat.completions.create({
    model: options.model || 'llama-3.3-70b-versatile',
    max_tokens: 500,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'You are an expert sales copywriter. Always respond with valid JSON only. No markdown, no explanation, just the JSON object.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const text = response.choices[0].message.content;
  const cleaned = stripFences(text);
  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    throw new Error('Groq response missing subject/body fields');
  }
  return parsed;
}

function buildPersonalizedPrompt({
  businessName,
  websiteUrl,
  clientName,
  industry,
  location,
  auditData = {},
  agencySettings = {},
  emailNumber = 1,
}) {
  const scores = auditData.scores || {};
  const topIssues = Array.isArray(auditData.topIssues) ? auditData.topIssues.slice(0, 3) : [];
  const recs = Array.isArray(auditData.recommendations)
    ? auditData.recommendations.slice(0, 3)
    : [];
  const competitor = auditData.competitorData;

  const issuesLines = topIssues.length
    ? topIssues
        .map((i, idx) => {
          const title = i.title || i.name || `Issue ${idx + 1}`;
          const desc = i.description || i.detail || '';
          return desc ? `  ${idx + 1}. ${title} — ${desc}` : `  ${idx + 1}. ${title}`;
        })
        .join('\n')
    : '  (none flagged as critical)';

  const recsLines = recs.length
    ? recs
        .map((r, idx) => {
          const title = r.title || r.name || `Rec ${idx + 1}`;
          const text = r.recommendation || r.description || '';
          return text ? `  ${idx + 1}. ${title} — ${text}` : `  ${idx + 1}. ${title}`;
        })
        .join('\n')
    : '  (none provided)';

  const competitorLine = competitor
    ? `Competitor context: ${JSON.stringify(competitor).slice(0, 300)}`
    : '';

  const agencyName = agencySettings.agency_name || 'our team';
  const agencyContact = agencySettings.agency_contact || '';
  const agencyWebsite = agencySettings.agency_website || '';

  return [
    `You are writing cold outreach email #${emailNumber} for a digital agency to a local business owner,`,
    `following up on a website audit you just ran on their site.`,
    ``,
    `BUSINESS`,
    `  Name: ${businessName}`,
    `  Contact: ${clientName || 'Owner'}`,
    `  Industry: ${industry || 'local business'}`,
    `  Location: ${location || 'unspecified'}`,
    `  Website: ${websiteUrl}`,
    ``,
    `AUDIT RESULT`,
    `  Overall score: ${auditData.overallScore ?? '?'} / 100  (grade ${auditData.grade || '?'})`,
    `  SEO: ${scores.seo ?? '?'}  Performance: ${scores.performance ?? '?'}  Security: ${scores.security ?? '?'}  Accessibility: ${scores.accessibility ?? '?'}  Mobile: ${scores.mobile ?? '?'}`,
    `  Top critical issues:`,
    issuesLines,
    `  Key recommendations:`,
    recsLines,
    competitorLine,
    ``,
    `AGENCY (you are writing as)`,
    `  Name: ${agencyName}`,
    `  Contact: ${agencyContact}`,
    `  Website: ${agencyWebsite}`,
    ``,
    `Write email #${emailNumber} in a ${emailNumber === 1 ? 'warm, consultative' : 'slightly more direct'} tone.`,
    `Goal: get the owner to reply or book a 15-minute call.`,
    ``,
    `Return ONLY a JSON object with exactly these four keys:`,
    `{`,
    `  "subject": "<under 70 chars, no emoji, no clickbait>",`,
    `  "greeting": "<single line, e.g. 'Hi John,' or 'Hi there,'>",`,
    `  "body": "<3-5 short paragraphs, plaintext, personalized to the business and audit score, mentions one specific issue, references the location/industry naturally>",`,
    `  "cta": "<one short closing sentence asking for the reply or call>"`,
    `}`,
    `No markdown, no code fences, no commentary — JSON object only.`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function generatePersonalizedEmail(options = {}) {
  const apiKey = options.apiKey || getApiKey();
  if (!apiKey) {
    throw new Error('Groq API key not configured (set GROQ_API_KEY or groq_api_key in settings)');
  }

  const client = new Groq({ apiKey });
  const prompt = buildPersonalizedPrompt(options);

  const response = await client.chat.completions.create({
    model: options.model || 'llama-3.3-70b-versatile',
    max_tokens: 800,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'You are an expert B2B sales copywriter for a digital agency. Always respond with valid JSON only — no markdown, no code fences, no commentary, just the JSON object.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const text = response.choices[0].message.content;
  const cleaned = stripFences(text);
  const parsed = JSON.parse(cleaned);

  const required = ['subject', 'greeting', 'body', 'cta'];
  for (const k of required) {
    if (typeof parsed[k] !== 'string' || !parsed[k].trim()) {
      throw new Error(`Groq response missing or empty "${k}" field`);
    }
  }
  return {
    subject: parsed.subject,
    greeting: parsed.greeting,
    body: parsed.body,
    cta: parsed.cta,
  };
}

module.exports = {
  generateEmail,
  generatePersonalizedEmail,
  getApiKey,
  buildPrompt,
  buildPersonalizedPrompt,
};
