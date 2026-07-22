// DigitalHub - Security & moderation helpers
'use strict';
const db = require('../db');

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || req.ip || 'unknown';
}

// Deteksi OS & browser sederhana dari User-Agent (tanpa library eksternal)
function parseUserAgent(ua) {
  ua = ua || '';
  let os = 'Unknown';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ios/i.test(ua)) os = 'iOS';
  else if (/mac os/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) browser = 'Safari';

  return { os, browser };
}

// Negara TIDAK bisa dideteksi akurat tanpa layanan IP-geolocation pihak ketiga
// (mis. ipapi.co, ip-api.com). Placeholder ini mengembalikan 'Unknown' kecuali
// header CDN (mis. Cloudflare 'cf-ipcountry') tersedia.
function guessCountry(req) {
  return req.headers['cf-ipcountry'] || req.headers['x-country-code'] || 'Unknown';
}

function logVisit(req) {
  try {
    const ip = getClientIp(req);
    const { os, browser } = parseUserAgent(req.headers['user-agent']);
    const country = guessCountry(req);
    db.prepare('INSERT INTO visitor_log (path, ip, country, os, browser) VALUES (?,?,?,?,?)')
      .run(req.path, ip, country, os, browser);
  } catch (e) { /* jangan sampai logging error mengganggu request utama */ }
}

function recordClientMeta(table, id, req) {
  const ip = getClientIp(req);
  const { os, browser } = parseUserAgent(req.headers['user-agent']);
  const country = guessCountry(req);
  db.prepare(`UPDATE ${table} SET last_ip=?, last_country=?, last_os=?, last_browser=? WHERE id=?`)
    .run(ip, country, os, browser, id);
}

// Cek apakah teks mengandung kata yang difilter (case-insensitive, cocok kata utuh)
function containsBannedWord(text) {
  if (!text) return null;
  const words = db.prepare('SELECT word FROM banned_words').all().map(r => r.word.toLowerCase());
  const lower = String(text).toLowerCase();
  for (const w of words) {
    const re = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(lower)) return w;
  }
  return null;
}

// Blokir akun 24 jam karena melanggar filter kata
function autoBlock24h(table, id, reason) {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE ${table} SET is_blocked = 1, blocked_until = ?, blocked_reason = ? WHERE id = ?`)
    .run(until, reason, id);
}

function isCurrentlyBlocked(row) {
  if (!row) return false;
  if (!row.is_blocked) return false;
  if (!row.blocked_until) return true; // blokir permanen (manual dari admin)
  return new Date(row.blocked_until) > new Date();
}

function blockIp24h(ip, reason) {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO blocked_ips (ip, reason, blocked_until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason, blocked_until=excluded.blocked_until')
    .run(ip, reason, until);
}

function isIpBlocked(ip) {
  const row = db.prepare('SELECT * FROM blocked_ips WHERE ip = ?').get(ip);
  if (!row) return false;
  if (!row.blocked_until) return true;
  return new Date(row.blocked_until) > new Date();
}

module.exports = {
  getClientIp, parseUserAgent, guessCountry, logVisit, recordClientMeta,
  containsBannedWord, autoBlock24h, isCurrentlyBlocked, blockIp24h, isIpBlocked,
};
