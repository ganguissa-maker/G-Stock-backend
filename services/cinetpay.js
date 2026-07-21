const axios = require('axios');
require('dotenv').config();

const API_BASE = 'https://api-checkout.cinetpay.com/v2';

function isConfigured() {
  return Boolean(process.env.CINETPAY_API_KEY && process.env.CINETPAY_SITE_ID);
}

/**
 * Crée une demande de paiement CinetPay et renvoie l'URL de la page de paiement
 * hébergée (le client y choisit Orange Money, MTN Mobile Money, carte, etc.).
 * Documentation : https://docs.cinetpay.com
 */
async function generatePaymentLink({ transactionId, amount, currency = 'XAF', description, customerName, customerSurname }) {
  if (!isConfigured()) {
    const err = new Error('CinetPay non configuré (CINETPAY_API_KEY / CINETPAY_SITE_ID manquants).');
    err.status = 501;
    throw err;
  }

  const payload = {
    apikey: process.env.CINETPAY_API_KEY,
    site_id: process.env.CINETPAY_SITE_ID,
    transaction_id: transactionId,
    amount,
    currency,
    description: description || 'Abonnement G-STOCK Premium',
    notify_url: process.env.CINETPAY_NOTIFY_URL,
    return_url: process.env.CINETPAY_RETURN_URL,
    channels: 'MOBILE_MONEY', // limite aux moyens mobile money (Orange Money, MTN MoMo...)
    lang: 'fr',
    customer_name: customerSurname || 'Client',
    customer_surname: customerName || 'G-STOCK',
  };

  const { data } = await axios.post(`${API_BASE}/payment`, payload, { timeout: 15000 });

  if (data.code !== '201' || !data.data?.payment_url) {
    const err = new Error(data.message || 'Erreur lors de la création du paiement CinetPay.');
    err.status = 502;
    err.details = data;
    throw err;
  }

  return { paymentUrl: data.data.payment_url, paymentToken: data.data.payment_token };
}

/**
 * Vérifie de façon AUTHORITATIVE le statut d'une transaction directement auprès
 * de CinetPay (ne jamais faire confiance uniquement au contenu d'un webhook,
 * qui pourrait être falsifié — on revérifie toujours côté serveur).
 */
async function checkPaymentStatus(transactionId) {
  if (!isConfigured()) {
    const err = new Error('CinetPay non configuré.');
    err.status = 501;
    throw err;
  }

  const payload = {
    apikey: process.env.CINETPAY_API_KEY,
    site_id: process.env.CINETPAY_SITE_ID,
    transaction_id: transactionId,
  };

  const { data } = await axios.post(`${API_BASE}/payment/check`, payload, { timeout: 15000 });
  return data; // data.data.status: 'ACCEPTED' | 'REFUSED' | 'PENDING' | ...
}

module.exports = { isConfigured, generatePaymentLink, checkPaymentStatus };
