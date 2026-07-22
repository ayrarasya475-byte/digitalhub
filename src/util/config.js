// DigitalHub - Config helper: baca pengaturan dari database dulu (bisa diatur dari
// Admin Panel > Config tanpa perlu edit file), baru fallback ke .env kalau kosong.
// Ini penting karena admin (kamu) mungkin akses dari HP dan nggak bisa edit .env langsung.
// Nilai SENSITIF (API key, secret) dienkripsi (AES-256-GCM) sebelum disimpan ke
// database — jadi kalau file database bocor, key tidak langsung kebaca polos.
'use strict';
const crypto = require('crypto');
const db = require('../db');

function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw && raw.length >= 64) return Buffer.from(raw.slice(0, 64), 'hex');
  if (!getEncryptionKey._warned) {
    console.warn('\n⚠️  ENCRYPTION_KEY belum diisi di .env — pakai kunci sementara (data terenkripsi hilang saat restart). Generate dengan: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    getEncryptionKey._warned = true;
    getEncryptionKey._fallback = getEncryptionKey._fallback || crypto.randomBytes(32);
  }
  return getEncryptionKey._fallback;
}

const SENSITIVE_KEYS = new Set([
  'payment_gateway_key', 'payment_gateway_secret',
  'h2h_api_key', 'otp_api_key', 'ptero_api_key', 'ai_api_key',
]);

function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(payload) {
  if (!payload || !payload.startsWith('enc:')) return payload || ''; // data lama/belum terenkripsi
  try {
    const [, ivHex, tagHex, dataHex] = payload.split(':');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    return ''; // kunci beda/data korup — anggap kosong daripada crash
  }
}

function getConfig(key, envName, fallback) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  if (row && row.value) return SENSITIVE_KEYS.has(key) ? decrypt(row.value) : row.value;
  if (envName && process.env[envName]) return process.env[envName];
  return fallback !== undefined ? fallback : '';
}

function setConfig(key, value) {
  const stored = SENSITIVE_KEYS.has(key) && value ? encrypt(value) : String(value ?? '');
  db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, stored);
}

function isConfigured(...keys) {
  return keys.every(k => getConfig(k, null, ''));
}

function logError(level, message, stack, route) {
  try {
    db.prepare('INSERT INTO error_logs (level, message, stack, route) VALUES (?,?,?,?)')
      .run(level, String(message).slice(0, 2000), String(stack || '').slice(0, 4000), route || '');
  } catch (e) { /* jangan sampai logger sendiri bikin crash */ }
}

module.exports = { getConfig, setConfig, isConfigured, logError, encrypt, decrypt };
