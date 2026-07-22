// DigitalHub - TikTok Downloader. Dipakai oleh public/pages/tiktok-downloader.html.
// Pakai endpoint publik TikWM (tanpa API key) sebagai best-effort. Ganti via
// TIKWM_ENDPOINT di .env kalau provider ini berubah/down.
'use strict';
const express = require('express');
const router = express.Router();

const TIKWM_ENDPOINT = process.env.TIKWM_ENDPOINT || 'https://www.tikwm.com/api/';

router.get('/', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.json({ status: false, error: 'URL TikTok wajib diisi.' });
  try {
    const resp = await fetch(`${TIKWM_ENDPOINT}?url=${encodeURIComponent(url)}`);
    const json = await resp.json();
    if (!json || json.code !== 0 || !json.data) {
      return res.json({ status: false, error: 'Gagal memproses video. Pastikan link valid & publik.' });
    }
    const d = json.data;
    const isSlide = Array.isArray(d.images) && d.images.length > 0;

    if (isSlide) {
      return res.json({
        status: true, type: 'slide',
        title: d.title, uploader: d.author && d.author.unique_id, cover: d.cover,
        total: d.images.length,
        images: d.images.map((url, i) => ({ url, index: i + 1 })),
        audio: d.music ? { url: d.music } : {},
      });
    }
    res.json({
      status: true, type: 'video',
      title: d.title, uploader: d.author && d.author.unique_id, cover: d.cover, duration: d.duration,
      video: { url: d.play }, audio: d.music ? { url: d.music } : {},
    });
  } catch (e) {
    res.json({ status: false, error: 'Layanan downloader sedang bermasalah, coba lagi nanti.' });
  }
});

// GET /api/tiktok-proxy-dl?url=X&filename=Y -> stream file asli dengan header download
// (link TikTok CDN langsung sering diblokir CORS/hotlink kalau didownload langsung dari browser)
const proxyRouter = express.Router();
proxyRouter.get('/', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).send('URL wajib diisi.');
  try {
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) return res.status(502).send('Gagal mengambil file.');
    res.setHeader('Content-Disposition', `attachment; filename="${(filename || 'download').replace(/"/g, '')}"`);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(502).send('Gagal memproses download.');
  }
});

module.exports = router;
module.exports.proxyRouter = proxyRouter;
