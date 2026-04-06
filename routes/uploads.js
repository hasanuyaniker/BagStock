const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// Multer yapılandırması
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req.uploadType === 'logo'
      ? path.join(__dirname, '../public/uploads/logo')
      : path.join(__dirname, '../public/uploads/products');
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    cb(null, name);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Sadece JPEG, PNG ve WebP dosyaları kabul edilir'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: (parseInt(process.env.UPLOAD_MAX_SIZE_MB) || 5) * 1024 * 1024 }
});

router.use(authMiddleware);

// POST /api/uploads/logo
router.post('/logo', (req, res, next) => {
  req.uploadType = 'logo';
  next();
}, upload.single('logo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Dosya yüklenemedi' });
  }
  const url = `/uploads/logo/${req.file.filename}`;
  res.json({ url, filename: req.file.filename });
});

// POST /api/uploads/product/:id
router.post('/product/:id', (req, res, next) => {
  req.uploadType = 'product';
  next();
}, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Dosya yüklenemedi' });
  }
  try {
    const url = `/uploads/products/${req.file.filename}`;
    await pool.query('UPDATE products SET product_image_url = $1, updated_at = NOW() WHERE id = $2', [url, req.params.id]);
    res.json({ url, filename: req.file.filename });
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
