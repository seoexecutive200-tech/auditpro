const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { searchAllDirectories } = require('./directoryCrawler');
const { findEmailsOnWebsite } = require('./emailFinder');
const { runAudit } = require('./auditEngine');
const { generatePersonalizedEmail } = require('./aiEmailGenerator');
const { generatePDF } = require('./pdfGenerator');
const { generateCampaignPDF } = require('./campaignPdfGenerator');
const { sendAuditReport } = require('./mailer');
const { addNotification } = require('./notifications');

// ========= Job status registry (in-memory, survives only within this process) =========
// jobId -> { campaignId, tenantId, userId, step, message, percent, status, counters..., summary?, cancelled }
const jobs = new Map();

const JOB_RETENTION_MS = 30 * 60 * 1000; // keep finished jobs queryable for 30 min

function setJob(jobId, patch) {
  const prev = jobs.get(jobId) || {};
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  jobs.set(jobId, next);
  return next;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function requestCancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  job.updatedAt = Date.now();
  return true;
}

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, j] of jobs) {
    if (
      (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') &&
      (j.updatedAt || 0) < cutoff
    ) {
      jobs.delete(id);
    }
  }
}
setInterval(pruneOldJobs, 5 * 60 * 1000).unref?.();

// ========= Helpers =========
const ALLOWED_LEAD_SOURCES = new Set(['yelp', 'yellowpages', 'bing', 'manual']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUrl(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function normalizeSource(src) {
  if (!src) return 'manual';
  const s = String(src).toLowerCase();
  if (s.includes('yelp')) return 'yelp';
  if (s.includes('yellow')) return 'yellowpages';
  if (s.includes('bing')) return 'bing';
  return 'manual';
}

function getSettingsForTenant(tenantId) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  if (tenantId) {
    try {
      const tenantRows = db
        .prepare('SELECT key, value FROM agency_settings WHERE tenant_id = ?')
        .all(tenantId);
      for (const r of tenantRows) out[r.key] = r.value;
    } catch {
      // agency_settings optional — safe to ignore
    }
  }
  return out;
}

function formatCampaignDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function updateCampaign(campaignId, fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  try {
    db.prepare(`UPDATE campaigns SET ${setSql} WHERE id = ?`).run(...values, campaignId);
  } catch (err) {
    console.error('updateCampaign failed:', err.message);
  }
}

function markCampaignStatus(campaignId, status, extra = {}) {
  const fields = { status, ...extra };
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    fields.completed_at = new Date().toISOString();
  }
  updateCampaign(campaignId, fields);
}

function shouldAbort(jobId) {
  const j = jobs.get(jobId);
  return !!(j && j.cancelled);
}

// ========= Main =========
async function runCampaign(options = {}, tenantId, userId) {
  const niche = String(options.niche || '').trim();
  const location = String(options.location || '').trim();
  const targetEmails = Math.max(1, Math.min(500, parseInt(options.targetEmails, 10) || 25));
  const autoAudit = options.autoAudit !== false;
  const autoEmail = options.autoEmail !== false;
  const autoFollowup = options.autoFollowup !== false;

  if (!niche || !location) {
    throw new Error('niche and location are required');
  }

  const jobId = uuidv4();
  const campaignId = uuidv4();
  const campaignName = `${niche} ${location} — ${formatCampaignDate(new Date())}`;

  db.prepare(
    `INSERT INTO campaigns
       (id, tenant_id, name, niche, location, target_emails, status,
        auto_audit, auto_email, auto_followup,
        started_by, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    campaignId,
    tenantId,
    campaignName,
    niche,
    location,
    targetEmails,
    autoAudit ? 1 : 0,
    autoEmail ? 1 : 0,
    autoFollowup ? 1 : 0,
    userId || null
  );

  setJob(jobId, {
    campaignId,
    campaignName,
    tenantId,
    userId,
    step: 'starting',
    message: `Campaign "${campaignName}" starting…`,
    percent: 0,
    status: 'running',
    leadsFound: 0,
    emailsFound: 0,
    emailsSent: 0,
    auditsCompleted: 0,
    cancelled: false,
    startedAt: Date.now(),
  });

  console.log(`🚀 Campaign "${campaignName}" started (job ${jobId})`);

  // Fire-and-forget the work; caller polls GET /job/:id
  runCampaignWork(jobId, {
    campaignId,
    campaignName,
    tenantId,
    userId,
    niche,
    location,
    targetEmails,
    autoAudit,
    autoEmail,
    autoFollowup,
  }).catch((err) => {
    console.error(`❌ Campaign "${campaignName}" crashed:`, err);
    setJob(jobId, {
      step: 'failed',
      message: err.message || 'Unknown error',
      status: 'failed',
      percent: 100,
    });
    markCampaignStatus(campaignId, 'failed');
  });

  return { jobId, campaignId, campaignName };
}

async function runCampaignWork(jobId, ctx) {
  const {
    campaignId,
    campaignName,
    tenantId,
    niche,
    location,
    targetEmails,
    autoAudit,
    autoEmail,
    autoFollowup,
  } = ctx;

  const settings = getSettingsForTenant(tenantId);
  const apiKey = settings.pagespeed_api_key || process.env.PAGESPEED_API_KEY || '';

  const adminUser = db
    .prepare(
      `SELECT * FROM users
       WHERE tenant_id = ? AND role = 'admin'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(tenantId);

  const adminHasSmtp =
    !!(adminUser && (adminUser.gmail_email || adminUser.smtp_email));

  // ---------- Step 2: Crawl (paginated) + Step 4: email lookup merged ----------
  // Target N leads with emails — keep paginating until we hit it, run out of
  // directory pages, or blow the attempt cap.
  setJob(jobId, {
    step: 'crawling',
    message: 'Crawling business directories…',
    percent: 5,
  });
  if (shouldAbort(jobId)) return finishCancelled(jobId, campaignId);

  const existingWebsites = new Set(
    db
      .prepare('SELECT website FROM leads WHERE tenant_id = ?')
      .all(tenantId)
      .map((r) => normalizeUrl(r.website))
      .filter(Boolean)
  );

  const leadsWithEmails = [];
  const processedKeys = new Set();
  const candidatePool = [];
  let attempts = 0;
  let totalScanned = 0;
  let totalFoundByCrawler = 0;
  const maxAttempts = targetEmails * 5;
  let batchStartPage = 1;

  outer: while (leadsWithEmails.length < targetEmails && attempts < maxAttempts) {
    // Refill candidates from the next page-batch when needed.
    const remaining = candidatePool.filter(
      (l) => l.website && !processedKeys.has(normalizeUrl(l.website))
    );
    if (remaining.length === 0) {
      if (shouldAbort(jobId)) return finishCancelled(jobId, campaignId);
      setJob(jobId, {
        step: 'crawling',
        message: `Fetching more results (batch ${batchStartPage})…`,
        leadsFound: totalFoundByCrawler,
        percent: 5 + Math.min(15, attempts / Math.max(1, targetEmails)) * 15,
      });
      let more;
      try {
        more = await searchAllDirectories(niche, location, targetEmails * 2, null, {
          startPage: batchStartPage,
        });
      } catch (err) {
        console.error('❌ Directory crawl failed:', err.message);
        break;
      }
      const moreResults = (more && more.results) || [];
      totalFoundByCrawler += moreResults.length;
      if (moreResults.length === 0) break;
      const fresh = moreResults.filter((l) => {
        const k = l.website ? normalizeUrl(l.website) : '';
        if (!k) return false;
        if (processedKeys.has(k)) return false;
        if (candidatePool.some((c) => normalizeUrl(c.website) === k)) return false;
        return true;
      });
      if (fresh.length === 0) break;
      candidatePool.push(...fresh);
      updateCampaign(campaignId, { leads_found: totalFoundByCrawler });
      batchStartPage += 1;
      continue;
    }

    setJob(jobId, {
      step: 'finding_emails',
      message: `Finding contact emails (${leadsWithEmails.length}/${targetEmails})…`,
      emailsFound: leadsWithEmails.length,
      percent: 25 + Math.round((leadsWithEmails.length / Math.max(1, targetEmails)) * 20),
    });

    for (const lead of candidatePool) {
      if (leadsWithEmails.length >= targetEmails) break outer;
      if (attempts >= maxAttempts) break outer;
      if (shouldAbort(jobId)) return finishCancelled(jobId, campaignId);
      if (!lead || !lead.website) continue;
      const k = normalizeUrl(lead.website);
      if (!k || processedKeys.has(k)) continue;
      processedKeys.add(k);

      attempts += 1;
      totalScanned += 1;

      if (existingWebsites.has(k)) {
        continue; // already in DB — skip email lookup entirely
      }

      try {
        const emailData = await findEmailsOnWebsite(lead.website);
        if (emailData && emailData.primaryEmail) {
          leadsWithEmails.push({
            ...lead,
            email: emailData.primaryEmail,
            contactName: emailData.contactName || lead.contactName || null,
          });
          setJob(jobId, {
            step: 'finding_emails',
            message: `Found emails: ${leadsWithEmails.length}/${targetEmails}`,
            emailsFound: leadsWithEmails.length,
            percent: 25 + Math.round((leadsWithEmails.length / Math.max(1, targetEmails)) * 20),
          });
        }
      } catch (err) {
        console.error(`❌ Email lookup failed (${lead.website}):`, err.message);
      }
      await sleep(800);
    }
  }

  const leadsFound = totalFoundByCrawler;
  updateCampaign(campaignId, {
    leads_found: leadsFound,
    emails_found: leadsWithEmails.length,
  });
  setJob(jobId, {
    step: 'finding_emails',
    message: `Found ${leadsWithEmails.length}/${targetEmails} leads with emails (scanned ${totalScanned})`,
    leadsFound,
    emailsFound: leadsWithEmails.length,
    percent: 45,
  });

  // ---------- Step 5: Save leads ----------
  for (const lead of leadsWithEmails) {
    if (shouldAbort(jobId)) return finishCancelled(jobId, campaignId);
    const leadId = uuidv4();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO leads
           (id, tenant_id, campaign_id, business_name, website, email,
            phone, address, city, source, contact_name,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))`
      ).run(
        leadId,
        tenantId,
        campaignId,
        lead.businessName || null,
        lead.website,
        lead.email,
        lead.phone || null,
        lead.address || null,
        lead.city || location,
        normalizeSource(lead.source),
        lead.contactName || null
      );
      const existing = db
        .prepare('SELECT id FROM leads WHERE tenant_id = ? AND website = ?')
        .get(tenantId, lead.website);
      lead.id = existing ? existing.id : leadId;
      // Tag previously-ignored leads onto this campaign for filter visibility
      if (existing) {
        db.prepare(
          `UPDATE leads SET campaign_id = COALESCE(campaign_id, ?) WHERE id = ?`
        ).run(campaignId, existing.id);
      }
    } catch (err) {
      console.error(`❌ Failed to save lead ${lead.website}:`, err.message);
    }
  }

  // ---------- Step 6: Audit + email ----------
  let emailsSent = 0;
  let totalScore = 0;
  let auditsCompleted = 0;
  const auditedLeads = [];

  for (let i = 0; i < leadsWithEmails.length; i += 1) {
    if (shouldAbort(jobId)) return finishCancelled(jobId, campaignId);
    const lead = leadsWithEmails[i];

    setJob(jobId, {
      step: 'auditing',
      message: `Auditing ${lead.businessName || lead.website}… (${i + 1}/${leadsWithEmails.length})`,
      currentSite: lead.website,
      auditsCompleted,
      percent: 45 + Math.round((i / Math.max(1, leadsWithEmails.length)) * 30),
    });

    let auditResult = null;
    let aiEmail = null;
    let pdfPath = null;

    try {
      if (autoAudit) {
        auditResult = await runAudit(lead.website, null, apiKey);
        auditsCompleted += 1;
        totalScore += auditResult.overallScore || 0;
        setJob(jobId, {
          step: 'auditing',
          message: `Audited ${lead.businessName || lead.website} — Score ${auditResult.overallScore}`,
          auditsCompleted,
          percent: 45 + Math.round(((i + 0.5) / Math.max(1, leadsWithEmails.length)) * 30),
        });
      }

      if (autoEmail && auditResult) {
        setJob(jobId, {
          step: 'generating_email',
          message: `Generating AI email for ${lead.businessName || lead.website}…`,
          percent: 45 + Math.round(((i + 0.7) / Math.max(1, leadsWithEmails.length)) * 30),
        });
        try {
          aiEmail = await generatePersonalizedEmail({
            businessName: lead.businessName || lead.website,
            websiteUrl: lead.website,
            clientName: lead.contactName || null,
            industry: niche,
            location,
            auditData: {
              overallScore: auditResult.overallScore,
              grade: auditResult.grade,
              scores: auditResult.scores,
              topIssues: (auditResult.issues || [])
                .filter((x) => x && x.severity === 'critical')
                .slice(0, 3),
              recommendations: (auditResult.recommendations || []).slice(0, 3),
            },
            agencySettings: settings,
            emailNumber: 1,
          });
        } catch (aiErr) {
          console.error(`❌ AI email gen failed (${lead.website}):`, aiErr.message);
        }
      }

      if (auditResult) {
        try {
          pdfPath = await generatePDF(
            {
              ...auditResult,
              clientName: lead.businessName || lead.website,
              clientEmail: lead.email,
              preparedBy: settings.agency_name || 'AuditPro',
            },
            settings
          );
        } catch (pdfErr) {
          console.error(`❌ PDF gen failed (${lead.website}):`, pdfErr.message);
        }

        const reportId = uuidv4();
        db.prepare(
          `INSERT INTO reports
             (id, tenant_id, user_id, client_name, client_email,
              website_url, overall_score, grade, seo_score,
              performance_score, accessibility_score, security_score,
              mobile_score, issues_json, recommendations_json,
              pdf_path, ai_email_json, created_at)
           VALUES (?, ?, 'pipeline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(
          reportId,
          tenantId,
          lead.businessName || null,
          lead.email,
          lead.website,
          auditResult.overallScore || 0,
          auditResult.grade || 'N/A',
          auditResult.scores?.seo || 0,
          auditResult.scores?.performance || 0,
          auditResult.scores?.accessibility || 0,
          auditResult.scores?.security || 0,
          auditResult.scores?.mobile || 0,
          JSON.stringify(auditResult.issues || []),
          JSON.stringify(auditResult.recommendations || []),
          pdfPath,
          aiEmail ? JSON.stringify(aiEmail) : null
        );
      }

      if (autoEmail && adminHasSmtp && pdfPath && lead.email) {
        setJob(jobId, {
          step: 'sending',
          message: `Sending email to ${lead.email}…`,
          percent: 45 + Math.round(((i + 0.9) / Math.max(1, leadsWithEmails.length)) * 30),
        });
        const trackingPixelId = uuidv4();
        await sendAuditReport({
          userSmtpConfig: adminUser,
          clientEmail: lead.email,
          clientName: lead.contactName || lead.businessName || 'there',
          agencySettings: settings,
          preparedBy: settings.agency_name || 'AuditPro Pipeline',
          reportData: { ...auditResult, websiteUrl: lead.website },
          pdfPath,
          aiEmail,
        });
        try {
          db.prepare(
            `INSERT INTO email_tracking
               (id, lead_id, email_type, tracking_pixel_id, sent_at, open_count, tenant_id)
             VALUES (?, ?, 'audit_report', ?, datetime('now'), 0, ?)`
          ).run(uuidv4(), lead.id, trackingPixelId, tenantId);
        } catch (trackErr) {
          console.error('email_tracking insert failed:', trackErr.message);
        }
        db.prepare(
          `UPDATE leads
             SET audit_sent = 1,
                 audit_sent_at = datetime('now'),
                 last_email_at = datetime('now'),
                 status = 'audited'
           WHERE id = ?`
        ).run(lead.id);
        emailsSent += 1;
        lead.emailSent = true;

        if (autoFollowup) {
          const delays = [
            parseInt(settings.follow_up_delay_1 || '3', 10),
            parseInt(settings.follow_up_delay_2 || '5', 10),
            parseInt(settings.follow_up_delay_3 || '7', 10),
            parseInt(settings.follow_up_delay_4 || '10', 10),
          ];
          for (let n = 0; n < 4; n += 1) {
            const scheduledAt = new Date();
            scheduledAt.setDate(scheduledAt.getDate() + delays[n]);
            try {
              db.prepare(
                `INSERT INTO follow_up_queue
                   (id, lead_id, email_number, scheduled_at, status, tenant_id)
                 VALUES (?, ?, ?, ?, 'pending', ?)`
              ).run(uuidv4(), lead.id, n + 1, scheduledAt.toISOString(), tenantId);
            } catch (fErr) {
              console.error('follow_up insert failed:', fErr.message);
            }
          }
        }
      }

      auditedLeads.push({
        id: lead.id,
        businessName: lead.businessName || lead.website,
        website: lead.website,
        email: lead.email,
        contactName: lead.contactName || null,
        score: auditResult?.overallScore || 0,
        grade: auditResult?.grade || 'N/A',
        emailSent: !!lead.emailSent,
      });

      updateCampaign(campaignId, {
        audits_completed: auditsCompleted,
        emails_sent: emailsSent,
        avg_score:
          auditsCompleted > 0 ? Math.round((totalScore / auditsCompleted) * 10) / 10 : 0,
      });
    } catch (err) {
      console.error(`❌ Failed for ${lead.website}:`, err.message);
      auditedLeads.push({
        id: lead.id,
        businessName: lead.businessName || lead.website,
        website: lead.website,
        email: lead.email,
        contactName: lead.contactName || null,
        score: 0,
        grade: 'N/A',
        emailSent: false,
        error: err.message,
      });
    }

    await sleep(2000);
  }

  // ---------- Step 7: Campaign PDF ----------
  setJob(jobId, {
    step: 'generating_pdf',
    message: 'Generating campaign summary PDF…',
    percent: 85,
  });

  let campaignPdfPath = null;
  try {
    campaignPdfPath = await generateCampaignPDF({
      campaignId,
      campaignName,
      niche,
      location,
      date: new Date(),
      stats: {
        leadsFound,
        emailsFound: leadsWithEmails.length,
        emailsSent,
        avgScore:
          auditsCompleted > 0 ? Math.round((totalScore / auditsCompleted) * 10) / 10 : 0,
        followUpsScheduled: emailsSent * 4,
      },
      leads: auditedLeads,
      agencySettings: settings,
    });
  } catch (err) {
    console.error('❌ Campaign PDF failed:', err.message);
  }

  const avgScore =
    auditsCompleted > 0 ? Math.round((totalScore / auditsCompleted) * 10) / 10 : 0;

  markCampaignStatus(campaignId, 'completed', {
    emails_sent: emailsSent,
    follow_ups_scheduled: emailsSent * 4,
    avg_score: avgScore,
    pdf_path: campaignPdfPath,
  });

  // ---------- Step 8: Bell notification ----------
  try {
    const notifyAdmin = db
      .prepare(
        `SELECT id FROM users
         WHERE tenant_id = ? AND role = 'admin'
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(tenantId);
    if (notifyAdmin) {
      addNotification(notifyAdmin.id, {
        type: 'pipeline_complete',
        message: `✅ ${campaignName} complete! ${emailsSent} emails sent`,
        leadId: campaignId,
        businessName: campaignName,
        campaignId,
        campaignPdfPath,
      });
    }
  } catch (err) {
    console.error('Notification failed:', err.message);
  }

  setJob(jobId, {
    step: 'completed',
    message: `Campaign complete! ${emailsSent} emails sent`,
    percent: 100,
    status: 'completed',
    campaignId,
    summary: {
      leadsFound,
      emailsFound: leadsWithEmails.length,
      emailsSent,
      avgScore,
      campaignPdfPath,
    },
  });

  console.log(
    `✅ Campaign "${campaignName}" completed: ${emailsSent} emails sent (avg score ${avgScore})`
  );
}

function finishCancelled(jobId, campaignId) {
  setJob(jobId, {
    step: 'cancelled',
    message: 'Campaign cancelled',
    percent: 100,
    status: 'cancelled',
  });
  markCampaignStatus(campaignId, 'cancelled');
  console.log(`🛑 Campaign ${campaignId} cancelled (job ${jobId})`);
}

module.exports = {
  runCampaign,
  getJob,
  requestCancel,
  sleep,
  normalizeUrl,
  normalizeSource,
  getSettingsForTenant,
};
