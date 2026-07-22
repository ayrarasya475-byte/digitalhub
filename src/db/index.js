// DigitalHub - Database layer (better-sqlite3)
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'digitalhub.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- owner | admin | support_agent
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES admins(id),
  admin_username TEXT,
  action TEXT NOT NULL,      -- login, create_product, block_user, dll
  detail TEXT,
  ip TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT DEFAULT 'error', -- error | warn
  message TEXT NOT NULL,
  stack TEXT,
  route TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  ads_enabled INTEGER DEFAULT 1,
  apikey TEXT UNIQUE,
  last_ip TEXT,
  last_country TEXT,
  last_os TEXT,
  last_browser TEXT,
  is_blocked INTEGER DEFAULT 0,
  blocked_until TEXT,
  blocked_reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Reseller = pemilik toko (multi-tenant storefront)
CREATE TABLE IF NOT EXISTS resellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  store_name TEXT NOT NULL,
  wa TEXT,
  password_hash TEXT NOT NULL,
  logo TEXT,
  color TEXT DEFAULT '#6366f1',
  balance INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_ip TEXT,
  last_country TEXT,
  last_os TEXT,
  last_browser TEXT,
  is_blocked INTEGER DEFAULT 0,
  blocked_until TEXT,
  blocked_reason TEXT,
  is_verified INTEGER DEFAULT 0,
  verified_at TEXT,
  social_link TEXT,
  apikey TEXT UNIQUE,
  own_ai_provider TEXT,     -- openrouter, gemini, qwen, deepseek, grok, dll
  own_ai_key TEXT,
  own_ai_enabled INTEGER DEFAULT 0,
  max_servers INTEGER DEFAULT 20,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reseller_banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  image TEXT NOT NULL,
  link TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER REFERENCES resellers(id) ON DELETE CASCADE, -- NULL = produk resmi DigitalHub
  category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  image TEXT,
  qris_image TEXT,
  payment_gateway TEXT DEFAULT 'manual', -- manual, qris, midtrans, dll (nama saja, integrasi menyusul)
  product_type TEXT DEFAULT 'digital',   -- digital, panel, otp, jasa, dll
  specification TEXT,   -- spesifikasi/detail teknis produk
  terms TEXT,            -- ketentuan produk
  usage_info TEXT,        -- cara pakai / penggunaan produk
  price INTEGER NOT NULL,
  cost_price INTEGER DEFAULT 0,
  stock INTEGER DEFAULT -1, -- -1 = unlimited
  is_active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER DEFAULT -1,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice TEXT UNIQUE NOT NULL,
  reseller_id INTEGER REFERENCES resellers(id),
  user_id INTEGER REFERENCES users(id),
  product_id INTEGER REFERENCES products(id),
  variant_id INTEGER REFERENCES product_variants(id),
  buyer_name TEXT,
  buyer_contact TEXT,
  target TEXT,          -- nomor tujuan / akun tujuan
  qty INTEGER DEFAULT 1,
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, paid, processing, success, failed, expired
  note TEXT,
  payload TEXT,          -- JSON detail tambahan (mis. hasil OTP, akun panel, dll)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5,
  comment TEXT,
  image TEXT,
  helpful INTEGER NOT NULL DEFAULT 0,
  is_approved INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER REFERENCES resellers(id),
  room TEXT NOT NULL,        -- pengelompokan percakapan (mis. slug toko / order invoice)
  sender TEXT NOT NULL,      -- 'buyer' | 'seller' | 'admin'
  sender_name TEXT,
  message TEXT,
  image TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  panel_username TEXT NOT NULL,
  panel_password TEXT NOT NULL,
  plan_id INTEGER,
  plan_name TEXT,
  ram_mb INTEGER, disk_mb INTEGER, cpu_pct INTEGER,
  domain TEXT,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active, suspended, deleted
  expires_at INTEGER NOT NULL, -- epoch ms
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS panel_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ram_mb INTEGER, disk_mb INTEGER, cpu_pct INTEGER,
  price INTEGER NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 30,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS otp_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'rumahotp', -- 'smscode' | 'rumahotp' (nama layanan/tab di UI)
  service TEXT NOT NULL,
  country_name TEXT,
  phone_number TEXT,
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting, otp_received, completed, canceled, expired
  otp TEXT,
  otp_msg TEXT,
  created_at INTEGER NOT NULL, -- epoch ms
  expires_at INTEGER NOT NULL  -- epoch ms
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER REFERENCES resellers(id),
  user_id INTEGER REFERENCES users(id),
  amount INTEGER NOT NULL,
  method TEXT DEFAULT 'qris',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image TEXT NOT NULL,
  link TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS visitor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT,
  ip TEXT,
  country TEXT,
  os TEXT,
  browser TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banned_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blocked_ips (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  blocked_until TEXT
);

CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT,     -- 'user' | 'reseller'
  actor_id INTEGER,
  reason TEXT,
  content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  method TEXT DEFAULT 'chat', -- chat, gateway
  status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_user_id INTEGER REFERENCES users(id),
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open, reviewed, dismissed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL, -- 'admin' | 'reseller'
  owner_id INTEGER,          -- NULL untuk admin (global)
  url TEXT NOT NULL,
  secret TEXT,
  events TEXT DEFAULT 'order.created', -- comma-separated
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  points_awarded INTEGER DEFAULT 10,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product_ids TEXT NOT NULL, -- JSON array of product id
  price INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ── Index performa: kolom yang sering dipakai di WHERE/JOIN/ORDER BY ──
-- (UNIQUE constraint di atas sudah otomatis bikin index sendiri, ini yang belum)
CREATE INDEX IF NOT EXISTS idx_products_reseller ON products(reseller_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_orders_reseller ON orders(reseller_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(buyer_contact);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews(is_approved);
CREATE INDEX IF NOT EXISTS idx_chats_room ON chats(room);
CREATE INDEX IF NOT EXISTS idx_panels_reseller ON panels(reseller_id);
CREATE INDEX IF NOT EXISTS idx_panels_username ON panels(panel_username);
CREATE INDEX IF NOT EXISTS idx_otp_orders_user ON otp_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_visitor_log_created ON visitor_log(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_activity_admin ON admin_activity_log(admin_id);

-- ══════════ Round 5: Keuangan (Dana/Event/Amal) ══════════
CREATE TABLE IF NOT EXISTS flash_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  reseller_id INTEGER REFERENCES resellers(id), -- NULL = dibuat owner (produk resmi)
  discount_percent INTEGER NOT NULL, -- 0-100
  starts_at INTEGER NOT NULL,  -- epoch ms
  ends_at INTEGER NOT NULL,    -- epoch ms
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER REFERENCES resellers(id), -- NULL = voucher resmi DigitalHub (dibuat owner)
  title TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent', -- percent | fixed
  discount_value INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id), -- NULL = berlaku semua produk resmi
  claim_limit INTEGER DEFAULT 0, -- 0 = tak terbatas
  claimed_count INTEGER DEFAULT 0,
  expires_at INTEGER,           -- epoch ms, NULL = tidak kedaluwarsa
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  claimed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT,
  UNIQUE(user_id, voucher_id)
);

CREATE TABLE IF NOT EXISTS daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_date TEXT NOT NULL, -- 'YYYY-MM-DD'
  points_awarded INTEGER DEFAULT 2,
  UNIQUE(user_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- transfer_in, transfer_out, topup, purchase, refund, giveaway
  amount INTEGER NOT NULL,
  counterparty TEXT,  -- username lawan transaksi (kalau transfer)
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Amal — DEMO SAJA sampai API Rumah Zakat asli dikonfigurasi di Config.
-- Tidak memotong saldo sungguhan, cuma catat "niat donasi" buat preview tampilan.
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  donor_name TEXT,
  campaign TEXT NOT NULL, -- 'sedekah' | 'santunan_anak' | 'bantuan_gaza' | dst
  amount INTEGER NOT NULL,
  is_demo INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id);
CREATE INDEX IF NOT EXISTS idx_flash_sales_active ON flash_sales(is_active);
CREATE INDEX IF NOT EXISTS idx_vouchers_active ON vouchers(is_active);
`);

// CATATAN: akun admin/Owner TIDAK di-seed di sini lagi — sistem admin (login,
// role Owner/Admin/Support Agent) sudah pindah ke Firestore sepenuhnya dan
// di-seed lewat src/db/firestoreSeed.js (dipanggil di server.js saat start).
// Tabel `admins` di SQLite di atas dibiarkan ada tapi TIDAK dipakai — supaya
// tidak ada 2 sumber kebenaran yang beda buat siapa saja yang bisa login admin.

// Seed default site settings
const defaultSettings = {
  site_name: process.env.SITE_NAME || 'DigitalHub',
  logo: '/media/logo.jpg',
  primary_color: '#6366f1',
  maintenance_enabled: '0',
  maintenance_message: 'Sedang maintenance, mohon tunggu sebentar.',
  maintenance_start: '',
  maintenance_end: '',
  maintenance_auto: '0', // 1 = otomatis nyala sesuai jadwal start/end

  // Payment gateway (nama bebas, mis. "Fr3newera")
  payment_gateway_name: '',
  payment_gateway_key: '',
  payment_gateway_secret: '',
  payment_gateway_mode: 'sandbox', // sandbox | live

  // Provider PPOB / OTP / Panel (bisa diisi lewat Admin Panel > Config)
  h2h_base_url: '', h2h_api_key: '', h2h_username: '',
  otp_base_url: '', otp_api_key: '',
  ptero_url: '', ptero_api_key: '',

  // Iklan CPC
  ads_enabled_global: '1',
  ads_meta_pixel_id: '',
  ads_points_per_click: '10',
  ads_rupiah_per_10_points: '100',

  // AI Assistant — 1 provider aktif saja (endpoint ATAU apikey), fallback ke Pollinations
  ai_endpoint: '',
  ai_api_key: '',
  ai_provider_name: '',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultSettings)) insertSetting.run(k, v);

// Seed contoh kata terfilter (admin bisa tambah/kurangi lewat panel admin)
const wordCount = db.prepare('SELECT COUNT(*) c FROM banned_words').get().c;
if (wordCount === 0) {
  const insWord = db.prepare('INSERT OR IGNORE INTO banned_words (word) VALUES (?)');
  ['anjing', 'bangsat', 'kontol', 'memek', 'goblok', 'tolol'].forEach(w => insWord.run(w));
}

// Seed default categories if empty
const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
if (catCount === 0) {
  const insCat = db.prepare('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)');
  const seedCats = [
    ['Panel Hosting', '🖥️', 1],
    ['OTP & PPOB', '📱', 2],
    ['Akun Premium', '⭐', 3],
    ['Jasa Digital', '🛠️', 4],
  ];
  seedCats.forEach(c => insCat.run(...c));
}

// Seed default panel plans if empty
const planCount = db.prepare('SELECT COUNT(*) c FROM panel_plans').get().c;
if (planCount === 0) {
  const insPlan = db.prepare('INSERT INTO panel_plans (name, ram_mb, disk_mb, cpu_pct, price, duration_days) VALUES (?,?,?,?,?,?)');
  insPlan.run('Panel 1GB', 1024, 2048, 50, 5000, 30);
  insPlan.run('Panel 2GB', 2048, 4096, 80, 9000, 30);
  insPlan.run('Panel 4GB', 4096, 8192, 100, 16000, 30);
  insPlan.run('Panel Unlimited', 0, 0, 200, 30000, 30);
}

module.exports = db;
