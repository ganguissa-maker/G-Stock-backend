require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const categoryRoutes = require('./routes/categories');
const supplierRoutes = require('./routes/suppliers');
const productRoutes = require('./routes/products');
const movementRoutes = require('./routes/movements');
const dashboardRoutes = require('./routes/dashboard');
const invoiceRoutes = require('./routes/invoices');
const customerRoutes = require('./routes/customers');
const analyticsRoutes = require('./routes/analytics');
const expenseRoutes = require('./routes/expenses');
const paymentRoutes = require('./routes/payments');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // certains webhooks de paiement postent en form-urlencoded
app.use(morgan('dev'));

// Route racine pour éviter le 404 de Render et des pings HTTP
app.get('/', (req, res) => {
  res.json({
    name: 'G-Stock API',
    status: 'online',
    healthCheck: '/api/health'
  });
});

// Verification d'état de l'API
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Definition des routes API
app.use('/api/auth', authRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/products', productRoutes);
app.use('/api/movements', movementRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/payments', paymentRoutes);

// Gestion des erreurs 404 (pour toute route non définie)
app.use((req, res) => res.status(404).json({ error: 'Route introuvable.' }));

// Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
  console.error('❌ Erreur non gérée :', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ 
    error: "Une erreur serveur est survenue. Vérifiez que la base de données est à jour (npm run migrate)." 
  });
});

// Filet de sécurité supplémentaire
process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesse non gérée :', reason);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 API de gestion de stock démarrée sur le port ${PORT}`);
});