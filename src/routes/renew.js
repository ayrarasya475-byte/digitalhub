// DigitalHub - Perpanjang Panel routes. Dipakai oleh public/pages/perpanjang-panel.html.
// Halaman ini publik (tanpa login) dan mengirim body application/x-www-form-urlencoded.
'use strict';
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const router = express.Router();

function statusLabel(p) {
  if (p.status === 'suspended') return 'SUSPENDED';
  if (p.expires_at < Date.now()) return 'EXPIRED';
  return 'ACTIVE';
}

// POST /api/renew/lookup  (form-urlencoded)  { username }
router.post('/lookup', (req, res) => {
  const username = (req.body.username || '').trim();
  if (!username) return res.status(400).json({ ok: false, message: 'Username panel wajib diisi.' });
  const panel = db.prepare('SELECT * FROM panels WHERE panel_username = ? AND status != \'deleted\'').get(username);
  if (!panel) return res.status(404).json({ ok: false, message: 'Panel tidak ditemukan.' });

  res.json({
    ok: true, username: panel.panel_username, ram: panel.ram_mb ? (panel.ram_mb >= 1024 ? (panel.ram_mb / 1024) + ' GB' : panel.ram_mb + ' MB') : 'Unlimited',
    plan: panel.plan_name, expiresAt: panel.expires_at,
    panelStatus: statusLabel(panel), pteroStatus: panel.status === 'deleted' ? 'deleted' : 'active',
  });
});

// POST /api/renew/order  (form-urlencoded)  { username, days, phone }
router.post('/order', (req, res) => {
  const username = (req.body.username || '').trim();
  const days = Math.max(1, parseInt(req.body.days) || 30);
  const phone = (req.body.phone || '').trim();
  if (!username) return res.status(400).json({ ok: false, message: 'Username panel wajib diisi.' });

  const panel = db.prepare('SELECT * FROM panels WHERE panel_username = ? AND status != \'deleted\'').get(username);
  if (!panel) return res.status(404).json({ ok: false, message: 'Panel tidak ditemukan.' });

  // Hitung harga per hari dari plan aslinya (fallback ke rata-rata plan aktif kalau plan sudah dihapus)
  let planRow = panel.plan_id ? db.prepare('SELECT * FROM panel_plans WHERE id = ?').get(panel.plan_id) : null;
  if (!planRow) planRow = db.prepare('SELECT * FROM panel_plans WHERE is_active = 1 ORDER BY price LIMIT 1').get();
  const pricePerDay = planRow ? Math.ceil(planRow.price / (planRow.duration_days || 30)) : 500;
  const total = pricePerDay * days;

  const invoice = 'RNW' + Date.now().toString(36).toUpperCase() + nanoid(12).toUpperCase();
  db.prepare(
    `INSERT INTO orders (invoice, reseller_id, buyer_contact, target, qty, price, status, note)
     VALUES (?,?,?,?,?,?, 'pending', ?)`
  ).run(invoice, panel.reseller_id, phone || null, username, days, total, `Perpanjang panel ${days} hari`);

  res.json({ ok: true, orderId: invoice, total, message: 'Order dibuat, lanjut ke pembayaran.' });
});

module.exports = router;
