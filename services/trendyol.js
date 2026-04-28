/**
 * Trendyol Satıcı API İstemcisi — v3
 * Native fetch (Node 18+) — axios bağımlılığı YOK
 * Endpoint: https://apigw.trendyol.com/integration/order/sellers
 * 13 günlük dilim bazlı çekim + 429 retry
 */

const TY_BASE = 'https://apigw.trendyol.com/integration/order/sellers';

// Trendyol raw durum → BagStock dahili durum
const TY_STATUS_MAP = {
  'Created':              'bekliyor',
  'Picking':              'kargoda',
  'Invoiced':             'kargoda',
  'Shipped':              'kargoda',
  'Delivered':            'teslim_edildi',
  'Cancelled':            'iptal',
  'UnDelivered':          'kargoda', // Kurye teslim edemedi, paket hâlâ kargo şirketinde (Taşıma Durumunda)
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Tek bir sayfayı çeker — 429 ve geçici hatalarda retry yapar (native fetch)
 */
async function fetchChunk(url, headers, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (netErr) {
      if (attempt === maxRetries) throw new Error(`Ağ hatası: ${netErr.message}`);
      console.warn(`[Trendyol] Ağ hatası, ${attempt + 1}. deneme tekrar deneniyor:`, netErr.message);
      await sleep(1500 * (attempt + 1));
      continue;
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5') * 1000;
      const waitMs = Math.max(retryAfter, 2000) * (attempt + 1);
      console.warn(`[Trendyol] 429 Rate limit — ${waitMs}ms bekleniyor (deneme ${attempt + 1})`);
      await sleep(waitMs);
      continue;
    }

    if (res.status === 401) throw new Error('Trendyol API 401 Unauthorized — API kimlik bilgilerini kontrol edin');
    if (res.status === 403) throw new Error('Trendyol API 403 Forbidden — supplierId veya izinleri kontrol edin');

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (attempt === maxRetries) throw new Error(`Trendyol API HTTP ${res.status}: ${body.substring(0, 300)}`);
      console.warn(`[Trendyol] HTTP ${res.status} — ${attempt + 1}. deneme başarısız`);
      await sleep(1500 * (attempt + 1));
      continue;
    }

    try {
      return await res.json();
    } catch (parseErr) {
      throw new Error(`Trendyol API yanıtı JSON değil: ${parseErr.message}`);
    }
  }
}

/**
 * startMs → endMs arasını en fazla maxDays günlük dilimlere böler
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
  // shipmentPackageStatus = paketin GERÇEk kargo durumu (Shipped, Delivered…)
  // order.status          = sipariş seviyesi — bazen eski/farklı değer taşır
  // Doğru öncelik: shipmentPackageStatus → packageStatus → status
  const rawStatus = (
    order.shipmentPackageStatus ||
    order.packageStatus ||
    order.status ||
    ''
  ).trim();

  // Ek olarak: birden fazla satır varsa satır durumlarına bak —
  // en "ileri" satır durumu paketin gerçek durumunu yansıtır
  const statusPriority = ['Delivered','Shipped','Invoiced','Picking','Returned',
    'ReturnedAndDelivered','Cancelled','UnDelivered','Created'];
  const lineStatuses = (order.lines || order.orderLineItems || [])
    .map(l => (l.lineItemStatusName || l.status || '').trim())
    .filter(Boolean);
  const bestLineStatus = statusPriority.find(s => lineStatuses.includes(s));
  // Paket düzeyinde status bilinmiyorsa veya Created ise satır durumu daha güvenilir
  const effectiveRaw = rawStatus && rawStatus !== 'Created' && TY_STATUS_MAP[rawStatus]
    ? rawStatus
    : (bestLineStatus || rawStatus);

  const statusInfo = mapStatus(effectiveRaw);

  // Paket seviyesinde desi (Trendyol portal'daki "Desi: 3" bu alandan gelir)
  const pkgDesi = parseFloat(
    order.volumetricWeight ||
    order.desi ||
    order.packageDesi ||
    order.shipmentPackageDesi ||
    order.cargoWeight ||
    0
  ) || 0;

  const lines = order.lines || order.orderLineItems || [];

  const items = lines.map(line => {
    const lineRaw = (
      line.lineItemStatusName ||
      line.status ||
      rawStatus
    ).trim();
    const lineStatus = mapStatus(lineRaw);

    // Satır seviyesinde desi — yoksa paket desi kullanılır
    const lineDesi = parseFloat(
      line.volumetricWeight || line.desi || line.packageDesi || 0
    ) || pkgDesi;

    // Komisyon — orders API'de varsa alınır, yoksa finance API tamamlar
    const lineComm = parseFloat(
      line.commissionFee || line.commissionAmount || line.commission || 0
    ) || null;
    const lineCommRate = parseFloat(
      line.commissionRate || line.commissionRatio || 0
    ) || null;

    return {
      item_id:           String(line.id || line.lineItemId || line.orderLineId || ''),
      barcode:           (line.barcode || line.sku || '').trim(),
      sku:               line.merchantSku || line.sku || '',
      product_name:      line.productName || line.name || '',
      quantity:          parseInt(line.quantity) || 1,
      price:             parseFloat(line.price || line.amount || line.linePrice || line.salePrice || 0),
      raw_status:        lineRaw,
      status:            lineStatus.internal,
      status_tr:         lineStatus.tr,
      should_deduct:     lineStatus.deduct || statusInfo.deduct,
      commission_amount: lineComm,
      commission_rate:   lineCommRate,
      cargo_desi:        lineDesi > 0 ? lineDesi : null
    };
  });

  // Kargo bilgileri
  const cargoCompany  = order.cargoProviderName || order.shipmentPackageCargoCompany || order.cargoCompany || '';
  const cargoTracking = order.cargoTrackingNumber || order.trackingNumber || '';
  const cargoStatus   = order.shipmentPackageStatus || rawStatus;

  // Toplam komisyon — satırlardan
  const totalCommission = items.reduce((s, i) => s + (i.commission_amount || 0), 0);
  const commRates = items.filter(i => i.commission_rate).map(i => i.commission_rate);
  const avgCommissionRate = commRates.length > 0
    ? commRates.reduce((a, b) => a + b, 0) / commRates.length
    : null;

  // Toplam desi — paket seviyesi öncelikli, yoksa satır toplamı
  const lineDesiSum = items.reduce((s, i) => s + (i.cargo_desi || 0), 0);
  const totalDesi = pkgDesi > 0 ? pkgDesi : lineDesiSum;

  return {
    platform:              'trendyol',
    order_id:              String(order.id || order.orderId || order.orderNumber || ''),
    order_number:          String(order.orderNumber || order.id || order.orderId || ''),
    status:                statusInfo.internal,
    status_tr:             statusInfo.tr,
    raw_status:            effectiveRaw,   // debug için gerçek kullanılan raw değer
    customer_name:         order.customerName || order.shipmentAddress?.fullName || order.buyerName || '',
    order_date:            order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price:           parseFloat(order.grossAmount || order.totalPrice || order.amount || 0),
    currency:              'TRY',
    cargo_company:         cargoCompany,
    cargo_tracking_number: cargoTracking,
    cargo_status:          cargoStatus,
    cargo_cost:            parseFloat(order.cargoFee || order.deliveryCost || order.shippingCost || 0) || null,
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
 * Son N günün siparişlerini çeker — 13 günlük dilimler, tüm sayfalar
 * status filtresi yok → API tüm statüleri döner (Shipped/Taşıma Durumunda dahil)
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
    const chunkLabel = `Dilim ${ci + 1}/${chunks.length}`;

    let page = 0;
    const size = 200;
    let totalPages = 1;

    while (page < totalPages) {
      // status parametresi YOK — API tüm statüleri döner
      const url = `${TY_BASE}/${supplierId}/orders?` +
        `startDate=${startDate}&endDate=${endDate}` +
        `&orderByField=PackageLastModifiedDate&orderByDirection=DESC` +
        `&size=${size}&page=${page}`;

      let data;
      try {
        data = await fetchChunk(url, headers);
      } catch (err) {
        if (page === 0 && ci === 0) throw err;
        console.error(`[Trendyol] ${chunkLabel} sayfa ${page} alınamadı:`, err.message);
        break;
      }

      // Yanıt yapısı kontrolü
      const content = data?.content || data?.result || data?.orders || [];
      if (!Array.isArray(content)) {
        console.warn(`[Trendyol] ${chunkLabel} beklenmedik yanıt:`, JSON.stringify(data).substring(0, 300));
        break;
      }

      totalPages = data.totalPages || data.totalPage || 1;
      console.log(`[Trendyol] ${chunkLabel} Sayfa ${page + 1}/${totalPages}: ${content.length} sipariş`);
      page++;

      for (const raw of content) {
        const order = mapOrder(raw);
        if (order.order_id && !seenIds.has(order.order_id)) {
          seenIds.add(order.order_id);
          allOrders.push(order);
          // Her siparişin durum bilgisini logla — kargoda sorunu için kritik
          console.log(`[TY#${order.order_number}] pkg:${(raw.shipmentPackageStatus||raw.packageStatus||'?')} / ord:${raw.status||'?'} → ${order.raw_status} → ${order.status} | desi:${order.cargo_desi??'—'}`);
        }
      }

      if (page < totalPages) await sleep(200);
    }

    if (ci < chunks.length - 1) await sleep(300);
  }

  console.log(`[Trendyol] Toplam ${allOrders.length} benzersiz sipariş`);
  return allOrders;
}

// Geriye dönük uyumluluk
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
