const { db } = require('../db/database');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayStr(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthStartStr(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-01`;
}

function ordinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function nextMonthFirstDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

function readableResetsOn(date = new Date()) {
  const next = nextMonthFirstDay(date);
  return `${MONTH_NAMES[next.getMonth()]} ${next.getDate()}${ordinalSuffix(next.getDate())}`;
}

function daysUntilReset(date = new Date()) {
  const next = nextMonthFirstDay(date);
  const ms = next.getTime() - date.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function computeStatus(remainingMonth) {
  if (remainingMonth <= 0) return 'exhausted';
  if (remainingMonth < 200) return 'critical';
  if (remainingMonth <= 500) return 'low';
  return 'ok';
}

function applyResets(row) {
  const now = new Date();
  const today = todayStr(now);
  const monthStart = monthStartStr(now);
  let tokensUsedToday = row.tokens_used_today;
  let tokensUsedMonth = row.tokens_used_month;
  let changed = false;

  if (!row.last_reset_date || row.last_reset_date < today) {
    tokensUsedToday = 0;
    changed = true;
  }
  if (!row.month_reset_date || row.month_reset_date < monthStart) {
    tokensUsedMonth = 0;
    changed = true;
  }

  if (changed) {
    db.prepare(
      `UPDATE api_usage
       SET tokens_used_today = ?, tokens_used_month = ?, last_reset_date = ?, month_reset_date = ?
       WHERE id = ?`
    ).run(tokensUsedToday, tokensUsedMonth, today, monthStart, row.id);
  }

  return {
    ...row,
    tokens_used_today: tokensUsedToday,
    tokens_used_month: tokensUsedMonth,
    last_reset_date: today,
    month_reset_date: monthStart,
  };
}

function buildStatus(row) {
  const now = new Date();
  const monthlyLimit = row.monthly_limit || 0;
  const tokensUsedToday = row.tokens_used_today || 0;
  const tokensUsedMonth = row.tokens_used_month || 0;
  const remainingMonth = Math.max(0, monthlyLimit - tokensUsedMonth);
  const remainingToday = remainingMonth;
  const percentUsed = monthlyLimit > 0
    ? Math.round((tokensUsedMonth / monthlyLimit) * 100)
    : 0;

  return {
    service: row.service,
    tokensUsedToday,
    tokensUsedMonth,
    monthlyLimit,
    remainingToday,
    remainingMonth,
    resetsOn: readableResetsOn(now),
    daysUntilReset: daysUntilReset(now),
    percentUsed,
    status: computeStatus(remainingMonth),
  };
}

function getTokenStatus(service) {
  const row = db.prepare('SELECT * FROM api_usage WHERE service = ?').get(service);
  if (!row) {
    return {
      service,
      tokensUsedToday: 0,
      tokensUsedMonth: 0,
      monthlyLimit: 0,
      remainingToday: 0,
      remainingMonth: 0,
      resetsOn: readableResetsOn(),
      daysUntilReset: daysUntilReset(),
      percentUsed: 0,
      status: 'exhausted',
    };
  }
  const updated = applyResets(row);
  return buildStatus(updated);
}

function useTokens(service, count) {
  const row = db.prepare('SELECT * FROM api_usage WHERE service = ?').get(service);
  if (!row) return getTokenStatus(service);

  const updated = applyResets(row);
  const now = new Date();
  const today = todayStr(now);
  const monthStart = monthStartStr(now);
  const newToday = (updated.tokens_used_today || 0) + count;
  const newMonth = (updated.tokens_used_month || 0) + count;

  db.prepare(
    `UPDATE api_usage
     SET tokens_used_today = ?, tokens_used_month = ?, last_reset_date = ?, month_reset_date = ?
     WHERE id = ?`
  ).run(newToday, newMonth, today, monthStart, updated.id);

  return buildStatus({
    ...updated,
    tokens_used_today: newToday,
    tokens_used_month: newMonth,
  });
}

function checkTokens(service, needed) {
  const status = getTokenStatus(service);
  return status.remainingMonth >= needed;
}

module.exports = {
  getTokenStatus,
  useTokens,
  checkTokens,
};
