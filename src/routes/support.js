// DigitalHub - Chat dukungan (user -> staff: Owner/Admin/Support Agent).
// Satu thread per user (room = support:{username}), semua staff bisa lihat & balas
// dari Admin Panel > Live. File dilampirkan via URL (bukan upload ke server kita).
'use strict';
const express = require('express');
const db = require('../db');
const { requireRole, verifyToken } = require('../util/auth');
const { containsBannedWord, getClientIp, blockIp24h, isIpBlocked } = require('../util/security');
const { publish, subscribe } = require('../util/chatBus');
const router = express.Router();
const auth = requireRole('user');

function roomOf(username) { return `support:${username}`; }

router.get('/messages', auth, (req, res) => {
  const room = roomOf(req.auth.username);
  const rows = db.prepare('SELECT * FROM chats WHERE room = ? ORDER BY id ASC LIMIT 200').all(room);
  res.json({ ok: true, messages: rows.map(r => ({
    id: r.id, from: r.sender, senderName: r.sender_name, text: r.message, fileUrl: r.image,
    createdAt: new Date(r.created_at.replace(' ', 'T') + 'Z').getTime(),
  })) });
});

// EventSource browser TIDAK BISA kirim header custom (Authorization dll), jadi endpoint
// stream ini menerima token lewat query string sebagai pengecualian yang wajar untuk SSE.
router.get('/stream', (req, res) => {
  const { verifyToken: verify } = require('../util/auth');
  const token = req.query.token;
  const data = token ? verify(token) : null;
  if (!data || data.role !== 'user') return res.status(401).json({ ok: false, message: 'Token tidak valid.' });

  const room = roomOf(data.username);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const unsubscribe = subscribe(room, (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

// POST /messages { text, fileUrl, to }  — "to" cuma label ('owner'|'admin'|'support_agent'), disimpan di note
router.post('/messages', auth, (req, res) => {
  const { text, fileUrl, to } = req.body || {};
  if (!text && !fileUrl) return res.status(400).json({ ok: false, message: 'Pesan kosong.' });

  const ip = getClientIp(req);
  if (isIpBlocked(ip)) return res.status(403).json({ ok: false, message: 'Kamu diblokir sementara.' });
  const hit = containsBannedWord(text);
  if (hit) {
    blockIp24h(ip, `Kata terfilter: ${hit}`);
    return res.status(403).json({ ok: false, message: 'Pesan mengandung kata yang dilarang. Kamu diblokir 24 jam.' });
  }

  const room = roomOf(req.auth.username);
  const info = db.prepare("INSERT INTO chats (room, sender, sender_name, message, image) VALUES (?, 'user', ?, ?, ?)")
    .run(room, req.auth.username, (to ? `[ke: ${to}] ` : '') + (text || ''), fileUrl || null);
  const saved = db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  const message = { id: saved.id, from: 'user', senderName: saved.sender_name, text: saved.message, fileUrl: saved.image, createdAt: Date.now() };
  publish(room, message);
  res.json({ ok: true, message });
});

// Staff (admin panel) balas thread dukungan siapapun — dipakai dari Admin Panel > Live nanti
router.post('/reply/:username', (req, res) => {
  const token = req.headers['x-admin-token'];
  const data = token ? verifyToken(token) : null;
  if (!data || data.role !== 'admin') return res.status(401).json({ ok: false, message: 'Akses staff diperlukan.' });

  const { text } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, message: 'Pesan kosong.' });
  const room = roomOf(req.params.username);
  const info = db.prepare("INSERT INTO chats (room, sender, sender_name, message) VALUES (?, 'seller', 'Tim DigitalHub', ?)").run(room, text);
  const saved = db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  const message = { id: saved.id, from: 'staff', senderName: 'Tim DigitalHub', text: saved.message, fileUrl: null, createdAt: Date.now() };
  publish(room, message);
  res.json({ ok: true, message });
});

module.exports = router;
