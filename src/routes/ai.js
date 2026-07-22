// DigitalHub - AI Assistant ("AI" di navigasi bawah). Bantu pembeli cari produk.
// Default: Pollinations AI (endpoint publik, tanpa API key).
// Kalau admin konfigurasi provider sendiri di Config (endpoint ATAU provider+key),
// itu yang dipakai. Kalau "ai_enabled" dimatikan, fitur AI nonaktif sepenuhnya.
'use strict';
const express = require('express');
const db = require('../db');
const { getConfig } = require('../util/config');
const router = express.Router();

const PROVIDER_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  grok: 'https://api.x.ai/v1/chat/completions',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  claude: null, // Anthropic tidak pakai format OpenAI-compatible; butuh integrasi terpisah
};

async function askPollinations(prompt) {
  const r = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai`);
  return r.text();
}

async function askOpenAiCompatible(prompt, endpoint, apiKey) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: prompt }] }),
  });
  const json = await r.json();
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || 'Maaf, AI tidak bisa menjawab saat ini.';
}

router.get('/status', (req, res) => {
  res.json({ ok: true, enabled: getConfig('ai_enabled', null, '1') === '1' });
});

router.post('/ask', async (req, res) => {
  if (getConfig('ai_enabled', null, '1') !== '1') {
    return res.status(403).json({ ok: false, message: 'Fitur AI sedang dinonaktifkan admin.' });
  }
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ ok: false, message: 'Pertanyaan kosong.' });

  const products = db.prepare("SELECT name, price, product_type FROM products WHERE is_active = 1 ORDER BY id DESC LIMIT 40").all();
  const catalog = products.map(p => `- ${p.name} (${p.product_type}) Rp${p.price.toLocaleString('id-ID')}`).join('\n');
  const prompt = `Kamu adalah asisten belanja untuk DigitalHub, marketplace produk digital (panel hosting, OTP/PPOB, akun premium). Jawab singkat, ramah, dan bahasa Indonesia. Rekomendasikan produk dari katalog berikut kalau relevan dengan pertanyaan pembeli:\n\n${catalog}\n\nPertanyaan pembeli: ${message}`;

  try {
    const customEndpoint = getConfig('ai_endpoint', null, '');
    const providerName = getConfig('ai_provider_name', null, '');
    const providerKey = getConfig('ai_api_key', null, '');

    let answer;
    if (customEndpoint) {
      answer = await askOpenAiCompatible(prompt, customEndpoint, '');
    } else if (providerName && providerKey && PROVIDER_ENDPOINTS[providerName]) {
      answer = await askOpenAiCompatible(prompt, PROVIDER_ENDPOINTS[providerName], providerKey);
    } else {
      answer = await askPollinations(prompt);
    }
    res.json({ ok: true, answer });
  } catch (e) {
    res.status(502).json({ ok: false, message: 'AI sedang tidak bisa dihubungi, coba lagi sebentar.' });
  }
});

module.exports = router;
