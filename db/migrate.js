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
    console.error('❌ Erreur lors de la migration :');
    console.error('  message :', err.message || '(vide)');
    console.error('  code    :', err.code || '(aucun)');
    console.error('  detail  :', err.detail || '(aucun)');
    console.error('  stack   :', err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();