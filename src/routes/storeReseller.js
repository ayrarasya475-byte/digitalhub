// DigitalHub - Reseller store routes
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireRole } = require('../util/auth');
const { recordClientMeta, isCurrentlyBlocked } = require('../util/security');

const router = express.Router();
const auth = requireRole('reseller');

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function publicReseller(r) {
  if (!r) return null;
  return {
    id: r.id, slug: r.slug, storeName: r.store_name, wa: r.wa,
    logo: r.logo, color: r.color, balance: r.balance, status: r.status,
    createdAt: r.created_at,
  };
}

// GET /api/store-reseller/check-slug?slug=
router.get('/check-slug', (req, res) => {
  const slug = slugify(req.query.slug);
  if (!slug) return res.json({ ok: true, available: false });
  const existing = db.prepare('SELECT id FROM resellers WHERE slug = ?').get(slug);
  res.json({ ok: true, available: !existing, slug });
});

// POST /api/store-reseller/register  { storeName, password, wa }
router.post('/register', (req, res) => {
  const { storeName, password, wa } = req.body || {};
  if (!storeName || String(storeName).trim().length < 3) {
    return res.status(400).json({ ok: false, message: 'Nama toko minimal 3 karakter.' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ ok: false, message: 'Password minimal 6 karakter.' });
  }
  const slug = slugify(storeName);
  if (!slug) return res.status(400).json({ ok: false, message: 'Nama toko tidak valid.' });

  const existing = db.prepare('SELECT id FROM resellers WHERE slug = ?').get(slug);
  if (existing) return res.status(409).json({ ok: false, message: 'Nama toko sudah dipakai, coba nama lain.' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(
    'INSERT INTO resellers (slug, store_name, wa, password_hash) VALUES (?, ?, ?, ?)'
  ).run(slug, String(storeName).trim(), wa || null, hash);

  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken({ role: 'reseller', id: reseller.id, slug: reseller.slug });
  res.json({ ok: true, token, slug: reseller.slug, storeName: reseller.store_name });
});

// POST /api/store-reseller/login  { slug, password }
router.post('/login', (req, res) => {
  const { slug, password } = req.body || {};
  const clean = slugify(slug);
  const reseller = db.prepare('SELECT * FROM resellers WHERE slug = ?').get(clean);
  if (!reseller || !bcrypt.compareSync(String(password || ''), reseller.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Slug atau password salah.' });
  }
  if (reseller.status !== 'active') {
    return res.status(403).json({ ok: false, message: 'Toko kamu sedang tidak aktif. Hubungi admin.' });
  }
  if (isCurrentlyBlocked(reseller)) {
    return res.status(403).json({ ok: false, message: `Akun diblokir${reseller.blocked_reason ? ': ' + reseller.blocked_reason : '.'}` });
  }
  recordClientMeta('resellers', reseller.id, req);
  const token = signToken({ role: 'reseller', id: reseller.id, slug: reseller.slug });
  res.json({ ok: true, token, slug: reseller.slug, storeName: reseller.store_name });
});

// GET /api/store-reseller/me
router.get('/me', auth, (req, res) => {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.id);
  if (!reseller) return res.status(404).json({ ok: false, message: 'Toko tidak ditemukan.' });
  res.json({ ok: true, reseller: publicReseller(reseller) });
});

// POST /api/store-reseller/change-password { oldPassword, newPassword }
router.post('/change-password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.id);
  if (!reseller || !bcrypt.compareSync(String(oldPassword || ''), reseller.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Password lama salah.' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ ok: false, message: 'Password baru minimal 6 karakter.' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE resellers SET password_hash = ? WHERE id = ?').run(hash, reseller.id);
  res.json({ ok: true, message: 'Password berhasil diganti.' });
});

// GET/POST /api/store-reseller/settings  (logo, color, wa)
router.get('/settings', auth, (req, res) => {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.id);
  res.json({ ok: true, settings: publicReseller(reseller) });
});
router.post('/settings', auth, (req, res) => {
  const { logo, color, wa, storeName } = req.body || {};
  const fields = [], vals = [];
  if (logo !== undefined) { fields.push('logo = ?'); vals.push(logo); }
  if (color !== undefined) { fields.push('color = ?'); vals.push(color); }
  if (wa !== undefined) { fields.push('wa = ?'); vals.push(wa); }
  if (storeName !== undefined && String(storeName).trim().length >= 3) {
    fields.push('store_name = ?'); vals.push(String(storeName).trim());
  }
  if (!fields.length) return res.json({ ok: true, message: 'Tidak ada perubahan.' });
  vals.push(req.auth.id);
  db.prepare(`UPDATE resellers SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true, message: 'Pengaturan toko disimpan.' });
});

// GET /api/store-reseller/banners
router.get('/banners', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reseller_banners WHERE reseller_id = ? ORDER BY sort_order').all(req.auth.id);
  res.json({ ok: true, banners: rows });
});
router.post('/banners', auth, (req, res) => {
  const { image, link } = req.body || {};
  if (!image) return res.status(400).json({ ok: false, message: 'Gambar wajib diisi.' });
  db.prepare('INSERT INTO reseller_banners (reseller_id, image, link) VALUES (?, ?, ?)').run(req.auth.id, image, link || null);
  res.json({ ok: true, message: 'Banner ditambahkan.' });
});

// GET /api/store-reseller/own-products
router.get('/own-products', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE reseller_id = ? ORDER BY id DESC').all(req.auth.id);
  res.json({ ok: true, products: rows });
});

// POST /api/store-reseller/own-products  create/update product
router.post('/own-products', auth, (req, res) => {
  const { name, description, image, price, stock, categoryId } = req.body || {};
  if (!name || !price) return res.status(400).json({ ok: false, message: 'Nama & harga wajib diisi.' });
  const slug = slugify(name) + '-' + Date.now().toString(36);
  const info = db.prepare(
    `INSERT INTO products (reseller_id, category_id, name, slug, description, image, price, stock)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.auth.id, categoryId || null, name, slug, description || '', image || null, price, stock ?? -1);
  res.json({ ok: true, id: info.lastInsertRowid, message: 'Produk ditambahkan.' });
});

router.delete('/own-products/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Produk tidak ditemukan.' });
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  res.json({ ok: true, message: 'Produk dihapus.' });
});

// GET /api/store-reseller/own-orders
router.get('/own-orders', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE reseller_id = ? ORDER BY id DESC LIMIT 200').all(req.auth.id);
  res.json({ ok: true, orders: rows });
});

// GET /api/store-reseller/chats -> daftar thread chat dari pembeli (dikelompokkan per buyerId)
router.get('/chats', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT room, sender, sender_name, message, id
    FROM chats WHERE reseller_id = ? AND room LIKE ?
    ORDER BY id DESC
  `).all(req.auth.id, `rs:${req.auth.slug}:%`);

  const threads = new Map();
  for (const r of rows) {
    const buyerId = r.room.split(':').slice(2).join(':');
    if (threads.has(buyerId)) continue; // baris pertama yang ditemui = pesan terakhir (sudah ORDER BY id DESC)
    threads.set(buyerId, {
      buyerId,
      buyerName: r.sender === 'buyer' ? r.sender_name : null,
      lastFrom: r.sender,
      lastText: r.message,
      unread: db.prepare("SELECT COUNT(*) c FROM chats WHERE room = ? AND sender = 'buyer' AND id > COALESCE((SELECT MAX(id) FROM chats WHERE room = ? AND sender = 'seller'), 0)").get(r.room, r.room).c,
    });
  }
  res.json({ ok: true, data: Array.from(threads.values()) });
});
router.post('/chats', auth, (req, res) => {
  const { buyerId, message } = req.body || {};
  if (!buyerId || !message) return res.status(400).json({ ok: false, message: 'Pesan kosong.' });
  const room = `rs:${req.auth.slug}:${buyerId}`;
  db.prepare('INSERT INTO chats (reseller_id, room, sender, sender_name, message) VALUES (?,?,?,?,?)')
    .run(req.auth.id, room, 'seller', req.auth.slug, message);
  res.json({ ok: true });
});

// ══════════ Tiket Diskon (voucher milik toko sendiri) ══════════
router.get('/own-tickets', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM vouchers WHERE reseller_id = ? ORDER BY id DESC').all(req.auth.id);
  res.json({ ok: true, tickets: rows });
});
router.post('/own-tickets', auth, (req, res) => {
  const { title, discountType, discountValue, productId, claimLimit, expiresAt } = req.body || {};
  if (!title || !discountValue) return res.status(400).json({ ok: false, message: 'Judul & nilai diskon wajib diisi.' });
  // Pastikan produk (kalau dipilih) memang punya toko ini, biar nggak bisa bikin tiket buat produk toko lain
  if (productId) {
    const p = db.prepare('SELECT id FROM products WHERE id = ? AND reseller_id = ?').get(productId, req.auth.id);
    if (!p) return res.status(403).json({ ok: false, message: 'Produk itu bukan milik toko kamu.' });
  }
  db.prepare(
    `INSERT INTO vouchers (reseller_id, title, discount_type, discount_value, product_id, claim_limit, expires_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(req.auth.id, title, discountType === 'fixed' ? 'fixed' : 'percent', parseInt(discountValue), productId || null, parseInt(claimLimit) || 0, expiresAt || null);
  res.json({ ok: true, message: 'Tiket diskon dibuat.' });
});
router.delete('/own-tickets/:id', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!v) return res.status(404).json({ ok: false, message: 'Tiket tidak ditemukan.' });
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(v.id);
  res.json({ ok: true, message: 'Tiket dihapus.' });
});

// ══════════ Flash Sale milik toko sendiri ══════════
router.get('/own-flash-sales', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT fs.*, p.name AS product_name FROM flash_sales fs JOIN products p ON p.id = fs.product_id
    WHERE fs.reseller_id = ? ORDER BY fs.id DESC
  `).all(req.auth.id);
  res.json({ ok: true, flashSales: rows });
});
router.post('/own-flash-sales', auth, (req, res) => {
  const { productId, discountPercent, startsAt, endsAt } = req.body || {};
  if (!productId || !discountPercent || !endsAt) return res.status(400).json({ ok: false, message: 'Produk, diskon, & waktu selesai wajib diisi.' });
  const p = db.prepare('SELECT id FROM products WHERE id = ? AND reseller_id = ?').get(productId, req.auth.id);
  if (!p) return res.status(403).json({ ok: false, message: 'Produk itu bukan milik toko kamu.' });
  db.prepare('INSERT INTO flash_sales (product_id, reseller_id, discount_percent, starts_at, ends_at) VALUES (?,?,?,?,?)')
    .run(productId, req.auth.id, Math.min(90, parseInt(discountPercent)), startsAt || Date.now(), parseInt(endsAt));
  res.json({ ok: true, message: 'Flash sale dibuat.' });
});
router.delete('/own-flash-sales/:id', auth, (req, res) => {
  const fs = db.prepare('SELECT * FROM flash_sales WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!fs) return res.status(404).json({ ok: false, message: 'Flash sale tidak ditemukan.' });
  db.prepare('DELETE FROM flash_sales WHERE id = ?').run(fs.id);
  res.json({ ok: true, message: 'Flash sale dihapus.' });
});

module.exports = router;
