/**
 * Hepsiburada Marketplace API İstemcisi
 * Dokümantasyon: https://developers.hepsiburada.com
 */

const HB_BASE = 'https://listing-external.hepsiburada.com';

// Hepsiburada sipariş durumu → BagStock dahili durum
const HB_STATUS_MAP = {
  'WAITING_IN_MERCHANT':    'bekliyor',
  'WAITING_IN_PACK_STAGE':  'bekliyor',
  'CONFIRMED':              'bekliyor',
  'IN_CARGO':               'kargoda',
  'AT_CARGO':               'kargoda',
  'IN_TRANSIT':             'kargoda',
  'DELIVERED':              'teslim_edildi',
  'UNDELIVERED':            'iptal',
  'CANCELLED':              'iptal',
  'CANCELLED_BEFORE_CARGO': 'iptal',
  'RETURNED':               'iade',
  'RETURN_ACCEPTED':        'iade'
};

// Stok düşürme tetikleyici durumlar
const HB_DEDUCT_STATUSES = new Set(['IN_CARGO', 'AT_CARGO', 'IN_TRANSIT', 'DELIVERED']);

function makeHBHeaders(merchantId, apiKey) {
  const credentials = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

/**
 * Son N günün siparişlerini çeker
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
  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Tüm durumları ayrı ayrı çek (HB API bazı durumlarda tek status kabul eder)
  const statuses = ['WAITING_IN_MERCHANT', 'IN_CARGO', 'DELIVERED', 'CANCELLED'];
  const allOrders = [];
  const seenIds = new Set();

  for (const status of statuses) {
    let offset = 0;
    const limit = 100;
    let hasMore = true;

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
          // 404 = o status için sipariş yok, normal
          if (res.status === 404) { hasMore = false; break; }
          throw new Error(`Hepsiburada API HTTP ${res.status}: ${errText.substring(0, 200)}`);
        }
        data = await res.json();
      } catch (err) {
        if (offset === 0 && status === statuses[0]) throw err;
        console.error(`[HepsiB] Status=${status} offset=${offset} alınamadı:`, err.message);
        hasMore = false;
        break;
      }

      // HB API'si farklı response yapıları döndürebilir
      const orders = extractHBOrders(data);
      if (!orders || orders.length === 0) { hasMore = false; break; }

      for (const order of orders) {
        const norm = normalizeHBOrder(order);
        if (!seenIds.has(norm.order_id)) {
          seenIds.add(norm.order_id);
          allOrders.push(norm);
        }
      }

      if (orders.length < limit) { hasMore = false; }
      else { offset += limit; }
    }
  }

  return allOrders;
}

function extractHBOrders(data) {
  // HB çeşitli response yapıları kullanabilir
  if (Array.isArray(data)) return data;
  if (data?.data?.orders) return data.data.orders;
  if (data?.data?.orderList) return data.data.orderList;
  if (data?.orders) return data.orders;
  if (data?.orderList) return data.orderList;
  return [];
}

function formatHBDate(date) {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function normalizeHBOrder(order) {
  const rawStatus = order.status || '';
  const items = (order.orderLines || order.lines || order.items || []).map(line => ({
    item_id: String(line.id || line.lineId || ''),
    barcode: (line.barcode || line.productBarcode || '').trim(),
    sku: line.merchantSku || line.sku || '',
    product_name: line.name || line.productName || '',
    quantity: line.quantity || 1,
    price: line.price || line.salePrice || 0,
    raw_status: line.status || rawStatus,
    status: HB_STATUS_MAP[line.status || rawStatus] || 'bekliyor',
    should_deduct: HB_DEDUCT_STATUSES.has(line.status || rawStatus)
  }));

  return {
    platform: 'hepsiburada',
    order_id: String(order.id || order.orderId),
    order_number: String(order.orderNumber || order.id || order.orderId),
    status: HB_STATUS_MAP[rawStatus] || 'bekliyor',
    raw_status: rawStatus,
    customer_name: order.customerName || order.customer?.fullName || '',
    order_date: order.orderDate ? new Date(order.orderDate) : new Date(),
    total_price: order.totalPrice || order.grossAmount || 0,
    currency: 'TRY',
    items
  };
}

module.exports = { fetchHepsiburadaOrders, HB_STATUS_MAP, HB_DEDUCT_STATUSES };
