const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const cinetpay = require('../services/cinetpay');
const monetbil = require('../services/monetbil');

const router = express.Router();

const PROVIDERS = { cinetpay, monetbil };

function getProvider() {
  const name = (process.env.PAYMENT_PROVIDER || 'monetbil').toLowerCase();
  const service = PROVIDERS[name];
  if (!service) throw new Error(`PAYMENT_PROVIDER inconnu : "${name}" (valeurs possibles : cinetpay, monetbil).`);
  return { name, service };
}

function generateTransactionId(userId) {
  return `SUB-${userId}-${Date.now()}`;
}

// POST /api/payments/subscribe - démarre un paiement d'abonnement Premium (authentifié)
router.post('/subscribe', authenticate, asyncHandler(async (req, res) => {
  const { name, service } = getProvider();

  if (!service.isConfigured()) {
    return res.status(501).json({
      error: `Le paiement en ligne (${name}) n'est pas encore configuré sur ce serveur. ` +
             'Contactez l\'administrateur, ou demandez une activation manuelle de votre compte Premium.',
    });
  }

  const amount = Number(process.env.SUBSCRIPTION_PRICE_XAF || 2000);
  const transactionId = generateTransactionId(req.user.id);

  await pool.query(
    `INSERT INTO subscription_payments (user_id, transaction_id, amount, currency, status)
     VALUES ($1,$2,$3,'XAF','pending')`,
    [req.user.id, transactionId, amount]
  );

  try {
    const { paymentUrl } = await service.generatePaymentLink({
      transactionId,
      amount,
      description: 'Abonnement G-STOCK Premium - 1 mois',
      customerName: req.user.name,
      customerEmail: req.user.email,
    });
    res.json({ payment_url: paymentUrl, transaction_id: transactionId });
  } catch (err) {
    await pool.query("UPDATE subscription_payments SET status = 'refused' WHERE transaction_id = $1", [transactionId]);
    res.status(err.status || 502).json({ error: err.message });
  }
}));

// Fonction partagée : active le Premium si le paiement est confirmé.
//
// - CinetPay : revérifie ACTIVEMENT la transaction auprès de leur API avant
//   d'activer quoi que ce soit (source d'information la plus fiable).
// - Monetbil : à défaut d'API de revérification confirmée publiquement, on se
//   base sur les données de la notification reçue (notifiedData), en exigeant
//   que le montant corresponde à celui attendu, et sans jamais retraiter une
//   transaction déjà marquée "accepted".
async function verifyAndApply(transactionId, notifiedData = null) {
  const paymentResult = await pool.query('SELECT * FROM subscription_payments WHERE transaction_id = $1', [transactionId]);
  const payment = paymentResult.rows[0];
  if (!payment) return { found: false };
  if (payment.status === 'accepted') return { found: true, alreadyProcessed: true, payment };

  const { name, service } = getProvider();
  let outcome = 'pending';

  if (name === 'cinetpay') {
    const statusResult = await service.checkPaymentStatus(transactionId);
    const cinetpayStatus = statusResult?.data?.status;
    outcome = cinetpayStatus === 'ACCEPTED' ? 'accepted' : cinetpayStatus === 'REFUSED' ? 'refused' : 'pending';
  } else if (name === 'monetbil') {
    if (notifiedData) {
      const amountMatches = notifiedData.amount === undefined || Math.abs(notifiedData.amount - Number(payment.amount)) < 1;
      outcome = notifiedData.status === 'accepted' && amountMatches ? 'accepted' : notifiedData.status === 'refused' ? 'refused' : 'pending';
    }
    // Sans donnée de notification fraîche, on ne peut pas revérifier activement :
    // le statut reste celui déjà connu en base (pending tant que le webhook
    // notify_url n'a pas été reçu).
  }

  if (outcome === 'accepted') {
    await pool.query(
      "UPDATE subscription_payments SET status = 'accepted', paid_at = NOW() WHERE transaction_id = $1",
      [transactionId]
    );
    await pool.query('UPDATE users SET is_premium = true WHERE id = $1', [payment.user_id]);
    return { found: true, accepted: true, payment };
  }

  if (outcome === 'refused') {
    await pool.query("UPDATE subscription_payments SET status = 'refused' WHERE transaction_id = $1", [transactionId]);
    return { found: true, accepted: false, payment };
  }

  return { found: true, accepted: false, pending: true, payment };
}

// GET /api/payments/verify/:transactionId - vérification déclenchée par le client
// après le retour depuis la page de paiement.
// ⚠️ Avec Monetbil, cette route ne peut confirmer le paiement que si la
// notification (webhook) est déjà arrivée — pensez à exposer notify_url
// publiquement (ex: ngrok en développement) pour des tests fiables.
router.get('/verify/:transactionId', authenticate, asyncHandler(async (req, res) => {
  const paymentCheck = await pool.query(
    'SELECT * FROM subscription_payments WHERE transaction_id = $1 AND user_id = $2',
    [req.params.transactionId, req.user.id]
  );
  if (paymentCheck.rows.length === 0) return res.status(404).json({ error: 'Transaction introuvable.' });

  const result = await verifyAndApply(req.params.transactionId);
  res.json({
    status: result.accepted || result.alreadyProcessed ? 'accepted' : result.pending ? 'pending' : 'refused',
  });
}));

// POST /api/payments/notify - webhook public appelé par le fournisseur de paiement.
// Doit être accessible publiquement en production (URL HTTPS de votre backend déployé).
router.post('/notify', asyncHandler(async (req, res) => {
  const { name, service } = getProvider();

  try {
    if (name === 'cinetpay') {
      const transactionId = req.body.cpm_trans_id || req.body.transaction_id;
      if (!transactionId) return res.status(400).send('missing transaction_id');
      await verifyAndApply(transactionId);
    } else if (name === 'monetbil') {
      const parsed = service.parseNotification(req.body);
      if (!parsed.transactionId) return res.status(400).send('missing transaction_id');
      await verifyAndApply(parsed.transactionId, parsed);
    }
  } catch (err) {
    console.error(`Erreur webhook paiement (${name}) :`, err.message);
  }
  // Réponse HTTP 200 attendue par le fournisseur pour valider la réception.
  res.status(200).send('OK');
}));

// GET /api/payments/history - historique des paiements d'abonnement du compte connecté
router.get('/history', authenticate, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM subscription_payments WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(result.rows);
}));

module.exports = router;
