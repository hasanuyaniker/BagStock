/**
 * Hepsiburada Marketplace API İstemcisi
 * Dokümantasyon: https://developers.hepsiburada.com
 */

const HB_BASE = 'https://listing-external.hepsiburada.com';

// Hepsiburada raw durum → BagStock dahili durum
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
  'RETURNED':               'iade_bekliyor',   // Aksiyon bekleyen iade
  'RETURN_ACCEPTED':        'iade_onaylandi',  // Onaylanan iade
  'RETURN_IN_CARGO':        'iade_bekliyor'    // İade kargoda = aksiyon bekliyor
};

// Türkçe görüntüleme etiketleri
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
  'RETURN_IN_CARGO':        'İade Kargoda'
};

// Stok düşürme tetikleyici durumlar
const HB_DEDUCT_STATUSES = new Set(['IN_CARGO', 'AT_CARGO', 'IN_TRANSIT', 'DELIVERED']);

// İade statüleri
const HB_RETURN_STATUSES = new Set(['RETURNED', 'RETURN_ACCEPTED', 'RETURN_IN_CARGO']);

function makeHBHeaders(merchantId, apiKey) {
  const credentials = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

/**
 * Son N günün siparişlerini çeker — tüm sayfalar, tüm statüler
 * @param {object} creds - { merchantId, apiKey }
 * @param {number} days  - Kaç gün geriye git (varsayılan: 30)
 * @returns {Array}      - Normalleştirilmiş sipariş listesi
 */
async function fetchHepsiburadaOrders(creds, days = 30) {
  const { merchantId, apiKey } = creds;
  if (!merchantId || !apiKey) {
    throw new Error('Hepsiburada kimlik bilgileri eksik (merchantId, apiKey)');
  }

  const headers = makeHBHeaders(merchantId, apiKey);

  // Günün başı/sonu ile tarih aralığı
  const endDate = new Date();
  endDate.setHours(23, 59, 59, 999);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  startDate.setHours(0, 0, 0, 0);

  // Tüm durumları ayrı ayrı çek
  const statuses = [
    'WAITING_IN_MERCHANT',
    'IN_CARGO',
    'DELIVERED',
    'CANCELLED',
    'RETURNED'
  ];

  const allOrders = [];
  const seenIds = new Set();

  for (const status of statuses) {
    let offset = 0;
    const limit = 50;
    let hasMore = true;
    let pageNum = 0;

    while (hasMore) {
      const params = new URLSearchParams({
        status,
        beginDate: formatHBDate(startDate),
        endDate: formatHBDate(endDate),
        limit: String(limit),
        offset: String(offset)
      });

      const url = `${HB_BASE}/api/orders?${params}`;
      let data;

      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 404 || res.status === 204) { hasMore = false; break; }
          // İlk sayfa + ilk status'ta hata → throw
          if (offset === 0 && status === statuses[0]) {
            throw new Error(`Hepsiburada API HTTP ${res.status}: ${errText.substring(0, 300)}`);
          }
          // Diğer sayfa/statüslerde hata → atla
          console.warn(`[HepsiB] Status=${status} offset=${offset} HTTP ${res.status} — atlanıyor`);
          hasMore = false;
          break;
        }
        data = await res.json();
      } catch (err) {
        if (offset === 0 && status === statuses[0]) throw err;
        console.error(`[HepsiB] Status=${status} offset=${offset} hata:`, err.message);
        hasMore = false;
        break;
      }

      const orders = extractHBOrders(data);
      if (!orders || orders.length === 0) { hasMore = false; break; }

      pageNum++;
      console.log(`[HepsiB] Status=${status} sayfa ${pageNum} — ${orders.length} sipariş`);

      for (const order of orders) {
        const norm = normalizeHBOrder(order);
        if (!seenIds.has(norm.order_id)) {
          seenIds.add(norm.order_id);
          allOrders.push(norm);
        }
      }

      // Bir sonraki sayfa var mı?
      if (orders.length < limit) { hasMore = false; }
      else { offset += limit; }
    }
  }

  console.log(`[HepsiB] Toplam ${allOrders.length} sipariş çekildi`);
  return allOrders;
}

function extractHBOrders(data) {
  if (Array.isArray(data)) return data;
  if (data?.data?.orders) return data.data.orders;
  if (data?.data?.orderList) return data.data.orderList;
  if (data?.data?.items) return data.data.items;
  if (data?.orders) return data.orders;
  if (data?.orderList) return data.orderList;
  if (data?.items) return data.items;
  return [];
}

function formatHBDate(date) {
  // YYYY-MM-DD formatı
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normalizeHBOrder(order) {
  const rawStatus = order.status || '';
  const isReturned = HB_RETURN_STATUSES.has(rawStatus);

  const items = (order.orderLines || order.lines || order.items || order.orderItems || []).map(line => {
    const lineStatus = line.status || rawStatus;
    return {
      item_id: String(line.id || line.lineId || line.orderLineId || ''),
      barcode: (line.barcode || line.productBarcode || line.merchantBarcode || '').trim(),
      sku: line.merchantSku || line.sku || '',
      product_name: line.name || line.productName || line.productHbSku || '',
      quantity: parseInt(line.quantity || line.requestedQuantity || 1),
      price: parseFloat(line.price || line.salePrice || line.unitPrice || 0),
      raw_status: lineStatus,
      status: HB_STATUS_MAP[lineStatus] || HB_STATUS_MAP[rawStatus] || 'bekliyor',
      status_tr: HB_STATUS_TR[lineStatus] || HB_STATUS_TR[rawStatus] || lineStatus,
      should_deduct: HB_DEDUCT_STATUSES.has(lineStatus) || HB_DEDUCT_STATUSES.has(rawStatus),
      // Komisyon
      commission_amount: parseFloat(line.merchantCommissionAmount || line.commissionAmount || 0) || null,
      commission_rate:   parseFloat(line.merchantCommissionRate   || line.commissionRate   || 0) || null,
      // Desi
      cargo_desi: parseFloat(line.cargoDeciWeight || line.desi || 0) || null
    };
  });

  // Kargo
  const cargoCompany  = order.cargoCompany || order.shippingCompany || '';
  const cargoTracking = order.trackingNumber || order.cargoTrackingNumber || '';
  const cargoStatus   = order.cargoStatus || rawStatus;

  // Toplamlar
  const totalCommission = items.reduce((s, i) => s + (i.commission_amount || 0), 0);
  // Etkin komisyon oranı: tutar bazlı — ürün sayısından bağımsız
  const totalSalePrice  = items.reduce((s, i) => s + (parseFloat(i.price || 0) * parseInt(i.quantity || 1)), 0);
  const hbCommRates     = items.filter(i => i.commission_rate).map(i => i.commission_rate);
  const avgCommissionRate = (totalCommission > 0 && totalSalePrice > 0)
    ? Math.round((totalCommission / totalSalePrice) * 10000) / 100
    : (hbCommRates.length > 0 ? hbCommRates.reduce((a, b) => a + b, 0) / hbCommRates.length : null);
  const totalDesi = items.reduce((s, i) => s + (i.cargo_desi || 0), 0);

  return {
    platform: 'hepsiburada',
    order_id: String(order.orderNumber || order.id || order.orderId || order.packageId || ''),
    order_number: String(order.orderNumber || order.id || order.orderId || order.packageId || ''),
    status: HB_STATUS_MAP[rawStatus] || 'bekliyor',
    status_tr: HB_STATUS_TR[rawStatus] || rawStatus,
    raw_status: rawStatus,
    customer_name: order.customerName || order.customer?.fullName || order.customer?.name || '',
    order_date: order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price: parseFloat(order.totalPrice || order.grossAmount || order.amount || 0),
    currency: 'TRY',
    // Kargo
    cargo_company:         cargoCompany,
    cargo_tracking_number: cargoTracking,
    cargo_status:          cargoStatus,
    cargo_cost:            parseFloat(order.shippingCost || order.cargoCost || 0) || null,
    // Komisyon & desi
    commission_amount: totalCommission > 0 ? totalCommission : null,
    commission_rate:   avgCommissionRate,
    cargo_desi:        totalDesi > 0 ? totalDesi : null,
    // İade
    is_returned:   isReturned,
    return_reason: isReturned ? (order.returnReason || order.cancelReason || '') : null,
    return_date:   isReturned && order.returnDate ? new Date(order.returnDate) : null,
    items
  };
}

module.exports = { fetchHepsiburadaOrders, HB_STATUS_MAP, HB_STATUS_TR, HB_DEDUCT_STATUSES };
