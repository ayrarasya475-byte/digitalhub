// DigitalHub - Koneksi Firebase Admin SDK (Firestore + Realtime Database).
// PENTING: ini beda dari "firebaseConfig" yang dipakai di browser (client SDK).
// Yang dibutuhkan di sini adalah SERVICE ACCOUNT (kredensial server, akses penuh,
// TIDAK boleh pernah dikirim ke browser/client).
//
// Cara dapetin Service Account:
//   1. Buka Firebase Console -> project kamu (digitalhub-c12)
//   2. Klik ⚙️ (Project Settings) -> tab "Service Accounts"
//   3. Klik "Generate new private key" -> download file JSON-nya
//   4. Dari file itu, salin 3 nilai ke .env:
//      FIREBASE_PROJECT_ID      = project_id
//      FIREBASE_CLIENT_EMAIL    = client_email
//      FIREBASE_PRIVATE_KEY     = private_key (utuh, termasuk -----BEGIN/END-----)
//   Jangan commit file JSON itu ke Git / kirim ke siapapun.
'use strict';
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // .env menyimpan newline sebagai "\n" literal (dua karakter) — perlu diubah balik
  // jadi newline asli supaya key RSA-nya valid.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      '\n⚠️  FIREBASE belum dikonfigurasi lengkap di .env (FIREBASE_PROJECT_ID / ' +
      'FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY). Server tetap jalan, tapi semua ' +
      'fitur yang butuh database akan error sampai ini diisi.\n'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://digitalhub-c12-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
}

const firestore = admin.firestore();
const rtdb = admin.database();

module.exports = { admin, firestore, rtdb };
