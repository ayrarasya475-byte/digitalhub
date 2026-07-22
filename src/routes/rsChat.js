// DigitalHub - Chat dukungan reseller <-> pembeli (per toko, per buyerId).
// Dipakai oleh dashboard-reseller.html (sisi reseller) dan sisi pembeli (baru,
// menjawab permintaan "user bisa chat dengan reseller ketika membeli barang").
// Room convention: rs:{slug}:{buyerId}
//
// ⚠️ CATATAN KEAMANAN (BOLA): buyerId di sini berfungsi sebagai "bearer token" —
// siapapun yang tahu buyerId bisa baca chat itu (endpoint /messages & /stream publik,
// biar pembeli non-login bisa akses). Ini AMAN selama buyerId di-generate di sisi
// browser pembeli sebagai string acak panjang (mis. crypto.randomUUID(), disimpan di
// localStorage) — JANGAN PERNAH pakai nomor HP/email/angka berurutan sebagai buyerId,
// karena itu bisa ditebak orang lain. Halaman buyer-facing yang pakai endpoint ini
// WAJIB generate buyerId dengan crypto.randomUUID() saat pertama kali buka chat.
'use strict';
const express = require('express');
const db = require('../db');
const { verifyToken, getBearerToken } = require('../util/auth');
const { containsBannedWord, getClientIp, blockIp24h, isIpBlocked } = require('../util/security');
const { publish, subscribe } = require('../util/chatBus');
const router = express.Router({ mergeParams: true });

function roomName(slug, buyerId) { return `rs:${slug}:${buyerId}`; }

function requireResellerOwner(req, res, next) {
  const token = getBearerToken(req);
  const data = token ? verifyToken(token) : null;
  if (!data || data.role !== 'reseller' || data.slug !== req.params.slug) {
    return res.status(401).json({ ok: false, message: 'Login toko diperlukan.' });
  }
  req.auth = data;
  next();
}

// GET /api/rs-chat/:slug/messages?buyerId=X  (publik, dibaca pembeli & reseller)
router.get('/:slug/messages', (req, res) => {
  const buyerId = req.query.buyerId;
  if (!buyerId) return res.status(400).json({ ok: false, message: 'buyerId wajib diisi.' });
  const room = roomName(req.params.slug, buyerId);
  const rows = db.prepare('SELECT * FROM chats WHERE room = ? ORDER BY id ASC LIMIT 200').all(room);
  res.json({ ok: true, messages: rows.map(r => ({ id: r.id, from: r.sender, text: r.message })) });
});

// GET /api/rs-chat/:slug/stream?buyerId=X  (SSE real-time)
router.get('/:slug/stream', (req, res) => {
  const buyerId = req.query.buyerId;
  const room = roomName(req.params.slug, buyerId || 'unknown');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const unsubscribe = subscribe(room, (msg) => res.write(`data: ${JSON.stringify({ type: 'msg', message: msg })}\n\n`));
  const heartbeat = setInterval(() => res.write(':ping\n\n'), 25000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

function sendMessage(req, res, sender) {
  const { slug } = req.params;
  const { buyerId, buyerName, text } = req.body || {};
  if (!buyerId || !text) return res.status(400).json({ ok: false, message: 'buyerId & text wajib diisi.' });

  const reseller = db.prepare('SELECT * FROM resellers WHERE slug = ?').get(slug);
  if (!reseller) return res.status(404).json({ ok: false, message: 'Toko tidak ditemukan.' });

  const ip = getClientIp(req);
  if (isIpBlocked(ip)) return res.status(403).json({ ok: false, message: 'Kamu diblokir sementara.' });
  const hit = containsBannedWord(text);
  if (hit) {
    blockIp24h(ip, `Kata terfilter: ${hit}`);
    return res.status(403).json({ ok: false, message: 'Pesan mengandung kata yang dilarang. Kamu diblokir 24 jam.' });
  }

  const room = roomName(slug, buyerId);
  const senderName = sender === 'seller' ? reseller.store_name : (buyerName || 'Pembeli');
  const info = db.prepare('INSERT INTO chats (reseller_id, room, sender, sender_name, message) VALUES (?,?,?,?,?)')
    .run(reseller.id, room, sender, senderName, text);
  const message = { id: info.lastInsertRowid, from: sender, text };
  publish(room, message);
  res.json({ ok: true, message });
}

// POST /api/rs-chat/:slug/reply  (reseller membalas — perlu login toko)
router.post('/:slug/reply', requireResellerOwner, (req, res) => sendMessage(req, res, 'seller'));

// POST /api/rs-chat/:slug/send  (pembeli mengirim — publik, dipakai halaman pembeli)
router.post('/:slug/send', (req, res) => sendMessage(req, res, 'buyer'));

module.exports = router;
