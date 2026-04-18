const express = require('express');
const router = express.Router();
const multer = require('multer');
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Sadece JPEG, PNG ve WebP dosyaları kabul edilir'), false);
  }
};

// Memory storage — dosya diske yazılmaz, deploy sonrası kaybolmaz
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: (parseInt(process.env.UPLOAD_MAX_SIZE_MB) || 5) * 1024 * 1024 }
});

router.use(authMiddleware);

// POST /api/uploads/product/:id
// Resmi base64 olarak DB'ye kaydeder (Railway ephemeral filesystem sorununu çözer)
router.post('/product/:id', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Dosya yüklenemedi' });
  }
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await pool.query(
      'UPDATE products SET product_image_url = $1, updated_at = NOW() WHERE id = $2',
      [base64, req.params.id]
    );
    res.json({ url: base64 });
  } catch (err) {
    console.error('Görsel güncelleme hatası:', err);
    res.status(500).json({ error: 'Görsel güncellenemedi' });
  }
});

// Multer hata yakalama
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Dosya boyutu çok büyük (max 5MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
