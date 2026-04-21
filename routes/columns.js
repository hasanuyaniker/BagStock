const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);

// GET /api/columns/:tableName
router.get('/:tableName', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT column_key, is_visible, column_order, column_width FROM column_settings WHERE user_id = $1 AND table_name = $2 ORDER BY column_order',
      [req.user.id, req.params.tableName]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Sütun ayarları hatası:', err);
    res.status(500).json({ error: 'Sütun ayarları alınamadı' });
  }
});

// PUT /api/columns/:tableName
router.put('/:tableName', async (req, res) => {
  const client = await pool.connect();
  try {
    const columns = req.body; // [{column_key, is_visible, column_order, column_width}]
    if (!Array.isArray(columns)) {
      return res.status(400).json({ error: 'Geçersiz veri formatı' });
    }

    await client.query('BEGIN');

    for (const col of columns) {
      await client.query(
        `INSERT INTO column_settings (user_id, table_name, column_key, is_visible, column_order, column_width, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, table_name, column_key)
         DO UPDATE SET is_visible = $4, column_order = $5, column_width = $6, updated_at = NOW()`,
        [req.user.id, req.params.tableName, col.column_key, col.is_visible !== false, col.column_order || 0, col.column_width || null]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Sütun ayarları kaydedildi' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Sütun ayarları kayıt hatası:', err);
    res.status(500).json({ error: 'Sütun ayarları kaydedilemedi' });
  } finally {
    client.release();
  }
});

// DELETE /api/columns/:tableName — sütun genişliklerini sıfırla
router.delete('/:tableName', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM column_settings WHERE user_id = $1 AND table_name = $2',
      [req.user.id, req.params.tableName]
    );
    res.json({ message: 'Sütun ayarları sıfırlandı' });
  } catch (err) {
    console.error('Sütun sıfırlama hatası:', err);
    res.status(500).json({ error: 'Sütun ayarları sıfırlanamadı' });
  }
});

module.exports = router;
