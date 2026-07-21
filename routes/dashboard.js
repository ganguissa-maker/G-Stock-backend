const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(authenticate);

router.get('/stats', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const [productsCount, lowStock, totalValue, recentMovements, invoiceStats, recentInvoices, salesToday] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM products WHERE user_id = $1', [userId]),
    pool.query(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.user_id = $1 AND p.quantity <= p.min_threshold ORDER BY p.quantity ASC LIMIT 20`,
      [userId]
    ),
    pool.query('SELECT COALESCE(SUM(price * quantity), 0)::float AS total FROM products WHERE user_id = $1', [userId]),
    pool.query(
      `SELECT m.*, p.name AS product_name, u.name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE p.user_id = $1
       ORDER BY m.created_at DESC LIMIT 10`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::float AS revenue
       FROM invoices WHERE status != 'cancelled' AND user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT i.*, u.name AS user_name FROM invoices i
       LEFT JOIN users u ON u.id = i.user_id
       WHERE i.user_id = $1
       ORDER BY i.created_at DESC LIMIT 5`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::float AS total
       FROM invoices
       WHERE user_id = $1 AND status != 'cancelled' AND created_at >= CURRENT_DATE`,
      [userId]
    ),
  ]);

  res.json({
    total_products: productsCount.rows[0].count,
    low_stock_products: lowStock.rows,
    low_stock_count: lowStock.rows.length,
    total_stock_value: totalValue.rows[0].total,
    recent_movements: recentMovements.rows,
    total_invoices: invoiceStats.rows[0].count,
    total_revenue: invoiceStats.rows[0].revenue,
    recent_invoices: recentInvoices.rows,
    sales_today_count: salesToday.rows[0].count,
    sales_today_total: salesToday.rows[0].total,
  });
}));

module.exports = router;
