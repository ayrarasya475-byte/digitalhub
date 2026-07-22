// DigitalHub - App-level protection middleware.
// CATATAN JUJUR: ini proteksi tingkat aplikasi (rate-limit, filter kata, blokir IP).
// Untuk anti-DDoS yang sesungguhnya (serangan volumetrik/jaringan), itu harus
// ditangani di layer infrastruktur/CDN (mis. Cloudflare gratis di depan domain kamu) —
// tidak ada kode Node.js yang bisa menahan serangan skala jaringan itu sendirian.
'use strict';
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { getClientIp, isIpBlocked, logVisit } = require('./security');

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

// Rate limit umum: cegah spam request / percobaan brute-force sederhana
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120, // 120 request/menit/IP untuk endpoint umum
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Terlalu banyak permintaan, coba lagi sebentar.' },
});

// Rate limit ketat khusus endpoint auth (anti brute-force login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20, // 20 percobaan/15menit/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Terlalu banyak percobaan login, coba lagi 15 menit lagi.' },
});

// Blokir permintaan dari IP yang sedang diblokir sistem (mis. karena melanggar filter kata)
function ipBlockGuard(req, res, next) {
  const ip = getClientIp(req);
  if (isIpBlocked(ip)) {
    return res.status(403).json({ ok: false, message: 'IP kamu sedang diblokir sementara oleh sistem.' });
  }
  next();
}

// Mode maintenance: kalau aktif, semua request non-admin dibalas halaman/pesan maintenance
function maintenanceGuard(req, res, next) {
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/admin-panell')) return next();

  const enabled = getSetting('maintenance_enabled', '0') === '1';
  const auto = getSetting('maintenance_auto', '0') === '1';
  let active = enabled;

  if (auto) {
    const start = getSetting('maintenance_start', '');
    const end = getSetting('maintenance_end', '');
    if (start && end) {
      const now = new Date();
      active = now >= new Date(start) && now <= new Date(end);
    }
  }

  if (!active) return next();

  const message = getSetting('maintenance_message', 'Sedang maintenance, mohon tunggu sebentar.');
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ ok: false, maintenance: true, message });
  }
  res.status(503).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Maintenance — DigitalHub</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{background:#181818;color:#e5e5e5;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:2rem}
    .box{max-width:380px}h1{font-size:1.3rem;margin-bottom:.6rem}p{color:#a0a0a0;font-size:.9rem}</style></head>
    <body><div class="box"><h1>🛠️ Sedang Maintenance</h1><p>${message}</p></div></body></html>`);
}

// Basic security headers (pengganti ringan tanpa dependency helmet)
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  // CATATAN JUJUR soal CSP: semua halaman di app ini pakai <script> inline (bukan file
  // eksternal terpisah), jadi CSP yang benar-benar ketat (tanpa 'unsafe-inline') akan
  // mematahkan hampir semua halaman kecuali kita refactor ke nonce per-request (kerjaan
  // besar tersendiri). Versi di bawah ini tetap menutup celah paling umum (blok iframe
  // asing, blok object/embed, batasi sumber font/CDN cuma yang kepakai) sambil app tetap
  // jalan normal.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://text.pollinations.ai https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
  ].join('; '));
  next();
}

// Anti-scrape ringan: blokir user-agent bot/scraper yang jujur menyebut dirinya bot
// (tidak bisa menahan scraper yang menyamar sebagai browser biasa — itu butuh
// layanan khusus seperti Cloudflare Bot Management)
const SUSPICIOUS_UA = /curl|wget|python-requests|scrapy|httpclient|libwww-perl/i;
function antiScrapeGuard(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (SUSPICIOUS_UA.test(ua) && !req.path.startsWith('/api/tiktok')) {
    return res.status(403).json({ ok: false, message: 'Akses otomatis terdeteksi dan diblokir.' });
  }
  next();
}

function visitorLogger(req, res, next) {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/media')) {
    logVisit(req);
  }
  next();
}

module.exports = {
  generalLimiter, authLimiter, ipBlockGuard, maintenanceGuard,
  securityHeaders, antiScrapeGuard, visitorLogger,
};
