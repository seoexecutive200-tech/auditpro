const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { initDB } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// -------- Ensure pdfs/ exists at startup --------
const pdfsDir = path.join(__dirname, '..', 'pdfs');
if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });

// -------- Middleware --------
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// -------- Static frontend --------
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// -------- Health check --------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
});

// -------- Route imports --------
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users'); // default export: usersRouter, with .profileRouter attached
const auditRoutes = require('./routes/audit');
const bulkRoutes = require('./routes/bulk');
const reportsRoutes = require('./routes/reports');
const emailRoutes = require('./routes/email');
const pdfRoutes = require('./routes/pdf');
const settingsRoutes = require('./routes/settings');
const leadsRoutes = require('./routes/leads');
const leadFinderRoutes = require('./routes/leadFinder');
const nichesRoutes = require('./routes/niches');
const followUpRoutes = require('./routes/followUp');
const superAdminRoutes = require('./routes/superAdmin');
const agencyAuthRoutes = require('./routes/agencyAuth');
const pipelineRoutes = require('./routes/pipeline');
const { authenticateToken } = require('./utils/auth');
const { resolveTenant } = require('./middleware/tenantMiddleware');

// -------- Mount API routes --------
// Super-admin console + public agency branding — mount BEFORE the tenant-scoped
// API so their auth layers (super_admin JWT / public) aren't intercepted.
app.use('/api/super', superAdminRoutes);
app.use('/api/agency', agencyAuthRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/profile', usersRoutes.profileRouter);
app.use('/api/audit', auditRoutes);
app.use('/api/bulk', bulkRoutes);
// pdfRoutes must be mounted BEFORE reportsRoutes so that the PDF route
// (which supports ?token= query auth) isn't intercepted by reportsRoutes'
// router.use(authenticateToken) middleware that only reads the header.
app.use('/api/reports', pdfRoutes); // GET /api/reports/:id/pdf
app.use('/api/pdf', pdfRoutes); // alias
app.use('/api/reports', reportsRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/settings', settingsRoutes);

// Lead Finder mounted BEFORE leads CRUD so /search, /tokens, and
// /search/:jobId/status aren't intercepted by /:id in leads.js.
app.use('/api/leads', leadFinderRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/niches', nichesRoutes);
app.use('/api/followups', followUpRoutes);
app.use('/api/tracking', followUpRoutes.trackingRouter);
app.use('/api/notifications', followUpRoutes.notificationsRouter);
app.use('/api/pipeline', authenticateToken, resolveTenant, pipelineRoutes);

// -------- SPA fallback (serve index.html for non-API routes) --------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// -------- 404 for API --------
app.use((req, res, next) => {
  if (res.headersSent) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// -------- Error handler --------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error('Error:', err && err.message ? err.message : err);
  res.status(err.status || 500).json({
    error: (err && err.message) || 'Internal server error',
  });
});

// -------- Boot --------
try {
  initDB();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ AuditPro server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔑 Default login: admin@auditpro.com / Admin@123`);
    try {
      const { initCronJobs } = require('./utils/cronJobs');
      initCronJobs();
      console.log('⏰ Cron jobs initialized');
    } catch (err) {
      console.error('Failed to initialize cron jobs:', err.message);
    }
  });
} catch (err) {
  console.error('Failed to initialize database:', err);
  process.exit(1);
}

module.exports = app;
