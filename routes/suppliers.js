const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM suppliers WHERE user_id = $1 ORDER BY name ASC',
    [req.user.id]
  );
  res.json(result.rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, contact_name, email, phone, address } = req.body;
  if (!name) return res.status(400).json({ error: 'name est requis.' });
  const result = await pool.query(
    'INSERT INTO suppliers (name, contact_name, email, phone, address, user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [name, contact_name || null, email || null, phone || null, address || null, req.user.id]
  );
  res.status(201).json(result.rows[0]);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, contact_name, email, phone, address } = req.body;
  const result = await pool.query(
    `UPDATE suppliers SET
       name = COALESCE($1, name),
       contact_name = COALESCE($2, contact_name),
       email = COALESCE($3, email),
       phone = COALESCE($4, phone),
       address = COALESCE($5, address)
     WHERE id = $6 AND user_id = $7 RETURNING *`,
    [name, contact_name, email, phone, address, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  res.json(result.rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM suppliers WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Fournisseur introuvable.' });
  res.status(204).send();
}));

module.exports = router;
