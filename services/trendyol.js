/**
 * Trendyol Satıcı API İstemcisi
 * Dokümantasyon: https://developers.trendyol.com
 */

const TY_BASE = 'https://api.trendyol.com/sapigw';

// Trendyol sipariş durumu → BagStock dahili durum
const TY_STATUS_MAP = {
  'Created':     'bekliyor',
  'Picking':     'kargoda',
  'Invoiced':    'kargoda',
  'Shipped':     'kargoda',
  'Delivered':   'teslim_edildi',
  'Cancelled':   'iptal',
  'UnDelivered': 'iptal',
  'Returned':    'iade',
  'Repack':      'bekliyor',
  'WaitingForSupply': 'bekliyor'
};

// Stok düşürme tetikleyici durumlar (bu duruma geçince stok düşür)
const TY_DEDUCT_STATUSES = new Set(['Picking', 'Invoiced', 'Shipped', 'Delivered']);

function makeTYHeaders(apiKey, apiSecret, supplierId) {
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'User-Agent': `${supplierId} - SelfIntegration`,
    'Content-Type': 'application/json'
  };
}

/**
 * Son N günün siparişlerini çeker (tüm sayfalar dahil)
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
  const startDate = endDate - days * 24 * 60 * 60 * 1000;

  let allOrders = [];
  let page = 0;
  const size = 200;
  let totalPages = 1;

  while (page < totalPages) {
    const url = `${TY_BASE}/suppliers/${supplierId}/orders?startDate=${startDate}&endDate=${endDate}&size=${size}&page=${page}&orderByField=PackageLastModifiedDate&orderByDirection=DESC`;

    let data;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Trendyol API HTTP ${res.status}: ${errText.substring(0, 200)}`);
      }
      data = await res.json();
    } catch (err) {
      if (page === 0) throw err; // ilk sayfada hata — tamamen başarısız
      console.error(`[Trendyol] Sayfa ${page} alınamadı:`, err.message);
      break;
    }

    if (!data.content || !Array.isArray(data.content)) break;

    totalPages = data.totalPages || 1;
    page++;

    for (const order of data.content) {
      allOrders.push(normalizeTYOrder(order));
    }
  }

  return allOrders;
}

function normalizeTYOrder(order) {
  const items = (order.lines || []).map(line => ({
    item_id: String(line.id),
    barcode: (line.barcode || '').trim(),
    sku: line.sku || '',
    product_name: line.productName || '',
    quantity: line.quantity || 1,
    price: line.price || line.amount || 0,
    raw_status: line.lineItemStatusName || order.status || '',
    status: TY_STATUS_MAP[line.lineItemStatusName] || TY_STATUS_MAP[order.status] || 'bekliyor',
    should_deduct: TY_DEDUCT_STATUSES.has(line.lineItemStatusName || order.status)
  }));

  const rawStatus = order.status || '';
  return {
    platform: 'trendyol',
    order_id: String(order.id || order.orderNumber),
    order_number: String(order.orderNumber || order.id),
    status: TY_STATUS_MAP[rawStatus] || 'bekliyor',
    raw_status: rawStatus,
    customer_name: order.customerName || order.shipmentAddress?.fullName || '',
    order_date: order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price: order.grossAmount || order.totalPrice || 0,
    currency: 'TRY',
    items
  };
}

module.exports = { fetchTrendyolOrders, TY_STATUS_MAP, TY_DEDUCT_STATUSES };
