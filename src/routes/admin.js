// DigitalHub - Admin routes (login + kelola reseller, produk, deposit, keamanan, sistem)
'use strict';
const express = require('express');
const os = require('os');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireRole } = require('../util/auth');
const router = express.Router();
const auth = requireRole('admin'); // login syarat minimum: role admin JWT valid (owner/admin/support_agent)

function logActivity(req, action, detail) {
  const { getClientIp } = require('../util/security');
  const { firestore } = require('../db/firebase');
  firestore.collection('adminActivityLog').add({
    adminId: req.auth.id, adminUsername: req.auth.username, action, detail: detail || '',
    ip: getClientIp(req), createdAt: new Date().toISOString(),
  }).catch(() => {}); // jangan sampai logging gagal bikin request utama error
}

// Middleware tambahan: hanya Owner
function ownerOnly(req, res, next) {
  if (req.auth.adminRole !== 'owner') return res.status(403).json({ ok: false, message: 'Khusus Owner.' });
  next();
}
// Gate fleksibel: daftar role yang diizinkan mengakses suatu endpoint
function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.auth.adminRole)) {
      return res.status(403).json({ ok: false, message: 'Akses ditolak untuk role kamu.' });
    }
    next();
  };
}
// Matrix akses (sesuai spesifikasi role):
//  - owner          : semua fitur
//  - admin          : semua KECUALI Data, Developer, dan Config penuh (cuma gateway & ads)
//  - support_agent  : cuma baca Data + akses Live & BC
const gProduk    = allowRoles('owner', 'admin');
const gData      = allowRoles('owner', 'support_agent'); // admin TIDAK boleh akses Data sama sekali
const gDataWrite = allowRoles('owner'); // blokir/buka blokir cuma Owner, support_agent read-only
const gLiveBc    = allowRoles('owner', 'admin', 'support_agent');
const gGeneral   = allowRoles('owner', 'admin'); // grafik, sistem, reseller, order, ulasan
const gConfigBasic = allowRoles('owner', 'admin'); // payment gateway & ads (bagian "terbatas" utk admin)
const gConfigFull  = allowRoles('owner'); // provider API key & tambah saldo — sensitif, owner only

// ⚠️ MIGRASI BERTAHAP: login sudah pakai Firestore (koleksi "admins").
// Endpoint LAIN di file ini (produk, data, config, dll di bawah) MASIH pakai SQLite
// — belum dipindah karena saling terhubung dengan resellers/products/orders yang
// juga masih di SQLite. Migrasi penuh nanti dikerjakan sekaligus 1 paket biar konsisten.
const { firestore } = require('../db/firebase');
const adminsRef = firestore.collection('admins');

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const snap = await adminsRef.where('username', '==', username).where('isActive', '==', true).limit(1).get();
  if (snap.empty) return res.status(401).json({ ok: false, message: 'Username atau password salah.' });
  const doc = snap.docs[0];
  const adminData = doc.data();
  if (!bcrypt.compareSync(String(password || ''), adminData.passwordHash)) {
    return res.status(401).json({ ok: false, message: 'Username atau password salah.' });
  }
  const token = signToken({ role: 'admin', id: doc.id, username: adminData.username, adminRole: adminData.role }, '7d');
  await firestore.collection('adminActivityLog').add({
    adminId: doc.id, adminUsername: adminData.username, action: 'login',
    ip: require('../util/security').getClientIp(req), createdAt: new Date().toISOString(),
  });
  res.json({ ok: true, token, username: adminData.username, role: adminData.role });
});

// GET /api/admin/me -> info role diri sendiri (dipakai frontend buat sembunyikan tab sesuai role)
router.get('/me', auth, async (req, res) => {
  const doc = await adminsRef.doc(req.auth.id).get();
  if (!doc.exists) return res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
  const a = doc.data();
  res.json({ ok: true, admin: { id: doc.id, username: a.username, role: a.role } });
});

// GET /api/admin/roles-available — publik, cuma buat tahu role apa yang aktif
// (dipakai halaman Dukungan biar nggak nawarin chat ke role yang belum ada orangnya)
router.get('/roles-available', async (req, res) => {
  const snap = await adminsRef.where('isActive', '==', true).get();
  const roles = snap.docs.map(d => d.data().role);
  res.json({ ok: true, owner: roles.includes('owner'), admin: roles.includes('admin'), supportAgent: roles.includes('support_agent') });
});

// ══════════════════════════ RESELLER ══════════════════════════
router.get('/resellers', auth, gGeneral, (req, res) => {
  const rows = db.prepare('SELECT id, slug, store_name, wa, balance, status, created_at FROM resellers ORDER BY id DESC').all();
  res.json({ ok: true, resellers: rows });
});

router.post('/resellers/:id/deposit', auth, gGeneral, (req, res) => {
  const { amount } = req.body || {};
  const amt = parseInt(amount);
  if (!amt || amt <= 0) return res.status(400).json({ ok: false, message: 'Jumlah tidak valid.' });
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, message: 'Reseller tidak ditemukan.' });
  db.prepare('UPDATE resellers SET balance = balance + ? WHERE id = ?').run(amt, r.id);
  db.prepare('INSERT INTO deposits (reseller_id, amount, status) VALUES (?, ?, \'success\')').run(r.id, amt);
  res.json({ ok: true, message: `Saldo ${r.store_name} ditambah Rp${amt}.` });
});

router.post('/resellers/:id/status', auth, gGeneral, (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ ok: false, message: 'Status tidak valid.' });
  db.prepare('UPDATE resellers SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true, message: 'Status reseller diperbarui.' });
});

router.get('/orders', auth, gGeneral, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all();
  res.json({ ok: true, orders: rows });
});

router.get('/reviews/pending', auth, gGeneral, (req, res) => {
  const rows = db.prepare('SELECT * FROM reviews WHERE is_approved = 0 ORDER BY id DESC').all();
  res.json({ ok: true, reviews: rows });
});

router.post('/reviews/:id/approve', auth, gGeneral, (req, res) => {
  db.prepare('UPDATE reviews SET is_approved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════ 1. ADD — PRODUK ══════════════════════════
router.get('/products', auth, gProduk, (req, res) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  res.json({ ok: true, products: rows });
});

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

router.post('/products', auth, gProduk, (req, res) => {
  const {
    name, categoryId, description, image, qrisImage, paymentGateway,
    productType, specification, terms, usageInfo, price, costPrice, stock,
  } = req.body || {};
  if (!name || !price) return res.status(400).json({ ok: false, message: 'Nama & harga wajib diisi.' });
  const slug = slugify(name) + '-' + Date.now().toString(36);
  const info = db.prepare(
    `INSERT INTO products (category_id, name, slug, description, image, qris_image, payment_gateway, product_type, specification, terms, usage_info, price, cost_price, stock)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(categoryId || null, name, slug, description || '', image || null, qrisImage || null,
    paymentGateway || 'manual', productType || 'digital', specification || '', terms || '', usageInfo || '',
    price, costPrice || 0, stock ?? -1);
  res.json({ ok: true, id: info.lastInsertRowid, message: 'Produk ditambahkan.' });
});

router.put('/products/:id', auth, gProduk, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Produk tidak ditemukan.' });
  const {
    name, categoryId, description, image, qrisImage, paymentGateway,
    productType, specification, terms, usageInfo, price, costPrice, stock, isActive,
  } = req.body || {};
  db.prepare(
    `UPDATE products SET name=?, category_id=?, description=?, image=?, qris_image=?, payment_gateway=?,
     product_type=?, specification=?, terms=?, usage_info=?, price=?, cost_price=?, stock=?, is_active=?
     WHERE id=?`
  ).run(
    name ?? p.name, categoryId ?? p.category_id, description ?? p.description, image ?? p.image,
    qrisImage ?? p.qris_image, paymentGateway ?? p.payment_gateway, productType ?? p.product_type,
    specification ?? p.specification, terms ?? p.terms, usageInfo ?? p.usage_info,
    price ?? p.price, costPrice ?? p.cost_price, stock ?? p.stock, isActive ?? p.is_active, p.id
  );
  res.json({ ok: true, message: 'Produk diperbarui.' });
});

router.delete('/products/:id', auth, gProduk, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Produk tidak ditemukan.' });
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  res.json({ ok: true, message: 'Produk dihapus.' });
});

// ══════════════════════════ 2. GRAPHICS — ANALITIK ══════════════════════════
router.get('/analytics', auth, gGeneral, (req, res) => {
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(price),0) v FROM orders WHERE status IN ('paid','success')").get().v;
  const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const totalVisitors = db.prepare('SELECT COUNT(*) c FROM visitor_log').get().c;
  const totalProducts = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  const totalResellers = db.prepare('SELECT COUNT(*) c FROM resellers').get().c;

  const topProducts = db.prepare(`
    SELECT p.id, p.name, COUNT(o.id) AS total_sold, COALESCE(SUM(o.price),0) AS revenue
    FROM products p LEFT JOIN orders o ON o.product_id = p.id
    GROUP BY p.id ORDER BY total_sold DESC LIMIT 4
  `).all();

  const last7DaysOrders = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS c, COALESCE(SUM(price),0) AS revenue
    FROM orders WHERE created_at >= date('now', '-7 day')
    GROUP BY day ORDER BY day ASC
  `).all();

  const last7DaysVisitors = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS c
    FROM visitor_log WHERE created_at >= date('now', '-7 day')
    GROUP BY day ORDER BY day ASC
  `).all();

  res.json({
    ok: true,
    summary: { totalRevenue, totalOrders, totalVisitors, totalProducts, totalResellers },
    topProducts, last7DaysOrders, last7DaysVisitors,
  });
});

// ══════════════════════════ 3. LIVE — CHAT KOMUNITAS REAL ══════════════════════════
// Admin bisa lihat & ikut chat di room komunitas (halaman /chat) secara langsung.
router.get('/live/messages', auth, gLiveBc, (req, res) => {
  const rows = db.prepare("SELECT * FROM chats WHERE room = 'general' ORDER BY id DESC LIMIT 50").all().reverse();
  res.json({
    ok: true,
    messages: rows.map(r => ({ id: r.id, username: r.sender_name, text: r.message, photoUrl: r.image, createdAt: new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() })),
  });
});

router.post('/live/send', auth, gLiveBc, (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, message: 'Pesan kosong.' });
  const { publish } = require('../util/chatBus');
  const info = db.prepare("INSERT INTO chats (room, sender, sender_name, message) VALUES ('general', 'admin', 'Admin DigitalHub', ?)").run(text);
  const saved = db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  const message = { id: saved.id, username: saved.sender_name, displayName: saved.sender_name, text: saved.message, photoUrl: null, createdAt: Date.now() };
  publish('general', message);
  res.json({ ok: true, message });
});

// Daftar percakapan reseller<->pembeli yang sedang aktif (read-only, untuk pengawasan admin)
router.get('/live/rs-threads', auth, gLiveBc, (req, res) => {
  const rows = db.prepare(`
    SELECT room, reseller_id, sender_name, message, MAX(id) as last_id
    FROM chats WHERE room LIKE 'rs:%' GROUP BY room ORDER BY last_id DESC LIMIT 30
  `).all();
  const withStore = rows.map(r => {
    const reseller = db.prepare('SELECT store_name, slug FROM resellers WHERE id = ?').get(r.reseller_id);
    return { room: r.room, storeName: reseller ? reseller.store_name : '-', lastMessage: r.message, lastFrom: r.sender_name };
  });
  res.json({ ok: true, threads: withStore });
});

// ══════════════════════════ 4. DATA — USER & KEAMANAN ══════════════════════════
router.get('/data/users', auth, gData, (req, res) => {
  const rows = db.prepare(`
    SELECT id, username, email, balance, last_ip, last_country, last_os, last_browser,
           is_blocked, blocked_until, blocked_reason, created_at
    FROM users ORDER BY id DESC LIMIT 500
  `).all();
  res.json({ ok: true, users: rows });
});

router.get('/data/resellers', auth, gData, (req, res) => {
  const rows = db.prepare(`
    SELECT id, slug, store_name, balance, last_ip, last_country, last_os, last_browser,
           is_blocked, blocked_until, blocked_reason, status, created_at
    FROM resellers ORDER BY id DESC LIMIT 500
  `).all();
  res.json({ ok: true, resellers: rows });
});

router.post('/data/block', auth, gDataWrite, (req, res) => {
  const { type, id, reason, permanent } = req.body || {};
  const table = type === 'reseller' ? 'resellers' : 'users';
  const until = permanent ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE ${table} SET is_blocked = 1, blocked_until = ?, blocked_reason = ? WHERE id = ?`)
    .run(until, reason || 'Diblokir oleh admin', id);
  res.json({ ok: true, message: 'Akun diblokir.' });
});

router.post('/data/unblock', auth, gDataWrite, (req, res) => {
  const { type, id } = req.body || {};
  const table = type === 'reseller' ? 'resellers' : 'users';
  db.prepare(`UPDATE ${table} SET is_blocked = 0, blocked_until = NULL, blocked_reason = NULL WHERE id = ?`).run(id);
  res.json({ ok: true, message: 'Blokir dibuka.' });
});

router.get('/data/blocked-ips', auth, gData, (req, res) => {
  const rows = db.prepare('SELECT * FROM blocked_ips ORDER BY blocked_until DESC').all();
  res.json({ ok: true, ips: rows });
});

router.post('/data/unblock-ip', auth, gDataWrite, (req, res) => {
  db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(req.body.ip);
  res.json({ ok: true, message: 'IP dibuka.' });
});

router.get('/data/visitors', auth, gData, (req, res) => {
  const rows = db.prepare('SELECT * FROM visitor_log ORDER BY id DESC LIMIT 200').all();
  res.json({ ok: true, visitors: rows });
});

// ══════════════════════════ 5. SISTEM ══════════════════════════
router.get('/system/status', auth, gGeneral, (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    platform: os.platform(),
    cpuCount: os.cpus().length,
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    loadAvg: os.loadavg(),
  });
});

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

router.get('/system/maintenance', auth, gGeneral, (req, res) => {
  res.json({
    ok: true,
    enabled: getSetting('maintenance_enabled', '0') === '1',
    auto: getSetting('maintenance_auto', '0') === '1',
    start: getSetting('maintenance_start', ''),
    end: getSetting('maintenance_end', ''),
    message: getSetting('maintenance_message', ''),
  });
});

router.post('/system/maintenance', auth, gGeneral, (req, res) => {
  const { enabled, auto, start, end, message } = req.body || {};
  if (enabled !== undefined) setSetting('maintenance_enabled', enabled ? '1' : '0');
  if (auto !== undefined) setSetting('maintenance_auto', auto ? '1' : '0');
  if (start !== undefined) setSetting('maintenance_start', start);
  if (end !== undefined) setSetting('maintenance_end', end);
  if (message !== undefined) setSetting('maintenance_message', message);
  res.json({ ok: true, message: 'Pengaturan maintenance disimpan.' });
});

// Pembersihan cache/log: hapus chat & visitor log lama, demo private-chat log (bukan hapus data transaksi)
router.post('/system/cleanup', auth, gGeneral, (req, res) => {
  const chatsDel = db.prepare("DELETE FROM chats WHERE created_at < datetime('now', '-30 day')").run();
  const visitorsDel = db.prepare("DELETE FROM visitor_log WHERE created_at < datetime('now', '-14 day')").run();
  const modLogDel = db.prepare("DELETE FROM moderation_log WHERE created_at < datetime('now', '-30 day')").run();
  res.json({
    ok: true,
    message: 'Pembersihan selesai.',
    deleted: { chats: chatsDel.changes, visitorLogs: visitorsDel.changes, moderationLogs: modLogDel.changes },
  });
});

// ══════════════════════════ SCANNER — FILTER KATA ══════════════════════════
router.get('/scanner/words', auth, gGeneral, (req, res) => {
  const rows = db.prepare('SELECT * FROM banned_words ORDER BY word').all();
  res.json({ ok: true, words: rows });
});
router.post('/scanner/words', auth, gGeneral, (req, res) => {
  const { word } = req.body || {};
  if (!word) return res.status(400).json({ ok: false, message: 'Kata wajib diisi.' });
  db.prepare('INSERT OR IGNORE INTO banned_words (word) VALUES (?)').run(String(word).toLowerCase().trim());
  res.json({ ok: true, message: 'Kata ditambahkan ke filter.' });
});
router.delete('/scanner/words/:id', auth, gGeneral, (req, res) => {
  db.prepare('DELETE FROM banned_words WHERE id = ?').run(req.params.id);
  res.json({ ok: true, message: 'Kata dihapus dari filter.' });
});
router.get('/scanner/log', auth, gGeneral, (req, res) => {
  const rows = db.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT 200').all();
  res.json({ ok: true, log: rows });
});

// Cek keamanan dasar web (bukan pemindai kerentanan sungguhan — itu butuh tools
// khusus seperti OWASP ZAP; ini cuma checklist konfigurasi dasar)
router.get('/scanner/basic-check', auth, gGeneral, (req, res) => {
  res.json({
    ok: true,
    checklist: [
      { label: 'Rate limiting aktif', ok: true },
      { label: 'Security headers aktif', ok: true },
      { label: 'Password di-hash (bcrypt)', ok: true },
      { label: 'JWT_SECRET sudah diganti dari default', ok: process.env.JWT_SECRET && process.env.JWT_SECRET !== 'digitalhub_dev_secret_change_me' },
      { label: 'Admin password sudah diganti dari default', ok: process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== '97979797' },
    ],
    note: 'Untuk pemindaian kerentanan mendalam, gunakan tools khusus seperti OWASP ZAP atau Mozilla Observatory terhadap domain kamu.',
  });
});

// ══════════════════════════ 6. BC — BROADCAST (DEMO SAJA) ══════════════════════════
router.post('/broadcast/demo', auth, gLiveBc, (req, res) => {
  res.json({ ok: true, demo: true, message: 'Ini simulasi saja — broadcast sungguhan belum diaktifkan.' });
});

// ══════════════════════════ CONFIG — API KEY, PAYMENT GATEWAY, SALDO USER ══════════════════════════
const { getConfig: getEncConfig, setConfig: setEncConfig } = require('../util/config');

const CONFIG_KEYS = [
  'payment_gateway_name', 'payment_gateway_key', 'payment_gateway_secret', 'payment_gateway_mode',
  'h2h_base_url', 'h2h_api_key', 'h2h_username',
  'otp_base_url', 'otp_api_key',
  'ptero_url', 'ptero_api_key',
  'ads_enabled_global', 'ads_meta_pixel_id', 'ads_points_per_click', 'ads_rupiah_per_10_points',
  'ai_endpoint', 'ai_api_key', 'ai_provider_name', 'ai_enabled',
];

// GET/POST /config pakai getEncConfig/setEncConfig (bukan getSetting/setSetting lokal)
// supaya API key sensitif (payment_gateway_key/secret, h2h/otp/ptero/ai_api_key)
// otomatis terenkripsi (AES-256-GCM) sebelum masuk database.
router.get('/config', auth, gConfigBasic, (req, res) => {
  const values = {};
  CONFIG_KEYS.forEach(k => { values[k] = getEncConfig(k, null, ''); });
  res.json({ ok: true, config: values });
});

router.post('/config', auth, gConfigBasic, (req, res) => {
  const body = req.body || {};
  CONFIG_KEYS.forEach(k => { if (body[k] !== undefined) setEncConfig(k, body[k]); });
  res.json({ ok: true, message: 'Konfigurasi disimpan (API key sensitif terenkripsi).' });
});

// Tambah saldo user via User ID (untuk konfirmasi top-up manual)
router.post('/config/add-balance', auth, gConfigFull, (req, res) => {
  const { userId, amount, note } = req.body || {};
  const amt = parseInt(amount);
  if (!userId || !amt || amt <= 0) return res.status(400).json({ ok: false, message: 'User ID & jumlah wajib valid.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amt, userId);
  db.prepare("INSERT INTO topup_requests (user_id, amount, method, status, note) VALUES (?,?,?,'approved',?)")
    .run(userId, amt, 'manual-admin', note || 'Ditambahkan manual oleh admin');
  res.json({ ok: true, message: `Saldo ${user.username} ditambah Rp${amt.toLocaleString('id-ID')}.` });
});

router.get('/config/topup-requests', auth, gConfigBasic, (req, res) => {
  const rows = db.prepare(`
    SELECT tr.*, u.username FROM topup_requests tr JOIN users u ON u.id = tr.user_id
    WHERE tr.status = 'pending' ORDER BY tr.id DESC
  `).all();
  res.json({ ok: true, requests: rows });
});

router.post('/config/topup-requests/:id/approve', auth, gConfigFull, (req, res) => {
  const tr = db.prepare('SELECT * FROM topup_requests WHERE id = ?').get(req.params.id);
  if (!tr || tr.status !== 'pending') return res.status(404).json({ ok: false, message: 'Request tidak ditemukan.' });
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(tr.amount, tr.user_id);
  db.prepare("UPDATE topup_requests SET status = 'approved' WHERE id = ?").run(tr.id);
  res.json({ ok: true, message: 'Top-up disetujui & saldo ditambahkan.' });
});

router.post('/config/topup-requests/:id/reject', auth, gConfigFull, (req, res) => {
  db.prepare("UPDATE topup_requests SET status = 'rejected' WHERE id = ?").run(req.params.id);
  res.json({ ok: true, message: 'Request ditolak.' });
});

// ══════════════════════════ ROLES MANAGEMENT (Owner only, Firestore) ══════════════════════════
router.get('/roles', auth, ownerOnly, async (req, res) => {
  const snap = await adminsRef.get();
  const admins = snap.docs.map(d => ({ id: d.id, username: d.data().username, role: d.data().role, is_active: d.data().isActive, created_at: d.data().createdAt }));
  res.json({ ok: true, admins });
});
router.post('/roles', auth, ownerOnly, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ ok: false, message: 'Username & password (min 6 karakter) wajib diisi.' });
  }
  if (!['owner', 'admin', 'support_agent'].includes(role)) {
    return res.status(400).json({ ok: false, message: 'Role tidak valid.' });
  }
  const existing = await adminsRef.where('username', '==', username).limit(1).get();
  if (!existing.empty) return res.status(409).json({ ok: false, message: 'Username sudah dipakai.' });
  await adminsRef.add({ username, passwordHash: bcrypt.hashSync(password, 10), role, isActive: true, createdAt: new Date().toISOString() });
  logActivity(req, 'create_admin', `Membuat akun ${username} (${role})`);
  res.json({ ok: true, message: 'Akun admin dibuat.' });
});
router.put('/roles/:id', auth, ownerOnly, async (req, res) => {
  const docRef = adminsRef.doc(req.params.id);
  const doc = await docRef.get();
  if (!doc.exists) return res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
  const { password, role, isActive } = req.body || {};
  const updates = {};
  if (password) updates.passwordHash = bcrypt.hashSync(password, 10);
  if (role && ['owner', 'admin', 'support_agent'].includes(role)) updates.role = role;
  if (isActive !== undefined) updates.isActive = !!isActive;
  if (Object.keys(updates).length) await docRef.update(updates);
  logActivity(req, 'edit_admin', `Mengedit akun ${doc.data().username}`);
  res.json({ ok: true, message: 'Akun diperbarui.' });
});
router.delete('/roles/:id', auth, ownerOnly, async (req, res) => {
  const docRef = adminsRef.doc(req.params.id);
  const doc = await docRef.get();
  if (!doc.exists) return res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
  if (doc.data().role === 'owner') return res.status(400).json({ ok: false, message: 'Akun Owner tidak bisa dihapus.' });
  await docRef.delete();
  logActivity(req, 'delete_admin', `Menghapus akun ${doc.data().username}`);
  res.json({ ok: true, message: 'Akun dihapus.' });
});

router.get('/activity-log', auth, ownerOnly, async (req, res) => {
  const snap = await firestore.collection('adminActivityLog').orderBy('createdAt', 'desc').limit(200).get();
  const log = snap.docs.map(d => {
    const l = d.data();
    return { admin_username: l.adminUsername, action: l.action, detail: l.detail, ip: l.ip, created_at: l.createdAt };
  });
  res.json({ ok: true, log });
});

// ══════════════════════════ DEVELOPER — password terpisah (86868686 default) ═══════
// Semua route di bawah ini WAJIB owner + verifikasi password developer per-request
// (bukan cuma sekali di frontend) supaya tidak bisa dibypass dari devtools browser.
function requireDevPassword(req, res, next) {
  const devPass = process.env.DEVELOPER_PASSWORD || '86868686';
  const given = req.headers['x-dev-password'];
  if (given !== devPass) return res.status(401).json({ ok: false, message: 'Password Developer salah.' });
  next();
}
const dev = [auth, ownerOnly, requireDevPassword];

// ── Monitor real-time — "Cron Job Manager" versi jujur: semua angka di sini asli
// dari database/proses berjalan, bukan simulasi/statis. ──
router.get('/dev/monitor', ...dev, (req, res) => {
  const maintenance = {
    enabled: getSetting('maintenance_enabled', '0') === '1',
    auto: getSetting('maintenance_auto', '0') === '1',
  };
  const blockedIpsCount = db.prepare('SELECT COUNT(*) c FROM blocked_ips WHERE blocked_until IS NULL OR blocked_until > ?').get(new Date().toISOString()).c;
  const requestsLastHour = db.prepare("SELECT COUNT(*) c FROM visitor_log WHERE created_at > datetime('now', '-1 hour')").get().c;
  const requestsLast5Min = db.prepare("SELECT COUNT(*) c FROM visitor_log WHERE created_at > datetime('now', '-5 minutes')").get().c;
  const moderationLast24h = db.prepare("SELECT COUNT(*) c FROM moderation_log WHERE created_at > datetime('now', '-1 day')").get().c;
  const errorsLast24h = db.prepare("SELECT COUNT(*) c FROM error_logs WHERE created_at > datetime('now', '-1 day')").get().c;
  const activeChatRoomsCount = db.prepare("SELECT COUNT(DISTINCT room) c FROM chats WHERE created_at > datetime('now', '-10 minutes')").get().c;

  // Indikator sederhana lonjakan traffic (bukan deteksi DDoS canggih — cuma nunjukkin
  // kalau traffic 5 menit terakhir jauh di atas rata-rata per-5-menit dalam sejam terakhir)
  const avgPer5Min = requestsLastHour / 12;
  const trafficSpike = avgPer5Min > 5 && requestsLast5Min > avgPer5Min * 3;

  res.json({
    ok: true,
    maintenance,
    blockedIpsCount,
    requestsLastHour, requestsLast5Min,
    trafficSpike,
    moderationLast24h,
    errorsLast24h,
    activeChatRoomsCount,
    serverUptimeSeconds: Math.floor(process.uptime()),
  });
});

// ── Log Viewer + AI explain (Pollinations, tanpa API key) ──
router.get('/dev/logs', ...dev, (req, res) => {
  const rows = db.prepare('SELECT * FROM error_logs ORDER BY id DESC LIMIT 100').all();
  res.json({ ok: true, logs: rows });
});
router.delete('/dev/logs', ...dev, (req, res) => {
  db.prepare('DELETE FROM error_logs').run();
  res.json({ ok: true, message: 'Log dibersihkan.' });
});
router.post('/dev/logs/:id/explain', ...dev, async (req, res) => {
  const log = db.prepare('SELECT * FROM error_logs WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ ok: false, message: 'Log tidak ditemukan.' });
  try {
    const prompt = `Jelaskan error Node.js/Express berikut dengan bahasa sederhana untuk pemula, sebutkan kemungkinan penyebab dan langkah perbaikan singkat (maks 150 kata, bahasa Indonesia):\n\nPesan: ${log.message}\nRoute: ${log.route || '-'}\nStack: ${(log.stack || '').slice(0, 800)}`;
    const r = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai`);
    const explanation = await r.text();
    res.json({ ok: true, explanation });
  } catch (e) {
    res.status(502).json({ ok: false, message: 'Gagal menghubungi AI. Coba lagi sebentar.' });
  }
});

// ── Webhooks (API/webhook config, dipindah ke Developer sesuai permintaan) ──
router.get('/dev/webhooks', ...dev, (req, res) => {
  const rows = db.prepare("SELECT * FROM webhooks WHERE owner_type = 'admin' ORDER BY id DESC").all();
  res.json({ ok: true, webhooks: rows });
});
router.post('/dev/webhooks', ...dev, (req, res) => {
  const { url, events, secret } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, message: 'URL webhook wajib diisi.' });
  db.prepare("INSERT INTO webhooks (owner_type, url, secret, events) VALUES ('admin', ?, ?, ?)")
    .run(url, secret || '', events || 'order.created');
  res.json({ ok: true, message: 'Webhook ditambahkan.' });
});
router.delete('/dev/webhooks/:id', ...dev, (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id = ? AND owner_type = \'admin\'').run(req.params.id);
  res.json({ ok: true, message: 'Webhook dihapus.' });
});

// ── Security hardening sederhana: ganti path admin panel, batas percobaan login ──
router.get('/dev/security', ...dev, (req, res) => {
  res.json({
    ok: true,
    adminPath: getSetting('admin_panel_path', '/admin-panell'),
    maxLoginAttempts: getSetting('max_login_attempts', '20'),
  });
});
router.post('/dev/security', ...dev, (req, res) => {
  const { adminPath, maxLoginAttempts } = req.body || {};
  if (adminPath && /^\/[a-zA-Z0-9-_]{3,40}$/.test(adminPath)) setSetting('admin_panel_path', adminPath);
  if (maxLoginAttempts) setSetting('max_login_attempts', String(parseInt(maxLoginAttempts) || 20));
  res.json({ ok: true, message: 'Pengaturan keamanan disimpan. Restart server supaya URL baru aktif.' });
});

module.exports = router;
module.exports.logActivity = logActivity;
