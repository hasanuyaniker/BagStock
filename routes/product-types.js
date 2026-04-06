const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);

// GET /api/product-types
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_types ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Ürün tipleri hatası:', err);
    res.status(500).json({ error: 'Ürün tipleri alınamadı' });
  }
});

// POST /api/product-types
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Tip adı zorunludur' });
    }
    const result = await pool.query(
      'INSERT INTO product_types (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Bu tip adı zaten mevcut' });
    }
    console.error('Tip ekleme hatası:', err);
    res.status(500).json({ error: 'Tip eklenemedi' });
  }
});

// DELETE /api/product-types/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM product_types WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tip bulunamadı' });
    }
    res.json({ message: 'Tip silindi' });
  } catch (err) {
    console.error('Tip silme hatası:', err);
    res.status(500).json({ error: 'Tip silinemedi' });
  }
});

module.exports = router;
