// DigitalHub - Community chat (satu room global, "/chat"). Real-time via SSE.
// Kontrak ini menyesuaikan chat.html yang sudah dibangun sebelumnya di template asli:
// - Auth pakai header x-api-key (apikey milik user, BUKAN JWT)
// - Field pesan: { id, username, displayName, photoUrl, text, createdAt(epoch ms) }
// - Admin bisa hapus pesan siapa saja pakai header x-admin-token (JWT admin)
'use strict';
const express = require('express');
const db = require('../db');
const { verifyToken } = require('../util/auth');
const { containsBannedWord, getClientIp, blockIp24h, isIpBlocked } = require('../util/security');
const { publish, subscribe } = require('../util/chatBus');
const router = express.Router();

const ROOM = 'general';

function getUserByApiKey(apikey) {
  if (!apikey) return null;
  return db.prepare('SELECT * FROM users WHERE apikey = ?').get(apikey);
}

function toEpoch(sqliteTs) {
  // SQLite CURRENT_TIMESTAMP formatnya 'YYYY-MM-DD HH:MM:SS' (UTC, tanpa 'Z') —
  // tambahkan 'Z' supaya Date.parse konsisten dianggap UTC.
  return new Date(sqliteTs.replace(' ', 'T') + 'Z').getTime();
}

function rowToMessage(row) {
  return {
    id: row.id,
    username: row.sender_name,
    displayName: row.sender_name,
    photoUrl: row.image || null,
    text: row.message || '',
    createdAt: toEpoch(row.created_at),
  };
}

// GET /api/chat/stream -> SSE real-time untuk room komunitas
router.get('/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const unsubscribe = subscribe(ROOM, (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

// GET /api/chat?limit=50  atau  ?since=EPOCH&limit=20
router.get('/', (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit) || 50);
  let rows;
  if (req.query.since) {
    const sinceIso = new Date(parseInt(req.query.since)).toISOString().replace('T', ' ').replace('Z', '');
    rows = db.prepare('SELECT * FROM chats WHERE room = ? AND created_at > ? ORDER BY id ASC LIMIT ?').all(ROOM, sinceIso, limit);
  } else {
    rows = db.prepare('SELECT * FROM chats WHERE room = ? ORDER BY id DESC LIMIT ?').all(ROOM, limit).reverse();
  }
  const total = db.prepare('SELECT COUNT(*) c FROM chats WHERE room = ?').get(ROOM).c;
  res.json({ ok: true, messages: rows.map(rowToMessage), total });
});

// POST /api/chat  (header x-api-key) { text, photoUrl, displayName }
router.post('/', (req, res) => {
  const apikey = req.headers['x-api-key'];
  const user = getUserByApiKey(apikey);
  if (!user) return res.status(401).json({ ok: false, message: 'Silakan login untuk mengirim pesan.' });

  const { text, photoUrl } = req.body || {};
  if (!text && !photoUrl) return res.status(400).json({ ok: false, message: 'Pesan kosong.' });

  const ip = getClientIp(req);
  if (isIpBlocked(ip)) return res.status(403).json({ ok: false, message: 'Kamu diblokir sementara. Coba lagi 24 jam ke depan.' });

  const hit = containsBannedWord(text);
  if (hit) {
    blockIp24h(ip, `Kata terfilter: ${hit}`);
    db.prepare('INSERT INTO moderation_log (actor_type, actor_id, reason, content) VALUES (?,?,?,?)')
      .run('user', user.id, `Kata terfilter: ${hit}`, text);
    return res.status(403).json({ ok: false, message: 'Pesan mengandung kata yang dilarang. Kamu diblokir 24 jam.' });
  }

  const info = db.prepare('INSERT INTO chats (room, sender, sender_name, message, image) VALUES (?,?,?,?,?)')
    .run(ROOM, 'user', user.username, text || '', photoUrl || null);
  const saved = db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  const message = rowToMessage(saved);
  publish(ROOM, message);

  res.json({ ok: true, message });
});

// DELETE /api/chat/:id  (x-api-key = pemilik pesan, ATAU x-admin-token = admin)
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM chats WHERE id = ? AND room = ?').get(req.params.id, ROOM);
  if (!row) return res.status(404).json({ ok: false, message: 'Pesan tidak ditemukan.' });

  const adminToken = req.headers['x-admin-token'];
  const adminData = adminToken ? verifyToken(adminToken) : null;
  const isAdmin = adminData && adminData.role === 'admin';

  if (!isAdmin) {
    const apikey = req.headers['x-api-key'];
    const user = getUserByApiKey(apikey);
    if (!user || user.username !== row.sender_name) {
      return res.status(401).json({ ok: false, message: 'Kamu tidak boleh menghapus pesan ini.' });
    }
  }
  db.prepare('DELETE FROM chats WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
