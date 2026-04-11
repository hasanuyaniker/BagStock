require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Otomatik Migration ────────────────────────────────────────────────────
async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
  });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
      id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color VARCHAR(100)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(200)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
    console.log('✓ Migration tamam');
  } catch (err) {
    console.error('Migration hatası (kritik değil):', err.message);
  } finally {
    await pool.end();
  }
}

// CORS ayarları
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:' + PORT,
    /\.railway\.app$/
  ],
  credentials: true
}));

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Statik dosyalar
app.use(express.static(path.join(__dirname, 'public')));

// Route'lar
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/product-types', require('./routes/product-types'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/columns', require('./routes/columns'));
app.use('/api/users', require('./routes/users'));
app.use('/api/export', require('./routes/export'));
app.use('/api/stockcount', require('./routes/stockcount'));
app.use('/api/settings', require('./routes/settings'));

// Yedekleme endpoint
app.get('/api/backup', require('./middleware/auth'), async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false });

    const products = (await pool.query('SELECT * FROM products ORDER BY id')).rows;
    const sales = (await pool.query('SELECT * FROM sales ORDER BY id')).rows;
    const productTypes = (await pool.query('SELECT * FROM product_types ORDER BY id')).rows;
    const stockSessions = (await pool.query('SELECT * FROM stock_count_sessions ORDER BY id')).rows;
    const stockItems = (await pool.query('SELECT * FROM stock_count_items ORDER BY id')).rows;

    const backup = {
      exported_at: new Date().toISOString(),
      products,
      sales,
      product_types: productTypes,
      stock_count_sessions: stockSessions,
      stock_count_items: stockItems
    };

    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=yedek_${today}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
    await pool.end();
  } catch (err) {
    console.error('Yedekleme hatası:', err);
    res.status(500).json({ error: 'Yedekleme başarısız' });
  }
});

// SPA fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Hata yakalama
app.use((err, req, res, next) => {
  console.error('Sunucu hatası:', err);
  res.status(500).json({ error: 'Sunucu hatası oluştu' });
});

// Migration çalıştır, sonra sunucuyu başlat
runMigrations().then(() => {
  // SMTP durum kontrolü
  const smtp = {
    SMTP_HOST:   process.env.SMTP_HOST   || '✗ EKSİK',
    SMTP_PORT:   process.env.SMTP_PORT   || '587 (varsayılan)',
    SMTP_USER:   process.env.SMTP_USER   || '✗ EKSİK',
    SMTP_PASS:   process.env.SMTP_PASS   ? '✓ MEVCUT' : '✗ EKSİK',
    SMTP_SECURE: process.env.SMTP_SECURE || 'false (varsayılan)',
  };
  console.log('── SMTP Durumu ──────────────────────────────');
  Object.entries(smtp).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log('─────────────────────────────────────────────');

  app.listen(PORT, () => {
    console.log(`Stok Takip Sistemi - Port: ${PORT}`);
  });
});
