// DigitalHub - Main server
'use strict';
require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'production'; // Express jalan mode production by default (lebih cepat, error message diringkas)
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const {
  generalLimiter, authLimiter, ipBlockGuard, maintenanceGuard,
  securityHeaders, antiScrapeGuard, visitorLogger,
} = require('./util/middleware');
const db = require('./db'); // SQLite — MASIH dipakai untuk produk/order/panel/dll (belum dimigrasi)
const { logError } = require('./util/config');
const { seedFirestore } = require('./db/firestoreSeed'); // Firestore — dipakai khusus buat akun admin (Owner/Admin/Support Agent)

seedFirestore().catch((e) => console.error('[firestore-seed] Gagal seed Firestore:', e.message));

// Tangkap error yang lolos dari semua try/catch (biar Log Viewer di Developer beneran berguna)
process.on('uncaughtException', (err) => { logError('error', err.message, err.stack, 'process'); });
process.on('unhandledRejection', (err) => { logError('error', err && err.message || String(err), err && err.stack, 'process'); });

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // supaya rate-limit & IP logging akurat di belakang reverse proxy/hosting

// ── Kompresi gzip manual (tanpa dependency tambahan, pakai zlib bawaan Node) ──
// Ini yang bikin halaman kerasa "berat" jadi jauh lebih ringan di HP dengan koneksi lambat.
app.use((req, res, next) => {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('gzip')) return next();
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return originalSend(body);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buf.length < 1024) return originalSend(body); // percuma kompres payload kecil
    zlib.gzip(buf, (err, compressed) => {
      if (err) return originalSend(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(compressed);
    });
    return res;
  };
  next();
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(securityHeaders);
app.use(antiScrapeGuard);
app.use(ipBlockGuard);
app.use(maintenanceGuard);
app.use(visitorLogger);
app.use('/api', generalLimiter);
app.use(['/api/user/login', '/api/user/register', '/api/store-reseller/login', '/api/store-reseller/register', '/api/reseller/login', '/api/admin/login'], authLimiter);

// ── Static assets ──
// Media (logo, dsb): boleh di-cache lama karena jarang berubah.
app.use('/media', express.static(path.join(__dirname, '..', 'public', 'media'), {
  maxAge: '7d', etag: true,
}));
// Halaman HTML/JS: cache pendek + wajib revalidate, supaya update kode kamu
// langsung kepakai tanpa orang harus "clear cache" manual di HP mereka.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

// ==== API routes ====
app.use('/api', require('./routes/public'));
app.use('/api/store-reseller', require('./routes/storeReseller'));
app.use('/api/reseller', require('./routes/resellerPanel'));
app.use('/api/renew', require('./routes/renew'));
app.use('/api/otp', require('./routes/otp'));
app.use('/api/h2h', require('./routes/h2h'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/rs-chat', require('./routes/rsChat'));
app.use('/api/tiktok-dl', require('./routes/tiktok'));
app.use('/api/tiktok-proxy-dl', require('./routes/tiktok').proxyRouter);
app.use('/api/user', require('./routes/user'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/v2/orders', require('./routes/orders'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/keuangan', require('./routes/keuangan'));
app.use('/api/support', require('./routes/support'));

// ==== Halaman (HTML statis, dirender oleh browser + fetch ke API di atas) ====
const PAGES = path.join(__dirname, '..', 'public', 'pages');
const pageRoute = (route, file) => app.get(route, (req, res) => res.sendFile(path.join(PAGES, file)));

pageRoute('/', 'index.html');
pageRoute('/market', 'market.html');
pageRoute('/reseller', 'login-reseller.html');
pageRoute('/reseller-dashboard', 'dashboard-reseller.html');
pageRoute('/cpanel', 'cpanel.html');
pageRoute('/renew', 'perpanjang-panel.html');
pageRoute('/otp', 'otp.html');
pageRoute('/track', 'cek-order.html');
pageRoute('/tiktok', 'tiktok-downloader.html');
pageRoute('/ulasan', 'ulasan.html');
pageRoute('/chat', 'chat.html');
pageRoute('/login', 'login.html');
pageRoute('/toko', 'toko.html');
pageRoute('/ai', 'ai.html');
pageRoute('/profil', 'profil.html');
pageRoute('/keuangan', 'keuangan.html');
pageRoute('/dukungan', 'dukungan.html');

// Path admin panel bisa diganti dari Developer > Security (default /admin-panell)
function getSettingSync(key, fallback) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return (row && row.value) ? row.value : fallback;
}
const adminPath = getSettingSync('admin_panel_path', '/admin-panell');
pageRoute(adminPath, 'admin.html');
if (adminPath !== '/admin-panell') pageRoute('/admin-panell', 'admin.html'); // alias lama tetap jalan biar gak nyasar

// Alias lama (kalau ada yang linknya masih pakai penamaan panjang)
pageRoute('/cek-order', 'cek-order.html');
pageRoute('/perpanjang-panel', 'perpanjang-panel.html');
pageRoute('/tiktok-downloader', 'tiktok-downloader.html');
pageRoute('/jadi-reseller', 'login-reseller.html');

// Storefront reseller: /:slug -> market terfilter toko itu (opsional tahap lanjut)

app.use((req, res) => res.status(404).json({ ok: false, message: 'Halaman/endpoint tidak ditemukan.' }));

// Error handler global — semua error yang lolos dari route masuk sini, tercatat ke
// Log Viewer (Developer), dan pengunjung tetap dapat respons rapi (bukan crash polos).
app.use((err, req, res, next) => {
  logError('error', err.message, err.stack, req.originalUrl);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: 'Terjadi kesalahan di server. Sudah tercatat di Log Viewer.' });
});

// Lokal / Render / Termux: jalan sebagai server biasa (app.listen).
// Vercel: file ini di-import sebagai serverless function, JANGAN app.listen()
// (Vercel yang pegang kendali listen-nya sendiri) — cukup export `app`.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✨ DigitalHub berjalan di http://localhost:${PORT}\n`);
    if (adminPath !== '/admin-panell') console.log(`   Admin panel: ${adminPath}\n`);
  });
}

module.exports = app;
