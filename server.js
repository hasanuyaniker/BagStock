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
    // Çoklu barkod desteği
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode2 VARCHAR(100)`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode3 VARCHAR(100)`);
    // Marketplace sipariş tablosu
    await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_orders (
      id SERIAL PRIMARY KEY,
      platform VARCHAR(20) NOT NULL,
      order_id VARCHAR(100) NOT NULL,
      order_number VARCHAR(100),
      status VARCHAR(30) NOT NULL DEFAULT 'bekliyor',
      raw_status VARCHAR(50),
      customer_name VARCHAR(200),
      order_date TIMESTAMPTZ DEFAULT NOW(),
      total_price NUMERIC(12,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'TRY',
      stock_deducted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(platform, order_id)
    )`);
    // Marketplace sipariş kalemleri tablosu
    await pool.query(`CREATE TABLE IF NOT EXISTS marketplace_order_items (
      id SERIAL PRIMARY KEY,
      marketplace_order_id INTEGER REFERENCES marketplace_orders(id) ON DELETE CASCADE,
      item_id VARCHAR(100) NOT NULL,
      barcode VARCHAR(100),
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name VARCHAR(300),
      sku VARCHAR(100),
      quantity INTEGER NOT NULL DEFAULT 1,
      price NUMERIC(12,2) DEFAULT 0,
      status VARCHAR(30),
      raw_status VARCHAR(50),
      stock_deducted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(marketplace_order_id, item_id)
    )`);
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
app.use('/api/marketplace', require('./routes/marketplace'));

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
  let checkCount = 0;

  async function checkAndSend() {
    if (isSending) return;
    checkCount++;

    let date, hhmm;
    try {
      ({ date, hhmm } = getIstanbulDateTime());
    } catch (e) {
      console.error('[Zamanlayıcı] Saat alınamadı:', e.message);
      return;
    }

    // Her 10 kontrolde bir (≈5 dakikada) durum logu — Railway loglarında görülebilir
    if (checkCount % 10 === 1) {
      console.log(`[Zamanlayıcı] İstanbul: ${date} ${hhmm}`);
    }

    try {
      // Ayarlanan saati DB'den al
      const timeRow = await appPool.query("SELECT value FROM app_settings WHERE key = 'daily_report_time'");
      const reportTime = (timeRow.rows[0]?.value || '').trim();

      if (!reportTime) return; // saat ayarlanmamış
      if (!/^\d{2}:\d{2}$/.test(reportTime)) {
        console.warn(`[Zamanlayıcı] Geçersiz saat formatı DB'de: "${reportTime}"`);
        return;
      }

      // Henüz gelmemiş
      if (hhmm < reportTime) return;

      // sentKey: "YYYY-MM-DD|HH:MM" — saat veya gün değişirse yeni anahtar oluşur
      const sentKey = `${date}|${reportTime}`;
      const sentRow = await appPool.query("SELECT value FROM app_settings WHERE key = 'daily_report_sent_key'");
      const lastSentKey = sentRow.rows[0]?.value || null;

      if (lastSentKey === sentKey) return; // bu gün için zaten gönderildi

      console.log(`[Zamanlayıcı] GÖNDERIM BAŞLIYOR — ${date} ${hhmm} (ayarlı: ${reportTime})`);
      isSending = true;

      try {
        await sendDailySalesReport();
        await appPool.query(
          `INSERT INTO app_settings (key, value) VALUES ('daily_report_sent_key', $1)
           ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
          [sentKey]
        );
        console.log(`[Zamanlayıcı] ✓ Başarıyla gönderildi → ${sentKey}`);
      } catch (sendErr) {
        console.error(`[Zamanlayıcı] ✗ Gönderim hatası (tekrar denenecek): ${sendErr.message}`);
      } finally {
        isSending = false;
      }

    } catch (err) {
      isSending = false;
      console.error('[Zamanlayıcı] DB hatası:', err.message);
    }
  }

  // Her 30 saniyede bir kontrol
  setInterval(checkAndSend, 30 * 1000);

  // App başladığında 10 saniye sonra hemen kontrol
  // (Railway deploy sırasında saat geçmişse bile yakalanır)
  setTimeout(checkAndSend, 10 * 1000);

  console.log('✓ Günlük rapor zamanlayıcı başlatıldı (30s aralık + startup check)');
}

// ── Marketplace senkronizasyon zamanlayıcı ────────────────────────────────────
function startMarketplaceSyncScheduler(appPool) {
  const { runMarketplaceSync } = require('./routes/marketplace');

  async function doSync() {
    try {
      // Kimlik bilgisi var mı kontrol et
      const credRow = await appPool.query(
        "SELECT value FROM app_settings WHERE key = 'marketplace_credentials'"
      );
      if (!credRow.rows.length || !credRow.rows[0].value) return; // yapılandırılmamış

      let creds;
      try { creds = JSON.parse(credRow.rows[0].value); } catch { return; }

      const hasAny = (creds.trendyol?.supplierId && creds.trendyol?.apiKey) ||
                     (creds.hepsiburada?.merchantId && creds.hepsiburada?.apiKey);
      if (!hasAny) return;

      await runMarketplaceSync(appPool);
    } catch (err) {
      console.error('[Marketplace Zamanlayıcı] Hata:', err.message);
    }
  }

  // Her 15 dakikada bir senkronize et
  setInterval(doSync, 15 * 60 * 1000);
  // Başlangıçta 30 saniye sonra ilk senkronizasyon
  setTimeout(doSync, 30 * 1000);
  console.log('✓ Marketplace senkronizasyon zamanlayıcı başlatıldı (15 dakika aralık)');
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
  startMarketplaceSyncScheduler(appPool);

  app.listen(PORT, () => {
    console.log(`Stok Takip Sistemi - Port: ${PORT}`);
  });
});
