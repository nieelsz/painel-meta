const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const file = process.env.DEMO_MODE === 'true' ? 'demo.db' : 'painel.db';
const db = new Database(path.join(dataDir, file));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ad_accounts (
  id TEXT PRIMARY KEY,            -- act_123
  name TEXT,
  currency TEXT,
  timezone TEXT,
  account_status INTEGER,
  token_id INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,            -- plataforma:pedido
  platform TEXT,
  order_id TEXT,
  status TEXT,                    -- approved | pending | refunded | chargeback | canceled | refused
  payment_method TEXT,            -- pix | card | boleto | other
  product TEXT,
  gross_cents INTEGER DEFAULT 0,
  net_cents INTEGER DEFAULT 0,
  customer_state TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  created_at TEXT,
  day TEXT,                       -- YYYY-MM-DD no fuso do painel
  hour INTEGER,
  raw TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_day ON sales(day);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_ids TEXT DEFAULT '[]',
  products TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT CURRENT_TIMESTAMP,
  entity_id TEXT, entity_name TEXT, action TEXT, detail TEXT
);
`);

function getSetting(key, def) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? JSON.parse(r.value) : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

module.exports = { db, getSetting, setSetting };
