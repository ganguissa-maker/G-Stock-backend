const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT c.*,
       COALESCE((SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id), 0)::int AS invoice_count,
       COALESCE((SELECT SUM(i.total_amount) FROM invoices i WHERE i.customer_id = c.id AND i.status != 'cancelled'), 0)::float AS total_spent,
       COALESCE((SELECT SUM(i.total_amount - i.amount_paid) FROM invoices i
                 WHERE i.customer_id = c.id AND i.status != 'cancelled' AND (i.total_amount - i.amount_paid) > 0.01), 0)::float AS balance_due
     FROM customers c
     WHERE c.user_id = $1
     ORDER BY c.name ASC`,
    [req.user.id]
  );
  res.json(result.rows);
}));

// GET /api/customers/:id - fiche client + historique de ses factures (avec solde dû par facture)
router.get('/:id', asyncHandler(async (req, res) => {
  const customerResult = await pool.query(
    'SELECT * FROM customers WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  const customer = customerResult.rows[0];
  if (!customer) return res.status(404).json({ error: 'Client introuvable.' });

  const invoices = await pool.query(
    `SELECT id, invoice_number, total_amount, amount_paid, (total_amount - amount_paid) AS balance_due, status, created_at
     FROM invoices WHERE customer_id = $1 AND user_id = $2
     ORDER BY created_at DESC`,
    [req.params.id, req.user.id]
  );

  const balanceDue = invoices.rows
    .filter((inv) => inv.status !== 'cancelled')
    .reduce((sum, inv) => sum + Number(inv.balance_due), 0);

  res.json({ ...customer, invoices: invoices.rows, balance_due: balanceDue });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: 'name est requis.' });
  const result = await pool.query(
    'INSERT INTO customers (name, phone, email, address, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, phone || null, email || null, address || null, req.user.id]
  );
  res.status(201).json(result.rows[0]);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, phone, email, address } = req.body;
  const result = await pool.query(
    `UPDATE customers SET
       name = COALESCE($1, name),
       phone = $2,
       email = $3,
       address = $4
     WHERE id = $5 AND user_id = $6 RETURNING *`,
    [name, phone || null, email || null, address || null, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Client introuvable.' });
  res.json(result.rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM customers WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Client introuvable.' });
  res.status(204).send();
}));

module.exports = router;
