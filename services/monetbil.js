const axios = require('axios');
require('dotenv').config();

const API_BASE = 'https://api.monetbil.com';

function isConfigured() {
  return Boolean(process.env.MONETBIL_SERVICE_KEY);
}

/**
 * Crée une demande de paiement Monetbil (widget v2.1) et renvoie l'URL de la
 * page de paiement hébergée (Orange Money, MTN Mobile Money, etc.).
 * Documentation : https://www.monetbil.com/services (après connexion)
 *
 * ⚠️ Les noms de champs ci-dessous sont ceux documentés publiquement par Monetbil
 * pour le widget v2.1. Une fois votre compte marchand activé, comparez-les à la
 * documentation affichée dans votre tableau de bord Monetbil (elle peut varier
 * légèrement selon votre pays/offre) et ajustez si besoin.
 */
async function generatePaymentLink({ transactionId, amount, currency = 'XAF', description, customerName, customerSurname, customerEmail, customerPhone }) {
  if (!isConfigured()) {
    const err = new Error('Monetbil non configuré (MONETBIL_SERVICE_KEY manquant).');
    err.status = 501;
    throw err;
  }

  const payload = {
    amount,
    currency,
    country: process.env.MONETBIL_COUNTRY || 'CM',
    locale: 'fr',
    item_ref: transactionId,
    payment_ref: transactionId,
    first_name: customerSurname || 'Client',
    last_name: customerName || 'G-STOCK',
    email: customerEmail || undefined,
    phone: customerPhone || undefined,
    return_url: process.env.MONETBIL_RETURN_URL || process.env.CINETPAY_RETURN_URL,
    notify_url: process.env.MONETBIL_NOTIFY_URL,
  };

  const { data } = await axios.post(
    `${API_BASE}/widget/v2.1/${process.env.MONETBIL_SERVICE_KEY}`,
    new URLSearchParams(Object.entries(payload).filter(([, v]) => v !== undefined)),
    { timeout: 15000 }
  );

  if (!data.success || !data.payment_url) {
    const err = new Error(data.message || 'Erreur lors de la création du paiement Monetbil.');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return { paymentUrl: data.payment_url };
}

/**
 * Interprète la notification envoyée par Monetbil sur notify_url.
 *
 * ⚠️ IMPORTANT — à confirmer avec la documentation de votre compte Monetbil activé :
 * Monetbil ne publie pas, à notre connaissance, d'API REST séparée pour revérifier
 * une transaction après coup (contrairement à CinetPay). La notification reçue ici
 * est donc la source d'information la plus directe. Pour limiter les risques :
 *  - on n'accepte que si le statut ET le montant reçus correspondent à ce qui est
 *    attendu pour la transaction déjà enregistrée en base (créée par /subscribe),
 *  - on ignore toute notification pour une transaction inconnue ou déjà traitée,
 *  - si Monetbil fournit un champ de signature ("sign") dans votre documentation
 *    activée, ajoutez ici sa vérification avant de faire confiance à la notification.
 */
function parseNotification(body) {
  const transactionId = body.payment_ref || body.item_ref || body.transaction_id;
  const rawStatus = String(body.status || '').toLowerCase();
  const isSuccess = ['success', '1', 'true', 'completed', 'accepted'].includes(rawStatus);
  const isFailure = ['failed', '0', 'false', 'cancelled'].includes(rawStatus);

  return {
    transactionId,
    amount: body.amount !== undefined ? Number(body.amount) : undefined,
    status: isSuccess ? 'accepted' : isFailure ? 'refused' : 'pending',
  };
}

module.exports = { isConfigured, generatePaymentLink, parseNotification };
