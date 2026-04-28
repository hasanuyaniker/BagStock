/**
 * Marketplace API Rotaları
 * GET  /api/marketplace/orders          - Senkronize siparişleri listele
 * GET  /api/marketplace/daily-count     - Bugünün sipariş adedi (dashboard KPI)
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
    if (from)     { conditions.push(`mo.order_date >= $${params.push(from)}`); }
    if (to)       { conditions.push(`mo.order_date <= $${params.push(to + ' 23:59:59')}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM marketplace_orders mo ${where}`, params
    );

    const ordersResult = await pool.query(
      `SELECT mo.*,
              json_agg(json_build_object(
                'id', moi.id,
                'item_id', moi.item_id,
                'barcode', moi.barcode,
                'product_id', moi.product_id,
                'product_name', moi.product_name,
                'sku', moi.sku,
                'quantity', moi.quantity,
                'price', moi.price,
                'status', moi.status,
                'raw_status', moi.raw_status,
                'stock_deducted', moi.stock_deducted,
                'p_name', p.name,
                'p_barcode', p.barcode
              ) ORDER BY moi.id) AS items
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
        COUNT(*) FILTER (WHERE status != 'iptal') AS order_count,
        SUM(total_price) FILTER (WHERE status != 'iptal') AS total_revenue
      FROM marketplace_orders
      WHERE order_date::date = $1
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
      totalCount += parseInt(row.order_count) || 0;
      totalRevenue += parseFloat(row.total_revenue) || 0;
    }

    res.json({ byPlatform, totalCount, totalRevenue, date: today });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/marketplace/sync-status ─────────────────────────────────────────
router.get('/sync-status', async (req, res) => {
  try {
    const tySyncRow = await pool.query(
      "SELECT value, updated_at FROM app_settings WHERE key = 'marketplace_sync_trendyol'"
    );
    const hbSyncRow = await pool.query(
      "SELECT value, updated_at FROM app_settings WHERE key = 'marketplace_sync_hepsiburada'"
    );
    const errorRow = await pool.query(
      "SELECT value, updated_at FROM app_settings WHERE key = 'marketplace_sync_error'"
    );

    res.json({
      trendyol: tySyncRow.rows[0] ? {
        lastSync: tySyncRow.rows[0].updated_at,
        info: tySyncRow.rows[0].value
      } : null,
      hepsiburada: hbSyncRow.rows[0] ? {
        lastSync: hbSyncRow.rows[0].updated_at,
        info: hbSyncRow.rows[0].value
      } : null,
      lastError: errorRow.rows[0]?.value || null,
      lastErrorAt: errorRow.rows[0]?.updated_at || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/marketplace/sync ────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  // Async başlat — response'u bloklamaz
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
// SYNC MOTOR — hem scheduler hem manuel route tarafından çağrılır
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
    // Kimlik bilgilerini DB'den al
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

    // Trendyol
    if (creds.trendyol?.supplierId && creds.trendyol?.apiKey && creds.trendyol?.apiSecret) {
      promises.push(syncPlatform(db, 'trendyol', creds.trendyol));
    }

    // Hepsiburada
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
    await db.query(
      `DELETE FROM app_settings WHERE key = 'marketplace_sync_error'`
    );
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

    // Siparişi upsert et
    const orderResult = await client.query(
      `INSERT INTO marketplace_orders
         (platform, order_id, order_number, status, raw_status, customer_name, order_date, total_price, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (platform, order_id) DO UPDATE SET
         status = EXCLUDED.status,
         raw_status = EXCLUDED.raw_status,
         customer_name = EXCLUDED.customer_name,
         total_price = EXCLUDED.total_price,
         updated_at = NOW()
       RETURNING id, stock_deducted`,
      [order.platform, order.order_id, order.order_number,
       order.status, order.raw_status, order.customer_name,
       order.order_date, order.total_price, order.currency || 'TRY']
    );

    const orderId = orderResult.rows[0].id;

    // Order items upsert + stok düşümü
    for (const item of order.items) {
      if (!item.barcode) continue;

      // Ürünü barkodla eşleştir (3 barkod alanını kontrol et)
      const productResult = await client.query(
        `SELECT id, name, stock_quantity, barcode, barcode2, barcode3
         FROM products
         WHERE barcode = $1 OR barcode2 = $1 OR barcode3 = $1
         LIMIT 1`,
        [item.barcode]
      );
      const product = productResult.rows[0] || null;

      // Item upsert
      const itemResult = await client.query(
        `INSERT INTO marketplace_order_items
           (marketplace_order_id, item_id, barcode, product_id, product_name, sku,
            quantity, price, status, raw_status, stock_deducted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, FALSE)
         ON CONFLICT (marketplace_order_id, item_id) DO UPDATE SET
           status = EXCLUDED.status,
           raw_status = EXCLUDED.raw_status,
           product_id = COALESCE(EXCLUDED.product_id, marketplace_order_items.product_id)
         RETURNING id, stock_deducted`,
        [orderId, item.item_id || item.barcode,
         item.barcode, product?.id || null,
         item.product_name, item.sku || '',
         item.quantity, item.price,
         item.status, item.raw_status]
      );

      const itemRow = itemResult.rows[0];
      const alreadyDeducted = itemRow.stock_deducted;

      // Stok düşümü: kargoda + daha önce düşürülmemiş + ürün bulundu
      if (item.should_deduct && !alreadyDeducted && product) {
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
        console.log(`[Marketplace] Stok düşüldü: ${product.name} (${item.barcode}) — ${product.stock_quantity} → ${newStock} (${order.platform} #${order.order_number})`);
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
