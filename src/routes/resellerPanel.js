// DigitalHub - Reseller PANEL routes (manajemen panel hosting/game, gaya Pterodactyl).
// Kontrak endpoint & bentuk response di file ini SENGAJA disamakan persis dengan
// yang sudah dipakai oleh public/pages/cpanel.html (template asli) — termasuk
// pembungkus {ok, data}, nama field (panelUsername, expiresAt, dst), dan header
// auth 'x-reseller-token'. Satu akun reseller dipakai bareng untuk toko + panel.
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireRole } = require('../util/auth');
const { isConfigured } = require('../util/config');
const router = express.Router();
const auth = requireRole('reseller');

function isSimulation() {
  return !isConfigured('ptero_url', 'ptero_api_key');
}

function formatMb(mb) {
  if (!mb || mb === 0) return 'Unlimited';
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace('.0', '') + ' GB';
  return mb + ' MB';
}

// POST /api/reseller/login  { username, password }  (cpanel.html mengirim "username")
router.post('/login', (req, res) => {
  const { slug, username, password } = req.body || {};
  const clean = String(slug || username || '').toLowerCase().trim();
  const reseller = db.prepare('SELECT * FROM resellers WHERE slug = ?').get(clean);
  if (!reseller || !bcrypt.compareSync(String(password || ''), reseller.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Username atau password salah.' });
  }
  const token = signToken({ role: 'reseller', id: reseller.id, slug: reseller.slug });
  res.json({ ok: true, token, slug: reseller.slug, storeName: reseller.store_name });
});

// GET /api/reseller/profile -> { ok, data: { username, activeServers, maxServers, allowedPlans } }
router.get('/profile', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.id);
  if (!r) return res.status(404).json({ ok: false, message: 'Login kembali diperlukan.' });
  const activeServers = db.prepare("SELECT COUNT(*) c FROM panels WHERE reseller_id = ? AND status != 'deleted'").get(r.id).c;
  res.json({
    ok: true,
    data: { username: r.slug, activeServers, maxServers: r.max_servers, allowedPlans: [] }, // [] = semua plan diizinkan
  });
});

router.post('/change-password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.id);
  if (!r || !bcrypt.compareSync(String(oldPassword || ''), r.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Password lama salah.' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ ok: false, message: 'Password baru minimal 6 karakter.' });
  }
  db.prepare('UPDATE resellers SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), r.id);
  res.json({ ok: true, message: 'Password diganti.' });
});

// GET /api/reseller/plans -> { ok, data: [{ id(string), name, ram, disk, cpu, price, duration_days }] }
router.get('/plans', (req, res) => {
  const rows = db.prepare('SELECT * FROM panel_plans WHERE is_active = 1 ORDER BY price').all();
  res.json({
    ok: true,
    data: rows.map(p => ({
      id: String(p.id), name: p.name, ram: p.ram_mb, disk: p.disk_mb, cpu: p.cpu_pct,
      price: p.price, durationDays: p.duration_days,
    })),
  });
});

// GET /api/reseller/eggs -> { ok, data: [{id, nest, nestName, name}], defaultEgg }
router.get('/eggs', auth, (req, res) => {
  res.json({
    ok: true,
    defaultEgg: 1,
    data: [
      { id: 1, nest: 1, nestName: 'Aplikasi', name: 'Node.js' },
      { id: 2, nest: 1, nestName: 'Aplikasi', name: 'Python' },
      { id: 3, nest: 2, nestName: 'Game', name: 'Minecraft Java' },
      { id: 4, nest: 2, nestName: 'Game', name: 'VPS Ubuntu' },
    ],
  });
});

// GET /api/reseller/servers -> { ok, data: [{ id, panelUsername, plan, ram, disk, cpu, description, status, domain, expiresAt }] }
router.get('/servers', auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM panels WHERE reseller_id = ? ORDER BY id DESC").all(req.auth.id);
  res.json({
    ok: true,
    data: rows.map(p => ({
      id: String(p.id), panelUsername: p.panel_username, plan: p.plan_name,
      ram: formatMb(p.ram_mb), disk: formatMb(p.disk_mb), cpu: p.cpu_pct === 0 ? 'Unlimited' : p.cpu_pct + '%',
      description: p.description || '', status: p.status, domain: p.domain || '',
      expiresAt: p.expires_at,
    })),
  });
});

router.get('/servers/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Server tidak ditemukan.' });
  res.json({ ok: true, data: p });
});

// POST /api/reseller/create-panel  { username, password, plan(id string), days, egg }
router.post('/create-panel', auth, (req, res) => {
  const { username, password, plan, days, egg } = req.body || {};
  if (!username || String(username).trim().length < 3) {
    return res.status(400).json({ ok: false, message: 'Username panel minimal 3 karakter.' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ ok: false, message: 'Password minimal 6 karakter.' });
  }
  const planRow = db.prepare('SELECT * FROM panel_plans WHERE id = ?').get(plan);
  if (!planRow) return res.status(404).json({ ok: false, message: 'Plan tidak ditemukan.' });

  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(req.auth.id);
  const activeServers = db.prepare("SELECT COUNT(*) c FROM panels WHERE reseller_id = ? AND status != 'deleted'").get(reseller.id).c;
  if (reseller.max_servers && activeServers >= reseller.max_servers) {
    return res.status(403).json({ ok: false, message: 'Kuota server penuh. Hubungi admin untuk menambah kuota.' });
  }
  if (reseller.balance < planRow.price) {
    return res.status(402).json({ ok: false, message: 'Saldo tidak cukup. Silakan top up dulu.' });
  }
  db.prepare('UPDATE resellers SET balance = balance - ? WHERE id = ?').run(planRow.price, reseller.id);

  const dayCount = Math.max(1, Math.min(3650, parseInt(days) || planRow.duration_days || 30));
  const expiresAt = Date.now() + dayCount * 86400000;
  const domain = process.env.PANEL_PTERO_URL_PUBLIC || 'https://panel-kamu.contoh.com';

  const info = db.prepare(
    `INSERT INTO panels (reseller_id, panel_username, panel_password, plan_id, plan_name, ram_mb, disk_mb, cpu_pct, domain, description, status, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?)`
  ).run(reseller.id, username.trim(), password, planRow.id, planRow.name, planRow.ram_mb, planRow.disk_mb, planRow.cpu_pct, domain, '', expiresAt);

  const data = {
    id: String(info.lastInsertRowid), username: username.trim(), password, domain,
    plan: planRow.name, ram: formatMb(planRow.ram_mb), disk: formatMb(planRow.disk_mb),
    cpu: planRow.cpu_pct === 0 ? 'Unlimited' : planRow.cpu_pct + '%',
    days: dayCount, expiresAt, description: '',
  };
  res.json({ ok: true, data, credentials: { username: username.trim(), password }, mode: isSimulation() ? 'simulation' : 'live' });
});

// POST /api/reseller/servers/:id/extend { days, newExpTs, description }
router.post('/servers/:id/extend', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Server tidak ditemukan.' });
  const { newExpTs, description } = req.body || {};
  const expiresAt = parseInt(newExpTs) || (Date.now() + 30 * 86400000);
  db.prepare("UPDATE panels SET expires_at = ?, description = ?, status = 'active' WHERE id = ?")
    .run(expiresAt, description || p.description, p.id);
  res.json({ ok: true, message: 'Panel diperpanjang.', expiresAt });
});

router.post('/servers/:id/suspend', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Server tidak ditemukan.' });
  db.prepare("UPDATE panels SET status = 'suspended' WHERE id = ?").run(p.id);
  res.json({ ok: true, message: 'Server di-suspend.' });
});

router.post('/servers/:id/unsuspend', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Server tidak ditemukan.' });
  db.prepare("UPDATE panels SET status = 'active' WHERE id = ?").run(p.id);
  res.json({ ok: true, message: 'Server diaktifkan kembali.' });
});

router.delete('/servers/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ? AND reseller_id = ?').get(req.params.id, req.auth.id);
  if (!p) return res.status(404).json({ ok: false, message: 'Server tidak ditemukan.' });
  db.prepare("UPDATE panels SET status = 'deleted' WHERE id = ?").run(p.id);
  res.json({ ok: true, message: 'Server dihapus.' });
});

module.exports = router;
