const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);

// GET /api/materials
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM materials ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Materyaller alınamadı' });
  }
});

// POST /api/materials
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Materyal adı zorunludur' });
    const result = await pool.query('INSERT INTO materials (name) VALUES ($1) RETURNING *', [name.trim()]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu materyal adı zaten mevcut' });
    res.status(500).json({ error: 'Materyal eklenemedi' });
  }
});

// PUT /api/materials/:id
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Materyal adı zorunludur' });
    const result = await pool.query(
      'UPDATE materials SET name = $1 WHERE id = $2 RETURNING *',
      [name.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Materyal bulunamadı' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu materyal adı zaten mevcut' });
    res.status(500).json({ error: 'Materyal güncellenemedi' });
  }
});

// DELETE /api/materials/:id
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM materials WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Materyal bulunamadı' });
    res.json({ message: 'Materyal silindi' });
  } catch (err) {
    res.status(500).json({ error: 'Materyal silinemedi' });
  }
});

module.exports = router;
