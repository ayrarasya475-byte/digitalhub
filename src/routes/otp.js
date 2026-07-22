// DigitalHub - OTP / Virtual Number routes. Dipakai oleh public/pages/otp.html.
// PENTING: halaman ini dipakai oleh USER (pembeli), bukan reseller — auth pakai
// header x-api-key (apikey akun user), saldo dipotong dari users.balance.
// Mode simulasi otomatis kalau provider OTP belum dikonfigurasi (Admin Panel > Config).
'use strict';
const express = require('express');
const db = require('../db');
const { isConfigured } = require('../util/config');
const router = express.Router();

function isSimulation() {
  return !isConfigured('otp_base_url', 'otp_api_key');
}

function getUser(req) {
  const key = req.headers['x-api-key'];
  return key ? db.prepare('SELECT * FROM users WHERE apikey = ?').get(key) : null;
}
function requireUser(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'Silakan login terlebih dahulu.' });
  req.user = user;
  next();
}

const DUMMY_SERVICES = [
  { id: 'whatsapp', service_id: 'whatsapp', name: 'WhatsApp', price: 3500 },
  { id: 'telegram', service_id: 'telegram', name: 'Telegram', price: 2500 },
  { id: 'facebook', service_id: 'facebook', name: 'Facebook', price: 2000 },
  { id: 'google', service_id: 'google', name: 'Google / Gmail', price: 3000 },
  { id: 'instagram', service_id: 'instagram', name: 'Instagram', price: 2800 },
  { id: 'tiktok', service_id: 'tiktok', name: 'TikTok', price: 2200 },
];
const DUMMY_COUNTRIES = [
  { id: 'id', country_id: 'id', name: 'Indonesia', country: 'Indonesia' },
  { id: 'my', country_id: 'my', name: 'Malaysia', country: 'Malaysia' },
  { id: 'sg', country_id: 'sg', name: 'Singapura', country: 'Singapura' },
];

function orderToJson(o) {
  return {
    id: o.id, provider: o.provider, service: o.service, status: o.status,
    phoneNumber: o.phone_number, otp: o.otp || null, otpMsg: o.otp_msg || null,
    createdAt: o.created_at, expiresAt: o.expires_at,
  };
}

router.get('/info', (req, res) => res.json({ ok: true, mode: isSimulation() ? 'simulation' : 'live' }));
router.get('/servers', (req, res) => res.json({ ok: true, servers: [{ id: 1, name: 'Server 1 (SmsCode)' }, { id: 2, name: 'Server 2 (RumahOTP)' }] }));
router.get('/services', (req, res) => res.json({ ok: true, data: DUMMY_SERVICES, services: DUMMY_SERVICES }));
router.get('/pinned', (req, res) => res.json({ ok: true, data: DUMMY_SERVICES.slice(0, 3) }));
router.get('/countries/:service?', (req, res) => res.json({ ok: true, data: DUMMY_COUNTRIES }));
router.get('/operators/:country?/:providerId?', (req, res) => res.json({ ok: true, data: [{ id: 'any', name: 'Semua Operator' }] }));

router.get('/smscode/services', (req, res) => res.json({ ok: true, data: DUMMY_SERVICES }));
router.get('/smscode/countries', (req, res) => res.json({ ok: true, data: DUMMY_COUNTRIES }));
router.get('/smscode/products', (req, res) => res.json({
  ok: true,
  data: DUMMY_SERVICES.map(s => ({ id: s.id, platform_id: s.id, country_id: 'id', name: s.name, price: s.price, price_raw: s.price })),
}));

// POST /api/otp/order  (body fleksibel: dari flow "rotp" ATAU flow "smscode", lihat otp.html)
router.post('/order', requireUser, (req, res) => {
  const body = req.body || {};
  const provider = body.provider === 'smscode' ? 'smscode' : 'rumahotp';
  const serviceName = body.service_name || body.serviceName || 'Layanan OTP';
  const countryName = body.country_name || 'Indonesia';
  const price = parseInt(body.price) || 2500;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.balance < price) return res.status(402).json({ ok: false, message: 'Saldo tidak cukup.' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(price, user.id);

  const fakeNumber = '628' + Math.floor(100000000 + Math.random() * 899999999);
  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000; // 15 menit
  const info = db.prepare(
    `INSERT INTO otp_orders (user_id, provider, service, country_name, phone_number, price, status, created_at, expires_at)
     VALUES (?,?,?,?,?,?, 'waiting', ?, ?)`
  ).run(user.id, provider, serviceName, countryName, fakeNumber, price, now, expiresAt);

  const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance;
  res.json({ ok: true, orderId: info.lastInsertRowid, balance: newBalance, mode: isSimulation() ? 'simulation' : 'live' });
});

// GET /api/otp/orders -> { ok, data: [order,...] }
router.get('/orders', requireUser, (req, res) => {
  const rows = db.prepare('SELECT * FROM otp_orders WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);

  // Mode simulasi: OTP "masuk" otomatis 15 detik setelah order dibuat, biar bisa didemokan
  if (isSimulation()) {
    const now = Date.now();
    rows.forEach(o => {
      if (o.status === 'waiting' && now - o.created_at > 15000) {
        const code = String(Math.floor(100000 + Math.random() * 899999));
        db.prepare("UPDATE otp_orders SET status = 'otp_received', otp = ?, otp_msg = ? WHERE id = ?")
          .run(code, `Kode verifikasi Anda: ${code}`, o.id);
        o.status = 'otp_received'; o.otp = code; o.otp_msg = `Kode verifikasi Anda: ${code}`;
      } else if (o.status === 'waiting' && now > o.expires_at) {
        db.prepare("UPDATE otp_orders SET status = 'expired' WHERE id = ?").run(o.id);
        o.status = 'expired';
      }
    });
  }
  res.json({ ok: true, data: rows.map(orderToJson) });
});

router.get('/order/:id/status', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM otp_orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ ok: false, message: 'Order tidak ditemukan.' });
  res.json({ ok: true, data: orderToJson(o) });
});

router.post('/order/:id/cancel', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM otp_orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ ok: false, message: 'Order tidak ditemukan.' });
  if (['completed', 'canceled', 'expired'].includes(o.status)) {
    return res.status(400).json({ ok: false, message: 'Order sudah selesai.' });
  }
  // Refund hanya kalau belum 5 menit & belum ada OTP masuk (kebijakan sederhana)
  const canRefund = !o.otp && (Date.now() - o.created_at) < 5 * 60 * 1000;
  db.prepare("UPDATE otp_orders SET status = 'canceled' WHERE id = ?").run(o.id);
  let balance = req.user.balance;
  if (canRefund) {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(o.price, req.user.id);
    balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id).balance;
  }
  res.json({ ok: true, message: canRefund ? 'Order dibatalkan, saldo dikembalikan.' : 'Order dibatalkan.', balance });
});

router.post('/order/:id/finish', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM otp_orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ ok: false, message: 'Order tidak ditemukan.' });
  db.prepare("UPDATE otp_orders SET status = 'completed' WHERE id = ?").run(o.id);
  res.json({ ok: true, message: 'Order diselesaikan.' });
});

router.post('/order/:id/resend', requireUser, (req, res) => {
  const o = db.prepare('SELECT * FROM otp_orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!o) return res.status(404).json({ ok: false, message: 'Order tidak ditemukan.' });
  if (isSimulation()) {
    const code = String(Math.floor(100000 + Math.random() * 899999));
    db.prepare("UPDATE otp_orders SET status = 'otp_received', otp = ?, otp_msg = ? WHERE id = ?")
      .run(code, `Kode verifikasi Anda: ${code}`, o.id);
  }
  res.json({ ok: true, message: 'Kirim ulang diproses.' });
});

module.exports = router;
