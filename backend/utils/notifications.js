const { v4: uuidv4 } = require('uuid');

const MAX_PER_USER = 50;

const notifications = new Map();
const clients = new Map();

function getList(userId) {
  if (!notifications.has(userId)) notifications.set(userId, []);
  return notifications.get(userId);
}

function pushSSE(userId, payload) {
  const set = clients.get(userId);
  if (!set || set.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch {
      // client gone — drop
      set.delete(res);
    }
  }
  if (set.size === 0) clients.delete(userId);
}

function addNotification(userId, notification) {
  if (!userId) return null;
  const n = {
    id: notification && notification.id ? notification.id : uuidv4(),
    type: notification && notification.type ? notification.type : 'info',
    message: notification && notification.message ? notification.message : '',
    leadId: notification && notification.leadId ? notification.leadId : null,
    businessName: notification && notification.businessName ? notification.businessName : null,
    read: false,
    createdAt: new Date().toISOString(),
  };

  const list = getList(userId);
  list.unshift(n);
  if (list.length > MAX_PER_USER) list.length = MAX_PER_USER;

  pushSSE(userId, { type: 'notification', notification: n });
  return n;
}

function getNotifications(userId) {
  const list = getList(userId);
  const unread = list.filter((n) => !n.read).map((n) => ({ ...n }));
  for (const n of list) n.read = true;
  return unread;
}

function markAllRead(userId) {
  const list = getList(userId);
  for (const n of list) n.read = true;
  return true;
}

function addNotificationClient(userId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  const list = getList(userId);
  const unread = list.filter((n) => !n.read);
  if (unread.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'pending', notifications: unread })}\n\n`);
  }

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 25000);

  function cleanup() {
    clearInterval(keepAlive);
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(userId);
    }
  }

  res.on('close', cleanup);
  res.on('error', cleanup);
}

module.exports = {
  addNotification,
  getNotifications,
  markAllRead,
  addNotificationClient,
};
