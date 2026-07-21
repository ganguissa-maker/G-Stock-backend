const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate, requireAdmin);

// GET /api/users - liste tous les comptes (admin uniquement)
router.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, role, created_at FROM users ORDER BY created_at ASC'
  );
  res.json(result.rows);
}));

// PUT /api/users/:id/role - promouvoir ou rétrograder un utilisateur
router.put('/:id/role', asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!['admin', 'employee'].includes(role)) {
    return res.status(400).json({ error: "role doit être 'admin' ou 'employee'." });
  }
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre rôle.' });
  }
  const result = await pool.query(
    'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role, created_at',
    [role, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json(result.rows[0]);
}));

module.exports = router;
