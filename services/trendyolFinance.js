/**
 * Trendyol Finance (Hakediş) API Servisi — native fetch, axios YOK
 * Endpoint: https://apigw.trendyol.com/integration/finance/sellers/{sellerId}/settlements
 */

const TY_FINANCE_BASE = 'https://apigw.trendyol.com/integration/finance/sellers';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Belirtilen tarih aralığı için Trendyol hakediş verilerini çeker
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
      `startDate=${startMs}&endDate=${endMs}&size=${size}&page=${page}`;

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (netErr) {
      if (page === 0) throw new Error(`Finance API ağ hatası: ${netErr.message}`);
      console.error('[TrendyolFinance] Ağ hatası, duruyoruz:', netErr.message);
      break;
    }

    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after') || '5') * 1000;
      console.warn(`[TrendyolFinance] 429 — ${wait}ms bekleniyor`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (page === 0) throw new Error(`Finance API HTTP ${res.status}: ${body.substring(0, 200)}`);
      console.error('[TrendyolFinance] HTTP hatası, duruyoruz:', res.status);
      break;
    }

    let data;
    try { data = await res.json(); } catch (e) { break; }

    const content = data.content || data.result || [];
    totalPages = data.totalPages || data.totalPage || 1;
    console.log(`[TrendyolFinance] Sayfa ${page + 1}/${totalPages}: ${content.length} kayıt`);
    allItems.push(...content);
    page++;

    if (page < totalPages) await sleep(300);
  }

  return allItems;
}

/**
 * Hakediş verisinden sipariş bazlı komisyon+desi haritası oluşturur
 */
function buildCommissionMap(settlements) {
  const map = new Map();
  for (const item of settlements) {
    const orderNo = String(
      item.orderNumber || item.orderNo || item.shipmentPackageId || ''
    ).trim();
    if (!orderNo) continue;

    const existing = map.get(orderNo) || { commissionFee: 0, commissionRate: null, desi: null };
    const fee  = parseFloat(item.commissionFee || item.commission || item.commissionAmount || 0);
    const rate = parseFloat(item.commissionRate || item.commissionRatio || 0);
    // Desi: Finance API'de gelebilecek tüm alan adları
    const desi = parseFloat(
      item.volumetricWeight || item.cargoWeight || item.desi ||
      item.packageDesi || item.shipmentDesi || 0
    ) || null;

    existing.commissionFee += fee;
    // Oran: 0.215 gibi decimal geliyorsa × 100 yap (Trendyol bazen decimal döner)
    if (rate > 0) {
      const normalizedRate = rate < 1 ? Math.round(rate * 100 * 100) / 100 : Math.round(rate * 100) / 100;
      if (!existing.commissionRate) existing.commissionRate = normalizedRate;
    }
    if (desi && !existing.desi) existing.desi = desi;
    map.set(orderNo, existing);
  }
  return map;
}

/**
 * DB'deki marketplace_orders tablosunu hakediş verileriyle günceller
 */
async function syncSettlements(db, creds, days = 30) {
  const { supplierId, apiKey, apiSecret } = creds;
  if (!supplierId || !apiKey || !apiSecret) {
    throw new Error('Trendyol Finance: kimlik bilgileri eksik');
  }

  const endDate   = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let settlements;
  try {
    settlements = await fetchSettlements(supplierId, apiKey, apiSecret, startDate, endDate);
  } catch (err) {
    console.warn('[TrendyolFinance] Hakediş çekilemedi (kritik değil):', err.message);
    return { updated: 0 };
  }

  if (!settlements.length) return { updated: 0 };

  const commMap = buildCommissionMap(settlements);
  let updated = 0;

  for (const [orderNumber, info] of commMap.entries()) {
    if (!info.commissionFee && !info.commissionRate && !info.desi) continue;
    // Finance API her zaman daha güvenilir — commission_amount IS NULL kontrolü kaldırıldı
    // commission_rate: Finance'dan geliyorsa her zaman güncelle (daha doğru kaynak)
    const result = await db.query(
      `UPDATE marketplace_orders
       SET commission_amount = CASE WHEN $1 > 0 THEN $1 ELSE commission_amount END,
           commission_rate   = CASE WHEN $2 IS NOT NULL THEN $2 ELSE commission_rate END,
           cargo_desi        = CASE WHEN $4 IS NOT NULL AND cargo_desi IS NULL THEN $4 ELSE cargo_desi END,
           updated_at        = NOW()
       WHERE platform = 'trendyol'
         AND (order_number = $3 OR order_id = $3)`,
      [info.commissionFee || 0, info.commissionRate || null, orderNumber, info.desi || null]
    );
    if (result.rowCount > 0) updated++;
  }

  console.log(`[TrendyolFinance] ${updated} sipariş komisyon güncellendi`);
  return { updated };
}

module.exports = { fetchSettlements, buildCommissionMap, syncSettlements };
