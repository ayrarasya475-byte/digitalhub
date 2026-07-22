// DigitalHub - Auth helpers (JWT based, stateless tokens for reseller/user/admin)
'use strict';
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'digitalhub_dev_secret_change_me';

function signToken(payload, expiresIn = '30d') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function verifyToken(token) {
  try { return jwt.verify(token, SECRET); }
  catch (e) { return null; }
}

function getBearerToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  // Halaman-halaman lama di template menggunakan nama header custom yang berbeda-beda
  // untuk hal yang secara konsep sama (token sesi reseller). Kita terima semuanya.
  if (req.headers['x-rs-store-token']) return req.headers['x-rs-store-token'];
  if (req.headers['x-reseller-token']) return req.headers['x-reseller-token'];
  if (req.cookies && req.cookies.token) return req.cookies.token;
  // EventSource (buat SSE real-time) TIDAK BISA kirim header custom sama sekali —
  // jadi buat endpoint /stream, token boleh dikirim lewat query string.
  if (req.query && req.query.token) return req.query.token;
  return null;
}

// Generic middleware factory: requires payload.role === role
function requireRole(role) {
  return (req, res, next) => {
    const token = getBearerToken(req);
    const data = token ? verifyToken(token) : null;
    if (!data || data.role !== role) {
      return res.status(401).json({ ok: false, message: 'Unauthorized. Silakan login ulang.' });
    }
    req.auth = data;
    next();
  };
}

// Optional auth: attaches req.auth if valid token present, doesn't block otherwise
function optionalAuth(req, res, next) {
  const token = getBearerToken(req);
  req.auth = token ? verifyToken(token) : null;
  next();
}

// Auth berbasis apikey (dipakai halaman publik: chat komunitas, ulasan, OTP end-user)
// Beda dari JWT — apikey adalah string tetap yang disimpan di kolom users.apikey.
function requireApiKeyUser(db) {
  return (req, res, next) => {
    const key = req.headers['x-api-key'];
    const user = key ? db.prepare('SELECT * FROM users WHERE apikey = ?').get(key) : null;
    if (!user) return res.status(401).json({ ok: false, message: 'Silakan login terlebih dahulu.' });
    req.user = user;
    next();
  };
}

function requireAdminHeaderToken() {
  return (req, res, next) => {
    const token = req.headers['x-admin-token'];
    const data = token ? verifyToken(token) : null;
    if (!data || data.role !== 'admin') {
      return res.status(401).json({ ok: false, message: 'Akses admin diperlukan.' });
    }
    req.admin = data;
    next();
  };
}

module.exports = { signToken, verifyToken, getBearerToken, requireRole, optionalAuth, requireApiKeyUser, requireAdminHeaderToken };
