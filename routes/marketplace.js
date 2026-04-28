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
    if (status)   { conditions.push(`mo.status = $${params.push(status)}`); }
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
      SELECT
        platform,
        COUNT(*) AS order_count,
        COALESCE(SUM(total_price), 0) AS total_revenue,
        COALESCE(SUM(commission_amount), 0) AS total_commission,
        COALESCE(AVG(cargo_desi), 0) AS avg_desi
      FROM marketplace_orders
      WHERE
        DATE(order_date) >= CURRENT_DATE - INTERVAL '${days} days'
        AND status NOT IN ('iptal', 'iade')
      GROUP BY platform
    `);

    const rows = result.rows;
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

// ── POST /api/marketplace/sync ────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  res.json({ ok: true, message: 'Senkronizasyon başlatıldı' });
  try {
    await runMarketplaceSync(pool);
  } catch (err) {
    console.error('[Marketplace] Manuel sync hatası:', err.message);
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

    // Siparişi upsert et (tüm yeni alanlarla)
    const orderResult = await client.query(
      `INSERT INTO marketplace_orders
         (platform, order_id, order_number, status, status_tr, raw_status,
          customer_name, order_date, total_price, currency,
          cargo_status, cargo_company, cargo_tracking_number, cargo_cost, cargo_desi,
          commission_amount, commission_rate,
          is_returned, return_reason, return_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (platform, order_id) DO UPDATE SET
         status               = EXCLUDED.status,
         status_tr            = EXCLUDED.status_tr,
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
        order.return_date    || null
      ]
    );

    const orderId = orderResult.rows[0].id;

    // Order items upsert + stok düşümü
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
        deductCount++;
        console.log(`[Marketplace] Stok düşüldü: ${product.name} (${item.barcode}) ${product.stock_quantity}→${newStock} [${order.platform} #${order.order_number}]`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { deductCount };
}
