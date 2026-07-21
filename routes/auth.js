const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

const PUBLIC_USER_FIELDS = 'id, name, email, is_premium, company_name, company_phone, company_address, created_at';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email et password sont requis.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }
    const hash = await bcrypt.hash(password, 10);
    // Chaque compte est indépendant : il gère uniquement son propre stock,
    // ses propres produits, catégories, fournisseurs, clients et factures.
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING ${PUBLIC_USER_FIELDS}`,
      [name, email, hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la création du compte.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email et password sont requis.' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }
    // Le JWT ne transporte que l'identité ; le statut Premium est toujours
    // revérifié en base à chaque requête (voir middleware/requirePremium.js).
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_premium: user.is_premium,
        company_name: user.company_name,
        company_phone: user.company_phone,
        company_address: user.company_address,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
  }
});

// GET /api/auth/me - toujours lu en base pour refléter un statut Premium
// activé entre-temps, sans obliger à se reconnecter.
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT ${PUBLIC_USER_FIELDS} FROM users WHERE id = $1`, [req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ user: result.rows[0] });
}));

// PUT /api/auth/me - mise à jour du profil (nom, informations entreprise pour les documents PDF)
router.put('/me', authenticate, asyncHandler(async (req, res) => {
  const { name, company_name, company_phone, company_address } = req.body;
  const result = await pool.query(
    `UPDATE users SET
       name = COALESCE($1, name),
       company_name = $2,
       company_phone = $3,
       company_address = $4
     WHERE id = $5 RETURNING ${PUBLIC_USER_FIELDS}`,
    [name, company_name || null, company_phone || null, company_address || null, req.user.id]
  );
  res.json({ user: result.rows[0] });
}));

module.exports = router;
