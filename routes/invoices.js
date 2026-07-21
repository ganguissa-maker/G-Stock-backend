const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

function generateInvoiceNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `FAC-${y}${m}-${rand}`;
}

// GET /api/invoices - liste des factures du compte connecté
router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT i.*, u.name AS user_name FROM invoices i
     LEFT JOIN users u ON u.id = i.user_id
     WHERE i.user_id = $1
     ORDER BY i.created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json(result.rows);
}));

// GET /api/invoices/:id - détail d'une facture (uniquement si elle appartient au compte connecté)
router.get('/:id', asyncHandler(async (req, res) => {
  const invoiceResult = await pool.query(
    `SELECT i.*, u.name AS user_name FROM invoices i
     LEFT JOIN users u ON u.id = i.user_id WHERE i.id = $1 AND i.user_id = $2`,
    [req.params.id, req.user.id]
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) return res.status(404).json({ error: 'Facture introuvable.' });
  const items = await pool.query(
    'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC',
    [req.params.id]
  );
  const payments = await pool.query(
    'SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY payment_date ASC',
    [req.params.id]
  );
  const balanceDue = Math.max(0, Number(invoice.total_amount) - Number(invoice.amount_paid));
  res.json({ ...invoice, items: items.rows, payments: payments.rows, balance_due: balanceDue });
}));

// POST /api/invoices  { customer_id?, customer_name, customer_contact, items: [{ product_id, quantity, unit_price? }] }
// Crée la facture ET déduit automatiquement le stock des produits concernés (uniquement les siens).
// Si le client a déjà une dette en cours, elle est automatiquement ajoutée au montant
// des nouveaux achats (total = achats + dette reportée), et les anciennes factures
// impayées correspondantes sont soldées (le solde est transféré sur la nouvelle facture,
// pour ne jamais compter la même dette deux fois).
router.post('/', asyncHandler(async (req, res) => {
  const { customer_id, customer_name, customer_contact, items } = req.body;

  if (!customer_name) {
    return res.status(400).json({ error: 'customer_name est requis.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'La facture doit contenir au moins un article.' });
  }
  for (const it of items) {
    if (!it.product_id || !it.quantity || Number(it.quantity) <= 0) {
      return res.status(400).json({ error: 'Chaque article doit avoir un product_id et une quantity > 0.' });
    }
  }

  // Si un client persistant est indiqué, vérifier qu'il appartient bien au compte connecté
  if (customer_id) {
    const customerCheck = await pool.query('SELECT id FROM customers WHERE id = $1 AND user_id = $2', [customer_id, req.user.id]);
    if (customerCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Client introuvable.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let purchaseAmount = 0;
    const prepared = [];

    // 1) Vérifier que chaque produit appartient bien au compte connecté et que le stock est suffisant
    for (const it of items) {
      const productResult = await client.query(
        'SELECT * FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [it.product_id, req.user.id]
      );
      const product = productResult.rows[0];
      if (!product) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Produit introuvable (id ${it.product_id}).` });
      }
      const quantity = Number(it.quantity);
      if (product.quantity < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Stock insuffisant pour "${product.name}" (disponible : ${product.quantity}, demandé : ${quantity}).`,
        });
      }
      const unitPrice = it.unit_price !== undefined && it.unit_price !== null ? Number(it.unit_price) : Number(product.price);
      const subtotal = Math.round(unitPrice * quantity * 100) / 100;
      purchaseAmount += subtotal;
      prepared.push({ product, quantity, unitPrice, subtotal });
    }

    // 2) Récupérer la dette actuelle du client (s'il est enregistré) pour la reporter sur cette facture
    let previousDebt = 0;
    let debtInvoices = [];
    if (customer_id) {
      const debtResult = await client.query(
        `SELECT id, invoice_number, total_amount, amount_paid, (total_amount - amount_paid) AS balance_due
         FROM invoices
         WHERE customer_id = $1 AND user_id = $2 AND status != 'cancelled' AND (total_amount - amount_paid) > 0.01
         FOR UPDATE`,
        [customer_id, req.user.id]
      );
      debtInvoices = debtResult.rows;
      previousDebt = debtInvoices.reduce((sum, inv) => sum + Number(inv.balance_due), 0);
    }

    const total = Math.round((purchaseAmount + previousDebt) * 100) / 100;

    // 3) Créer la facture (total = achats + dette reportée)
    const invoiceNumber = generateInvoiceNumber();
    const invoiceResult = await client.query(
      `INSERT INTO invoices (invoice_number, customer_id, customer_name, customer_contact, status, total_amount, previous_debt, user_id)
       VALUES ($1,$2,$3,$4,'unpaid',$5,$6,$7) RETURNING *`,
      [invoiceNumber, customer_id || null, customer_name, customer_contact || null, total, previousDebt, req.user.id]
    );
    const invoice = invoiceResult.rows[0];

    // 4) Pour chaque ligne : enregistrer l'article, déduire le stock, tracer le mouvement
    for (const p of prepared) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, cost_price, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [invoice.id, p.product.id, p.product.name, p.quantity, p.unitPrice, p.product.cost_price || 0, p.subtotal]
      );

      const newQuantity = p.product.quantity - p.quantity;
      await client.query(
        'UPDATE products SET quantity = $1, updated_at = NOW() WHERE id = $2',
        [newQuantity, p.product.id]
      );

      await client.query(
        `INSERT INTO stock_movements (product_id, type, quantity, reason, user_id, invoice_id)
         VALUES ($1,'OUT',$2,$3,$4,$5)`,
        [p.product.id, p.quantity, `Facture ${invoiceNumber}`, req.user.id, invoice.id]
      );
    }

    // 5) Solder les anciennes factures impayées : leur dette est transférée sur la nouvelle facture,
    // pour ne jamais la compter deux fois dans le solde dû du client.
    for (const debtInvoice of debtInvoices) {
      const carriedAmount = Number(debtInvoice.balance_due);
      await client.query(
        'INSERT INTO invoice_payments (invoice_id, amount, note, user_id) VALUES ($1,$2,$3,$4)',
        [debtInvoice.id, carriedAmount, `Reporté sur la facture ${invoiceNumber}`, req.user.id]
      );
      await client.query(
        "UPDATE invoices SET amount_paid = total_amount, status = 'paid' WHERE id = $1",
        [debtInvoice.id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...invoice,
      purchase_amount: purchaseAmount,
      balance_due: total,
      items: prepared.map((p) => ({
        product_id: p.product.id,
        product_name: p.product.name,
        quantity: p.quantity,
        unit_price: p.unitPrice,
        cost_price: p.product.cost_price || 0,
        subtotal: p.subtotal,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// PUT /api/invoices/:id/status  { status: 'unpaid' | 'paid' | 'cancelled' }
router.put('/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['unpaid', 'paid', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: "status doit être 'unpaid', 'paid' ou 'cancelled'." });
  }
  const result = await pool.query(
    'UPDATE invoices SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
    [status, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Facture introuvable.' });
  res.json(result.rows[0]);
}));

// POST /api/invoices/:id/payments  { amount, note? }
// Enregistre un paiement partiel ou total sur une facture existante (dette client).
router.post('/:id/payments', asyncHandler(async (req, res) => {
  const { amount, note } = req.body;
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount doit être supérieur à 0.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceResult = await client.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.user.id]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Facture introuvable.' });
    }
    if (invoice.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cette facture est annulée.' });
    }

    const currentBalance = Number(invoice.total_amount) - Number(invoice.amount_paid);
    if (Number(amount) > currentBalance + 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Le montant dépasse le solde dû (${currentBalance.toLocaleString('fr-FR')} FCFA).` });
    }

    await client.query(
      'INSERT INTO invoice_payments (invoice_id, amount, note, user_id) VALUES ($1,$2,$3,$4)',
      [invoice.id, amount, note || null, req.user.id]
    );

    const newAmountPaid = Number(invoice.amount_paid) + Number(amount);
    const newStatus = newAmountPaid >= Number(invoice.total_amount) - 0.01 ? 'paid' : invoice.status;

    const updated = await client.query(
      'UPDATE invoices SET amount_paid = $1, status = $2 WHERE id = $3 RETURNING *',
      [newAmountPaid, newStatus, invoice.id]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ...updated.rows[0],
      balance_due: Math.max(0, Number(updated.rows[0].total_amount) - newAmountPaid),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;