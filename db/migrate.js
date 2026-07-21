const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sqlPath = path.join(__dirname, '..', 'migrations', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  try {
    console.log('Application du schéma SQL...');
    await pool.query(sql);
    console.log('✅ Migration terminée avec succès.');
  } catch (err) {
    console.error('❌ Erreur lors de la migration :', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
