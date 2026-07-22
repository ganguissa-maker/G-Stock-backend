const fs = require('fs');
const path = require('path');
const pool = require('./pool');

function logConnectionDiagnostic() {
  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      console.log(`🔎 DATABASE_URL détectée → hôte: ${url.hostname}, port: ${url.port || 5432}, base: ${url.pathname.slice(1)}`);
    } catch {
      console.log('🔎 DATABASE_URL détectée mais invalide (impossible de la parser).');
    }
  } else {
    console.log('🔎 DATABASE_URL est ABSENTE : le code utilise la config locale par défaut (DB_HOST=' + (process.env.DB_HOST || 'localhost') + ').');
    console.log('   → Sur Render, il faut définir DATABASE_URL dans Environment pour se connecter à la vraie base.');
  }
}

async function migrate() {
  const sqlPath = path.join(__dirname, '..', 'migrations', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  logConnectionDiagnostic();
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