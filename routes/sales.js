const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);

// POST /api/sales
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { product_id, quantity_change, sale_date, note } = req.body;

    if (!product_id || quantity_change === undefined || quantity_change === null) {
      return res.status(400).json({ error: 'Ürün ve miktar bilgisi zorunludur' });
    }

    await client.query('BEGIN');

    // Mevcut stoğu al
    const product = await client.query('SELECT stock_quantity FROM products WHERE id = $1 FOR UPDATE', [product_id]);
    if (product.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ürün bulunamadı' });
    }

    const currentStock = product.rows[0].stock_quantity;
    const newStock = Math.max(0, currentStock + quantity_change);

    // Stoğu güncelle
    await client.query('UPDATE products SET stock_quantity = $1, updated_at = NOW() WHERE id = $2', [newStock, product_id]);

    // Satış kaydı ekle
    const saleResult = await client.query(
      `INSERT INTO sales (product_id, quantity_change, sale_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [product_id, quantity_change, sale_date || new Date().toISOString().split('T')[0], note || null, req.user.id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      sale: saleResult.rows[0],
      new_stock: newStock
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Satış hatası:', err);
    res.status(500).json({ error: 'Satış kaydedilemedi' });
  } finally {
    client.release();
  }
});

// GET /api/sales
router.get('/', async (req, res) => {
  try {
    const { date, from, to } = req.query;
    let query = `
      SELECT s.*, p.name AS product_name, p.barcode AS product_barcode,
             pt.name AS product_type_name, p.product_image_url,
             u.username AS created_by_username
      FROM sales s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN product_types pt ON p.product_type_id = pt.id
      LEFT JOIN users u ON s.created_by = u.id
    `;
    const params = [];

    if (date) {
      query += ' WHERE s.sale_date = $1';
      params.push(date);
    } else if (from && to) {
      query += ' WHERE s.sale_date >= $1 AND s.sale_date <= $2';
      params.push(from, to);
    }

    query += ' ORDER BY s.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Satış listeleme hatası:', err);
    res.status(500).json({ error: 'Satışlar alınamadı' });
  }
});

module.exports = router;
