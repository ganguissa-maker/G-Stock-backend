const bcrypt = require('bcryptjs');
require('dotenv').config();
const pool = require('./pool');

// Crée un compte de démonstration facultatif (chaque compte est indépendant,
// il n'y a plus de notion d'administrateur ou d'employé).
async function seed() {
  const email = process.env.SEED_ADMIN_EMAIL || 'demo@stock.local';
  const password = process.env.SEED_ADMIN_PASSWORD || 'demo1234';
  const name = process.env.SEED_ADMIN_NAME || 'Compte de démonstration';
  const hash = await bcrypt.hash(password, 10);

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      console.log(`ℹ️  Le compte de démonstration (${email}) existe déjà.`);
      return;
    }
    await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)',
      [name, email, hash]
    );
    console.log(`✅ Compte de démonstration créé : ${email} / mot de passe : ${password}`);
    console.log('⚠️  Pensez à changer ce mot de passe après la première connexion.');
  } catch (err) {
    console.error('❌ Erreur lors du seed :', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
