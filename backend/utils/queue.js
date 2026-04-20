const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { runAudit } = require('./auditEngine');
const { generatePDF } = require('./pdfGenerator');
const { sendAuditReport } = require('./mailer');

class BulkQueue {
  constructor() {
    this.jobs = new Map();
    this.processing = false;
  }

  addJob(jobId, items) {
    const job = {
      jobId,
      items: items.map((it) => ({
        id: it.id || uuidv4(),
        websiteUrl: it.websiteUrl,
        clientName: it.clientName || null,
        clientEmail: it.clientEmail || null,
        competitorUrl: it.competitorUrl || null,
        status: 'pending',
        reportId: null,
        error: null,
      })),
      total: items.length,
      completed: 0,
      failed: 0,
      status: 'pending',
      clients: new Set(),
      createdAt: new Date(),
    };
    this.jobs.set(jobId, job);
    return jobId;
  }

  addClient(jobId, res) {
    const job = this.jobs.get(jobId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    if (!job) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Job not found' })}\n\n`);
      res.end();
      return;
    }

    res.write(
      `data: ${JSON.stringify({
        type: 'state',
        jobId,
        status: job.status,
        total: job.total,
        completed: job.completed,
        failed: job.failed,
        items: job.items,
      })}\n\n`
    );

    if (job.status === 'completed' || job.status === 'failed') {
      res.write(
        `data: ${JSON.stringify({
          type: 'job_completed',
          jobId,
          total: job.total,
          completed: job.completed,
          failed: job.failed,
          summary: `${job.completed} audits completed, ${job.failed} failed`,
        })}\n\n`
      );
      res.end();
      return;
    }

    job.clients.add(res);
    const cleanup = () => job.clients.delete(res);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  broadcast(jobId, eventData) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const payload = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const res of job.clients) {
      try {
        res.write(payload);
      } catch {
        job.clients.delete(res);
      }
    }
  }

  closeAllClients(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const res of job.clients) {
      try {
        res.end();
      } catch {}
    }
    job.clients.clear();
  }

  async processJob(jobId, apiKey, userSmtpConfig, agencySettings, preparedBy) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = 'running';
    db.prepare("UPDATE bulk_jobs SET status = 'running' WHERE id = ?").run(jobId);
    this.broadcast(jobId, { type: 'started', jobId, total: job.total });

    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i];
      item.status = 'running';
      try {
        db.prepare("UPDATE bulk_job_items SET status = 'running' WHERE id = ?").run(item.id);
      } catch {}

      this.broadcast(jobId, {
        type: 'item_started',
        jobId,
        itemId: item.id,
        websiteUrl: item.websiteUrl,
        current: i + 1,
        total: job.total,
        percent: Math.round((i / job.total) * 100),
      });

      try {
        const result = await runAudit(item.websiteUrl, item.competitorUrl || null, apiKey);
        const reportData = { ...result, preparedBy };

        const pdfPath = await generatePDF(reportData, agencySettings);

        const reportId = uuidv4();
        db.prepare(
          `INSERT INTO reports (
             id, user_id, client_name, client_email, website_url, competitor_url,
             overall_score, grade, seo_score, performance_score, accessibility_score,
             security_score, mobile_score, issues_json, recommendations_json,
             competitor_data_json, pdf_path
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          reportId,
          userSmtpConfig.id,
          item.clientName,
          item.clientEmail,
          item.websiteUrl,
          item.competitorUrl,
          result.overallScore,
          result.grade,
          result.scores.seo,
          result.scores.performance,
          result.scores.accessibility,
          result.scores.security,
          result.scores.mobile,
          JSON.stringify(result.issues),
          JSON.stringify(result.recommendations),
          result.competitorData ? JSON.stringify(result.competitorData) : null,
          pdfPath
        );

        if (item.clientEmail) {
          await sendAuditReport({
            userSmtpConfig,
            clientEmail: item.clientEmail,
            clientName: item.clientName || 'there',
            agencySettings,
            preparedBy,
            reportData,
            pdfPath,
          });
          db.prepare(
            "UPDATE reports SET email_sent = 1, email_sent_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).run(reportId);
        }

        item.status = 'completed';
        item.reportId = reportId;
        job.completed++;

        db.prepare(
          "UPDATE bulk_job_items SET status = 'completed', report_id = ? WHERE id = ?"
        ).run(reportId, item.id);
        db.prepare('UPDATE bulk_jobs SET completed = ? WHERE id = ?').run(
          job.completed,
          jobId
        );

        this.broadcast(jobId, {
          type: 'item_completed',
          jobId,
          itemId: item.id,
          websiteUrl: item.websiteUrl,
          reportId,
          current: i + 1,
          total: job.total,
          percent: Math.round(((i + 1) / job.total) * 100),
        });
      } catch (err) {
        item.status = 'failed';
        item.error = err.message;
        job.failed++;

        try {
          db.prepare(
            "UPDATE bulk_job_items SET status = 'failed', error_message = ? WHERE id = ?"
          ).run(err.message, item.id);
          db.prepare('UPDATE bulk_jobs SET failed = ? WHERE id = ?').run(job.failed, jobId);
        } catch {}

        this.broadcast(jobId, {
          type: 'item_failed',
          jobId,
          itemId: item.id,
          websiteUrl: item.websiteUrl,
          error: err.message,
          current: i + 1,
          total: job.total,
          percent: Math.round(((i + 1) / job.total) * 100),
        });
      }

      if (i < job.items.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    job.status = 'completed';
    db.prepare(
      "UPDATE bulk_jobs SET status = 'completed', completed = ?, failed = ? WHERE id = ?"
    ).run(job.completed, job.failed, jobId);

    this.broadcast(jobId, {
      type: 'job_completed',
      jobId,
      total: job.total,
      completed: job.completed,
      failed: job.failed,
      summary: `${job.completed} audits completed, ${job.failed} failed`,
    });

    this.closeAllClients(jobId);
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  getFailedItems(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return [];
    return job.items.filter((it) => it.status === 'failed');
  }
}

const instance = new BulkQueue();
module.exports = instance;
module.exports.BulkQueue = BulkQueue;
