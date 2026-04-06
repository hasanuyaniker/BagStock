const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);
router.use(adminOnly);

// GET /api/stockcount/sessions
router.get('/sessions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.count_date, s.note, s.status, s.applied_at, s.created_at,
             u.username AS created_by_username,
             COUNT(i.id) AS total_products,
             COUNT(CASE WHEN i.counted_quantity > i.system_quantity THEN 1 END) AS increased_count,
             COUNT(CASE WHEN i.counted_quantity < i.system_quantity THEN 1 END) AS decreased_count,
             COUNT(CASE WHEN i.counted_quantity = i.system_quantity THEN 1 END) AS unchanged_count
      FROM stock_count_sessions s
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN stock_count_items i ON i.session_id = s.id
      GROUP BY s.id, u.username
      ORDER BY s.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Sayım oturumları hatası:', err);
    res.status(500).json({ error: 'Sayım oturumları alınamadı' });
  }
});

// GET /api/stockcount/sessions/:id
router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await pool.query(
      `SELECT s.*, u.username AS created_by_username
       FROM stock_count_sessions s LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = $1`, [req.params.id]
    );
    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Sayım bulunamadı' });
    }

    const items = await pool.query(
      `SELECT sci.*, p.barcode, p.product_image_url,
              pt.name AS product_type_name
       FROM stock_count_items sci
       LEFT JOIN products p ON sci.product_id = p.id
       LEFT JOIN product_types pt ON p.product_type_id = pt.id
       WHERE sci.session_id = $1
       ORDER BY sci.product_name_snapshot`,
      [req.params.id]
    );

    res.json({ ...session.rows[0], items: items.rows });
  } catch (err) {
    console.error('Sayım detay hatası:', err);
    res.status(500).json({ error: 'Sayım detayı alınamadı' });
  }
});

// POST /api/stockcount/sessions
router.post('/sessions', async (req, res) => {
  const client = await pool.connect();
  try {
    const { count_date, note } = req.body;
    await client.query('BEGIN');

    const sessionResult = await client.query(
      `INSERT INTO stock_count_sessions (count_date, note, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [count_date || new Date().toISOString().split('T')[0], note || null, req.user.id]
    );
    const sessionId = sessionResult.rows[0].id;

    // Tüm aktif ürünleri ekle
    const products = await client.query(
      'SELECT id, name, stock_quantity, product_image_url FROM products ORDER BY name'
    );

    for (const p of products.rows) {
      await client.query(
        `INSERT INTO stock_count_items (session_id, product_id, product_name_snapshot, product_image_snapshot, system_quantity, counted_quantity)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [sessionId, p.id, p.name, p.product_image_url, p.stock_quantity]
      );
    }

    await client.query('COMMIT');

    // Tam session'ı getir
    const fullSession = await pool.query(
      `SELECT s.*, u.username AS created_by_username
       FROM stock_count_sessions s LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = $1`, [sessionId]
    );
    const items = await pool.query(
      'SELECT * FROM stock_count_items WHERE session_id = $1 ORDER BY product_name_snapshot',
      [sessionId]
    );

    res.status(201).json({ ...fullSession.rows[0], items: items.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Sayım oluşturma hatası:', err);
    res.status(500).json({ error: 'Sayım oluşturulamadı' });
  } finally {
    client.release();
  }
});

// PATCH /api/stockcount/sessions/:id/items
router.patch('/sessions/:id/items', async (req, res) => {
  try {
    const { product_id, counted_quantity } = req.body;

    // Draft kontrolü
    const session = await pool.query('SELECT status FROM stock_count_sessions WHERE id = $1', [req.params.id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Sayım bulunamadı' });
    }
    if (session.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Sadece taslak sayımlar düzenlenebilir' });
    }

    const result = await pool.query(
      `UPDATE stock_count_items SET counted_quantity = $1
       WHERE session_id = $2 AND product_id = $3 RETURNING *`,
      [counted_quantity, req.params.id, product_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sayım kalemi bulunamadı' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Sayım güncelleme hatası:', err);
    res.status(500).json({ error: 'Sayım güncellenemedi' });
  }
});

// POST /api/stockcount/sessions/:id/apply
router.post('/sessions/:id/apply', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const session = await client.query(
      'SELECT * FROM stock_count_sessions WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (session.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sayım bulunamadı' });
    }
    if (session.rows[0].status === 'applied') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Bu sayım zaten uygulanmış' });
    }

    const items = await client.query(
      'SELECT product_id, counted_quantity FROM stock_count_items WHERE session_id = $1',
      [req.params.id]
    );

    let appliedCount = 0;
    for (const item of items.rows) {
      await client.query(
        'UPDATE products SET stock_quantity = $1, updated_at = NOW() WHERE id = $2',
        [item.counted_quantity, item.product_id]
      );
      appliedCount++;
    }

    await client.query(
      "UPDATE stock_count_sessions SET status = 'applied', applied_at = NOW() WHERE id = $1",
      [req.params.id]
    );

    await client.query('COMMIT');

    // Özet hesapla
    const summary = await pool.query(
      `SELECT
         COUNT(CASE WHEN difference > 0 THEN 1 END) AS increased,
         COUNT(CASE WHEN difference < 0 THEN 1 END) AS decreased,
         COUNT(CASE WHEN difference = 0 THEN 1 END) AS unchanged
       FROM stock_count_items WHERE session_id = $1`,
      [req.params.id]
    );

    res.json({
      applied_count: appliedCount,
      summary: summary.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Sayım uygulama hatası:', err);
    res.status(500).json({ error: 'Sayım uygulanamadı' });
  } finally {
    client.release();
  }
});

// DELETE /api/stockcount/sessions/:id
router.delete('/sessions/:id', async (req, res) => {
  try {
    const session = await pool.query('SELECT status FROM stock_count_sessions WHERE id = $1', [req.params.id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Sayım bulunamadı' });
    }
    if (session.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Sadece taslak sayımlar silinebilir' });
    }

    await pool.query('DELETE FROM stock_count_sessions WHERE id = $1', [req.params.id]);
    res.json({ message: 'Sayım silindi' });
  } catch (err) {
    console.error('Sayım silme hatası:', err);
    res.status(500).json({ error: 'Sayım silinemedi' });
  }
});

module.exports = router;
