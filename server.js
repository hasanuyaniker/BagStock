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
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
  });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
      id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color VARCHAR(100)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(200)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
    await pool.query(`ALTER TABLE products ALTER COLUMN product_image_url TYPE TEXT`);
    await pool.query(`ALTER TABLE stock_count_items ALTER COLUMN product_image_snapshot TYPE TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS materials (id SERIAL PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL`);
    await pool.query(`INSERT INTO materials (name) VALUES ('Deri'),('Suni Deri'),('Kumaş'),('Hasır'),('Naylon'),('Süet'),('Diğer') ON CONFLICT (name) DO NOTHING`);
    // Eski ISO timestamp anahtarını temizle (artık kullanılmıyor)
    await pool.query(`DELETE FROM app_settings WHERE key = 'daily_report_sent_at'`);
    // is_active: satışa açık/kapalı alanı
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
    // marketplace: hangi platformdan satıldığı
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS marketplace VARCHAR(20) NOT NULL DEFAULT 'normal'`);
    // 18.04.2026 öncesi satış verilerini tek seferlik temizle
    const cleanedFlag = await pool.query(`SELECT value FROM app_settings WHERE key = 'sales_cleaned_before_20260418'`);
    if (cleanedFlag.rows.length === 0) {
      await pool.query(`DELETE FROM sales WHERE sale_date < '2026-04-18'`);
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('sales_cleaned_before_20260418', 'true') ON CONFLICT (key) DO NOTHING`);
      console.log('✓ 2026-04-18 öncesi satış verileri silindi');
    }
    // 21.04.2026 satış verilerini tek seferlik sil
    const cleaned0421 = await pool.query(`SELECT value FROM app_settings WHERE key = 'sales_cleaned_20260421'`);
    if (cleaned0421.rows.length === 0) {
      await pool.query(`DELETE FROM sales WHERE sale_date = '2026-04-21'`);
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('sales_cleaned_20260421', 'true') ON CONFLICT (key) DO NOTHING`);
      console.log('✓ 21.04.2026 satış verileri silindi');
    }
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
app.use('/api/materials', require('./routes/materials'));
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
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

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

// ── Günlük rapor zamanlayıcı ──────────────────────────────────────────────
function startDailyReportScheduler(appPool) {
  const { sendDailySalesReport, getIstanbulDateTime } = require('./services/notify');
  let isSending = false;

  async function checkAndSend() {
    if (isSending) return;

    try {
      const { date, hhmm } = getIstanbulDateTime();

      // Ayarlanan saati DB'den al
      const timeRow = await appPool.query("SELECT value FROM app_settings WHERE key = 'daily_report_time'");
      const reportTime = (timeRow.rows[0]?.value || '').trim();
      if (!reportTime || !/^\d{2}:\d{2}$/.test(reportTime)) return;

      // Ayarlanan saat henüz gelmemiş — sadece 0-59 dk gecikmeli pencerede gönder
      // (örn. 20:00 ayarlıysa 20:00–20:59 arası gönderir, 21:00'den sonra artık bu gün için yok sayar)
      if (hhmm < reportTime) return;
      const [rH, rM] = reportTime.split(':').map(Number);
      const [cH, cM] = hhmm.split(':').map(Number);
      const diffMin = (cH * 60 + cM) - (rH * 60 + rM);
      if (diffMin > 59) return; // 1 saati geçmişse bugün için gönderme fırsatı kaçtı

      // Bu tarih+saat için daha önce gönderilmiş mi?
      const sentKey = `${date}|${reportTime}`;
      const sentRow = await appPool.query("SELECT value FROM app_settings WHERE key = 'daily_report_sent_key'");
      const lastSentKey = sentRow.rows[0]?.value || null;
      if (lastSentKey === sentKey) return;

      console.log(`[Günlük Rapor] ${date} ${hhmm} — gönderim başlıyor (ayarlı: ${reportTime})`);
      isSending = true;

      try {
        await sendDailySalesReport();
        await appPool.query(
          `INSERT INTO app_settings (key, value) VALUES ('daily_report_sent_key', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
          [sentKey]
        );
        console.log(`[Günlük Rapor] ✓ ${sentKey} başarıyla gönderildi`);
      } catch (sendErr) {
        console.error(`[Günlük Rapor] ✗ Gönderim hatası (tekrar denenecek): ${sendErr.message}`);
      } finally {
        isSending = false;
      }

    } catch (err) {
      isSending = false;
      console.error('[Günlük Rapor Zamanlayıcı] DB hatası:', err.message);
    }
  }

  // Her 30 saniyede bir kontrol (60s yerine — daha güvenilir)
  setInterval(checkAndSend, 30 * 1000);

  // Uygulama (yeniden) başladığında 10 saniye sonra hemen kontrol et
  // → Railway yeniden deploy etse bile zamanlı saat kaçmaz
  setTimeout(checkAndSend, 10 * 1000);

  console.log('✓ Günlük rapor zamanlayıcı başlatıldı (30s aralık + startup check)');
}

// Migration çalıştır, sonra sunucuyu başlat
runMigrations().then(() => {
  // Email bildirim durum kontrolü
  const resendKey = process.env.RESEND_API_KEY;
  console.log('── Email Bildirim Durumu ────────────────────');
  console.log(`  RESEND_API_KEY: ${resendKey ? '✓ MEVCUT' : '✗ EKSİK — bildirimler çalışmaz'}`);
  console.log(`  NOTIFY_FROM: ${process.env.NOTIFY_FROM || 'onboarding@resend.dev (varsayılan)'}`);
  console.log('─────────────────────────────────────────────');

  const appPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
  });

  startDailyReportScheduler(appPool);

  app.listen(PORT, () => {
    console.log(`Stok Takip Sistemi - Port: ${PORT}`);
  });
});
