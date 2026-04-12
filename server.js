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
    await pool.query(`ALTER TABLE products ALTER COLUMN product_image_url TYPE TEXT`);
    // Eski ISO timestamp anahtarını temizle (artık kullanılmıyor)
    await pool.query(`DELETE FROM app_settings WHERE key = 'daily_report_sent_at'`);
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

// ── Günlük rapor zamanlayıcı ──────────────────────────────────────────────
function startDailyReportScheduler(appPool) {
  const { sendDailySalesReport, getIstanbulDateTime } = require('./services/notify');
  let isSending = false; // eşzamanlı çift gönderim önleme

  async function checkAndSend() {
    if (isSending) return; // zaten gönderim yapılıyor

    try {
      const { date, hhmm } = getIstanbulDateTime();

      // Ayarlanan saati DB'den al
      const timeRow = await appPool.query("SELECT value FROM app_settings WHERE key = 'daily_report_time'");
      const reportTime = timeRow.rows[0]?.value || null;
      if (!reportTime) return; // saat ayarlanmamış

      // Ayarlanan saat henüz gelmemiş
      if (hhmm < reportTime) return;

      // Bugün zaten başarıyla gönderilmiş mi?
      const sentRow = await appPool.query("SELECT value FROM app_settings WHERE key = 'daily_report_sent_date'");
      const lastSentDate = sentRow.rows[0]?.value || null;
      if (lastSentDate === date) return; // bugün zaten gönderildi

      console.log(`[Günlük Rapor] ${date} ${hhmm} — gönderim başlıyor (ayarlı: ${reportTime})`);
      isSending = true;

      try {
        await sendDailySalesReport();

        // Yalnızca BAŞARILI gönderimden sonra tarihi kaydet
        await appPool.query(
          `INSERT INTO app_settings (key, value) VALUES ('daily_report_sent_date', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
          [date]
        );
        console.log(`[Günlük Rapor] ✓ ${date} raporu başarıyla gönderildi`);
      } catch (sendErr) {
        // Gönderim hata verdi — tarih kaydedilmez, bir sonraki dakika tekrar denenecek
        console.error(`[Günlük Rapor] ✗ Gönderim hatası (tekrar denenecek): ${sendErr.message}`);
      } finally {
        isSending = false;
      }

    } catch (err) {
      isSending = false;
      console.error('[Günlük Rapor Zamanlayıcı] Hata:', err.message);
    }
  }

  // Sunucu başlarken 10 saniye sonra ilk kontrol (deploy sonrası kaçırılan saati yakala)
  setTimeout(checkAndSend, 10000);

  // Her dakika kontrol
  setInterval(checkAndSend, 60 * 1000);

  console.log('✓ Günlük rapor zamanlayıcı başlatıldı');
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
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
  });

  startDailyReportScheduler(appPool);

  app.listen(PORT, () => {
    console.log(`Stok Takip Sistemi - Port: ${PORT}`);
  });
});
