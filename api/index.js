// DigitalHub - Entry point khusus Vercel.
// Vercel otomatis mendeteksi file di folder /api sebagai serverless function.
// Kita cukup ekspor Express app yang sudah didefinisikan di src/server.js —
// Vercel yang akan "membungkusnya" jadi handler request/response.
// (src/server.js sendiri sudah pintar: dia skip app.listen() kalau process.env.VERCEL ada.)
'use strict';
process.env.VERCEL = process.env.VERCEL || '1';
module.exports = require('../src/server.js');
