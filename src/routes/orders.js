// DigitalHub - Order routes: checkout & lookup by invoice
'use strict';
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const router = express.Router();

function genInvoice() {
  return 'DH' + Date.now().toString(36).toUpperCase() + nanoid(12).toUpperCase();
}

// POST /api/v2/orders  { productId, variantId, qty, target, buyerName, buyerContact, resellerSlug }
router.post('/', (req, res) => {
  const { productId, variantId, qty, target, buyerName, buyerContact, resellerSlug } = req.body || {};
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(productId);
  if (!product) return res.status(404).json({ ok: false, message: 'Produk tidak ditemukan.' });

  let price = product.price;
  let variant = null;
  if (variantId) {
    variant = db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?').get(variantId, productId);
    if (variant) price = variant.price;
  }
  const q = Math.max(1, parseInt(qty) || 1);
  const total = price * q;

  let resellerId = product.reseller_id;
  if (resellerSlug) {
    const r = db.prepare('SELECT id FROM resellers WHERE slug = ?').get(resellerSlug);
    if (r) resellerId = r.id;
  }

  const invoice = genInvoice();
  db.prepare(
    `INSERT INTO orders (invoice, reseller_id, product_id, variant_id, buyer_name, buyer_contact, target, qty, price, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'pending')`
  ).run(invoice, resellerId || null, product.id, variant ? variant.id : null, buyerName || null, buyerContact || null, target || null, q, total);

  res.json({ ok: true, invoice, total, message: 'Order dibuat. Silakan lanjut pembayaran.' });
});

// GET /api/v2/orders/:invoice
router.get('/:invoice', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE invoice = ?').get(req.params.invoice);
  if (!order) return res.status(404).json({ ok: false, message: 'Order tidak ditemukan.' });
  res.json({ ok: true, order });
});

module.exports = router;
