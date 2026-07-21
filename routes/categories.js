const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM categories WHERE user_id = $1 ORDER BY name ASC',
    [req.user.id]
  );
  res.json(result.rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name est requis.' });
  try {
    const result = await pool.query(
      'INSERT INTO categories (name, description, user_id) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Vous avez déjà une catégorie avec ce nom.' });
    throw err;
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const result = await pool.query(
    `UPDATE categories SET name = COALESCE($1, name), description = COALESCE($2, description)
     WHERE id = $3 AND user_id = $4 RETURNING *`,
    [name, description, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Catégorie introuvable.' });
  res.json(result.rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM categories WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Catégorie introuvable.' });
  res.status(204).send();
}));

module.exports = router;
