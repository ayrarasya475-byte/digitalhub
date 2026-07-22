// DigitalHub - Public routes (no auth): store-info, products, categories, slides, reviews
'use strict';
const express = require('express');
const db = require('../db');
const router = express.Router();

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

// GET /api/store-info  -> info toko/global (dipakai berbagai halaman utk logo+warna)
router.get('/store-info', (req, res) => {
  const slug = req.query.slug;
  if (slug) {
    const reseller = db.prepare('SELECT * FROM resellers WHERE slug = ?').get(slug);
    if (reseller) {
      return res.json({
        ok: true, isStore: true, slug: reseller.slug, storeName: reseller.store_name,
        logo: reseller.logo || getSetting('logo', '/media/logo.jpg'),
        color: reseller.color || getSetting('primary_color', '#34d399'),
        wa: reseller.wa,
      });
    }
  }
  res.json({
    ok: true, isStore: false,
    storeName: getSetting('site_name', 'DigitalHub'),
    logo: getSetting('logo', '/media/logo.jpg'),
    color: getSetting('primary_color', '#34d399'),
  });
});

// GET /api/categories
router.get('/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
  const data = rows.map(c => c.name);
  res.json({ ok: true, data, categories: rows });
});

// GET /api/products?category=&reseller=&q=  -> { ok, data: [...], store, wa, settings }
router.get('/products', (req, res) => {
  const { category, reseller, q } = req.query;
  let sql = 'SELECT p.*, c.name AS category_name, r.slug AS reseller_slug, r.store_name AS reseller_name FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN resellers r ON r.id = p.reseller_id WHERE p.is_active = 1';
  const params = [];
  if (category) { sql += ' AND (c.name = ? OR p.category_id = ?)'; params.push(category, category); }
  if (reseller) { sql += ' AND r.slug = ?'; params.push(reseller); }
  if (q) { sql += ' AND p.name LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY p.sort_order, p.id DESC LIMIT 300';
  const rows = db.prepare(sql).all(...params);

  const variantStmt = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, id');
  const data = rows.map(p => {
    const variantRows = variantStmt.all(p.id);
    const variants = variantRows.length
      ? variantRows.map(v => ({ id: v.id, name: v.name, price: v.price, stock: v.stock }))
      : [{ id: `${p.id}-default`, name: p.name, price: p.price, stock: p.stock }];
    return {
      id: p.id, name: p.name, description: p.description, thumbnail: p.image || '',
      category: p.category_name || 'Digital', type: p.product_type || 'digital',
      active: !!p.is_active, isNew: (Date.now() - toEpoch(p.created_at)) < 3 * 86400000,
      resellerSlug: p.reseller_slug || null, resellerName: p.reseller_name || null,
      qrisImage: p.qris_image || null, paymentGateway: p.payment_gateway || 'manual',
      specification: p.specification || '', terms: p.terms || '', usageInfo: p.usage_info || '',
      variants,
    };
  });

  let storeName = getSetting('site_name', 'DigitalHub');
  let wa = null;
  if (reseller) {
    const r = db.prepare('SELECT * FROM resellers WHERE slug = ?').get(reseller);
    if (r) { storeName = r.store_name; wa = r.wa ? `https://wa.me/${r.wa.replace(/\D/g, '')}` : null; }
  }

  res.json({
    ok: true, data, products: data, // "products" disertakan juga untuk kompatibilitas halaman lain
    store: storeName, wa,
    settings: {
      maintenanceMode: getSetting('maintenance_enabled', '0') === '1',
      maintenanceMsg: getSetting('maintenance_message', ''),
      channelWa: getSetting('channel_wa', ''),
      faq: [],
    },
  });
});

// GET /api/premku/products -> stub kompatibilitas (kategori "Premium" opsional, kosong dulu)
router.get('/premku/products', (req, res) => res.json({ ok: true, data: [] }));

// GET /api/slides
router.get('/slides', (req, res) => {
  const rows = db.prepare('SELECT * FROM slides ORDER BY sort_order, id').all();
  res.json({ ok: true, slides: rows });
});

// GET /api/ad -> single promo ad banner (dummy config, bisa diisi lewat admin nanti)
router.get('/ad', (req, res) => {
  const ad = getSetting('ad_banner', '');
  res.json({ ok: true, ad: ad ? JSON.parse(ad) : null });
});

// GET /api/panel-plans
router.get('/panel-plans', (req, res) => {
  const rows = db.prepare('SELECT * FROM panel_plans WHERE is_active = 1 ORDER BY price').all();
  res.json({ ok: true, plans: rows });
});

function toEpoch(sqliteTs) {
  return new Date(sqliteTs.replace(' ', 'T') + 'Z').getTime();
}
function reviewToJson(r) {
  return {
    id: r.id, username: r.username || r.name, displayName: r.name, star: r.rating,
    text: r.comment || '', photoUrl: r.image || null, helpful: r.helpful || 0,
    createdAt: toEpoch(r.created_at),
  };
}

// GET /api/reviews?page=1&sort=newest&star=0  -> { ok, reviews, page, pages, total }
router.get('/reviews', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 20;
  const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
  let sql = 'SELECT r.*, u.username AS username FROM reviews r LEFT JOIN users u ON u.id = r.user_id WHERE r.is_approved = 1';
  const params = [];
  if (req.query.star && parseInt(req.query.star) > 0) { sql += ' AND r.rating = ?'; params.push(parseInt(req.query.star)); }
  sql += ` ORDER BY r.id ${sort} LIMIT ? OFFSET ?`;
  params.push(perPage, (page - 1) * perPage);
  const rows = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) c FROM reviews WHERE is_approved = 1').get().c;
  res.json({ ok: true, reviews: rows.map(reviewToJson), page, pages: Math.max(1, Math.ceil(total / perPage)), total });
});

// POST /api/reviews  (header x-api-key) { star, displayName, text, photoUrl }
router.post('/reviews', (req, res) => {
  const apikey = req.headers['x-api-key'];
  const user = apikey ? db.prepare('SELECT * FROM users WHERE apikey = ?').get(apikey) : null;
  if (!user) return res.status(401).json({ ok: false, message: 'Silakan login untuk menulis ulasan.' });

  const { star, displayName, text, photoUrl } = req.body || {};
  if (!star) return res.status(400).json({ ok: false, message: 'Rating wajib diisi.' });

  const { getClientIp, containsBannedWord, blockIp24h, isIpBlocked } = require('../util/security');
  const ip = getClientIp(req);
  if (isIpBlocked(ip)) return res.status(403).json({ ok: false, message: 'Kamu diblokir sementara. Coba lagi 24 jam ke depan.' });

  const hit = containsBannedWord(text);
  if (hit) {
    blockIp24h(ip, `Kata terfilter: ${hit}`);
    db.prepare('INSERT INTO moderation_log (actor_type, actor_id, reason, content) VALUES (?,?,?,?)')
      .run('user', user.id, `Kata terfilter: ${hit}`, text);
    return res.status(403).json({ ok: false, message: 'Ulasan mengandung kata yang dilarang. Kamu diblokir 24 jam.' });
  }

  const r = Math.min(5, Math.max(1, parseInt(star) || 5));
  const name = (displayName || user.username || '').trim() || user.username;
  const info = db.prepare('INSERT INTO reviews (user_id, name, rating, comment, image) VALUES (?,?,?,?,?)')
    .run(user.id, name, r, text || '', photoUrl || null);
  const saved = db.prepare('SELECT r.*, u.username FROM reviews r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?').get(info.lastInsertRowid);
  res.json({ ok: true, message: 'Terima kasih atas ulasannya!', review: reviewToJson(saved) });
});

// POST /api/reviews/:id/helpful
router.post('/reviews/:id/helpful', (req, res) => {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ ok: false, message: 'Ulasan tidak ditemukan.' });
  db.prepare('UPDATE reviews SET helpful = helpful + 1 WHERE id = ?').run(r.id);
  const helpful = db.prepare('SELECT helpful FROM reviews WHERE id = ?').get(r.id).helpful;
  res.json({ ok: true, helpful });
});

// DELETE /api/reviews/:id  (header x-admin-token)
router.delete('/reviews/:id', (req, res) => {
  const { verifyToken } = require('../util/auth');
  const token = req.headers['x-admin-token'];
  const data = token ? verifyToken(token) : null;
  if (!data || data.role !== 'admin') return res.status(401).json({ ok: false, message: 'Akses admin diperlukan.' });
  db.prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/history  { query }  -> { ok, data: [order,...] }  (dipakai halaman Cek Order)
router.post('/history', (req, res) => {
  const q = (req.body && req.body.query || '').trim();
  if (!q) return res.status(400).json({ ok: false, message: 'Masukkan nomor HP atau ID transaksi.' });

  const byInvoice = db.prepare('SELECT * FROM orders WHERE invoice = ?').get(q);
  const byContact = db.prepare('SELECT * FROM orders WHERE buyer_contact = ? ORDER BY id DESC LIMIT 50').all(q);
  const rows = byInvoice ? [byInvoice, ...byContact.filter(o => o.id !== byInvoice.id)] : byContact;

  if (!rows.length) return res.status(404).json({ ok: false, message: 'Tidak ditemukan order dengan data tersebut.' });

  const statusMap = { pending: 'PENDING', paid: 'PENDING', processing: 'PENDING', success: 'COMPLETED', failed: 'FAILED', expired: 'EXPIRED' };
  const data = rows.map(o => {
    let result = null;
    if (o.payload) { try { result = JSON.parse(o.payload); } catch (e) { /* ignore */ } }
    return {
      invoice: o.invoice, target: o.target, price: o.price,
      status: statusMap[o.status] || o.status.toUpperCase(),
      createdAt: toEpoch(o.created_at), result,
    };
  });
  res.json({ ok: true, data });
});

// GET /api/stores -> daftar toko reseller, terverifikasi & paling laris di atas
router.get('/stores', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.slug, r.store_name, r.logo, r.is_verified, r.created_at,
           COUNT(o.id) AS total_orders
    FROM resellers r
    LEFT JOIN orders o ON o.reseller_id = r.id AND o.status IN ('paid','success')
    WHERE r.status = 'active'
    GROUP BY r.id
    ORDER BY r.is_verified DESC, total_orders DESC, r.id DESC
    LIMIT 100
  `).all();
  res.json({ ok: true, stores: rows.map(r => ({
    slug: r.slug, storeName: r.store_name, logo: r.logo, verified: !!r.is_verified, totalOrders: r.total_orders,
  })) });
});

module.exports = router;
