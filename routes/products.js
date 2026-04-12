const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// GET /api/products/:id/image — auth gerektirmez (email istemcileri için)
router.get('/:id/image', async (req, res) => {
  try {
    const result = await pool.query('SELECT product_image_url FROM products WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row?.product_image_url || !row.product_image_url.startsWith('data:')) {
      return res.status(404).send('No image');
    }
    const [header, data] = row.product_image_url.split(',');
    const mimeMatch = header.match(/data:([^;]+)/);
    if (!mimeMatch) return res.status(400).send('Invalid image');
    const buffer = Buffer.from(data, 'base64');
    res.setHeader('Content-Type', mimeMatch[1]);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('Ürün görseli hatası:', err);
    res.status(500).send('Error');
  }
});

router.use(authMiddleware);

// GET /api/products/stats
router.get('/stats', async (req, res) => {
  try {
    const totalValue = await pool.query(
      'SELECT COALESCE(SUM(cost_price * stock_quantity), 0) AS total FROM products'
    );
    const totalSkus = await pool.query('SELECT COUNT(*) AS count FROM products');
    const outOfStock = await pool.query('SELECT COUNT(*) AS count FROM products WHERE stock_quantity = 0');
    const criticalStock = await pool.query(
      'SELECT COUNT(*) AS count FROM products WHERE stock_quantity > 0 AND stock_quantity <= critical_stock'
    );
    const criticalProducts = await pool.query(
      'SELECT id, name, stock_quantity FROM products WHERE stock_quantity > 0 AND stock_quantity <= critical_stock ORDER BY stock_quantity ASC'
    );
    const outOfStockProducts = await pool.query(
      'SELECT id, name FROM products WHERE stock_quantity = 0 ORDER BY name'
    );
    const stockByProduct = await pool.query(
      'SELECT name, stock_quantity, critical_stock FROM products ORDER BY stock_quantity ASC'
    );
    const stockByType = await pool.query(
      `SELECT COALESCE(pt.name, 'Belirtilmemiş') AS type_name, SUM(p.stock_quantity) AS total_stock
       FROM products p LEFT JOIN product_types pt ON p.product_type_id = pt.id
       GROUP BY pt.name ORDER BY total_stock DESC`
    );

    res.json({
      totalValue: parseFloat(totalValue.rows[0].total),
      totalSkus: parseInt(totalSkus.rows[0].count),
      outOfStock: parseInt(outOfStock.rows[0].count),
      criticalStock: parseInt(criticalStock.rows[0].count),
      criticalProducts: criticalProducts.rows,
      outOfStockProducts: outOfStockProducts.rows,
      stockByProduct: stockByProduct.rows,
      stockByType: stockByType.rows
    });
  } catch (err) {
    console.error('Stats hatası:', err);
    res.status(500).json({ error: 'İstatistikler alınamadı' });
  }
});

// GET /api/products
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, pt.name AS product_type_name
       FROM products p
       LEFT JOIN product_types pt ON p.product_type_id = pt.id
       ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Ürün listeleme hatası:', err);
    res.status(500).json({ error: 'Ürünler alınamadı' });
  }
});

// POST /api/products
router.post('/', async (req, res) => {
  try {
    const {
      name, barcode, product_type_id, supplier_name, stock_quantity,
      product_image_url, cost_price, critical_stock, color,
      trendyol_price, trendyol_commission, hepsiburada_price, hepsiburada_commission
    } = req.body;

    if (!name || !barcode) {
      return res.status(400).json({ error: 'Ürün adı ve barkod zorunludur' });
    }

    const result = await pool.query(
      `INSERT INTO products (name, barcode, product_type_id, supplier_name, stock_quantity,
        product_image_url, cost_price, critical_stock, color,
        trendyol_price, trendyol_commission, hepsiburada_price, hepsiburada_commission)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [name, barcode, product_type_id || null, supplier_name || null, stock_quantity || 0,
       product_image_url || null, cost_price || null, critical_stock || 5, color || null,
       trendyol_price || null, trendyol_commission || null,
       hepsiburada_price || null, hepsiburada_commission || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Bu barkod zaten kullanılıyor' });
    }
    console.error('Ürün ekleme hatası:', err);
    res.status(500).json({ error: 'Ürün eklenemedi' });
  }
});

// PUT /api/products/:id
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, barcode, product_type_id, supplier_name, stock_quantity,
      product_image_url, cost_price, critical_stock, color,
      trendyol_price, trendyol_commission, hepsiburada_price, hepsiburada_commission
    } = req.body;

    const result = await pool.query(
      `UPDATE products SET
        name=$1, barcode=$2, product_type_id=$3, supplier_name=$4, stock_quantity=$5,
        product_image_url=$6, cost_price=$7, critical_stock=$8, color=$9,
        trendyol_price=$10, trendyol_commission=$11,
        hepsiburada_price=$12, hepsiburada_commission=$13,
        updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [name, barcode, product_type_id || null, supplier_name || null, stock_quantity || 0,
       product_image_url || null, cost_price || null, critical_stock || 5, color || null,
       trendyol_price || null, trendyol_commission || null,
       hepsiburada_price || null, hepsiburada_commission || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Bu barkod zaten kullanılıyor' });
    }
    console.error('Ürün güncelleme hatası:', err);
    res.status(500).json({ error: 'Ürün güncellenemedi' });
  }
});

// DELETE /api/products/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ürün bulunamadı' });
    }
    res.json({ message: 'Ürün silindi' });
  } catch (err) {
    console.error('Ürün silme hatası:', err);
    res.status(500).json({ error: 'Ürün silinemedi' });
  }
});

module.exports = router;
