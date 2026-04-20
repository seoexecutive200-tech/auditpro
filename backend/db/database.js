const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const DB_PATH = process.env.DB_PATH || './db/auditpro.db';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default_32_character_key_change_me';

const DEFAULT_TENANT_ID = 'default';

const resolvedDbPath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.join(__dirname, '..', '..', DB_PATH);

const dbDir = path.dirname(resolvedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(resolvedDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function getKey() {
  return crypto
    .createHash('sha256')
    .update(String(ENCRYPTION_KEY))
    .digest();
}

function encrypt(text) {
  if (text === null || text === undefined || text === '') return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  if (text === null || text === undefined || text === '') return text;
  const parts = String(text).split(':');
  if (parts.length !== 2) return text;
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','sales')),
      smtp_type TEXT CHECK(smtp_type IN ('gmail','hostinger')),
      gmail_email TEXT,
      gmail_app_password TEXT,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_email TEXT,
      smtp_password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      client_name TEXT,
      client_email TEXT,
      website_url TEXT,
      competitor_url TEXT,
      overall_score INTEGER,
      grade TEXT,
      seo_score INTEGER,
      performance_score INTEGER,
      accessibility_score INTEGER,
      security_score INTEGER,
      mobile_score INTEGER,
      issues_json TEXT,
      recommendations_json TEXT,
      competitor_data_json TEXT,
      pdf_path TEXT,
      email_sent INTEGER DEFAULT 0,
      email_sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS bulk_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      total_sites INTEGER,
      completed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT CHECK(status IN ('pending','running','completed','failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS bulk_job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      website_url TEXT,
      client_name TEXT,
      client_email TEXT,
      competitor_url TEXT,
      status TEXT CHECK(status IN ('pending','running','completed','failed')),
      report_id TEXT,
      error_message TEXT,
      FOREIGN KEY (job_id) REFERENCES bulk_jobs(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS niches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      assigned_to TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      business_name TEXT,
      website TEXT UNIQUE,
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      country TEXT,
      niche_id TEXT,
      assigned_to TEXT,
      source TEXT CHECK(source IN ('yelp','yellowpages','bing','manual')),
      contact_name TEXT,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','opened','replied','audited','converted','cold')),
      audit_sent INTEGER DEFAULT 0,
      audit_sent_at DATETIME,
      last_email_at DATETIME,
      follow_up_count INTEGER DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (niche_id) REFERENCES niches(id),
      FOREIGN KEY (assigned_to) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_tracking (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      email_type TEXT CHECK(email_type IN ('audit_report','follow_up_1','follow_up_2','follow_up_3','follow_up_4')),
      tracking_pixel_id TEXT UNIQUE,
      sent_at DATETIME,
      opened_at DATETIME,
      open_count INTEGER DEFAULT 0,
      replied INTEGER DEFAULT 0,
      replied_at DATETIME,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS follow_up_queue (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      email_number INTEGER,
      scheduled_at DATETIME,
      sent_at DATETIME,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','cancelled','failed')),
      error_message TEXT,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS lead_searches (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      niche TEXT,
      location TEXT,
      sources_used TEXT,
      total_found INTEGER DEFAULT 0,
      emails_found INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS api_usage (
      id TEXT PRIMARY KEY,
      service TEXT,
      tokens_used_today INTEGER DEFAULT 0,
      tokens_used_month INTEGER DEFAULT 0,
      monthly_limit INTEGER DEFAULT 1000,
      last_reset_date TEXT,
      month_reset_date TEXT
    );
  `);
}

function createTenantTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subdomain TEXT UNIQUE,
      brand_name TEXT,
      logo_url TEXT,
      primary_color TEXT DEFAULT '#6C2BD9',
      gradient_start TEXT DEFAULT '#6C2BD9',
      gradient_end TEXT DEFAULT '#8B5CF6',
      owner_name TEXT,
      owner_email TEXT UNIQUE,
      plan TEXT DEFAULT 'pro',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','cancelled')),
      monthly_price REAL DEFAULT 300,
      subscription_start DATETIME,
      subscription_end DATETIME,
      max_users INTEGER DEFAULT 10,
      max_leads_per_month INTEGER DEFAULT 5000,
      max_audits_per_month INTEGER DEFAULT 1000,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS super_admins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agency_settings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      UNIQUE(tenant_id, key),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    );

    CREATE TABLE IF NOT EXISTS lead_scores (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      tenant_id TEXT,
      score INTEGER DEFAULT 0,
      events_json TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS pipeline_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      type TEXT,
      status TEXT CHECK(status IN ('running','completed','failed')),
      config_json TEXT,
      results_json TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      name TEXT,
      niche TEXT,
      location TEXT,
      target_emails INTEGER,
      status TEXT CHECK(status IN ('running','completed','failed','cancelled')),
      leads_found INTEGER DEFAULT 0,
      emails_found INTEGER DEFAULT 0,
      emails_sent INTEGER DEFAULT 0,
      audits_completed INTEGER DEFAULT 0,
      follow_ups_scheduled INTEGER DEFAULT 0,
      avg_score REAL DEFAULT 0,
      pdf_path TEXT,
      auto_audit INTEGER DEFAULT 1,
      auto_email INTEGER DEFAULT 1,
      auto_followup INTEGER DEFAULT 1,
      started_by TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      deleted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pipeline_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT UNIQUE,
      enabled INTEGER DEFAULT 0,
      run_time TEXT DEFAULT '09:00',
      niches_json TEXT,
      locations_json TEXT,
      max_leads_per_run INTEGER DEFAULT 50,
      auto_audit INTEGER DEFAULT 1,
      auto_email INTEGER DEFAULT 1,
      auto_followup INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// Idempotent ALTER — ignores the "duplicate column" error if already applied.
function addColumnIfMissing(table, columnDef, columnName) {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`).run();
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) {
      console.warn(`⚠ migration on ${table}.${columnName}: ${err.message}`);
    }
  }
}

function addReportAiEmailColumn() {
  addColumnIfMissing('reports', 'ai_email_json TEXT', 'ai_email_json');
}

function addLeadsCampaignColumn() {
  addColumnIfMissing('leads', 'campaign_id TEXT', 'campaign_id');
}

// Add tenant_id to existing tables. Each ALTER is idempotent — SQLite errors if
// the column already exists, so we swallow per-table errors individually.
function addTenantIdColumns() {
  const tables = [
    'users',
    'reports',
    'leads',
    'niches',
    'bulk_jobs',
    'bulk_job_items',
    'lead_searches',
    'email_tracking',
    'follow_up_queue',
  ];
  for (const t of tables) {
    try {
      db.prepare(
        `ALTER TABLE ${t} ADD COLUMN tenant_id TEXT DEFAULT '${DEFAULT_TENANT_ID}'`
      ).run();
    } catch (err) {
      // column already exists — safe to ignore
      if (!/duplicate column name/i.test(err.message)) {
        console.warn(`⚠ tenant_id migration on ${t}: ${err.message}`);
      }
    }
  }
}

function seedDefaultTenant() {
  // Only seed when the tenants table is empty. This prevents overwriting any
  // operator-customized tenants on deploy. INSERT OR IGNORE would already
  // preserve the 'default' row by PK, but we want the broader guarantee that
  // we never touch existing tenant data at all.
  const tenantCount = db.prepare('SELECT COUNT(*) AS c FROM tenants').get().c;
  if (tenantCount > 0) return;

  db.prepare(`
    INSERT OR IGNORE INTO tenants (
      id, name, subdomain, brand_name, logo_url, primary_color,
      gradient_start, gradient_end, plan, status, monthly_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    DEFAULT_TENANT_ID,
    'My Agency',
    'default',
    'AuditPro',
    'https://chosenfirstai.com/wp-content/uploads/2026/03/Untitled-506-x-383-px.png',
    '#6C2BD9',
    '#6C2BD9',
    '#8B5CF6',
    'enterprise',
    'active',
    0
  );
}

function seedSuperAdmin() {
  const existing = db
    .prepare('SELECT id FROM super_admins WHERE email = ?')
    .get('superadmin@auditpro.com');
  if (existing) return;
  const passwordHash = bcrypt.hashSync('SuperAdmin@123', 10);
  db.prepare(`
    INSERT OR IGNORE INTO super_admins (id, name, email, password_hash)
    VALUES (?, ?, ?, ?)
  `).run(uuidv4(), 'Super Admin', 'superadmin@auditpro.com', passwordHash);
}

function seedDefaultPipelineConfig() {
  const existing = db
    .prepare('SELECT id FROM pipeline_configs WHERE tenant_id = ?')
    .get(DEFAULT_TENANT_ID);
  if (existing) return;
  db.prepare(`
    INSERT OR IGNORE INTO pipeline_configs (
      id, tenant_id, enabled, run_time, niches_json, locations_json, max_leads_per_run,
      auto_audit, auto_email, auto_followup
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    DEFAULT_TENANT_ID,
    0,
    '09:00',
    '[]',
    '[]',
    50,
    1,
    1,
    1
  );
}

function seedAdmin() {
  // Only insert the default admin when there are no users at all in the
  // database. On an existing install we must not re-create admin@auditpro.com
  // — that would regenerate the bcrypt hash on every deploy and clobber any
  // rotated password. If one user already exists, the schema is considered
  // provisioned and we leave it alone.
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) {
    // Back-fill tenant_id on any pre-existing users if it was NULL — this is
    // safe because we're filling a missing value, not overwriting.
    db.prepare(
      "UPDATE users SET tenant_id = ? WHERE tenant_id IS NULL OR tenant_id = ''"
    ).run(DEFAULT_TENANT_ID);
    return;
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync('Admin@123', 10);

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, 'Admin', 'admin@auditpro.com', passwordHash, 'admin', DEFAULT_TENANT_ID);
  console.log('🌱 Seeded default admin user (first-run)');
}

function seedSettings() {
  const defaults = {
    agency_name: 'AuditPro',
    agency_logo: 'https://chosenfirstai.com/wp-content/uploads/2026/03/Untitled-506-x-383-px.png',
    agency_contact: 'contact@youragency.com',
    agency_website: 'https://youragency.com',
    agency_phone: '',
    bing_api_key: '',
    groq_api_key: '',
    follow_up_delay_1: '3',
    follow_up_delay_2: '5',
    follow_up_delay_3: '7',
    follow_up_delay_4: '10',
    follow_up_enabled: 'true',
    tracking_pixel_enabled: 'true',
  };

  // Only add MISSING setting keys. Never overwrite an existing value — the
  // operator may have changed agency_name, logo, API keys, etc. and we must
  // not revert them on deploy.
  const existingKeys = new Set(
    db.prepare('SELECT key FROM settings').all().map((r) => r.key)
  );
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  let added = 0;
  for (const [key, value] of Object.entries(defaults)) {
    if (!existingKeys.has(key)) {
      insert.run(key, value);
      added += 1;
    }
  }
  if (added > 0) console.log(`🌱 Added ${added} missing default setting(s)`);
}

function seedApiUsage() {
  const existing = db.prepare('SELECT id FROM api_usage WHERE service = ?').get('bing');
  if (existing) return;

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const today = `${yyyy}-${mm}-${dd}`;
  const monthStart = `${yyyy}-${mm}-01`;

  db.prepare(`
    INSERT INTO api_usage (id, service, tokens_used_today, tokens_used_month, monthly_limit, last_reset_date, month_reset_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), 'bing', 0, 0, 1000, today, monthStart);
}

function initDB() {
  createTables();
  createTenantTables();
  addTenantIdColumns();
  addReportAiEmailColumn();
  addLeadsCampaignColumn();
  // Belt-and-suspenders explicit ALTERs for deployments with older schemas.
  // Each runs idempotently; "duplicate column name" is the expected harmless
  // outcome when the column already exists.
  // Note: single-quoted string literals. SQLite treats double-quoted tokens as
  // identifiers, which breaks subsequent queries (root cause of the previous
  // "no such column" error we were chasing).
  const leadMigrations = [
    'ALTER TABLE leads ADD COLUMN campaign_id TEXT',
    "ALTER TABLE leads ADD COLUMN tenant_id TEXT DEFAULT 'default'",
    'ALTER TABLE leads ADD COLUMN niche_id TEXT',
    'ALTER TABLE leads ADD COLUMN assigned_to TEXT',
    'ALTER TABLE leads ADD COLUMN contact_name TEXT',
    'ALTER TABLE leads ADD COLUMN country TEXT',
    'ALTER TABLE leads ADD COLUMN follow_up_count INTEGER DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN audit_sent INTEGER DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN audit_sent_at DATETIME',
    'ALTER TABLE leads ADD COLUMN last_email_at DATETIME',
    'ALTER TABLE leads ADD COLUMN notes TEXT',
    'ALTER TABLE leads ADD COLUMN updated_at DATETIME',
  ];
  for (const sql of leadMigrations) {
    try {
      db.prepare(sql).run();
      console.log('✅ Migration:', sql.split('ADD COLUMN')[1].trim());
    } catch (e) {
      // Column already exists — safe to ignore; anything else is worth noting.
      if (!/duplicate column name/i.test(e.message)) {
        console.warn('⚠ Migration skipped:', sql, '-', e.message);
      }
    }
  }
  seedDefaultTenant();
  seedSuperAdmin();
  seedDefaultPipelineConfig();
  seedAdmin();
  seedSettings();
  seedApiUsage();
  console.log('Database initialized');
}

// Resolve the tenant_id for a request. Super admins may pass ?tenant_id=... or
// a x-tenant-id header to scope queries to a specific tenant; ordinary users
// are pinned to the tenant baked into their JWT. Falls back to DEFAULT_TENANT_ID.
function getTenantId(req) {
  if (!req) return DEFAULT_TENANT_ID;
  const user = req.user || {};
  if (user.role === 'super_admin') {
    const override =
      (req.query && req.query.tenant_id) ||
      req.headers['x-tenant-id'] ||
      user.tenant_id ||
      DEFAULT_TENANT_ID;
    return String(override);
  }
  return user.tenant_id || DEFAULT_TENANT_ID;
}

module.exports = {
  db,
  encrypt,
  decrypt,
  initDB,
  getTenantId,
  DEFAULT_TENANT_ID,
};
