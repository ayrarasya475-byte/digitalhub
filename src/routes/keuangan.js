// DigitalHub - Fitur Keuangan (Dana/Event/Amal). Auth pakai JWT user biasa.
'use strict';
const express = require('express');
const db = require('../db');
const { requireRole } = require('../util/auth');
const router = express.Router();
const auth = requireRole('user');

function todayStr() { return new Date().toISOString().slice(0, 10); }

// ══════════════════════ DANA (wallet) ══════════════════════
router.get('/dana/summary', auth, (req, res) => {
  const user = db.prepare('SELECT balance, points FROM users WHERE id = ?').get(req.auth.id);
  const log = db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.auth.id);
  res.json({ ok: true, balance: user.balance, points: user.points, log });
});

// Transfer saldo ke user lain (saldo internal DigitalHub, bukan uang asli pihak ketiga)
router.post('/dana/transfer', auth, (req, res) => {
  const { toUsername, amount, note } = req.body || {};
  const amt = parseInt(amount);
  if (!toUsername || !amt || amt <= 0) return res.status(400).json({ ok: false, message: 'Isi username tujuan & jumlah yang benar.' });

  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (sender.balance < amt) return res.status(402).json({ ok: false, message: 'Saldo kamu tidak cukup.' });
  const receiver = db.prepare('SELECT * FROM users WHERE username = ?').get(toUsername);
  if (!receiver) return res.status(404).json({ ok: false, message: 'Username tujuan tidak ditemukan.' });
  if (receiver.id === sender.id) return res.status(400).json({ ok: false, message: 'Tidak bisa transfer ke diri sendiri.' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, sender.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amt, receiver.id);
    db.prepare("INSERT INTO wallet_transactions (user_id, type, amount, counterparty, note) VALUES (?, 'transfer_out', ?, ?, ?)")
      .run(sender.id, amt, receiver.username, note || '');
    db.prepare("INSERT INTO wallet_transactions (user_id, type, amount, counterparty, note) VALUES (?, 'transfer_in', ?, ?, ?)")
      .run(receiver.id, amt, sender.username, note || '');
  });
  tx();
  const newBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(sender.id).balance;
  res.json({ ok: true, message: `Rp${amt.toLocaleString('id-ID')} terkirim ke ${receiver.username}.`, balance: newBalance });
});

// ══════════════════════ EVENT (poin, flash sale, voucher) ══════════════════════
router.post('/event/checkin', auth, (req, res) => {
  const today = todayStr();
  const already = db.prepare('SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?').get(req.auth.id, today);
  if (already) return res.status(400).json({ ok: false, message: 'Kamu udah check-in hari ini. Balik lagi besok ya!' });
  db.prepare('INSERT INTO daily_checkins (user_id, checkin_date, points_awarded) VALUES (?, ?, 2)').run(req.auth.id, today);
  db.prepare('UPDATE users SET points = points + 2 WHERE id = ?').run(req.auth.id);
  const points = db.prepare('SELECT points FROM users WHERE id = ?').get(req.auth.id).points;
  res.json({ ok: true, message: '+2 poin buat hari ini!', points });
});
router.get('/event/checkin-status', auth, (req, res) => {
  const already = db.prepare('SELECT id FROM daily_checkins WHERE user_id = ? AND checkin_date = ?').get(req.auth.id, todayStr());
  res.json({ ok: true, checkedInToday: !!already });
});

router.get('/event/flash-sales', (req, res) => {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT fs.*, p.name AS product_name, p.price AS original_price, p.image
    FROM flash_sales fs JOIN products p ON p.id = fs.product_id
    WHERE fs.is_active = 1 AND fs.ends_at > ? ORDER BY fs.ends_at ASC
  `).all(now);
  res.json({ ok: true, flashSales: rows.map(f => ({
    id: f.id, productId: f.product_id, productName: f.product_name, image: f.image,
    originalPrice: f.original_price, discountPercent: f.discount_percent,
    salePrice: Math.round(f.original_price * (1 - f.discount_percent / 100)),
    startsAt: f.starts_at, endsAt: f.ends_at,
  })) });
});

router.get('/event/vouchers', auth, (req, res) => {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT v.*, r.store_name AS reseller_name FROM vouchers v LEFT JOIN resellers r ON r.id = v.reseller_id
    WHERE v.is_active = 1 AND (v.expires_at IS NULL OR v.expires_at > ?) ORDER BY v.id DESC
  `).all(now);
  const claimed = new Set(db.prepare('SELECT voucher_id FROM user_vouchers WHERE user_id = ?').all(req.auth.id).map(r => r.voucher_id));
  res.json({ ok: true, vouchers: rows.map(v => ({
    id: v.id, title: v.title, discountType: v.discount_type, discountValue: v.discount_value,
    resellerName: v.reseller_name || null, expiresAt: v.expires_at, claimed: claimed.has(v.id),
    remaining: v.claim_limit > 0 ? Math.max(0, v.claim_limit - v.claimed_count) : null,
  })) });
});
router.post('/event/vouchers/:id/claim', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id = ? AND is_active = 1').get(req.params.id);
  if (!v) return res.status(404).json({ ok: false, message: 'Voucher tidak ditemukan.' });
  if (v.claim_limit > 0 && v.claimed_count >= v.claim_limit) return res.status(400).json({ ok: false, message: 'Voucher udah habis diklaim.' });
  const already = db.prepare('SELECT id FROM user_vouchers WHERE user_id = ? AND voucher_id = ?').get(req.auth.id, v.id);
  if (already) return res.status(400).json({ ok: false, message: 'Kamu udah klaim voucher ini.' });
  db.prepare('INSERT INTO user_vouchers (user_id, voucher_id) VALUES (?, ?)').run(req.auth.id, v.id);
  db.prepare('UPDATE vouchers SET claimed_count = claimed_count + 1 WHERE id = ?').run(v.id);
  res.json({ ok: true, message: 'Voucher berhasil diklaim, cek di dompet vouchermu.' });
});
router.get('/event/my-vouchers', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT uv.*, v.title, v.discount_type, v.discount_value FROM user_vouchers uv
    JOIN vouchers v ON v.id = uv.voucher_id WHERE uv.user_id = ? ORDER BY uv.id DESC
  `).all(req.auth.id);
  res.json({ ok: true, vouchers: rows });
});

// Tukar poin jadi saldo diskon (10 poin = Rp100)
router.post('/event/redeem-points', auth, (req, res) => {
  const points = parseInt((req.body || {}).points);
  if (!points || points < 10 || points % 10 !== 0) return res.status(400).json({ ok: false, message: 'Jumlah poin harus kelipatan 10.' });
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.auth.id);
  if (user.points < points) return res.status(402).json({ ok: false, message: 'Poin kamu nggak cukup.' });
  const rupiah = (points / 10) * 100;
  db.prepare('UPDATE users SET points = points - ?, balance = balance + ? WHERE id = ?').run(points, rupiah, req.auth.id);
  db.prepare("INSERT INTO wallet_transactions (user_id, type, amount, note) VALUES (?, 'giveaway', ?, 'Tukar poin')").run(req.auth.id, rupiah);
  const updated = db.prepare('SELECT balance, points FROM users WHERE id = ?').get(req.auth.id);
  res.json({ ok: true, message: `${points} poin ditukar jadi Rp${rupiah.toLocaleString('id-ID')} saldo.`, ...updated });
});

// ══════════════════════ AMAL (DEMO — lihat catatan di db/index.js) ══════════════════════
const CAMPAIGNS = [
  { key: 'sedekah', label: 'Sedekah', target: 1000000 },
  { key: 'santunan_anak', label: 'Santunan Anak Yatim', target: 1000000 },
  { key: 'bantuan_gaza', label: 'Bantuan Gaza', target: 1000000 },
];

router.get('/amal/campaigns', (req, res) => {
  const data = CAMPAIGNS.map(c => {
    const sum = db.prepare('SELECT COALESCE(SUM(amount),0) t, COUNT(*) c FROM donations WHERE campaign = ?').get(c.key);
    return { ...c, collected: sum.t, donorCount: sum.c, progress: Math.min(100, Math.round((sum.t / c.target) * 100)) };
  });
  res.json({ ok: true, demo: true, campaigns: data });
});

router.get('/amal/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT COALESCE(donor_name, 'Hamba Allah') AS name, SUM(amount) AS total, COUNT(*) AS count
    FROM donations GROUP BY donor_name ORDER BY total DESC LIMIT 10
  `).all();
  res.json({ ok: true, demo: true, leaderboard: rows });
});

router.post('/amal/donate', (req, res) => {
  const { campaign, amount, donorName } = req.body || {};
  const amt = parseInt(amount);
  if (!CAMPAIGNS.find(c => c.key === campaign)) return res.status(400).json({ ok: false, message: 'Kampanye tidak ditemukan.' });
  if (!amt || amt <= 0) return res.status(400).json({ ok: false, message: 'Jumlah donasi tidak valid.' });

  // DEMO: sengaja TIDAK memotong saldo asli / users.balance — ini cuma simulasi tampilan
  // sampai API Rumah Zakat beneran dikonfigurasi (Admin Panel > Config).
  const userId = req.headers['x-api-key']
    ? (db.prepare('SELECT id FROM users WHERE apikey = ?').get(req.headers['x-api-key']) || {}).id
    : null;
  db.prepare('INSERT INTO donations (user_id, donor_name, campaign, amount, is_demo) VALUES (?,?,?,?,1)')
    .run(userId || null, donorName || 'Hamba Allah', campaign, amt);

  let donationCount = 0;
  if (userId) donationCount = db.prepare('SELECT COUNT(*) c FROM donations WHERE user_id = ?').get(userId).c;

  res.json({
    ok: true, demo: true,
    message: 'Terima kasih niat baiknya! (Ini masih demo — donasi belum diteruskan ke Rumah Zakat sungguhan sampai fiturnya aktif penuh.)',
    donationCount,
    nextMilestone: donationCount ? (5 - (donationCount % 5)) : 5,
  });
});

module.exports = router;
