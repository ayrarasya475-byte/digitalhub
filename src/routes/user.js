// DigitalHub - Buyer/user account routes.
// CATATAN: sengaja pakai SQLite (bukan Firestore) supaya konsisten dengan SEMUA
// fitur lain yang baca identitas user dari sini (chat, OTP, PPOB, ulasan, keuangan,
// dukungan). Migrasi ke Firestore untuk koleksi ini ditunda sampai migrasi PENUH
// (semua tabel sekaligus) siap dikerjakan — migrasi setengah-setengah kemarin
// justru bikin fitur lain yang bergantung pada user.id jadi rusak diam-diam.
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('../db');
const { signToken, requireRole, getBearerToken, verifyToken } = require('../util/auth');
const { recordClientMeta, isCurrentlyBlocked } = require('../util/security');
const router = express.Router();
const auth = requireRole('user');

router.post('/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ ok: false, message: 'Username & password (min 6 karakter) wajib diisi.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ ok: false, message: 'Username sudah dipakai.' });
  const hash = bcrypt.hashSync(password, 10);
  const apikey = nanoid(32);
  const info = db.prepare('INSERT INTO users (username, email, password_hash, apikey) VALUES (?,?,?,?)')
    .run(username, email || null, hash, apikey);
  recordClientMeta('users', info.lastInsertRowid, req);
  const token = signToken({ role: 'user', id: info.lastInsertRowid, username });
  res.json({ ok: true, token, username });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Username atau password salah.' });
  }
  if (isCurrentlyBlocked(user)) {
    return res.status(403).json({ ok: false, message: `Akun diblokir${user.blocked_reason ? ': ' + user.blocked_reason : '.'}` });
  }
  recordClientMeta('users', user.id, req);
  const token = signToken({ role: 'user', id: user.id, username: user.username });
  res.json({ ok: true, token, username: user.username });
});

router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, username, email, balance, points, ads_enabled, apikey, created_at FROM users WHERE id = ?').get(req.auth.id);
  if (!user) return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  res.json({ ok: true, user: { ...user, adsEnabled: user.ads_enabled } });
});

// me-soft: versi ringan, tidak error kalau belum login (dipakai utk cek status guest)
router.get('/me-soft', (req, res) => {
  const token = getBearerToken(req);
  const data = token ? verifyToken(token) : null;
  if (!data || data.role !== 'user') return res.json({ ok: true, loggedIn: false, user: null });
  const user = db.prepare('SELECT id, username, balance FROM users WHERE id = ?').get(data.id);
  res.json({ ok: true, loggedIn: !!user, user: user || null });
});

router.post('/settings', auth, (req, res) => {
  const { adsEnabled } = req.body || {};
  if (adsEnabled !== undefined) db.prepare('UPDATE users SET ads_enabled = ? WHERE id = ?').run(adsEnabled ? 1 : 0, req.auth.id);
  res.json({ ok: true, message: 'Pengaturan disimpan.' });
});

router.post('/change-password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (!user || !bcrypt.compareSync(String(oldPassword || ''), user.password_hash)) {
    return res.status(401).json({ ok: false, message: 'Password lama salah.' });
  }
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, message: 'Password baru minimal 6 karakter.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ ok: true, message: 'Password diganti.' });
});

router.get('/apikey', auth, (req, res) => {
  const user = db.prepare('SELECT apikey FROM users WHERE id = ?').get(req.auth.id);
  res.json({ ok: true, apikey: user.apikey });
});

router.post('/topup-request', auth, (req, res) => {
  const amt = parseInt((req.body || {}).amount);
  if (!amt || amt <= 0) return res.status(400).json({ ok: false, message: 'Jumlah tidak valid.' });
  db.prepare("INSERT INTO topup_requests (user_id, amount, method, status) VALUES (?,?,'chat','pending')").run(req.auth.id, amt);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.auth.id);
  db.prepare("INSERT INTO chats (room, sender, sender_name, message) VALUES ('general', 'user', ?, ?)")
    .run(user.username, `[Permintaan top-up] Rp${amt.toLocaleString('id-ID')}`);
  res.json({ ok: true, message: 'Permintaan top-up terkirim ke admin.' });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = router;
