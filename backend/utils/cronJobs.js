const cron = require('node-cron');
const { db } = require('../db/database');

function getPort() {
  return process.env.PORT || 3000;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayStr(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function initCronJobs() {
  // JOB 1 — Process follow-up queue every hour on the hour.
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Processing follow-up queue...');
    try {
      const response = await fetch(
        'http://127.0.0.1:' + getPort() + '/api/followups/process',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const result = await response.json();
      console.log(`✅ Follow-ups processed: ${result.processed || 0} (failed: ${result.failed || 0})`);
    } catch (err) {
      console.error('❌ Follow-up cron error:', err.message);
    }
  });

  // JOB 2 — Reset daily Bing tokens at midnight.
  cron.schedule('0 0 * * *', () => {
    try {
      const today = todayStr();
      db.prepare(
        `UPDATE api_usage
         SET tokens_used_today = 0, last_reset_date = ?
         WHERE service = 'bing'`
      ).run(today);
      console.log('✅ Daily Bing tokens reset');
    } catch (err) {
      console.error('❌ Token reset error:', err.message);
    }
  });

  // JOB 3 — Reset monthly Bing tokens on the 1st of each month.
  cron.schedule('0 0 1 * *', () => {
    try {
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
      db.prepare(
        `UPDATE api_usage
         SET tokens_used_month = 0, month_reset_date = ?
         WHERE service = 'bing'`
      ).run(monthStart);
      console.log('✅ Monthly Bing tokens reset');
    } catch (err) {
      console.error('❌ Monthly token reset error:', err.message);
    }
  });

  // JOB 4 — Heartbeat / reply-check placeholder every 30 minutes.
  cron.schedule('*/30 * * * *', () => {
    console.log('📬 Checking follow-up statuses...');
    try {
      const overdueLeads = db
        .prepare(
          `SELECT l.id, l.business_name, l.last_email_at,
                  l.follow_up_count, l.status
           FROM leads l
           WHERE l.status NOT IN ('converted', 'cold', 'replied')
             AND l.last_email_at IS NOT NULL
             AND l.audit_sent = 1`
        )
        .all();
      console.log(`📊 ${overdueLeads.length} leads being tracked`);
    } catch (err) {
      console.error('❌ Reply check error:', err.message);
    }
  });
}

module.exports = {
  initCronJobs,
};
