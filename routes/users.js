const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');
const { adminOnly } = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);
router.use(adminOnly);

// GET /api/users
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, email, phone, created_at FROM users ORDER BY created_at'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Kullanıcı listeleme hatası:', err);
    res.status(500).json({ error: 'Kullanıcılar alınamadı' });
  }
});

// POST /api/users
router.post('/', async (req, res) => {
  try {
    const { username, pin, role, email, phone } = req.body;
    if (!username || !pin) {
      return res.status(400).json({ error: 'Kullanıcı adı ve PIN zorunludur' });
    }
    if (!/^\d{4}$/.test(pin.toString())) {
      return res.status(400).json({ error: 'PIN 4 haneli bir sayı olmalıdır' });
    }

    const pinHash = await bcrypt.hash(pin.toString(), 10);
    const result = await pool.query(
      `INSERT INTO users (username, pin_hash, role, email, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, role, email, phone, created_at`,
      [username, pinHash, role || 'standard', email || null, phone || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten mevcut' });
    }
    console.error('Kullanıcı ekleme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı eklenemedi' });
  }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, pin, role, email, phone } = req.body;

    let query, params;
    if (pin) {
      if (!/^\d{4}$/.test(pin.toString())) {
        return res.status(400).json({ error: 'PIN 4 haneli bir sayı olmalıdır' });
      }
      const pinHash = await bcrypt.hash(pin.toString(), 10);
      query = `UPDATE users SET username=$1, pin_hash=$2, role=$3, email=$4, phone=$5
               WHERE id=$6 RETURNING id, username, role, email, phone, created_at`;
      params = [username, pinHash, role || 'standard', email || null, phone || null, id];
    } else {
      query = `UPDATE users SET username=$1, role=$2, email=$3, phone=$4
               WHERE id=$5 RETURNING id, username, role, email, phone, created_at`;
      params = [username, role || 'standard', email || null, phone || null, id];
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Bu kullanıcı adı zaten mevcut' });
    }
    console.error('Kullanıcı güncelleme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı güncellenemedi' });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Kendinizi silemezsiniz' });
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    res.json({ message: 'Kullanıcı silindi' });
  } catch (err) {
    console.error('Kullanıcı silme hatası:', err);
    res.status(500).json({ error: 'Kullanıcı silinemedi' });
  }
});

module.exports = router;
