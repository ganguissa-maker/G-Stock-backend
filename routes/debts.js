const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const requirePremium = require('../middleware/requirePremium');

const router = express.Router();
router.use(authenticate, requirePremium);

// GET /api/debts - liste des clients ayant un solde dû, avec le détail de leurs factures impayées.
// Ne couvre que les clients enregistrés (liés à une fiche client) — les ventes à des
// clients occasionnels (sans fiche) ne sont pas suivies ici.
router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT
       c.id AS customer_id,
       c.name AS customer_name,
       c.phone AS customer_phone,
       COALESCE(SUM(i.total_amount - i.amount_paid), 0)::float AS total_due,
       COUNT(i.id)::int AS unpaid_invoice_count
     FROM customers c
     JOIN invoices i ON i.customer_id = c.id
     WHERE c.user_id = $1 AND i.status != 'cancelled' AND (i.total_amount - i.amount_paid) > 0.01
     GROUP BY c.id, c.name, c.phone
     ORDER BY total_due DESC`,
    [req.user.id]
  );
  res.json(result.rows);
}));

// GET /api/debts/:customerId - détail des factures impayées d'un client précis
router.get('/:customerId', asyncHandler(async (req, res) => {
  const customerCheck = await pool.query('SELECT * FROM customers WHERE id = $1 AND user_id = $2', [req.params.customerId, req.user.id]);
  if (customerCheck.rows.length === 0) return res.status(404).json({ error: 'Client introuvable.' });

  const invoices = await pool.query(
    `SELECT id, invoice_number, total_amount, amount_paid, (total_amount - amount_paid) AS balance_due, status, created_at
     FROM invoices
     WHERE customer_id = $1 AND user_id = $2 AND status != 'cancelled' AND (total_amount - amount_paid) > 0.01
     ORDER BY created_at ASC`,
    [req.params.customerId, req.user.id]
  );

  res.json({ customer: customerCheck.rows[0], invoices: invoices.rows });
}));

module.exports = router;
