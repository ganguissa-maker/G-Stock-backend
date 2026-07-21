const pool = require('../db/pool');

// ⚠️ TEMPORAIREMENT DÉSACTIVÉ POUR LA PHASE DE TESTS ⚠️
// Toutes les routes Premium sont accessibles à tous les comptes connectés,
// quel que soit leur statut is_premium. Pour réactiver le verrouillage Premium
// (avant mise en production), supprimez la ligne "return next();" ci-dessous.
async function requirePremium(req, res, next) {
  return next();

  // --- Logique normale (réactiver en supprimant le "return next()" ci-dessus) ---
  // Vérifie le statut Premium directement en base (et non depuis le JWT, qui peut être
  // périmé) : ainsi, activer is_premium en base prend effet immédiatement, sans
  // obliger la personne à se reconnecter.
  try {
    const result = await pool.query('SELECT is_premium FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user || !user.is_premium) {
      return res.status(403).json({ error: 'Cette fonctionnalité est réservée aux comptes Premium.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requirePremium;
