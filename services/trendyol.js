/**
 * Trendyol Satıcı API İstemcisi — v2
 * Yeni endpoint: https://apigw.trendyol.com/integration/order/sellers
 * 13 günlük dilim bazlı çekim + 429 retry + axios
 */

const axios = require('axios');

const TY_BASE = 'https://apigw.trendyol.com/integration/order/sellers';

// Tüm statüler — tek requestte gönderilir
const ALL_STATUSES = [
  'Created', 'Picking', 'Invoiced', 'Shipped', 'Delivered',
  'UnDelivered', 'Returned', 'Cancelled', 'UnPacked', 'UnSupplied'
].join(',');

// Trendyol raw durum → BagStock dahili durum (stok mantığı için)
const TY_STATUS_MAP = {
  'Created':              'bekliyor',
  'Picking':              'kargoda',
  'Invoiced':             'kargoda',
  'Shipped':              'kargoda',
  'Delivered':            'teslim_edildi',
  'Cancelled':            'iptal',
  'UnDelivered':          'iptal',
  'Returned':             'iade',
  'ReturnedAndDelivered': 'iade',
  'Repack':               'bekliyor',
  'WaitingForSupply':     'bekliyor',
  'SentForPackaging':     'bekliyor',
  'UnPacked':             'bekliyor',
  'UnSupplied':           'bekliyor'
};

// Türkçe görüntüleme etiketleri
const TY_STATUS_TR = {
  'Created':              'Oluşturuldu',
  'Picking':              'Hazırlanıyor',
  'Invoiced':             'Faturalandı',
  'Shipped':              'Kargoya Verildi',
  'Delivered':            'Teslim Edildi',
  'Cancelled':            'İptal Edildi',
  'UnDelivered':          'Teslim Edilemedi',
  'Returned':             'İade Edildi',
  'ReturnedAndDelivered': 'İade Teslim Alındı',
  'Repack':               'Yeniden Paketleniyor',
  'WaitingForSupply':     'Tedarik Bekleniyor',
  'SentForPackaging':     'Paketlemeye Gönderildi',
  'UnPacked':             'Paketlenmedi',
  'UnSupplied':           'Tedarik Edilemedi'
};

// Stok düşürme tetikleyici durumlar
const TY_DEDUCT_STATUSES = new Set(['Picking', 'Invoiced', 'Shipped', 'Delivered']);

// İade statüleri
const TY_RETURN_STATUSES = new Set(['Returned', 'ReturnedAndDelivered']);

// ── Yardımcılar ────────────────────────────────────────────────────────────────

function makeTYHeaders(apiKey, apiSecret, supplierId) {
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'User-Agent': `${supplierId} - SelfIntegration`,
    'Content-Type': 'application/json'
  };
}

/**
 * startMs → endMs arasını en fazla MAX_DAYS günlük dilimlere böler
 * Trendyol API 14 gün limiti var, 13 gün alıyoruz (güvenlik payı)
 */
function splitDateRangeToChunks(startMs, endMs, maxDays = 13) {
  const chunks = [];
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + maxMs, endMs);
    chunks.push({ startDate: cursor, endDate: chunkEnd });
    cursor = chunkEnd + 1;
  }
  return chunks;
}

/**
 * 429 rate-limit — belirtilen süre kadar bekle ve tekrar dene
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Tek bir sayfayı çeker. 429 gelirse bekleyip yeniden dener.
 */
async function fetchChunk(url, headers, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(url, { headers, timeout: 30000 });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = parseInt(err.response.headers['retry-after'] || '5') * 1000;
        const waitMs = Math.max(retryAfter, 2000) * (attempt + 1);
        console.warn(`[Trendyol] 429 Rate limit — ${waitMs}ms bekleniyor (deneme ${attempt + 1}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }
      if (err.response?.status === 401) {
        throw new Error(`Trendyol API 401 Unauthorized — API kimlik bilgilerini kontrol edin`);
      }
      if (err.response?.status === 403) {
        throw new Error(`Trendyol API 403 Forbidden — supplierId veya izinleri kontrol edin`);
      }
      const status = err.response?.status || 'ağ hatası';
      const body = JSON.stringify(err.response?.data || err.message || '').substring(0, 300);
      if (attempt === maxRetries) {
        throw new Error(`Trendyol API HTTP ${status}: ${body}`);
      }
      console.warn(`[Trendyol] HTTP ${status} — ${attempt + 1}. deneme başarısız, tekrar deneniyor...`);
      await sleep(1500 * (attempt + 1));
    }
  }
}

// ── Durum haritalama ───────────────────────────────────────────────────────────

function mapStatus(rawStatus) {
  return {
    internal: TY_STATUS_MAP[rawStatus] || 'bekliyor',
    tr:       TY_STATUS_TR[rawStatus] || rawStatus,
    deduct:   TY_DEDUCT_STATUSES.has(rawStatus),
    returned: TY_RETURN_STATUSES.has(rawStatus)
  };
}

// ── Sipariş normalize ──────────────────────────────────────────────────────────

function mapOrder(order) {
  const rawStatus = order.status || order.shipmentPackageStatus || '';
  const statusInfo = mapStatus(rawStatus);

  const items = (order.lines || []).map(line => {
    const lineRaw = line.lineItemStatusName || rawStatus;
    const lineStatus = mapStatus(lineRaw);
    return {
      item_id:           String(line.id || line.lineItemId || ''),
      barcode:           (line.barcode || '').trim(),
      sku:               line.sku || line.merchantSku || '',
      product_name:      line.productName || '',
      quantity:          line.quantity || 1,
      price:             parseFloat(line.price || line.amount || line.linePrice || 0),
      raw_status:        lineRaw,
      status:            lineStatus.internal,
      status_tr:         lineStatus.tr,
      should_deduct:     lineStatus.deduct || statusInfo.deduct,
      commission_amount: parseFloat(line.commissionAmount || line.commissionFee || 0) || null,
      commission_rate:   parseFloat(line.commissionRate || 0) || null,
      cargo_desi:        parseFloat(line.volumetricWeight || line.desi || 0) || null
    };
  });

  const cargoCompany = order.cargoProviderName || order.shipmentPackageCargoCompany || '';
  const cargoTracking = order.cargoTrackingNumber || '';
  const cargoStatus   = order.shipmentPackageStatus || rawStatus;

  const totalCommission = items.reduce((s, i) => s + (i.commission_amount || 0), 0);
  const avgCommissionRate = items.length > 0
    ? items.reduce((s, i) => s + (i.commission_rate || 0), 0) / items.length
    : null;
  const totalDesi = items.reduce((s, i) => s + (i.cargo_desi || 0), 0);

  return {
    platform:              'trendyol',
    order_id:              String(order.id || order.orderNumber || ''),
    order_number:          String(order.orderNumber || order.id || ''),
    status:                statusInfo.internal,
    status_tr:             statusInfo.tr,
    raw_status:            rawStatus,
    customer_name:         order.customerName || order.shipmentAddress?.fullName || '',
    order_date:            order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price:           parseFloat(order.grossAmount || order.totalPrice || 0),
    currency:              'TRY',
    cargo_company:         cargoCompany,
    cargo_tracking_number: cargoTracking,
    cargo_status:          cargoStatus,
    cargo_cost:            parseFloat(order.cargoFee || order.deliveryCost || 0) || null,
    commission_amount:     totalCommission > 0 ? totalCommission : null,
    commission_rate:       avgCommissionRate,
    cargo_desi:            totalDesi > 0 ? totalDesi : null,
    is_returned:           statusInfo.returned,
    return_reason:         statusInfo.returned ? (order.returnReason || order.claimReason || '') : null,
    return_date:           statusInfo.returned && order.returnDate ? new Date(order.returnDate) : null,
    items
  };
}

// ── Ana Fonksiyon ─────────────────────────────────────────────────────────────

/**
 * Son N günün siparişlerini çeker — 13 günlük dilimler, tüm sayfalar, tüm statüler
 * @param {object} creds - { supplierId, apiKey, apiSecret }
 * @param {number} days  - Kaç gün geriye git (varsayılan: 30)
 * @returns {Array}      - Normalleştirilmiş sipariş listesi
 */
async function fetchTrendyolOrders(creds, days = 30) {
  const { supplierId, apiKey, apiSecret } = creds;
  if (!supplierId || !apiKey || !apiSecret) {
    throw new Error('Trendyol kimlik bilgileri eksik (supplierId, apiKey, apiSecret)');
  }

  const headers = makeTYHeaders(apiKey, apiSecret, supplierId);

  const endMs = Date.now();
  const startObj = new Date(endMs - days * 24 * 60 * 60 * 1000);
  startObj.setHours(0, 0, 0, 0);
  const startMs = startObj.getTime();

  const chunks = splitDateRangeToChunks(startMs, endMs);
  console.log(`[Trendyol] ${days} günlük aralık → ${chunks.length} dilim`);

  const allOrders = [];
  const seenIds = new Set();

  for (let ci = 0; ci < chunks.length; ci++) {
    const { startDate, endDate } = chunks[ci];
    const chunkLabel = `Dilim ${ci + 1}/${chunks.length} (${new Date(startDate).toLocaleDateString('tr-TR')} → ${new Date(endDate).toLocaleDateString('tr-TR')})`;

    let page = 0;
    const size = 200;
    let totalPages = 1;

    while (page < totalPages) {
      const url = `${TY_BASE}/${supplierId}/orders?` +
        `startDate=${startDate}&endDate=${endDate}` +
        `&orderByField=PackageLastModifiedDate&orderByDirection=DESC` +
        `&status=${encodeURIComponent(ALL_STATUSES)}` +
        `&size=${size}&page=${page}`;

      let data;
      try {
        data = await fetchChunk(url, headers);
      } catch (err) {
        if (page === 0 && ci === 0) throw err; // ilk dilim ilk sayfada hata kritik
        console.error(`[Trendyol] ${chunkLabel} sayfa ${page} alınamadı:`, err.message);
        break;
      }

      if (!data.content || !Array.isArray(data.content)) {
        console.warn(`[Trendyol] ${chunkLabel} content yok:`, JSON.stringify(data).substring(0, 200));
        break;
      }

      totalPages = data.totalPages || 1;
      console.log(`[Trendyol] ${chunkLabel} — Sayfa ${page + 1}/${totalPages}: ${data.content.length} sipariş`);
      page++;

      for (const raw of data.content) {
        const order = mapOrder(raw);
        if (!seenIds.has(order.order_id)) {
          seenIds.add(order.order_id);
          allOrders.push(order);
        }
      }

      // Sayfa aralarında kısa bekleme (rate limit önlemi)
      if (page < totalPages) await sleep(200);
    }

    // Dilimler arası kısa bekleme
    if (ci < chunks.length - 1) await sleep(300);
  }

  console.log(`[Trendyol] Toplam ${allOrders.length} benzersiz sipariş çekildi`);
  return allOrders;
}

// Geriye dönük uyumluluk için normalizeTYOrder de export et
const normalizeTYOrder = mapOrder;

module.exports = {
  fetchTrendyolOrders,
  normalizeTYOrder,
  mapOrder,
  mapStatus,
  splitDateRangeToChunks,
  TY_STATUS_MAP,
  TY_STATUS_TR,
  TY_DEDUCT_STATUSES
};
