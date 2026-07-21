const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name, s.name AS supplier_name
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id
`;

// Génère un identifiant technique unique (non exposé dans l'interface utilisateur)
function generateSku() {
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PRD-${time}-${rand}`;
}

// Vérifie qu'une catégorie/un fournisseur appartient bien au compte connecté
// (empêche de rattacher un produit à une catégorie/un fournisseur d'un autre compte).
async function assertOwnedOrNull(table, id, userId) {
  if (!id) return null;
  const result = await pool.query(`SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (result.rows.length === 0) {
    const err = new Error(`${table === 'categories' ? 'Catégorie' : 'Fournisseur'} introuvable.`);
    err.status = 400;
    throw err;
  }
  return id;
}

// GET /api/products?search=&category_id=&low_stock=true
router.get('/', asyncHandler(async (req, res) => {
  const { search, category_id, low_stock } = req.query;
  const clauses = ['p.user_id = $1'];
  const params = [req.user.id];

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }
  if (category_id) {
    params.push(category_id);
    clauses.push(`p.category_id = $${params.length}`);
  }
  if (low_stock === 'true') {
    clauses.push(`p.quantity <= p.min_threshold`);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;
  const result = await pool.query(`${PRODUCT_SELECT} ${where} ORDER BY p.name ASC`, params);
  res.json(result.rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1 AND p.user_id = $2`, [req.params.id, req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Produit introuvable.' });
  res.json(result.rows[0]);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, description, category_id, supplier_id, unit, price, cost_price, quantity, min_threshold } = req.body;
  if (!name) return res.status(400).json({ error: 'name est requis.' });

  try {
    await assertOwnedOrNull('categories', category_id, req.user.id);
    await assertOwnedOrNull('suppliers', supplier_id, req.user.id);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  let sku = generateSku();
  for (let attempts = 0; attempts < 5; attempts++) {
    const clash = await pool.query('SELECT id FROM products WHERE sku = $1', [sku]);
    if (clash.rows.length === 0) break;
    sku = generateSku();
  }

  const initialQuantity = Number(quantity) || 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO products (name, sku, description, category_id, supplier_id, unit, price, cost_price, quantity, min_threshold, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        name, sku, description || null, category_id || null, supplier_id || null,
        unit || 'unité', price || 0, cost_price || 0, initialQuantity, min_threshold || 0, req.user.id,
      ]
    );
    const product = result.rows[0];

    // Enregistre automatiquement le stock initial comme un mouvement d'entrée,
    // pour que l'historique des mouvements reflète toujours la réalité du stock.
    if (initialQuantity > 0) {
      await client.query(
        `INSERT INTO stock_movements (product_id, type, quantity, reason, user_id)
         VALUES ($1,'IN',$2,$3,$4)`,
        [product.id, initialQuantity, 'Stock initial (création du produit)', req.user.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(product);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: "Conflit d'identifiant technique, merci de réessayer." });
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const { name, description, category_id, supplier_id, unit, price, cost_price, min_threshold } = req.body;

  try {
    await assertOwnedOrNull('categories', category_id, req.user.id);
    await assertOwnedOrNull('suppliers', supplier_id, req.user.id);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const result = await pool.query(
    `UPDATE products SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       category_id = $3,
       supplier_id = $4,
       unit = COALESCE($5, unit),
       price = COALESCE($6, price),
       cost_price = COALESCE($7, cost_price),
       min_threshold = COALESCE($8, min_threshold),
       updated_at = NOW()
     WHERE id = $9 AND user_id = $10 RETURNING *`,
    [name, description, category_id || null, supplier_id || null, unit, price, cost_price, min_threshold, req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Produit introuvable.' });
  res.json(result.rows[0]);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM products WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Produit introuvable.' });
  res.status(204).send();
}));

module.exports = router;
