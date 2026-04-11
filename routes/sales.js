const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');
const { sendStockAlert } = require('../services/notify');

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

    // Mevcut stoğu al (ürün bilgileriyle birlikte)
    const product = await client.query(
      'SELECT stock_quantity, name, barcode, color, critical_stock, product_image_url FROM products WHERE id = $1 FOR UPDATE',
      [product_id]
    );
    if (product.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ürün bulunamadı' });
    }

    const p = product.rows[0];
    const currentStock = p.stock_quantity;
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

    // Stok uyarısı — commit sonrası async (response'u bloklamaz)
    setImmediate(() => {
      sendStockAlert([{
        name: p.name,
        barcode: p.barcode,
        color: p.color,
        critical_stock: p.critical_stock,
        product_image_url: p.product_image_url,
        prev_stock: currentStock,
        new_stock: newStock
      }]).catch(err => console.error('Bildirim hatası:', err.message));
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
             p.color AS product_color, p.cost_price AS product_cost_price,
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

// GET /api/sales/report — Satış raporu (tarih aralığı, ürün bazlı özet)
router.get('/report', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Başlangıç ve bitiş tarihi gereklidir' });
    }

    // Detaylı satış kayıtları
    const detailResult = await pool.query(`
      SELECT s.sale_date, p.name AS product_name, p.color, p.barcode, p.cost_price,
             s.quantity_change, pt.name AS product_type_name,
             u.username AS created_by_username
      FROM sales s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN product_types pt ON p.product_type_id = pt.id
      LEFT JOIN users u ON s.created_by = u.id
      WHERE s.sale_date >= $1 AND s.sale_date <= $2
      ORDER BY s.sale_date DESC, p.name
    `, [from, to]);

    // Ürün bazlı özet (sadece çıkışlar = satışlar)
    const summaryResult = await pool.query(`
      SELECT p.name AS product_name, p.color, p.barcode, p.cost_price,
             ABS(SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END)) AS total_sold,
             SUM(CASE WHEN s.quantity_change > 0 THEN s.quantity_change ELSE 0 END) AS total_in,
             ABS(SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END)) * COALESCE(p.cost_price, 0) AS total_cost
      FROM sales s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN product_types pt ON p.product_type_id = pt.id
      WHERE s.sale_date >= $1 AND s.sale_date <= $2
      GROUP BY p.id, p.name, p.color, p.barcode, p.cost_price
      HAVING SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END) < 0
      ORDER BY total_sold DESC
    `, [from, to]);

    res.json({
      details: detailResult.rows,
      summary: summaryResult.rows,
      period: { from, to }
    });
  } catch (err) {
    console.error('Satış raporu hatası:', err);
    res.status(500).json({ error: 'Rapor oluşturulamadı' });
  }
});

module.exports = router;
