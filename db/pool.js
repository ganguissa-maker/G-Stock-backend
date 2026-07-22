const { Pool } = require('pg');
require('dotenv').config();

// Sur Render (et la plupart des hébergeurs), la base est fournie via une seule
// variable DATABASE_URL, et la connexion doit se faire en SSL. En local, on
// continue d'utiliser les variables séparées (DB_HOST, DB_USER, etc.) sans SSL.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'stock_app',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    });

pool.on('error', (err) => {
  console.error('Erreur inattendue du pool PostgreSQL', err);
});

module.exports = pool;