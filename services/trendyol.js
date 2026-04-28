/**
 * Trendyol Satıcı API İstemcisi
 * Dokümantasyon: https://developers.trendyol.com
 */

const TY_BASE = 'https://api.trendyol.com/sapigw';

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
  'SentForPackaging':     'bekliyor'
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
  'SentForPackaging':     'Paketlemeye Gönderildi'
};

// Stok düşürme tetikleyici durumlar
const TY_DEDUCT_STATUSES = new Set(['Picking', 'Invoiced', 'Shipped', 'Delivered']);

// İade statüleri
const TY_RETURN_STATUSES = new Set(['Returned', 'ReturnedAndDelivered']);

function makeTYHeaders(apiKey, apiSecret, supplierId) {
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'User-Agent': `${supplierId} - SelfIntegration`,
    'Content-Type': 'application/json'
  };
}

/**
 * Son N günün siparişlerini çeker — TÜM sayfalar dahil, TÜM statüler
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
  const endDate = Date.now();
  // Günün başından itibaren al (timestamp ms)
  const startDateObj = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  startDateObj.setHours(0, 0, 0, 0);
  const startDate = startDateObj.getTime();

  const allOrders = [];
  const seenIds = new Set();
  let page = 0;
  const size = 200; // Trendyol max page size
  let totalPages = 1;

  while (page < totalPages) {
    // Tüm statüleri çek — status parametresi verilmezse Trendyol varsayılan olarak tümünü döner
    const url = `${TY_BASE}/suppliers/${supplierId}/orders?` +
      `startDate=${startDate}&endDate=${endDate}` +
      `&size=${size}&page=${page}` +
      `&orderByField=PackageLastModifiedDate&orderByDirection=DESC`;

    let data;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Trendyol API HTTP ${res.status}: ${errText.substring(0, 300)}`);
      }
      data = await res.json();
    } catch (err) {
      if (page === 0) throw err;
      console.error(`[Trendyol] Sayfa ${page} alınamadı, duruyoruz:`, err.message);
      break;
    }

    if (!data.content || !Array.isArray(data.content)) {
      console.warn('[Trendyol] content array yok, yanıt yapısı:', JSON.stringify(data).substring(0, 200));
      break;
    }

    totalPages = data.totalPages || 1;
    console.log(`[Trendyol] Sayfa ${page + 1}/${totalPages} — ${data.content.length} sipariş`);
    page++;

    for (const order of data.content) {
      const norm = normalizeTYOrder(order);
      if (!seenIds.has(norm.order_id)) {
        seenIds.add(norm.order_id);
        allOrders.push(norm);
      }
    }
  }

  console.log(`[Trendyol] Toplam ${allOrders.length} sipariş çekildi (${page} sayfa)`);
  return allOrders;
}

function normalizeTYOrder(order) {
  const rawStatus = order.status || order.shipmentPackageStatus || '';

  const items = (order.lines || []).map(line => {
    const lineStatus = line.lineItemStatusName || rawStatus;
    return {
      item_id: String(line.id || line.lineItemId || ''),
      barcode: (line.barcode || '').trim(),
      sku: line.sku || line.merchantSku || '',
      product_name: line.productName || '',
      quantity: line.quantity || 1,
      price: parseFloat(line.price || line.amount || line.linePrice || 0),
      raw_status: lineStatus,
      status: TY_STATUS_MAP[lineStatus] || TY_STATUS_MAP[rawStatus] || 'bekliyor',
      status_tr: TY_STATUS_TR[lineStatus] || TY_STATUS_TR[rawStatus] || lineStatus,
      should_deduct: TY_DEDUCT_STATUSES.has(lineStatus) || TY_DEDUCT_STATUSES.has(rawStatus),
      // Komisyon — Trendyol satırlarında gelebilir
      commission_amount: parseFloat(line.commissionAmount || line.commissionFee || 0) || null,
      commission_rate:   parseFloat(line.commissionRate || 0) || null,
      // Desi/kargo
      cargo_desi: parseFloat(line.volumetricWeight || line.desi || 0) || null
    };
  });

  // Kargo bilgisi — Trendyol order seviyesinde
  const cargoCompany = order.cargoProviderName || order.shipmentPackageCargoCompany || '';
  const cargoTracking = order.cargoTrackingNumber || '';
  const cargoStatus   = order.shipmentPackageStatus || rawStatus;

  // İade kontrolü
  const isReturned = TY_RETURN_STATUSES.has(rawStatus);

  // Komisyon ve desi toplamları — satırlardan hesapla
  const totalCommission = items.reduce((s, i) => s + (i.commission_amount || 0), 0);
  const avgCommissionRate = items.length > 0
    ? items.reduce((s, i) => s + (i.commission_rate || 0), 0) / items.length
    : null;
  const totalDesi = items.reduce((s, i) => s + (i.cargo_desi || 0), 0);

  return {
    platform: 'trendyol',
    order_id: String(order.id || order.orderNumber || ''),
    order_number: String(order.orderNumber || order.id || ''),
    status: TY_STATUS_MAP[rawStatus] || 'bekliyor',
    status_tr: TY_STATUS_TR[rawStatus] || rawStatus,
    raw_status: rawStatus,
    customer_name: order.customerName || order.shipmentAddress?.fullName || '',
    order_date: order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price: parseFloat(order.grossAmount || order.totalPrice || 0),
    currency: 'TRY',
    // Kargo
    cargo_company:          cargoCompany,
    cargo_tracking_number:  cargoTracking,
    cargo_status:           cargoStatus,
    cargo_cost:             parseFloat(order.cargoFee || order.deliveryCost || 0) || null,
    // Komisyon & desi
    commission_amount:      totalCommission > 0 ? totalCommission : null,
    commission_rate:        avgCommissionRate,
    cargo_desi:             totalDesi > 0 ? totalDesi : null,
    // İade
    is_returned:   isReturned,
    return_reason: isReturned ? (order.returnReason || order.claimReason || '') : null,
    return_date:   isReturned && order.returnDate ? new Date(order.returnDate) : null,
    items
  };
}

module.exports = { fetchTrendyolOrders, TY_STATUS_MAP, TY_STATUS_TR, TY_DEDUCT_STATUSES };
