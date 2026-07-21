const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const requirePremium = require('../middleware/requirePremium');

const router = express.Router();
router.use(authenticate, requirePremium);

// GET /api/analytics/overview
// Regroupe tout ce dont a besoin la page Analyses en un seul appel.
// "profit" = marge brute (ventes - coût des produits vendus).
// "net_profit" = bénéfice réel = marge brute - dépenses de la période (loyer, salaires, etc.).
router.get('/overview', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [revenueByMonth, expensesByMonth, topProducts, worstProducts, currentPeriod, previousPeriod, currentExpenses, previousExpenses] = await Promise.all([
    pool.query(
      `SELECT
         to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS month,
         COALESCE(SUM(ii.subtotal), 0)::float AS revenue,
         COALESCE(SUM((ii.unit_price - ii.cost_price) * ii.quantity), 0)::float AS profit
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.user_id = $1 AND i.status != 'cancelled'
         AND i.created_at >= date_trunc('month', NOW()) - INTERVAL '5 months'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [userId]
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', expense_date), 'YYYY-MM') AS month,
         COALESCE(SUM(amount), 0)::float AS expenses
       FROM expenses
       WHERE user_id = $1 AND expense_date >= date_trunc('month', NOW()) - INTERVAL '5 months'
       GROUP BY 1
       ORDER BY 1 ASC`,
      [userId]
    ),
    pool.query(
      `SELECT ii.product_id, ii.product_name,
         SUM(ii.quantity)::int AS quantity_sold,
         COALESCE(SUM(ii.subtotal), 0)::float AS revenue,
         COALESCE(SUM((ii.unit_price - ii.cost_price) * ii.quantity), 0)::float AS profit
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.user_id = $1 AND i.status != 'cancelled'
       GROUP BY ii.product_id, ii.product_name
       ORDER BY profit DESC
       LIMIT 5`,
      [userId]
    ),
    pool.query(
      `SELECT ii.product_id, ii.product_name,
         SUM(ii.quantity)::int AS quantity_sold,
         COALESCE(SUM(ii.subtotal), 0)::float AS revenue,
         COALESCE(SUM((ii.unit_price - ii.cost_price) * ii.quantity), 0)::float AS profit
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.user_id = $1 AND i.status != 'cancelled'
       GROUP BY ii.product_id, ii.product_name
       ORDER BY profit ASC
       LIMIT 5`,
      [userId]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(ii.subtotal), 0)::float AS revenue,
         COALESCE(SUM((ii.unit_price - ii.cost_price) * ii.quantity), 0)::float AS profit,
         COUNT(DISTINCT i.id)::int AS invoice_count
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.user_id = $1 AND i.status != 'cancelled'
         AND i.created_at >= date_trunc('month', NOW())`,
      [userId]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(ii.subtotal), 0)::float AS revenue,
         COALESCE(SUM((ii.unit_price - ii.cost_price) * ii.quantity), 0)::float AS profit,
         COUNT(DISTINCT i.id)::int AS invoice_count
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.user_id = $1 AND i.status != 'cancelled'
         AND i.created_at >= date_trunc('month', NOW()) - INTERVAL '1 month'
         AND i.created_at < date_trunc('month', NOW())`,
      [userId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS expenses FROM expenses
       WHERE user_id = $1 AND expense_date >= date_trunc('month', NOW())`,
      [userId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::float AS expenses FROM expenses
       WHERE user_id = $1 AND expense_date >= date_trunc('month', NOW()) - INTERVAL '1 month'
         AND expense_date < date_trunc('month', NOW())`,
      [userId]
    ),
  ]);

  // Fusionne CA/marge et dépenses par mois dans une seule série pour le graphique
  const expensesMap = Object.fromEntries(expensesByMonth.rows.map((r) => [r.month, r.expenses]));
  const revenueMonths = revenueByMonth.rows.map((r) => r.month);
  const allMonths = Array.from(new Set([...revenueMonths, ...expensesByMonth.rows.map((r) => r.month)])).sort();
  const revenueMap = Object.fromEntries(revenueByMonth.rows.map((r) => [r.month, r]));

  const monthly = allMonths.map((month) => {
    const rev = revenueMap[month] || { revenue: 0, profit: 0 };
    const exp = expensesMap[month] || 0;
    return {
      month,
      revenue: rev.revenue,
      profit: rev.profit,
      expenses: exp,
      net_profit: rev.profit - exp,
    };
  });

  const current = currentPeriod.rows[0];
  const previous = previousPeriod.rows[0];
  const currentExp = currentExpenses.rows[0].expenses;
  const previousExp = previousExpenses.rows[0].expenses;

  res.json({
    monthly,
    top_products: topProducts.rows,
    worst_products: worstProducts.rows,
    current_period: {
      ...current,
      expenses: currentExp,
      net_profit: current.profit - currentExp,
    },
    previous_period: {
      ...previous,
      expenses: previousExp,
      net_profit: previous.profit - previousExp,
    },
  });
}));

module.exports = router;
