/**
 * Hepsiburada Marketplace API İstemcisi
 * Dokümantasyon: https://developers.hepsiburada.com
 *
 * Doğru endpoint'ler (doc'tan doğrulandı):
 *   SIT sipariş listesi  : GET  https://oms-external-sit.hepsiburada.com/orders/merchantid/{merchantId}
 *   SIT paket listesi    : GET  https://oms-external-sit.hepsiburada.com/packages/merchantid/{merchantId}
 *   SIT test sipariş     : POST https://oms-stub-external-sit.hepsiburada.com/orders/merchantId/{merchantId}
 *   PROD sipariş listesi : GET  https://oms-external.hepsiburada.com/orders/merchantid/{merchantId}
 *   PROD paket listesi   : GET  https://oms-external.hepsiburada.com/packages/merchantid/{merchantId}
 *
 * Auth:  Basic Auth → merchantId:secretKey
 * Header: User-Agent → developer username (örn. huflex_dev)
 * Query params: begindate / enddate (lowercase — camelCase değil!)
 */

function getHBBase(environment) {
  return environment === 'production'
    ? 'https://oms-external.hepsiburada.com'
    : 'https://oms-external-sit.hepsiburada.com';  // SIT (test ortamı)
}

const HB_STUB_BASE = 'https://oms-stub-external-sit.hepsiburada.com'; // test sipariş oluşturma

// HB package status → BagStock dahili durum
const HB_PKG_STATUS_MAP = {
  'Packed':         'bekliyor',
  'Shipped':        'kargoda',
  'Delivered':      'teslim_edildi',
  'UnDelivered':    'iptal',
  'Returned':       'iade_bekliyor',
  'ReturnAccepted': 'iade_onaylandi',
  'Cancelled':      'iptal',
};

const HB_PKG_STATUS_TR = {
  'Packed':         'Paketlendi',
  'Shipped':        'Kargoya Verildi',
  'Delivered':      'Teslim Edildi',
  'UnDelivered':    'Teslim Edilemedi',
  'Returned':       'İade Bekliyor',
  'ReturnAccepted': 'İade Onaylandı',
  'Cancelled':      'İptal Edildi',
};

// Stok düşürme tetikleyici durumlar
const HB_DEDUCT_STATUSES = new Set(['Shipped', 'Delivered', 'IN_CARGO', 'DELIVERED']);

// İade statüleri
const HB_RETURN_STATUSES = new Set(['Returned', 'ReturnAccepted', 'RETURNED', 'RETURN_ACCEPTED']);

// Eski durum haritası (geriye dönük uyumluluk)
const HB_STATUS_MAP = {
  'WAITING_IN_MERCHANT':    'bekliyor',
  'WAITING_IN_PACK_STAGE':  'bekliyor',
  'CONFIRMED':              'bekliyor',
  'PREPARING_FOR_SHIPMENT': 'bekliyor',
  'IN_CARGO':               'kargoda',
  'AT_CARGO':               'kargoda',
  'IN_TRANSIT':             'kargoda',
  'DELIVERED':              'teslim_edildi',
  'UNDELIVERED':            'iptal',
  'CANCELLED':              'iptal',
  'CANCELLED_BEFORE_CARGO': 'iptal',
  'RETURNED':               'iade_bekliyor',
  'RETURN_ACCEPTED':        'iade_onaylandi',
  'RETURN_IN_CARGO':        'iade_bekliyor',
  'OPEN':                   'bekliyor',
  'Packed':                 'bekliyor',
  'Shipped':                'kargoda',
  'Delivered':              'teslim_edildi',
  'UnDelivered':            'iptal',
  'Returned':               'iade_bekliyor',
  'ReturnAccepted':         'iade_onaylandi',
  'Cancelled':              'iptal',
};

const HB_STATUS_TR = {
  'WAITING_IN_MERCHANT':    'Satıcıda Bekliyor',
  'WAITING_IN_PACK_STAGE':  'Paketleme Bekliyor',
  'CONFIRMED':              'Onaylandı',
  'PREPARING_FOR_SHIPMENT': 'Kargoya Hazırlanıyor',
  'IN_CARGO':               'Kargoya Verildi',
  'AT_CARGO':               'Kargo Şubesinde',
  'IN_TRANSIT':             'Yolda',
  'DELIVERED':              'Teslim Edildi',
  'UNDELIVERED':            'Teslim Edilemedi',
  'CANCELLED':              'İptal Edildi',
  'CANCELLED_BEFORE_CARGO': 'Kargo Öncesi İptal',
  'RETURNED':               'İade Bekliyor',
  'RETURN_ACCEPTED':        'İade Onaylandı',
  'RETURN_IN_CARGO':        'İade Kargoda',
  'OPEN':                   'Ödeme Tamamlandı',
  'Packed':                 'Paketlendi',
  'Shipped':                'Kargoya Verildi',
  'Delivered':              'Teslim Edildi',
  'UnDelivered':            'Teslim Edilemedi',
  'Returned':               'İade Bekliyor',
  'ReturnAccepted':         'İade Onaylandı',
  'Cancelled':              'İptal Edildi',
};

/**
 * Basic Auth header'ları oluştur
 * Basic Auth: merchantId:secretKey
 * User-Agent: developer username (huflex_dev)
 */
function makeHBHeaders(merchantId, apiKey, developerUsername) {
  const credentials = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'User-Agent':    developerUsername || 'BagStock',
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };
}

/**
 * Tüm HB siparişlerini çeker (açık + paketlenmiş)
 * @param {object} creds - { merchantId, username, apiKey, environment }
 * @param {number} days  - Kaç gün geriye git (varsayılan: 30)
 */
async function fetchHepsiburadaOrders(creds, days = 30) {
  const { merchantId, username, apiKey, environment } = creds;
  if (!merchantId || !apiKey) {
    throw new Error('Hepsiburada kimlik bilgileri eksik (merchantId, apiKey)');
  }

  const base    = getHBBase(environment);
  const headers = makeHBHeaders(merchantId, apiKey, username);

  const endDate   = new Date();
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  startDate.setHours(0, 0, 0, 0);

  const begindate = formatHBDate(startDate);
  const enddate   = formatHBDate(endDate);

  console.log(`[HepsiB] Base: ${base} | env: ${environment || 'sit'} | merchantId: ${merchantId}`);
  console.log(`[HepsiB] Tarih aralığı: ${begindate} → ${enddate}`);

  const allOrders = [];
  const seenIds   = new Set();

  // ── 1. Açık siparişler (ödemesi tamamlanmış, paketlenecek) ──────────────────
  console.log('[HepsiB] /orders/ endpoint çekiliyor (OPEN siparişler)...');
  await fetchPaginated(
    `${base}/orders/merchantid/${merchantId}`,
    { begindate, enddate },
    headers,
    (item) => {
      const norm = normalizeHBOpenOrder(item);
      if (norm.order_id && !seenIds.has(norm.order_id)) {
        seenIds.add(norm.order_id);
        allOrders.push(norm);
      }
    }
  );

  // ── 2. Paketlenmiş siparişler (kargoda, teslim, iade vb.) ──────────────────
  console.log('[HepsiB] /packages/ endpoint çekiliyor (paketlenmiş siparişler)...');
  await fetchPaginated(
    `${base}/packages/merchantid/${merchantId}`,
    { begindate, enddate },
    headers,
    (pkg) => {
      const norm = normalizeHBPackage(pkg);
      if (norm.order_id && !seenIds.has(norm.order_id)) {
        seenIds.add(norm.order_id);
        allOrders.push(norm);
      }
    }
  );

  console.log(`[HepsiB] Toplam ${allOrders.length} sipariş çekildi`);
  return allOrders;
}

/**
 * Sayfalı GET isteği — sonuçlar bitene kadar devam et
 */
async function fetchPaginated(baseUrl, extraParams, headers, onItem) {
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      ...extraParams,
      limit: String(limit),
      offset: String(offset)
    });
    const url = `${baseUrl}?${params}`;
    console.log(`[HepsiB] GET ${url}`);

    let data;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      console.log(`[HepsiB] HTTP ${res.status}`);

      if (res.status === 204 || res.status === 404) { hasMore = false; break; }

      const rawText = await res.text();
      console.log(`[HepsiB] Yanıt (ilk 300): ${rawText.substring(0, 300)}`);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 300)}`);
      }

      try { data = JSON.parse(rawText); } catch (e) {
        throw new Error(`JSON parse hatası: ${e.message}`);
      }
    } catch (err) {
      console.error(`[HepsiB] Hata: ${err.message}`);
      throw err;
    }

    const items = extractItems(data);
    console.log(`[HepsiB] ${items.length} kayıt alındı (offset=${offset})`);

    if (!items.length) { hasMore = false; break; }

    items.forEach(onItem);

    if (items.length < limit) { hasMore = false; }
    else { offset += limit; }
  }
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  // Olası response wrapper'ları
  const candidates = [
    data?.data?.items, data?.data?.orders, data?.data?.packages, data?.data?.orderList,
    data?.items, data?.orders, data?.packages, data?.orderList, data?.result
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length >= 0) return c;
  }
  return [];
}

function formatHBDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Açık sipariş normalleştiricisi (/orders endpoint'i) */
function normalizeHBOpenOrder(order) {
  const rawStatus = order.status || 'OPEN';

  const items = (order.lineItems || order.orderLines || order.lines || order.items || []).map(line => ({
    item_id:           String(line.id || line.lineItemId || line.lineId || ''),
    barcode:           (line.barcode || line.merchantBarcode || line.productBarcode || '').trim(),
    sku:               line.merchantSku || line.sku || '',
    product_name:      line.name || line.productName || line.hepsiburadaSku || '',
    quantity:          parseInt(line.quantity || line.requestedQuantity || 1),
    price:             parseFloat(line.price || line.salePrice || 0),
    raw_status:        rawStatus,
    status:            HB_STATUS_MAP[rawStatus] || 'bekliyor',
    status_tr:         HB_STATUS_TR[rawStatus] || 'Satıcıda Bekliyor',
    should_deduct:     false,
    commission_amount: null,
    commission_rate:   null,
    cargo_desi:        null,
  }));

  return {
    platform:              'hepsiburada',
    order_id:              String(order.orderNumber || order.id || order.orderId || ''),
    order_number:          String(order.orderNumber || order.id || order.orderId || ''),
    status:                HB_STATUS_MAP[rawStatus] || 'bekliyor',
    status_tr:             HB_STATUS_TR[rawStatus] || 'Satıcıda Bekliyor',
    raw_status:            rawStatus,
    customer_name:         order.customer?.fullName || order.customerName || '',
    order_date:            order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price:           parseFloat(order.totalPrice || order.grossAmount || 0),
    currency:              'TRY',
    cargo_company:         null,
    cargo_tracking_number: null,
    cargo_status:          rawStatus,
    cargo_cost:            null,
    commission_amount:     null,
    commission_rate:       null,
    cargo_desi:            null,
    is_returned:           false,
    return_reason:         null,
    return_date:           null,
    items,
  };
}

/** Paket normalleştiricisi (/packages endpoint'i) */
function normalizeHBPackage(pkg) {
  const rawStatus  = pkg.status || '';
  const internalSt = HB_PKG_STATUS_MAP[rawStatus] || HB_STATUS_MAP[rawStatus] || 'bekliyor';
  const statusTr   = HB_PKG_STATUS_TR[rawStatus] || HB_STATUS_TR[rawStatus] || rawStatus;
  const isReturned = HB_RETURN_STATUSES.has(rawStatus);

  const items = (pkg.lineItems || pkg.lines || pkg.items || []).map(line => {
    const lineStatus = line.status || rawStatus;
    return {
      item_id:           String(line.id || line.lineItemId || line.lineId || ''),
      barcode:           (line.barcode || line.merchantBarcode || '').trim(),
      sku:               line.merchantSku || line.sku || '',
      product_name:      line.name || line.productName || '',
      quantity:          parseInt(line.quantity || 1),
      price:             parseFloat(line.price || line.salePrice || 0),
      raw_status:        lineStatus,
      status:            HB_PKG_STATUS_MAP[lineStatus] || HB_STATUS_MAP[lineStatus] || internalSt,
      status_tr:         HB_PKG_STATUS_TR[lineStatus] || HB_STATUS_TR[lineStatus] || lineStatus,
      should_deduct:     HB_DEDUCT_STATUSES.has(rawStatus),
      commission_amount: parseFloat(line.commissionAmount || line.merchantCommissionAmount || 0) || null,
      commission_rate:   parseFloat(line.commissionRate   || line.merchantCommissionRate   || 0) || null,
      cargo_desi:        parseFloat(line.desi || line.cargoDeciWeight || 0) || null,
    };
  });

  const totalCommission  = items.reduce((s, i) => s + (i.commission_amount || 0), 0);
  const commRates        = items.filter(i => i.commission_rate).map(i => i.commission_rate);
  const avgCommissionRate = commRates.length
    ? Math.round(commRates.reduce((a,b)=>a+b,0) / commRates.length * 100) / 100
    : null;
  const totalDesi = items.reduce((s, i) => s + (i.cargo_desi || 0), 0);

  const orderId = String(
    pkg.orderNumber || pkg.packageNumber || pkg.id || pkg.packageId || ''
  );

  return {
    platform:              'hepsiburada',
    order_id:              orderId,
    order_number:          orderId,
    status:                internalSt,
    status_tr:             statusTr,
    raw_status:            rawStatus,
    customer_name:         pkg.customer?.fullName || pkg.customerName || '',
    order_date:            pkg.orderDate ? new Date(pkg.orderDate) : new Date(),
    total_price:           parseFloat(pkg.totalPrice || pkg.grossAmount || 0),
    currency:              'TRY',
    cargo_company:         pkg.cargoCompany || pkg.shippingCompany || null,
    cargo_tracking_number: pkg.trackingNumber || pkg.cargoTrackingNumber || null,
    cargo_status:          rawStatus,
    cargo_cost:            parseFloat(pkg.shippingCost || 0) || null,
    commission_amount:     totalCommission > 0 ? totalCommission : null,
    commission_rate:       avgCommissionRate,
    cargo_desi:            totalDesi > 0 ? totalDesi : null,
    is_returned:           isReturned,
    return_reason:         isReturned ? (pkg.returnReason || '') : null,
    return_date:           isReturned && pkg.returnDate ? new Date(pkg.returnDate) : null,
    items,
  };
}

/**
 * HB SIT listing'lerini çek — test siparişi için geçerli ListingId almak amacıyla
 * GET https://listing-external-sit.hepsiburada.com/listings/merchantid/{merchantId}
 * Prod: https://listing-external.hepsiburada.com/listings/merchantid/{merchantId}
 */
async function fetchHBListings(creds, limit = 10) {
  const { merchantId, username, apiKey, environment } = creds;
  const listingBase = environment === 'production'
    ? 'https://listing-external.hepsiburada.com'
    : 'https://listing-external-sit.hepsiburada.com';

  const headers = makeHBHeaders(merchantId, apiKey, username);
  const url = `${listingBase}/listings/merchantid/${merchantId}?offset=0&limit=${limit}`;
  console.log(`[HepsiB Listings] GET ${url}`);

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const rawText = await res.text();
  console.log(`[HepsiB Listings] HTTP ${res.status} | ${rawText.substring(0, 200)}`);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 200)}`);
  }

  let data;
  try { data = JSON.parse(rawText); } catch { return []; }

  // HB listing API yanıt formatı: { listings: [...] } veya doğrudan dizi
  const rows = Array.isArray(data) ? data : (data.listings || data.data || []);
  return rows.map(l => ({
    listingId:   String(l.id || l.listingId || l.ListingId || ''),
    merchantSku: String(l.merchantSku || l.MerchantSku || l.sku || ''),
    sku:         String(l.hepsiburadaSku || l.sku || l.Sku || l.merchantSku || ''),
    price:       parseFloat(l.price || l.salePrice || 0),
  })).filter(l => l.listingId);
}

/**
 * HB SIT test siparişi oluştur
 * POST https://oms-stub-external-sit.hepsiburada.com/orders/merchantId/{merchantId}
 */
async function createHBTestOrder(creds, orderData) {
  const { merchantId, username, apiKey } = creds;
  const headers = makeHBHeaders(merchantId, apiKey, username);

  const url = `${HB_STUB_BASE}/orders/merchantId/${merchantId}`;
  console.log(`[HepsiB Test Order] POST ${url}`);

  const res     = await fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify(orderData),
    signal:  AbortSignal.timeout(15000)
  });

  const rawText = await res.text();
  console.log(`[HepsiB Test Order] HTTP ${res.status} | ${rawText.substring(0, 300)}`);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 300)}`);
  }

  try { return JSON.parse(rawText); } catch { return { raw: rawText }; }
}

module.exports = {
  fetchHepsiburadaOrders,
  fetchHBListings,
  createHBTestOrder,
  getHBBase,
  makeHBHeaders,
  HB_STATUS_MAP,
  HB_STATUS_TR,
  HB_PKG_STATUS_MAP,
  HB_DEDUCT_STATUSES,
  formatHBDate,
};
