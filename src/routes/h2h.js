// DigitalHub - H2H PPOB routes, dipakai oleh tab "PPOB" di otp.html.
// Auth: header x-api-key (user biasa, sama seperti tab OTP). Saldo dari users.balance.
'use strict';
const express = require('express');
const db = require('../db');
const { isConfigured } = require('../util/config');
const router = express.Router();

function isSimulation() { return !isConfigured('h2h_base_url', 'h2h_api_key'); }

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

const DUMMY_PRODUCTS = [
  { code: 'ml-86', category: 'game', brand: 'ml', name: 'Mobile Legends 86 Diamond', price: 21000 },
  { code: 'ff-70', category: 'game', brand: 'ff', name: 'Free Fire 70 Diamond', price: 9500 },
  { code: 'pulsa-10k', category: 'pulsa', brand: 'telkomsel', name: 'Pulsa Telkomsel 10.000', price: 10500 },
  { code: 'pln-token-20k', category: 'pln', brand: 'pln', name: 'Token PLN 20.000', price: 20500 },
];

router.get('/products', requireUser, (req, res) => res.json({ ok: true, data: DUMMY_PRODUCTS }));

// GET /check-game?account_code=&account_number=
router.get('/check-game', requireUser, (req, res) => {
  const { account_code, account_number } = req.query;
  if (!account_code || !account_number) return res.status(400).json({ ok: false, message: 'Data tidak lengkap.' });
  res.json({ ok: true, data: { account_name: 'PLAYER-' + String(account_number).slice(-4), nickname: 'PLAYER-' + String(account_number).slice(-4), account_number } });
});

// GET /check-rekening?bank_code=&account_number=
router.get('/check-rekening', requireUser, (req, res) => {
  const { bank_code, account_number } = req.query;
  if (!bank_code || !account_number) return res.status(400).json({ ok: false, message: 'Data tidak lengkap.' });
  res.json({ ok: true, data: { account_name: 'NAMA PEMILIK (SIMULASI)', account_number } });
});

// POST /transaksi { product_code, target, price }
router.post('/transaksi', requireUser, (req, res) => {
  const { product_code, target, price } = req.body || {};
  if (!product_code || !target) return res.status(400).json({ ok: false, message: 'Produk & target wajib diisi.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const amt = parseInt(price) || 0;
  if (user.balance < amt) return res.status(402).json({ ok: false, message: 'Saldo tidak cukup.' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, user.id);

  const invoice = 'H2H' + Date.now().toString(36).toUpperCase();
  db.prepare(
    `INSERT INTO orders (invoice, user_id, buyer_contact, target, qty, price, status, note)
     VALUES (?,?,?,?,1,?, ?, ?)`
  ).run(invoice, user.id, target, target, amt, isSimulation() ? 'success' : 'processing', `PPOB: ${product_code}`);

  const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.id).balance;
  res.json({
    ok: true, balance: newBalance,
    data: { transaksi_id: invoice, id: invoice, status: isSimulation() ? 'success' : 'pending' },
    mode: isSimulation() ? 'simulation' : 'live',
  });
});

router.get('/transaksi/:invoice', requireUser, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE invoice = ?').get(req.params.invoice);
  if (!order) return res.status(404).json({ ok: false, message: 'Transaksi tidak ditemukan.' });
  const statusMap = { pending: 'pending', processing: 'process', success: 'success', failed: 'failed' };
  res.json({ ok: true, data: { transaksi_id: order.invoice, id: order.invoice, status: statusMap[order.status] || 'pending' } });
});

module.exports = router;
