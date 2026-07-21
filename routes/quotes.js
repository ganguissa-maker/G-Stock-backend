const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const requirePremium = require('../middleware/requirePremium');

const router = express.Router();
router.use(authenticate, requirePremium);

function generateQuoteNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `DEV-${y}${m}-${rand}`;
}

function generateInvoiceNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `FAC-${y}${m}-${rand}`;
}

// GET /api/quotes - liste des devis du compte connecté
router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM quotes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json(result.rows);
}));

// GET /api/quotes/:id - détail avec ses lignes
router.get('/:id', asyncHandler(async (req, res) => {
  const quoteResult = await pool.query('SELECT * FROM quotes WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  const quote = quoteResult.rows[0];
  if (!quote) return res.status(404).json({ error: 'Devis introuvable.' });
  const items = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1 ORDER BY id ASC', [req.params.id]);
  res.json({ ...quote, items: items.rows });
}));

// POST /api/quotes  { customer_id?, customer_name, customer_contact, items: [{product_id, quantity, unit_price?}] }
// Ne déduit PAS le stock (simple proposition commerciale).
router.post('/', asyncHandler(async (req, res) => {
  const { customer_id, customer_name, customer_contact, items } = req.body;

  if (!customer_name) return res.status(400).json({ error: 'customer_name est requis.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Le devis doit contenir au moins un article.' });
  }
  for (const it of items) {
    if (!it.product_id || !it.quantity || Number(it.quantity) <= 0) {
      return res.status(400).json({ error: 'Chaque article doit avoir un product_id et une quantity > 0.' });
    }
  }

  if (customer_id) {
    const customerCheck = await pool.query('SELECT id FROM customers WHERE id = $1 AND user_id = $2', [customer_id, req.user.id]);
    if (customerCheck.rows.length === 0) return res.status(400).json({ error: 'Client introuvable.' });
  }

  let total = 0;
  const prepared = [];
  for (const it of items) {
    const productResult = await pool.query('SELECT * FROM products WHERE id = $1 AND user_id = $2', [it.product_id, req.user.id]);
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ error: `Produit introuvable (id ${it.product_id}).` });
    const quantity = Number(it.quantity);
    const unitPrice = it.unit_price !== undefined && it.unit_price !== null ? Number(it.unit_price) : Number(product.price);
    const subtotal = Math.round(unitPrice * quantity * 100) / 100;
    total += subtotal;
    prepared.push({ product, quantity, unitPrice, subtotal });
  }

  const quoteNumber = generateQuoteNumber();
  const quoteResult = await pool.query(
    `INSERT INTO quotes (quote_number, customer_id, customer_name, customer_contact, status, total_amount, user_id)
     VALUES ($1,$2,$3,$4,'draft',$5,$6) RETURNING *`,
    [quoteNumber, customer_id || null, customer_name, customer_contact || null, total, req.user.id]
  );
  const quote = quoteResult.rows[0];

  for (const p of prepared) {
    await pool.query(
      `INSERT INTO quote_items (quote_id, product_id, product_name, quantity, unit_price, subtotal)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [quote.id, p.product.id, p.product.name, p.quantity, p.unitPrice, p.subtotal]
    );
  }

  res.status(201).json({
    ...quote,
    items: prepared.map((p) => ({
      product_id: p.product.id, product_name: p.product.name,
      quantity: p.quantity, unit_price: p.unitPrice, subtotal: p.subtotal,
    })),
  });
}));

// PUT /api/quotes/:id/status  { status: 'draft'|'sent'|'accepted'|'rejected' }
router.put('/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['draft', 'sent', 'accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status invalide.' });
  }
  const result = await pool.query(
    'UPDATE quotes SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [status, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Devis introuvable.' });
  res.json(result.rows[0]);
}));

// POST /api/quotes/:id/convert - transforme le devis en facture réelle (déduit le stock cette fois)
router.post('/:id/convert', asyncHandler(async (req, res) => {
  const quoteResult = await pool.query('SELECT * FROM quotes WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  const quote = quoteResult.rows[0];
  if (!quote) return res.status(404).json({ error: 'Devis introuvable.' });
  if (quote.status === 'converted') return res.status(400).json({ error: 'Ce devis a déjà été converti en facture.' });

  const quoteItems = await pool.query('SELECT * FROM quote_items WHERE quote_id = $1', [quote.id]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let total = 0;
    const prepared = [];
    for (const item of quoteItems.rows) {
      const productResult = await client.query('SELECT * FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE', [item.product_id, req.user.id]);
      const product = productResult.rows[0];
      if (!product) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Produit introuvable (id ${item.product_id}).` });
      }
      if (product.quantity < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Stock insuffisant pour "${product.name}" (disponible : ${product.quantity}, demandé : ${item.quantity}).`,
        });
      }
      total += Number(item.subtotal);
      prepared.push({ product, item });
    }

    const invoiceNumber = generateInvoiceNumber();
    const invoiceResult = await client.query(
      `INSERT INTO invoices (invoice_number, customer_id, customer_name, customer_contact, status, total_amount, user_id)
       VALUES ($1,$2,$3,$4,'unpaid',$5,$6) RETURNING *`,
      [invoiceNumber, quote.customer_id, quote.customer_name, quote.customer_contact, total, req.user.id]
    );
    const invoice = invoiceResult.rows[0];

    for (const p of prepared) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, cost_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoice.id, p.product.id, p.item.product_name, p.item.quantity, p.item.unit_price, p.product.cost_price || 0, p.item.subtotal]
      );

      const newQuantity = p.product.quantity - p.item.quantity;
      await client.query('UPDATE products SET quantity = $1, updated_at = NOW() WHERE id = $2', [newQuantity, p.product.id]);

      await client.query(
        `INSERT INTO stock_movements (product_id, type, quantity, reason, user_id, invoice_id)
         VALUES ($1,'OUT',$2,$3,$4,$5)`,
        [p.product.id, p.item.quantity, `Facture ${invoiceNumber} (devis ${quote.quote_number})`, req.user.id, invoice.id]
      );
    }

    await client.query(
      "UPDATE quotes SET status = 'converted', converted_invoice_id = $1 WHERE id = $2",
      [invoice.id, quote.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ invoice, quote_id: quote.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
