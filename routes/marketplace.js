/**
 * Marketplace API Rotaları
 * GET  /api/marketplace/orders          - Senkronize siparişleri listele
 * GET  /api/marketplace/daily-count     - Bugünün sipariş adedi (dashboard KPI)
 * GET  /api/marketplace/platform-stats  - Platform bazlı istatistikler (son N gün)
 * POST /api/marketplace/sync            - Manuel senkronizasyonu tetikle
 * GET  /api/marketplace/sync-status     - Son senkronizasyon bilgisi
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

router.use(authMiddleware);

// ── GET /api/marketplace/orders ──────────────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const { platform, status, from, to, limit = 100, offset = 0 } = req.query;
    const params = [];
    const conditions = [];

    if (platform) { conditions.push(`mo.platform = $${params.push(platform)}`); }
    // 'iade' filtresi iade_bekliyor ve iade_onaylandi'yı da kapsar
    if (status === 'iade') {
      conditions.push(`mo.status IN ('iade', 'iade_bekliyor', 'iade_onaylandi')`);
    } else if (status) {
      conditions.push(`mo.status = $${params.push(status)}`);
    }
    // DATE() karşılaştırması — saat farkını ortadan kaldırır
    if (from) { conditions.push(`DATE(mo.order_date) >= $${params.push(from)}`); }
    if (to)   { conditions.push(`DATE(mo.order_date) <= $${params.push(to)}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM marketplace_orders mo ${where}`, params
    );

    const ordersResult = await pool.query(
      `SELECT mo.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id',              moi.id,
                    'item_id',         moi.item_id,
                    'barcode',         moi.barcode,
                    'product_id',      moi.product_id,
                    'product_name',    moi.product_name,
                    'sku',             moi.sku,
                    'quantity',        moi.quantity,
                    'price',           moi.price,
                    'status',          moi.status,
                    'raw_status',      moi.raw_status,
                    'status_tr',       moi.status_tr,
                    'stock_deducted',  moi.stock_deducted,
                    'commission_amount', moi.commission_amount,
                    'commission_rate', moi.commission_rate,
                    'cargo_desi',      moi.cargo_desi,
                    'p_name',          p.name,
                    'p_barcode',       p.barcode
                  ) ORDER BY moi.id
                ) FILTER (WHERE moi.id IS NOT NULL),
                '[]'::json
              ) AS items
       FROM marketplace_orders mo
       LEFT JOIN marketplace_order_items moi ON moi.marketplace_order_id = mo.id
       LEFT JOIN products p ON p.id = moi.product_id
       ${where}
       GROUP BY mo.id
       ORDER BY mo.order_date DESC
       LIMIT $${params.push(Number(limit))} OFFSET $${params.push(Number(offset))}`,
      params
    );

    res.json({
      total: parseInt(countResult.rows[0].count),
      orders: ordersResult.rows
    });
  } catch (err) {
    console.error('[Marketplace] Sipariş listeleme hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/daily-count ─────────────────────────────────────────
router.get('/daily-count', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(`
      SELECT
        platform,
        COUNT(*) FILTER (WHERE status NOT IN ('iptal','iade')) AS order_count,
        COALESCE(SUM(total_price) FILTER (WHERE status NOT IN ('iptal','iade')), 0) AS total_revenue
      FROM marketplace_orders
      WHERE DATE(order_date) = $1
      GROUP BY platform
    `, [today]);

    const byPlatform = {};
    let totalCount = 0;
    let totalRevenue = 0;
    for (const row of result.rows) {
      byPlatform[row.platform] = {
        count: parseInt(row.order_count) || 0,
        revenue: parseFloat(row.total_revenue) || 0
      };
      totalCount   += parseInt(row.order_count) || 0;
      totalRevenue += parseFloat(row.total_revenue) || 0;
    }

    res.json({ byPlatform, totalCount, totalRevenue, date: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/platform-stats ──────────────────────────────────────
router.get('/platform-stats', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    const result = await pool.query(`
      WITH mp_data AS (
        -- API üzerinden senkronize edilen marketplace siparişleri
        SELECT platform,
               COUNT(*) AS order_count,
               COALESCE(SUM(total_price), 0) AS total_revenue,
               COALESCE(SUM(commission_amount), 0) AS total_commission,
               COALESCE(AVG(cargo_desi), 0) AS avg_desi
        FROM marketplace_orders
        WHERE DATE(order_date) >= CURRENT_DATE - INTERVAL '${days} days'
          AND status NOT IN ('iptal', 'iade')
        GROUP BY platform
      ),
      manual_data AS (
        -- Manuel girilen platform satışları (API sync ile gelen kayıtlar hariç)
        SELECT COALESCE(s.marketplace, 'normal') AS platform,
               COUNT(*) AS order_count,
               0::numeric AS total_revenue,
               0::numeric AS total_commission,
               0::numeric AS avg_desi
        FROM sales s
        WHERE DATE(s.sale_date) >= CURRENT_DATE - INTERVAL '${days} days'
          AND s.quantity_change < 0
          AND COALESCE(s.marketplace, 'normal') != 'normal'
          AND (s.note IS NULL OR s.note NOT LIKE 'Marketplace #%')
        GROUP BY s.marketplace
      )
      SELECT platform,
             SUM(order_count)      AS order_count,
             SUM(total_revenue)    AS total_revenue,
             SUM(total_commission) AS total_commission,
             COALESCE(AVG(NULLIF(avg_desi, 0)), 0) AS avg_desi
      FROM (
        SELECT * FROM mp_data
        UNION ALL
        SELECT * FROM manual_data
      ) combined
      GROUP BY platform
    `);

    // Her iki platformu her zaman dahil et (veri yoksa 0 göster)
    const KNOWN_PLATFORMS = ['trendyol', 'hepsiburada'];
    const rowMap = {};
    result.rows.forEach(r => { rowMap[r.platform] = r; });
    // Bilinen platformları ekle, DB'de olmayan platformları 0 ile doldur
    result.rows.forEach(r => { if (!KNOWN_PLATFORMS.includes(r.platform)) KNOWN_PLATFORMS.push(r.platform); });
    const rows = KNOWN_PLATFORMS.map(p => rowMap[p] || {
      platform: p, order_count: 0, total_revenue: 0, total_commission: 0, avg_desi: 0
    });

    const totalCount   = rows.reduce((s, r) => s + parseInt(r.order_count),     0);
    const totalRevenue = rows.reduce((s, r) => s + parseFloat(r.total_revenue), 0);

    const byQuantity = rows.map(r => ({
      platform:   r.platform,
      count:      parseInt(r.order_count),
      percentage: totalCount > 0 ? Math.round((parseInt(r.order_count) / totalCount) * 1000) / 10 : 0
    }));

    const byRevenue = rows.map(r => ({
      platform:   r.platform,
      amount:     parseFloat(r.total_revenue),
      percentage: totalRevenue > 0 ? Math.round((parseFloat(r.total_revenue) / totalRevenue) * 1000) / 10 : 0
    }));

    const extras = {};
    rows.forEach(r => {
      extras[r.platform] = {
        totalCommission: parseFloat(r.total_commission) || 0,
        avgDesi:         Math.round((parseFloat(r.avg_desi) || 0) * 10) / 10
      };
    });

    res.json({
      period:       `Son ${days} Gün`,
      byQuantity,
      byRevenue,
      extras,
      totalCount,
      totalRevenue
    });
  } catch (err) {
    console.error('[Marketplace] Platform stats hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/status-counts — platform bazlı durum sayımı ─────────
router.get('/status-counts', async (req, res) => {
  try {
    const { platform, from, to } = req.query;
    const params = [];
    const conditions = [];
    if (platform) conditions.push(`platform = $${params.push(platform)}`);
    if (from)     conditions.push(`DATE(order_date) >= $${params.push(from)}`);
    if (to)       conditions.push(`DATE(order_date) <= $${params.push(to)}`);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT platform, status, COUNT(*) AS cnt FROM marketplace_orders ${where} GROUP BY platform, status`,
      params
    );

    const emptyGroup = () => ({ bekliyor: 0, kargoda: 0, teslim_edildi: 0, iptal: 0, iade: 0, iade_bekliyor: 0, iade_onaylandi: 0 });
    // Her iki platformu her zaman göster (filtre yoksa ikisi de, filtre varsa sadece o)
    const byPlatform = {};
    if (!platform) {
      byPlatform.trendyol    = emptyGroup();
      byPlatform.hepsiburada = emptyGroup();
    }
    const total = emptyGroup();

    result.rows.forEach(r => {
      const n = parseInt(r.cnt);
      if (!byPlatform[r.platform]) byPlatform[r.platform] = emptyGroup();
      const grp = byPlatform[r.platform];

      if (r.status === 'iade_bekliyor') {
        grp.iade += n; grp.iade_bekliyor += n;
        total.iade += n; total.iade_bekliyor += n;
      } else if (r.status === 'iade_onaylandi') {
        grp.iade += n; grp.iade_onaylandi += n;
        total.iade += n; total.iade_onaylandi += n;
      } else if (grp[r.status] !== undefined) {
        grp[r.status] += n;
        total[r.status] += n;
      }
    });

    // Manuel satışları da teslim_edildi olarak ekle
    const manConditions = [`s.quantity_change < 0`, `COALESCE(s.marketplace,'normal') != 'normal'`, `(s.note IS NULL OR s.note NOT LIKE 'Marketplace #%')`];
    const manParams = [];
    if (platform) manConditions.push(`s.marketplace = $${manParams.push(platform)}`);
    if (from)     manConditions.push(`DATE(s.sale_date) >= $${manParams.push(from)}`);
    if (to)       manConditions.push(`DATE(s.sale_date) <= $${manParams.push(to)}`);
    const manWhere = 'WHERE ' + manConditions.join(' AND ');

    const manResult = await pool.query(
      `SELECT COALESCE(s.marketplace,'normal') AS platform, COUNT(*) AS cnt
       FROM sales s ${manWhere} GROUP BY s.marketplace`, manParams
    );
    manResult.rows.forEach(r => {
      if (!byPlatform[r.platform]) byPlatform[r.platform] = emptyGroup();
      const n = parseInt(r.cnt);
      byPlatform[r.platform].teslim_edildi += n;
      total.teslim_edildi += n;
    });

    res.json({ byPlatform, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/manual-orders — sales tablosundaki manuel platform satışları ──
router.get('/manual-orders', async (req, res) => {
  try {
    const { platform, status, from, to, limit = 500, offset = 0 } = req.query;

    // Manuel satışlar sadece teslim_edildi statüsündedir
    if (status && status !== 'teslim_edildi') {
      return res.json({ total: 0, orders: [] });
    }

    const params = [];
    const conditions = [
      `s.quantity_change < 0`,
      `COALESCE(s.marketplace, 'normal') != 'normal'`,
      `(s.note IS NULL OR s.note NOT LIKE 'Marketplace #%')`
    ];
    if (platform) conditions.push(`COALESCE(s.marketplace,'normal') = $${params.push(platform)}`);
    if (from)     conditions.push(`DATE(s.sale_date) >= $${params.push(from)}`);
    if (to)       conditions.push(`DATE(s.sale_date) <= $${params.push(to)}`);
    const where = 'WHERE ' + conditions.join(' AND ');

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM sales s JOIN products p ON p.id = s.product_id ${where}`, params
    );

    const saleParams = [...params, Number(limit), Number(offset)];
    const result = await pool.query(`
      SELECT s.id, COALESCE(s.marketplace,'normal') AS platform,
             s.sale_date, s.note,
             ABS(s.quantity_change) AS quantity,
             p.id AS product_db_id, p.name AS p_name,
             p.barcode, p.color,
             ABS(s.quantity_change) * COALESCE(p.cost_price, 0) AS total_price
      FROM sales s
      JOIN products p ON p.id = s.product_id
      ${where}
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, saleParams);

    const orders = result.rows.map(r => ({
      order_id:      'manual-' + r.id,
      order_number:  'MAN-' + r.id,
      platform:      r.platform,
      status:        'teslim_edildi',
      status_tr:     'Manuel Satış',
      raw_status:    'Manuel Satış',
      order_date:    r.sale_date,
      total_price:   parseFloat(r.total_price) || 0,
      stock_deducted: true,
      _source:       'manual',
      note:          r.note,
      items: [{
        barcode:       r.barcode,
        product_id:    r.product_db_id,
        product_name:  r.p_name,
        p_name:        r.p_name,
        quantity:      parseInt(r.quantity),
        stock_deducted: true
      }]
    }));

    res.json({ total: parseInt(countResult.rows[0].count), orders });
  } catch (err) {
    console.error('[Marketplace] Manuel sipariş hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/sync-status ─────────────────────────────────────────
router.get('/sync-status', async (req, res) => {
  try {
    const [tySyncRow, hbSyncRow, errorRow] = await Promise.all([
      pool.query("SELECT value, updated_at FROM app_settings WHERE key = 'marketplace_sync_trendyol'"),
      pool.query("SELECT value, updated_at FROM app_settings WHERE key = 'marketplace_sync_hepsiburada'"),
      pool.query("SELECT value, updated_at FROM app_settings WHERE key = 'marketplace_sync_error'")
    ]);

    res.json({
      trendyol: tySyncRow.rows[0]
        ? { lastSync: tySyncRow.rows[0].updated_at, info: tySyncRow.rows[0].value }
        : null,
      hepsiburada: hbSyncRow.rows[0]
        ? { lastSync: hbSyncRow.rows[0].updated_at, info: hbSyncRow.rows[0].value }
        : null,
      lastError:   errorRow.rows[0]?.value || null,
      lastErrorAt: errorRow.rows[0]?.updated_at || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/marketplace/orders/:id/desi ───────────────────────────────────
router.patch('/orders/:id/desi', async (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const desi = parseFloat(req.body.desi);
    if (isNaN(id) || isNaN(desi) || desi < 0) {
      return res.status(400).json({ error: 'Geçersiz id veya desi değeri' });
    }
    const result = await pool.query(
      `UPDATE marketplace_orders SET cargo_desi = $1, updated_at = NOW() WHERE id = $2 RETURNING id, cargo_desi`,
      [desi, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sipariş bulunamadı' });
    res.json({ ok: true, id: result.rows[0].id, cargo_desi: result.rows[0].cargo_desi });
  } catch (err) {
    console.error('[Marketplace] Desi güncelleme hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/orders/export ── CSV export ─────────────────────────
router.get('/orders/export', async (req, res) => {
  try {
    const { platform, status, from, to } = req.query;
    const params = [];
    const conditions = [];
    if (platform) conditions.push(`mo.platform = $${params.push(platform)}`);
    if (status === 'iade') {
      conditions.push(`mo.status IN ('iade', 'iade_bekliyor', 'iade_onaylandi')`);
    } else if (status) {
      conditions.push(`mo.status = $${params.push(status)}`);
    }
    if (from) conditions.push(`DATE(mo.order_date) >= $${params.push(from)}`);
    if (to)   conditions.push(`DATE(mo.order_date) <= $${params.push(to)}`);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT mo.platform, mo.order_number, mo.status_tr, mo.raw_status,
              mo.customer_name, mo.order_date, mo.total_price, mo.currency,
              mo.cargo_company, mo.cargo_tracking_number, mo.cargo_desi,
              mo.commission_amount,
              STRING_AGG(
                COALESCE(p.name, moi.product_name, moi.barcode) || ' ×' || moi.quantity::text,
                ' | '
              ) AS urunler
       FROM marketplace_orders mo
       LEFT JOIN marketplace_order_items moi ON moi.marketplace_order_id = mo.id
       LEFT JOIN products p ON p.id = moi.product_id
       ${where}
       GROUP BY mo.id
       ORDER BY mo.order_date DESC`,
      params
    );

    const STATUS_TR = {
      bekliyor: 'Bekliyor', kargoda: 'Kargoda', teslim_edildi: 'Teslim Edildi',
      iptal: 'İptal', iade_bekliyor: 'İade Bekliyor', iade_onaylandi: 'İade Onaylandı', iade: 'İade'
    };

    const header = ['Platform','Sipariş No','Durum','Müşteri','Tarih','Tutar','Kargo Firması','Takip No','Desi','Komisyon','Ürünler'];
    const rows = result.rows.map(r => {
      const dateStr = r.order_date ? new Date(r.order_date).toLocaleDateString('tr-TR') : '';
      const platformLabel = r.platform === 'trendyol' ? 'Trendyol' : r.platform === 'hepsiburada' ? 'Hepsiburada' : r.platform;
      const statusLabel = r.status_tr || STATUS_TR[r.status] || r.raw_status || '';
      return [
        platformLabel,
        r.order_number || '',
        statusLabel,
        r.customer_name || '',
        dateStr,
        r.total_price || 0,
        r.cargo_company || '',
        r.cargo_tracking_number || '',
        r.cargo_desi || '',
        r.commission_amount || '',
        (r.urunler || '').replace(/"/g, '""')
      ].map(v => `"${v}"`).join(',');
    });

    const csv = '﻿' + [header.map(h => `"${h}"`).join(','), ...rows].join('\r\n');
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=siparisler_${today}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('[Marketplace] CSV export hatası:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/marketplace/sync ────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  res.json({ ok: true, message: 'Senkronizasyon başlatıldı' });
  try {
    await runMarketplaceSync(pool);
  } catch (err) {
    console.error('[Marketplace] Manuel sync hatası:', err.message);
  }
});

// ── POST /api/marketplace/test-shipping-email ─────────────────────────────────
// Bugün kargoya verilen tüm siparişleri tek mail ile gönderir
// ── POST /api/marketplace/test-hb-connection — HB API bağlantı testi ────────
router.post('/test-hb-connection', async (req, res) => {
  try {
    const credRow = await pool.query("SELECT value FROM app_settings WHERE key = 'marketplace_credentials'");
    if (!credRow.rows.length) return res.status(400).json({ error: 'HB kimlik bilgileri bulunamadı' });
    let creds = {};
    try { creds = JSON.parse(credRow.rows[0].value); } catch {}
    const hb = creds.hepsiburada;
    if (!hb?.merchantId || !hb?.apiKey) return res.status(400).json({ error: 'HB kimlik bilgileri eksik' });

    // Hepsiburada resmi mail konfirmasyonu:
    //   Basic Auth Username = merchantId
    //   Basic Auth Password = secretKey
    //   User-Agent          = developer username (huflex_dev)
    const developerUsername = hb.username || 'BagStock';
    const basicAuth = Buffer.from(`${hb.merchantId}:${hb.apiKey}`).toString('base64');
    const headers = {
      'Authorization': `Basic ${basicAuth}`,
      'User-Agent':    developerUsername,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    };

    // Test için birden fazla olası URL + path kombinasyonunu dene
    const today = new Date().toISOString().split('T')[0];
    const qp = `status=WAITING_IN_MERCHANT&beginDate=${today}&endDate=${today}&limit=1&offset=0`;
    const candidates = [
      // SIT ortamı — farklı path varyasyonları
      `https://listing-external-sit.hepsiburada.com/orders/merchantid/${hb.merchantId}?${qp}`,
      `https://listing-external-sit.hepsiburada.com/api/orders/merchantid/${hb.merchantId}?${qp}`,
      `https://listing-external-sit.hepsiburada.com/integration/orders/merchantid/${hb.merchantId}?${qp}`,
      // Prod ortamı (mevcut credentials SIT için ama deneyelim)
      `https://listing-external.hepsiburada.com/api/orders/merchantid/${hb.merchantId}?${qp}`,
    ];

    const results = [];
    for (const url of candidates) {
      try {
        console.log(`[HB Test] GET ${url}`);
        const fetchRes = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        const rawText  = await fetchRes.text();
        console.log(`[HB Test] HTTP ${fetchRes.status} — ${url}`);
        results.push({ url, status: fetchRes.status, ok: fetchRes.ok, response: rawText.substring(0, 500) });
        if (fetchRes.ok) break; // Başarılı bulundu, devam etme
      } catch (e) {
        results.push({ url, status: 0, ok: false, response: `Bağlantı hatası: ${e.message}` });
      }
    }

    const best = results.find(r => r.ok) || results[0];
    res.json({
      ok:            best.ok,
      status:        best.status,
      url:           best.url,
      basicAuthUser: hb.merchantId,
      userAgent:     developerUsername,
      response:      best.response,
      allResults:    results
    });
  } catch (err) {
    console.error('[HB Test] Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/marketplace/create-test-hb-order — HB SIT test siparişi ────────
router.post('/create-test-hb-order', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // DB'den rastgele ürün al
      const prodRes = await client.query(
        `SELECT id, name, barcode, barcode2, cost_price FROM products
         WHERE stock_quantity > 0 AND is_active = true
         ORDER BY RANDOM() LIMIT 3`
      );
      const products = prodRes.rows;
      if (products.length === 0) {
        return res.status(400).json({ error: 'Stokta aktif ürün bulunamadı' });
      }

      // Rastgele veri üret
      const NAMES = ['Ayşe Yılmaz','Fatma Kaya','Zeynep Demir','Emine Çelik','Hatice Şahin',
                     'Meryem Arslan','Özlem Kurt','Gülsüm Öztürk','Sevim Aydın','Büşra Doğan'];
      const CARGO = ['Yurtiçi Kargo','MNG Kargo','Aras Kargo','Sürat Kargo','PTT Kargo'];
      const STATUSES = [
        { status:'bekliyor',      status_tr:'Satıcıda Bekliyor',  raw:'WAITING_IN_MERCHANT' },
        { status:'bekliyor',      status_tr:'Paketleme Bekliyor', raw:'PREPARING_FOR_SHIPMENT' },
        { status:'kargoda',       status_tr:'Kargoya Verildi',    raw:'IN_CARGO' },
        { status:'teslim_edildi', status_tr:'Teslim Edildi',      raw:'DELIVERED' },
      ];

      const ts   = Date.now();
      const rand = Math.floor(Math.random() * 9000 + 1000);
      const orderId = `HB-TEST-${ts}-${rand}`;
      const st   = STATUSES[Math.floor(Math.random() * STATUSES.length)];
      const cust = NAMES[Math.floor(Math.random() * NAMES.length)];
      const cargo = CARGO[Math.floor(Math.random() * CARGO.length)];
      const tracking = st.status === 'kargoda' || st.status === 'teslim_edildi'
        ? `TRK${rand}${Math.floor(Math.random()*100000)}`
        : null;

      // 1-3 ürün seç
      const itemCount = Math.min(products.length, Math.floor(Math.random() * 2) + 1);
      const items = products.slice(0, itemCount);
      const totalPrice = items.reduce((s, p) => s + parseFloat(p.cost_price || 0) * 1.3, 0);

      await client.query('BEGIN');

      const orderResult = await client.query(
        `INSERT INTO marketplace_orders
           (platform, order_id, order_number, status, status_tr, raw_status,
            customer_name, order_date, total_price, currency,
            cargo_status, cargo_company, cargo_tracking_number,
            commission_amount, commission_rate, is_returned, kargoda_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,'TRY',$9,$10,$11,$12,$13,false,$14)
         RETURNING id`,
        [
          'hepsiburada', orderId, orderId,
          st.status, st.status_tr, st.raw,
          cust, Math.round(totalPrice * 100) / 100,
          st.raw,
          st.status === 'kargoda' || st.status === 'teslim_edildi' ? cargo : null,
          tracking,
          Math.round(totalPrice * 0.215 * 100) / 100,  // %21.5 komisyon
          21.5,
          st.status === 'kargoda' ? new Date().toISOString() : null
        ]
      );

      const moId = orderResult.rows[0].id;

      for (const p of items) {
        const qty = Math.floor(Math.random() * 2) + 1;
        const itemId = `TEST-${orderId}-${p.id}-${Date.now()}`;
        await client.query(
          `INSERT INTO marketplace_order_items
             (marketplace_order_id, item_id, product_id, barcode, product_name, quantity, price, raw_status, status, stock_deducted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
          [moId, itemId, p.id, p.barcode || '', p.name || '', qty,
           Math.round(parseFloat(p.cost_price || 0) * 1.3 * 100) / 100,
           st.raw, st.status]
        );

        // Kargoda/teslim ise stok düş
        if (st.status === 'kargoda' || st.status === 'teslim_edildi') {
          await client.query(
            `UPDATE products SET stock_quantity = GREATEST(0, stock_quantity - $1), updated_at = NOW()
             WHERE id = $2`,
            [qty, p.id]
          );
          await client.query(
            `UPDATE marketplace_order_items SET stock_deducted = true
             WHERE marketplace_order_id = $1 AND product_id = $2`,
            [moId, p.id]
          );
          await client.query(
            `INSERT INTO sales (product_id, quantity_change, sale_date, marketplace, note)
             VALUES ($1, $2, NOW(), 'hepsiburada', $3)`,
            [p.id, -qty, `Marketplace #${orderId}`]
          );
        }
      }

      await client.query('COMMIT');

      res.json({
        ok: true,
        order: { id: moId, order_id: orderId, status: st.status, status_tr: st.status_tr,
                 customer_name: cust, cargo_company: cargo, tracking, total_price: Math.round(totalPrice*100)/100,
                 items: items.map(p => p.name) }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[HB Test Order] Hata:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/test-hb-orders — HB test siparişlerini listele ───────
router.get('/test-hb-orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mo.id, mo.order_id, mo.order_number, mo.status, mo.status_tr,
              mo.customer_name, mo.order_date, mo.total_price,
              mo.cargo_company, mo.cargo_tracking_number, mo.commission_amount,
              JSON_AGG(JSON_BUILD_OBJECT(
                'name', COALESCE(p.name, moi.product_name),
                'barcode', moi.barcode,
                'quantity', moi.quantity,
                'deducted', moi.stock_deducted
              ) ORDER BY moi.id) AS items
       FROM marketplace_orders mo
       LEFT JOIN marketplace_order_items moi ON moi.marketplace_order_id = mo.id
       LEFT JOIN products p ON p.id = moi.product_id
       WHERE mo.platform = 'hepsiburada' AND mo.order_id LIKE 'HB-TEST-%'
       GROUP BY mo.id
       ORDER BY mo.order_date DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/marketplace/test-hb-orders — tüm test siparişlerini sil ──────
router.delete('/test-hb-orders', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM marketplace_orders WHERE platform='hepsiburada' AND order_id LIKE 'HB-TEST-%'`
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/test-shipping-email', async (req, res) => {
  try {
    const { sendDailyShippingSummary } = require('../services/mailer');
    const result = await sendDailyShippingSummary(pool);
    res.json({ ok: true, message: result.message });
  } catch (err) {
    console.error('[Marketplace] Test e-posta hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.runMarketplaceSync = runMarketplaceSync;

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC MOTOR
// ═══════════════════════════════════════════════════════════════════════════════
let _syncInProgress = false;

async function runMarketplaceSync(poolArg) {
  if (_syncInProgress) {
    console.log('[Marketplace] Senkronizasyon zaten çalışıyor, atlanıyor...');
    return;
  }
  _syncInProgress = true;
  const db = poolArg || pool;

  try {
    const credRow = await db.query(
      "SELECT value FROM app_settings WHERE key = 'marketplace_credentials'"
    );
    if (!credRow.rows.length || !credRow.rows[0].value) {
      console.log('[Marketplace] API kimlik bilgisi girilmemiş, sync atlanıyor.');
      return;
    }

    let creds;
    try { creds = JSON.parse(credRow.rows[0].value); }
    catch { console.error('[Marketplace] Kimlik bilgileri JSON parse hatası'); return; }

    const promises = [];

    if (creds.trendyol?.supplierId && creds.trendyol?.apiKey && creds.trendyol?.apiSecret) {
      promises.push(syncPlatform(db, 'trendyol', creds.trendyol));
    }
    if (creds.hepsiburada?.merchantId && creds.hepsiburada?.apiKey) {
      promises.push(syncPlatform(db, 'hepsiburada', creds.hepsiburada));
    }

    if (promises.length === 0) {
      console.log('[Marketplace] Yapılandırılmış platform yok, sync atlanıyor.');
      return;
    }

    await Promise.allSettled(promises);
  } finally {
    _syncInProgress = false;
  }
}

async function syncPlatform(db, platform, creds) {
  console.log(`[Marketplace] ${platform} sync başlıyor...`);
  try {
    let orders = [];

    if (platform === 'trendyol') {
      const { fetchTrendyolOrders } = require('../services/trendyol');
      orders = await fetchTrendyolOrders(creds, 30);
    } else if (platform === 'hepsiburada') {
      const { fetchHepsiburadaOrders } = require('../services/hepsiburada');
      orders = await fetchHepsiburadaOrders(creds, 30);
    }

    let upserted = 0, deducted = 0;
    for (const order of orders) {
      const { deductCount } = await upsertOrder(db, order);
      upserted++;
      deducted += deductCount;
    }

    // Trendyol Finance — komisyon verilerini senkronize et (sessiz, hata kritik değil)
    if (platform === 'trendyol') {
      try {
        const { syncSettlements } = require('../services/trendyolFinance');
        const finResult = await syncSettlements(db, creds, 30);
        if (finResult.updated > 0) {
          console.log(`[Marketplace] Trendyol Finance: ${finResult.updated} komisyon güncellendi`);
        }
      } catch (finErr) {
        console.warn('[Marketplace] Trendyol Finance sync atlandı:', finErr.message);
      }
    }

    const info = `${upserted} sipariş, ${deducted} stok düşümü`;
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [`marketplace_sync_${platform}`, info]
    );
    console.log(`[Marketplace] ${platform} ✓ ${info}`);

    // Hata kaydını temizle
    await db.query(`DELETE FROM app_settings WHERE key = 'marketplace_sync_error'`);
  } catch (err) {
    console.error(`[Marketplace] ${platform} sync hatası:`, err.message);
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('marketplace_sync_error', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [`[${platform}] ${err.message}`]
    );
  }
}

async function upsertOrder(db, order) {
  const client = await db.connect();
  let deductCount = 0;

  try {
    await client.query('BEGIN');

    // Kargo e-posta bildirimi için: mevcut durumu önceden oku
    let prevStatus = null;
    if (order.status === 'kargoda') {
      const prevRow = await client.query(
        `SELECT status FROM marketplace_orders WHERE platform = $1 AND order_id = $2`,
        [order.platform, order.order_id]
      );
      prevStatus = prevRow.rows[0]?.status || null;
    }

    // Siparişi upsert et (tüm yeni alanlarla)
    // kargoda_at: yeni sipariş kargoda ise şimdiki zamanı JS'de hesapla ($21)
    // $4'ü CASE WHEN içinde reuse etmek PostgreSQL'de tip çakışmasına yol açar
    const kargodaAtInsert = order.status === 'kargoda' ? new Date().toISOString() : null;

    const orderResult = await client.query(
      `INSERT INTO marketplace_orders
         (platform, order_id, order_number, status, status_tr, raw_status,
          customer_name, order_date, total_price, currency,
          cargo_status, cargo_company, cargo_tracking_number, cargo_cost, cargo_desi,
          commission_amount, commission_rate,
          is_returned, return_reason, return_date,
          kargoda_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (platform, order_id) DO UPDATE SET
         -- Terminal durumlar (teslim_edildi, iade_onaylandi) bekliyor/kargoda'ya düşürülemez
         status = CASE
           WHEN marketplace_orders.status IN ('teslim_edildi','iade_onaylandi')
                AND EXCLUDED.status IN ('bekliyor','kargoda','iptal')
           THEN marketplace_orders.status
           ELSE EXCLUDED.status
         END,
         status_tr = CASE
           WHEN marketplace_orders.status IN ('teslim_edildi','iade_onaylandi')
                AND EXCLUDED.status IN ('bekliyor','kargoda','iptal')
           THEN marketplace_orders.status_tr
           ELSE EXCLUDED.status_tr
         END,
         -- kargoda_at: yalnızca bekliyor→kargoda geçişinde set et, sonradan değiştirme
         kargoda_at = CASE
           WHEN EXCLUDED.status = 'kargoda' AND marketplace_orders.status <> 'kargoda'
           THEN NOW()
           ELSE marketplace_orders.kargoda_at
         END,
         raw_status           = EXCLUDED.raw_status,
         customer_name        = EXCLUDED.customer_name,
         total_price          = EXCLUDED.total_price,
         cargo_status         = EXCLUDED.cargo_status,
         cargo_company        = COALESCE(EXCLUDED.cargo_company, marketplace_orders.cargo_company),
         cargo_tracking_number= COALESCE(EXCLUDED.cargo_tracking_number, marketplace_orders.cargo_tracking_number),
         cargo_cost           = COALESCE(EXCLUDED.cargo_cost, marketplace_orders.cargo_cost),
         cargo_desi           = COALESCE(EXCLUDED.cargo_desi, marketplace_orders.cargo_desi),
         commission_amount    = COALESCE(EXCLUDED.commission_amount, marketplace_orders.commission_amount),
         commission_rate      = COALESCE(EXCLUDED.commission_rate, marketplace_orders.commission_rate),
         is_returned          = EXCLUDED.is_returned,
         return_reason        = COALESCE(EXCLUDED.return_reason, marketplace_orders.return_reason),
         return_date          = COALESCE(EXCLUDED.return_date, marketplace_orders.return_date),
         updated_at           = NOW()
       RETURNING id, stock_deducted`,
      [
        order.platform, order.order_id, order.order_number,
        order.status, order.status_tr || order.raw_status, order.raw_status,
        order.customer_name,
        order.order_date, order.total_price, order.currency || 'TRY',
        order.cargo_status   || null,
        order.cargo_company  || null,
        order.cargo_tracking_number || null,
        order.cargo_cost     || null,
        order.cargo_desi     || null,
        order.commission_amount || null,
        order.commission_rate   || null,
        order.is_returned || false,
        order.return_reason  || null,
        order.return_date    || null,
        kargodaAtInsert                           // $21
      ]
    );

    const orderId              = orderResult.rows[0].id;
    const orderAlreadyDeducted = orderResult.rows[0].stock_deducted === true;

    // ── Order-level guard ─────────────────────────────────────────────────────
    // Sipariş daha önce tam olarak işlendiyse stok düşümünü tamamen atla.
    // Bu sayede her deploy/sync'te aynı sipariş tekrar düşüm yapmaz.
    if (orderAlreadyDeducted) {
      // Yine de item meta-verilerini güncelle (durum, komisyon, vb.) ama stok dokunma
      for (const item of (order.items || [])) {
        if (!item.barcode && !item.item_id) continue;
        const productResult = await client.query(
          `SELECT id FROM products WHERE barcode = $1 OR barcode2 = $1 OR barcode3 = $1 LIMIT 1`,
          [item.barcode || '']
        );
        const productId = productResult.rows[0]?.id || null;
        await client.query(
          `INSERT INTO marketplace_order_items
             (marketplace_order_id, item_id, barcode, product_id, product_name, sku,
              quantity, price, status, raw_status, status_tr,
              commission_amount, commission_rate, cargo_desi, stock_deducted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, TRUE)
           ON CONFLICT (marketplace_order_id, item_id) DO UPDATE SET
             status            = EXCLUDED.status,
             raw_status        = EXCLUDED.raw_status,
             status_tr         = EXCLUDED.status_tr,
             product_id        = COALESCE(EXCLUDED.product_id, marketplace_order_items.product_id),
             commission_amount = COALESCE(EXCLUDED.commission_amount, marketplace_order_items.commission_amount),
             commission_rate   = COALESCE(EXCLUDED.commission_rate, marketplace_order_items.commission_rate),
             cargo_desi        = COALESCE(EXCLUDED.cargo_desi, marketplace_order_items.cargo_desi),
             stock_deducted    = TRUE`,
          [
            orderId,
            item.item_id || (item.barcode + '_' + (item.sku || '')),
            item.barcode,
            productId,
            item.product_name,
            item.sku || '',
            item.quantity,
            item.price,
            item.status,
            item.raw_status,
            item.status_tr || item.raw_status,
            item.commission_amount || null,
            item.commission_rate   || null,
            item.cargo_desi        || null
          ]
        );
      }
      await client.query('COMMIT');
    } else {
      // Order items upsert + stok düşümü (yeni sipariş)
      for (const item of (order.items || [])) {
        if (!item.barcode && !item.item_id) continue;

        // Ürünü barkodla eşleştir (3 barkod alanı)
        const productResult = await client.query(
          `SELECT id, name, stock_quantity FROM products
           WHERE barcode = $1 OR barcode2 = $1 OR barcode3 = $1
           LIMIT 1`,
          [item.barcode || '']
        );
        const product = productResult.rows[0] || null;

        const itemResult = await client.query(
          `INSERT INTO marketplace_order_items
             (marketplace_order_id, item_id, barcode, product_id, product_name, sku,
              quantity, price, status, raw_status, status_tr,
              commission_amount, commission_rate, cargo_desi,
              stock_deducted)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, FALSE)
           ON CONFLICT (marketplace_order_id, item_id) DO UPDATE SET
             status            = EXCLUDED.status,
             raw_status        = EXCLUDED.raw_status,
             status_tr         = EXCLUDED.status_tr,
             product_id        = COALESCE(EXCLUDED.product_id, marketplace_order_items.product_id),
             commission_amount = COALESCE(EXCLUDED.commission_amount, marketplace_order_items.commission_amount),
             commission_rate   = COALESCE(EXCLUDED.commission_rate, marketplace_order_items.commission_rate),
             cargo_desi        = COALESCE(EXCLUDED.cargo_desi, marketplace_order_items.cargo_desi)
           RETURNING id, stock_deducted`,
          [
            orderId,
            item.item_id || (item.barcode + '_' + (item.sku || '')),
            item.barcode,
            product?.id || null,
            item.product_name,
            item.sku || '',
            item.quantity,
            item.price,
            item.status,
            item.raw_status,
            item.status_tr || item.raw_status,
            item.commission_amount || null,
            item.commission_rate   || null,
            item.cargo_desi        || null
          ]
        );

        const itemRow = itemResult.rows[0];

        // Stok düşümü
        if (item.should_deduct && !itemRow.stock_deducted && product) {
          const newStock = Math.max(0, product.stock_quantity - item.quantity);
          await client.query(
            'UPDATE products SET stock_quantity = $1, updated_at = NOW() WHERE id = $2',
            [newStock, product.id]
          );
          await client.query(
            'UPDATE marketplace_order_items SET stock_deducted = TRUE WHERE id = $1',
            [itemRow.id]
          );
          // Satış raporlarına da ekle (marketplace kaynağı ile)
          const saleDate = order.order_date
            ? new Date(order.order_date).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];
          await client.query(
            `INSERT INTO sales (product_id, quantity_change, sale_date, note, marketplace)
             VALUES ($1, $2, $3, $4, $5)`,
            [product.id, -item.quantity, saleDate,
             `Marketplace #${order.order_number}`, order.platform]
          );
          deductCount++;
          console.log(`[Marketplace] Stok düşüldü: ${product.name} (${item.barcode}) ${product.stock_quantity}→${newStock} [${order.platform} #${order.order_number}]`);
        }
      }

      // Düşüm yapıldıysa siparişi order-level'de işaretle
      if (deductCount > 0) {
        await client.query(
          `UPDATE marketplace_orders SET stock_deducted = TRUE, updated_at = NOW() WHERE id = $1`,
          [orderId]
        );
      }

      await client.query('COMMIT');
    }

    // Kargoya geçiş bildirimi — sadece bekliyor → kargoda geçişinde
    if (order.status === 'kargoda') {
      console.log(`[Mailer] Kontrol: #${order.order_number} prevStatus=${prevStatus||'(yeni)'} → kargoda`);
    }
    if (order.status === 'kargoda' && prevStatus === 'bekliyor') {
      try {
        console.log(`[Mailer] Email tetiklendi → #${order.order_number}`);
        const { sendShippingNotification } = require('../services/mailer');
        await sendShippingNotification({ ...order, id: orderId });
      } catch (mailErr) {
        console.error('[Marketplace] Kargo e-posta hatası:', mailErr.message);
      }
    }

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { deductCount };
}
