const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

// GET /api/movements?product_id=
router.get('/', asyncHandler(async (req, res) => {
  const { product_id } = req.query;
  const clauses = ['p.user_id = $1'];
  const params = [req.user.id];
  if (product_id) {
    params.push(product_id);
    clauses.push(`m.product_id = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT m.*, p.name AS product_name, p.sku, u.name AS user_name
     FROM stock_movements m
     JOIN products p ON p.id = m.product_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY m.created_at DESC
     LIMIT 200`,
    params
  );
  res.json(result.rows);
}));

// POST /api/movements  { product_id, type: 'IN'|'OUT', quantity, reason }
router.post('/', asyncHandler(async (req, res) => {
  const { product_id, type, quantity, reason } = req.body;
  if (!product_id || !type || !quantity) {
    return res.status(400).json({ error: 'product_id, type et quantity sont requis.' });
  }
  if (!['IN', 'OUT'].includes(type)) {
    return res.status(400).json({ error: "type doit être 'IN' ou 'OUT'." });
  }
  if (Number(quantity) <= 0) {
    return res.status(400).json({ error: 'quantity doit être supérieur à 0.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE + filtre user_id : on ne peut agir que sur ses propres produits
    const productResult = await client.query(
      'SELECT * FROM products WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [product_id, req.user.id]
    );
    const product = productResult.rows[0];
    if (!product) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produit introuvable.' });
    }

    const delta = type === 'IN' ? Number(quantity) : -Number(quantity);
    const newQuantity = product.quantity + delta;
    if (newQuantity < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Stock insuffisant pour cette sortie.' });
    }

    await client.query('UPDATE products SET quantity = $1, updated_at = NOW() WHERE id = $2', [newQuantity, product_id]);

    const movementResult = await client.query(
      `INSERT INTO stock_movements (product_id, type, quantity, reason, user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [product_id, type, quantity, reason || null, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ movement: movementResult.rows[0], new_quantity: newQuantity });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
