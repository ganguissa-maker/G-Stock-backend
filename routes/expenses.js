const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const requirePremium = require('../middleware/requirePremium');

const router = express.Router();
router.use(authenticate, requirePremium);

router.get('/', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const clauses = ['user_id = $1'];
  const params = [req.user.id];
  if (from) { params.push(from); clauses.push(`expense_date >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`expense_date <= $${params.length}`); }
  const result = await pool.query(
    `SELECT * FROM expenses WHERE ${clauses.join(' AND ')} ORDER BY expense_date DESC, id DESC`,
    params
  );
  res.json(result.rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { label, category, amount, expense_date } = req.body;
  if (!label || !amount) return res.status(400).json({ error: 'label et amount sont requis.' });
  const result = await pool.query(
    'INSERT INTO expenses (label, category, amount, expense_date, user_id) VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE),$5) RETURNING *',
    [label, category || null, amount, expense_date || null, req.user.id]
  );
  res.status(201).json(result.rows[0]);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { label, category, amount, expense_date } = req.body;
  const result = await pool.query(
    `UPDATE expenses SET
       label = COALESCE($1, label),
       category = $2,
       amount = COALESCE($3, amount),
       expense_date = COALESCE($4, expense_date)
     WHERE id = $5 AND user_id = $6 RETURNING *`,
    [label, category || null, amount, expense_date || null, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Dépense introuvable.' });
  res.json(result.rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Dépense introuvable.' });
  res.status(204).send();
}));

module.exports = router;
