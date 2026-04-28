/**
 * Trendyol Finance (Hakediş) API Servisi
 * Endpoint: https://apigw.trendyol.com/integration/finance/sellers/{sellerId}/settlements
 *
 * Satıcının komisyon/hakediş verilerini çekerek sipariş bazlı komisyon bilgilerini günceller.
 */

const axios = require('axios');

const TY_FINANCE_BASE = 'https://apigw.trendyol.com/integration/finance/sellers';

/**
 * Belirtilen tarih aralığı için Trendyol hakediş verilerini çeker
 * @param {string} sellerId
 * @param {string} apiKey
 * @param {string} apiSecret
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {Array} Hakediş kayıtları
 */
async function fetchSettlements(sellerId, apiKey, apiSecret, startDate, endDate) {
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${credentials}`,
    'User-Agent': `${sellerId} - SelfIntegration`,
    'Content-Type': 'application/json'
  };

  const startMs = new Date(startDate).getTime();
  const endMs   = new Date(endDate).getTime();

  const allItems = [];
  let page = 0;
  const size = 500;
  let totalPages = 1;

  while (page < totalPages) {
    const url = `${TY_FINANCE_BASE}/${sellerId}/settlements?` +
      `startDate=${startMs}&endDate=${endMs}` +
      `&size=${size}&page=${page}`;

    try {
      const res = await axios.get(url, { headers, timeout: 30000 });
      const data = res.data;

      if (!data.content && !data.result) {
        console.warn('[TrendyolFinance] Beklenmedik yanıt yapısı:', JSON.stringify(data).substring(0, 200));
        break;
      }

      const content = data.content || data.result || [];
      totalPages = data.totalPages || 1;
      console.log(`[TrendyolFinance] Sayfa ${page + 1}/${totalPages}: ${content.length} kayıt`);
      allItems.push(...content);
      page++;

      if (page < totalPages) await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      if (err.response?.status === 429) {
        const wait = parseInt(err.response.headers['retry-after'] || '5') * 1000;
        console.warn(`[TrendyolFinance] 429 — ${wait}ms bekleniyor`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (page === 0) throw err;
      console.error('[TrendyolFinance] Sayfa hatası:', err.message);
      break;
    }
  }

  return allItems;
}

/**
 * Hakediş verisinden sipariş bazlı komisyon haritası oluşturur
 * @param {Array} settlements - fetchSettlements() çıktısı
 * @returns {Map} orderNumber → { commissionFee, commissionRate }
 */
function buildCommissionMap(settlements) {
  const map = new Map();

  for (const item of settlements) {
    // Trendyol settlement alanları (API belgelerine göre değişebilir)
    const orderNo = String(
      item.orderNumber || item.orderNo || item.shipmentPackageId || ''
    ).trim();
    if (!orderNo) continue;

    const existing = map.get(orderNo) || { commissionFee: 0, commissionRate: null };

    const fee  = parseFloat(item.commissionFee || item.commission || item.commissionAmount || 0);
    const rate = parseFloat(item.commissionRate || item.commissionRatio || 0);

    existing.commissionFee  += fee;
    if (rate && !existing.commissionRate) existing.commissionRate = rate;

    map.set(orderNo, existing);
  }

  return map;
}

/**
 * DB'deki marketplace_orders tablosunu hakediş verileriyle günceller
 * @param {object} db - pg Pool
 * @param {object} creds - { supplierId, apiKey, apiSecret }
 * @param {number} days - Kaç günlük hakediş verisi çekilsin
 * @returns {{ updated: number }}
 */
async function syncSettlements(db, creds, days = 30) {
  const { supplierId, apiKey, apiSecret } = creds;
  if (!supplierId || !apiKey || !apiSecret) {
    throw new Error('Trendyol Finance: kimlik bilgileri eksik');
  }

  const endDate   = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`[TrendyolFinance] ${days} günlük hakediş senkronizasyonu başlıyor...`);

  let settlements;
  try {
    settlements = await fetchSettlements(supplierId, apiKey, apiSecret, startDate, endDate);
  } catch (err) {
    console.error('[TrendyolFinance] fetchSettlements hatası:', err.message);
    // Kritik değil — stok/sipariş sync devam edebilir
    return { updated: 0 };
  }

  if (!settlements.length) {
    console.log('[TrendyolFinance] Hakediş verisi bulunamadı');
    return { updated: 0 };
  }

  const commMap = buildCommissionMap(settlements);
  let updated = 0;

  for (const [orderNumber, info] of commMap.entries()) {
    if (!info.commissionFee) continue;
    const result = await db.query(
      `UPDATE marketplace_orders
       SET commission_amount = $1,
           commission_rate   = COALESCE($2, commission_rate),
           updated_at        = NOW()
       WHERE platform = 'trendyol'
         AND (order_number = $3 OR order_id = $3)
         AND (commission_amount IS NULL OR commission_amount = 0)`,
      [info.commissionFee, info.commissionRate || null, orderNumber]
    );
    if (result.rowCount > 0) updated++;
  }

  console.log(`[TrendyolFinance] ${updated} sipariş komisyon bilgisi güncellendi`);
  return { updated };
}

module.exports = { fetchSettlements, buildCommissionMap, syncSettlements };
