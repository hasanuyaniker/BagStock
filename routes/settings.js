const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Sadece JPEG, PNG ve WebP kabul edilir'), false);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.use(authMiddleware);

// GET /api/settings/logo — logoyu base64 olarak döner
router.get('/logo', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'logo'"
    );
    if (result.rows.length === 0 || !result.rows[0].value) {
      return res.status(404).json({ error: 'Logo bulunamadı' });
    }
    res.json({ logo: result.rows[0].value });
  } catch (err) {
    res.status(500).json({ error: 'Logo alınamadı' });
  }
});

// POST /api/settings/logo — logoyu DB'ye base64 olarak kaydet
router.post('/logo', upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya gerekli' });
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('logo', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [base64]
    );
    res.json({ logo: base64 });
  } catch (err) {
    console.error('Logo kayıt hatası:', err);
    res.status(500).json({ error: 'Logo kaydedilemedi' });
  }
});

module.exports = router;
