// DigitalHub - Seed data awal ke Firestore (Owner admin + site_settings default).
// Dipanggil sekali saat server start (idempotent — aman dipanggil berkali-kali,
// nggak bikin duplikat).
'use strict';
const bcrypt = require('bcryptjs');
const { firestore } = require('./firebase');

async function seedFirestore() {
  // ── Owner admin ──
  const ownerUsername = process.env.OWNER_USERNAME || 'Rasya111';
  const ownerPassword = process.env.OWNER_PASSWORD || 'Bmbm12133';
  const adminsRef = firestore.collection('admins');
  const existingOwner = await adminsRef.where('username', '==', ownerUsername).limit(1).get();
  if (existingOwner.empty) {
    await adminsRef.add({
      username: ownerUsername,
      passwordHash: bcrypt.hashSync(ownerPassword, 10),
      role: 'owner',
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    console.log(`[firestore-seed] Owner dibuat -> username: ${ownerUsername}`);
  }

  // ── site_settings (satu dokumen tunggal, semua key jadi field) ──
  const settingsRef = firestore.collection('config').doc('site_settings');
  const settingsDoc = await settingsRef.get();
  if (!settingsDoc.exists) {
    await settingsRef.set({
      siteName: process.env.SITE_NAME || 'DigitalHub',
      logo: '/media/logo.jpg',
      primaryColor: '#6366f1',
      maintenanceEnabled: false,
      maintenanceMessage: 'Sedang maintenance, mohon tunggu sebentar.',
      maintenanceStart: '', maintenanceEnd: '', maintenanceAuto: false,
      paymentGatewayName: '', paymentGatewayKey: '', paymentGatewaySecret: '', paymentGatewayMode: 'sandbox',
      h2hBaseUrl: '', h2hApiKey: '', h2hUsername: '',
      otpBaseUrl: '', otpApiKey: '',
      pteroUrl: '', pteroApiKey: '',
      adsEnabledGlobal: true, adsMetaPixelId: '', adsPointsPerClick: 10, adsRupiahPer10Points: 100,
      aiEndpoint: '', aiApiKey: '', aiProviderName: '', aiEnabled: true,
      adminPanelPath: '/admin-panell', maxLoginAttempts: 20,
    });
    console.log('[firestore-seed] site_settings dibuat.');
  }

  // ── kategori default ──
  const catsRef = firestore.collection('categories');
  const catsSnap = await catsRef.limit(1).get();
  if (catsSnap.empty) {
    const batch = firestore.batch();
    [['Panel Hosting', '🖥️', 1], ['OTP & PPOB', '📱', 2], ['Akun Premium', '⭐', 3], ['Jasa Digital', '🛠️', 4]]
      .forEach(([name, icon, sortOrder]) => batch.set(catsRef.doc(), { name, icon, sortOrder }));
    await batch.commit();
    console.log('[firestore-seed] Kategori default dibuat.');
  }

  // ── kata terfilter default ──
  const wordsRef = firestore.collection('bannedWords');
  const wordsSnap = await wordsRef.limit(1).get();
  if (wordsSnap.empty) {
    const batch = firestore.batch();
    ['anjing', 'bangsat', 'kontol', 'memek', 'goblok', 'tolol'].forEach(w => batch.set(wordsRef.doc(), { word: w }));
    await batch.commit();
    console.log('[firestore-seed] Kata terfilter default dibuat.');
  }
}

module.exports = { seedFirestore };
