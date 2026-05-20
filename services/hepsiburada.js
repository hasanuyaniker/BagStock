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
  // Production'da yeni merchant'lar için uzun tarih aralığı (30 gün) 400 döndürebilir.
  // Merchant aktivasyon tarihi öncesi sorgulama reddedilir. Çoklu strateji denen.
  const today      = formatHBDate(new Date());
  const yesterday  = formatHBDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const week7ago   = formatHBDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  // Yeni merchant'larda HB, aktivasyon öncesi tarihleri reddeder.
  // tarihsiz endpoint ilk sırada — çalışırsa en güvenilir yol.
  // Tarihe dayalı sorgular ek güvence olarak arkada kalır.
  const ordersStrategies = [
    { label: 'tarihsiz',         params: {} },
    { label: 'sadece bugün',     params: { begindate: today,     enddate: today } },
    { label: 'dün+bugün',        params: { begindate: yesterday, enddate: today } },
    { label: 'son 7 gün',        params: { begindate: week7ago,  enddate: today } },
    { label: `son ${days} gün`,  params: { begindate, enddate } },
  ];

  const ordersCallback = (item) => {
    const norm = normalizeHBOpenOrder(item);
    if (norm.order_id && !seenIds.has(norm.order_id)) {
      seenIds.add(norm.order_id);
      allOrders.push(norm);
    }
  };

  let ordersFetched = false;
  for (const strategy of ordersStrategies) {
    try {
      console.log(`[HepsiB] /orders/ deneniyor: ${strategy.label}`);
      await fetchPaginated(`${base}/orders/merchantid/${merchantId}`, strategy.params, headers, ordersCallback);
      console.log(`[HepsiB] /orders/ başarılı: ${strategy.label}`);
      ordersFetched = true;
      break;
    } catch (e) {
      if (e.message.includes('400') || e.message.includes('BadRequest')) {
        console.warn(`[HepsiB] /orders/ strateji başarısız (${strategy.label}): ${e.message.substring(0, 120)}`);
      } else {
        throw e;
      }
    }
  }
  if (!ordersFetched) {
    console.warn('[HepsiB] /orders/ tüm stratejiler başarısız — açık siparişler atlandı');
  }

  // ── 2. Paketler — HB'nin status bazlı AYRI endpoint'leri var ─────────────────
  // Dok: /packages/merchantid/{id}           → Open/Packed (aksiyon bekleyenler)
  //      /packages/merchantid/{id}/shipped   → Kargoya Verilen
  //      /packages/merchantid/{id}/delivered → Teslim Edilen
  //      /packages/merchantid/{id}/undelivered→ Teslim Edilemedi
  // NOT: Base endpoint'te status query param YOKTUR — dokümanda tanımlanmamış.
  //      timespan parametresi destekleniyor (son N saat).

  const pkgBase = `${base}/packages/merchantid/${merchantId}`;

  // Tarihli sorgular /shipped ve /delivered endpoint'lerinde WrongDateFormat veriyor.
  // Bu nedenle sadece tarihsiz sorgular kullanılıyor.
  // Her sorgu kendi rawStatus'unu taşır — normalizer'a iletilir.
  const pkgQueries = [
    // Open / Packed siparişler
    // Open / Packed — timespan olmadan = sadece şu an aksiyon bekleyen paketler.
    // NOT: timespan=720 kaldırıldı; bu parametre kargodaki paketleri Packed gibi
    // döndürüp yanlış status yazımlarına ve tekrar mail gönderimlerine yol açıyordu.
    { url: pkgBase,                  params: {},               label: 'open-tarihsiz',        rawStatus: 'Packed'      },
    // Kargoya verilen (shipped endpoint'i sadece tarihsiz çalışıyor)
    { url: `${pkgBase}/shipped`,     params: {},               label: 'shipped-tarihsiz',     rawStatus: 'Shipped'     },
    // Teslim edilen
    { url: `${pkgBase}/delivered`,   params: {},               label: 'delivered-tarihsiz',   rawStatus: 'Delivered'   },
    // NOT: /undelivered endpoint'i kaldırıldı — kargoda durumundaki siparişleri
    // yanlışlıkla 'iptal' olarak işaretliyordu. UnDelivered paketler upsertOrder'daki
    // durum öncelik kuralları ile korunuyor.
  ];

  const pkgCallback = (pkg, forcedRawStatus) => {
    const norm = normalizeHBPackage(pkg, forcedRawStatus);
    if (norm.order_id && !seenIds.has(norm.order_id)) {
      seenIds.add(norm.order_id);
      allOrders.push(norm);
    }
  };

  let pkgFetched = false;
  for (const q of pkgQueries) {
    try {
      console.log(`[HepsiB] /packages/ ${q.label} | ${q.url.split('/').slice(-2).join('/')} | params: ${JSON.stringify(q.params)}`);
      const beforeCount = allOrders.length;
      await fetchPaginated(q.url, q.params, headers, (pkg) => pkgCallback(pkg, q.rawStatus));
      const added = allOrders.length - beforeCount;
      if (added > 0) {
        console.log(`[HepsiB] /packages/ ${q.label}: +${added} yeni paket`);
        pkgFetched = true;
      }
    } catch (e) {
      if (e.message.includes('400') || e.message.includes('BadRequest')) {
        console.warn(`[HepsiB] /packages/ başarısız (${q.label}): ${e.message.substring(0, 100)}`);
      } else {
        throw e;
      }
    }
  }

  if (!pkgFetched) {
    console.warn('[HepsiB] /packages/ tüm sorgular 0 kayıt döndürdü');
  }

  console.log(`[HepsiB] Toplam ${allOrders.length} sipariş çekildi`);

  // ── Flat-format paket zenginleştirme ─────────────────────────────────────────
  // /shipped ve /delivered endpoint'leri sadece düz (flat) kayıt döndürür:
  // lineItems olmaz, Barcode alanı teslimat/kargo barkodu olabilir.
  // İki adımda ürün adı + müşteri bilgisi doldurmaya çalışıyoruz.

  // Zenginleştirilmesi gereken flat-format paketler
  const flatToEnrich = allOrders.filter(o =>
    o.platform === 'hepsiburada' &&
    Array.isArray(o.items) &&
    o.items.every(i => !i.product_name) &&
    o.order_id
  );

  if (flatToEnrich.length > 0) {
    console.log(`[HepsiB] ${flatToEnrich.length} flat-format paket zenginleştirilecek`);

    // Adım 1: Bu sync'te /orders endpoint'inden zaten gelen siparişlerle eşleştir
    // order_number üzerinden eşleme — /orders open siparişler lineItems içerir
    const richByOrderNum = new Map();
    for (const o of allOrders) {
      if (o.order_number && o.items && o.items.some(i => i.product_name)) {
        richByOrderNum.set(o.order_number, o);
      }
    }

    for (const flatOrder of flatToEnrich) {
      if (flatOrder.order_number && richByOrderNum.has(flatOrder.order_number)) {
        const rich = richByOrderNum.get(flatOrder.order_number);
        flatOrder.items = rich.items.map(i => ({
          ...i,
          status:        flatOrder.status,
          status_tr:     flatOrder.status_tr,
          raw_status:    flatOrder.raw_status,
          should_deduct: HB_DEDUCT_STATUSES.has(flatOrder.raw_status),
        }));
        flatOrder.customer_name = flatOrder.customer_name || rich.customer_name || '';
        flatOrder.total_price   = flatOrder.total_price   || rich.total_price   || 0;
        console.log(`[HepsiB] ✓ #${flatOrder.order_number} /orders verisiyle zenginleştirildi`);
      }
    }

    // Adım 2: Hâlâ eksik olanlar için sipariş detay endpoint'ini dene
    // GET /orders/merchantid/{id}/ordernumber/{orderNumber} → lineItems, komisyon, müşteri adı dahil
    const stillFlat = flatToEnrich.filter(o => o.items.every(i => !i.product_name));
    if (stillFlat.length > 0) {
      console.log(`[HepsiB] ${stillFlat.length} paket için sipariş detay API'si çekiliyor...`);
      for (const flatOrder of stillFlat) {
        const orderNum = flatOrder.order_number || flatOrder.order_id;
        if (!orderNum) continue;
        try {
          const detailUrl = `${base}/orders/merchantid/${merchantId}/ordernumber/${orderNum}`;
          console.log(`[HepsiB] Sipariş detay GET ${detailUrl}`);
          const res = await fetch(detailUrl, { headers, signal: AbortSignal.timeout(10000) });
          console.log(`[HepsiB] Sipariş detay HTTP ${res.status}`);
          if (!res.ok) continue;

          const orderData = await res.json();
          const lineItems = orderData?.lineItems || orderData?.orderLines || orderData?.lines || orderData?.items || [];
          if (lineItems.length > 0) {
            flatOrder.items = lineItems.map(line => ({
              item_id:           String(line.id || line.lineItemId || line.lineId || ''),
              barcode:           (line.merchantSku || line.merchantSkuId || line.barcode || line.merchantBarcode || line.productBarcode || '').trim(),
              sku:               line.hepsiburadaSku || line.sku || line.merchantSku || '',
              product_name:      line.name || line.productName || line.hepsiburadaSku || '',
              quantity:          parseInt(line.quantity || line.requestedQuantity || 1),
              price:             parseFloat(line.price?.amount ?? line.price ?? line.unitPrice?.amount ?? line.salePrice ?? 0),
              raw_status:        flatOrder.raw_status,
              status:            flatOrder.status,
              status_tr:         flatOrder.status_tr,
              should_deduct:     HB_DEDUCT_STATUSES.has(flatOrder.raw_status),
              commission_amount: parseFloat(line.commission?.amount ?? line.commissionAmount ?? line.merchantCommissionAmount ?? 0) || null,
              commission_rate:   parseFloat(line.commissionRate ?? line.merchantCommissionRate ?? 0) || null,
              cargo_desi:        null,
            }));
            if (!flatOrder.customer_name) {
              flatOrder.customer_name = orderData?.customer?.fullName || orderData?.customerName || '';
            }
            if (!flatOrder.total_price || flatOrder.total_price === 0) {
              flatOrder.total_price = parseFloat(orderData?.totalPrice?.amount ?? orderData?.totalPrice ?? orderData?.grossAmount ?? 0) || 0;
            }
            console.log(`[HepsiB] ✓ #${orderNum} sipariş detay zenginleştirme başarılı (${lineItems.length} ürün)`);
            flatOrder.items.forEach(i => {
              console.log(`[HepsiB]   ↳ barcode="${i.barcode}" sku="${i.sku}" product_name="${i.product_name}" should_deduct=${i.should_deduct} qty=${i.quantity}`);
            });
          } else {
            // lineItems yok — paket detay endpoint'ini dene (kargo bilgisi endpoint'i)
            try {
              const pkgDetailUrl = `${pkgBase}/packagenumber/${flatOrder.order_id}`;
              console.log(`[HepsiB] Paket detay GET ${pkgDetailUrl}`);
              const pr = await fetch(pkgDetailUrl, { headers, signal: AbortSignal.timeout(10000) });
              console.log(`[HepsiB] Paket detay HTTP ${pr.status}`);
              if (!pr.ok) continue;
              const pkgData = await pr.json();
              const pkgLines = pkgData?.lineItems || pkgData?.lines || pkgData?.items || [];
              if (pkgLines.length > 0) {
                flatOrder.items = pkgLines.map(line => ({
                  item_id:           String(line.id || line.lineItemId || line.lineId || ''),
                  barcode:           (line.merchantSku || line.merchantSkuId || line.barcode || line.merchantBarcode || line.productBarcode || '').trim(),
                  sku:               line.merchantSku || line.sku || '',
                  product_name:      line.name || line.productName || line.hepsiburadaSku || '',
                  quantity:          parseInt(line.quantity || 1),
                  price:             parseFloat(line.price?.amount ?? line.price ?? line.unitPrice?.amount ?? 0),
                  raw_status:        flatOrder.raw_status,
                  status:            flatOrder.status,
                  status_tr:         flatOrder.status_tr,
                  should_deduct:     HB_DEDUCT_STATUSES.has(flatOrder.raw_status),
                  commission_amount: parseFloat(line.commission?.amount ?? line.commissionAmount ?? 0) || null,
                  commission_rate:   parseFloat(line.commissionRate ?? 0) || null,
                  cargo_desi:        null,
                }));
                console.log(`[HepsiB] ✓ #${flatOrder.order_id} paket detay zenginleştirme başarılı (${pkgLines.length} ürün)`);
                flatOrder.items.forEach(i => {
                  console.log(`[HepsiB]   ↳ barcode="${i.barcode}" sku="${i.sku}" product_name="${i.product_name}" should_deduct=${i.should_deduct} qty=${i.quantity}`);
                });
              } else {
                console.log(`[HepsiB] ⚠ #${flatOrder.order_id} hiçbir endpoint lineItems döndürmedi: ${JSON.stringify(orderData).substring(0, 200)}`);
              }
            } catch (pkgErr) {
              console.warn(`[HepsiB] #${flatOrder.order_id} paket detay hatası: ${pkgErr.message.substring(0, 100)}`);
            }
          }
        } catch (enrichErr) {
          console.warn(`[HepsiB] #${orderNum} zenginleştirme hatası: ${enrichErr.message.substring(0, 100)}`);
        }
      }
    }
  }

  // ── Listings API barkod haritası: 6225.../HBCV... → merchantSku (HF00...) ───────
  // HB sipariş detay API'si lineItems'ta merchantSku döndürmüyor.
  // Listings API'sinden ürün barkodu → satıcı SKU haritası oluşturup uyguluyoruz.
  try {
    const listingBase = environment === 'production'
      ? 'https://listing-external.hepsiburada.com'
      : 'https://listing-external-sit.hepsiburada.com';
    const lUrl = `${listingBase}/listings/merchantid/${merchantId}?offset=0&limit=1000`;
    console.log(`[HepsiB] Listings haritası çekiliyor: ${lUrl}`);
    const lRes = await fetch(lUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (lRes.ok) {
      const lData = await lRes.json();
      const rows = Array.isArray(lData) ? lData : (lData.listings || lData.data || lData.result || lData.items || []);
      const listingsMap = {}; // { "6225..." → "HF00...", "HBCV..." → "HF00..." }
      for (const l of rows) {
        const mSku = String(l.merchantSku || l.MerchantSku || '').trim();
        if (!mSku) continue;
        // Tüm olası barkod/sku alanlarını haritaya ekle
        for (const field of ['barcode', 'Barcode', 'productBarcode', 'ProductBarcode',
                              'gtin', 'ean', 'EAN', 'upc', 'hepsiburadaSku', 'HepsiburadaSku', 'sku', 'Sku']) {
          const val = String(l[field] || '').trim();
          if (val && val !== mSku) listingsMap[val] = mSku;
        }
      }
      const mapSize = Object.keys(listingsMap).length;
      console.log(`[HepsiB] Listings haritası: ${rows.length} listing → ${mapSize} barkod eşleşmesi`);
      if (mapSize > 0) {
        // Tüm siparişlerdeki barkodları harita ile çevir
        // Önce item.barcode ile dene (6225... veya HBCV... direkt eşleşirse)
        // Sonra item.sku ile dene — zenginleştirme hepsiburadaSku'yu sku'ya atar (HBCV...)
        // ve Listings haritası HBCV → HF00... biliyor.
        let converted = 0;
        for (const order of allOrders) {
          for (const item of (order.items || [])) {
            if (item.barcode && listingsMap[item.barcode]) {
              // Direkt barcode eşleşmesi
              const oldBarcode = item.barcode;
              item.barcode = listingsMap[item.barcode];
              console.log(`[HepsiB] Barkod çevrildi (barcode): "${oldBarcode}" → "${item.barcode}" [#${order.order_number || order.order_id}]`);
              converted++;
            } else if (item.sku && listingsMap[item.sku]) {
              // sku (hepsiburadaSku = HBCV...) üzerinden eşleşme
              const oldBarcode = item.barcode;
              item.barcode = listingsMap[item.sku];
              console.log(`[HepsiB] Barkod çevrildi (sku="${item.sku}"): "${oldBarcode}" → "${item.barcode}" [#${order.order_number || order.order_id}]`);
              converted++;
            }
          }
        }
        if (converted > 0) console.log(`[HepsiB] Toplam ${converted} item barkodu satıcı SKU'ya çevrildi`);
        else console.log(`[HepsiB] Listings haritasında eşleşen barkod bulunamadı (harita örnekleri: ${JSON.stringify(Object.entries(listingsMap).slice(0, 3))})`);
      }
    } else {
      console.warn(`[HepsiB] Listings API hatası: HTTP ${lRes.status}`);
    }
  } catch (listErr) {
    console.warn(`[HepsiB] Listings haritası çekilemedi (kritik değil): ${listErr.message.substring(0, 100)}`);
  }

  console.log(`[HepsiB] Zenginleştirme tamamlandı. Döndürülen sipariş: ${allOrders.length}`);
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
    // DEBUG — ilk item'ın ham yapısını logla
    if (items.length > 0 && offset === 0) {
      console.log('[HepsiB][DEBUG] item[0] keys:', Object.keys(items[0]).join(', '));
      console.log('[HepsiB][DEBUG] item[0]:', JSON.stringify(items[0]).substring(0, 800));
    }

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
    barcode:           (line.merchantSku || line.merchantSkuId || line.barcode || line.merchantBarcode || line.productBarcode || '').trim(),
    sku:               line.merchantSku || line.sku || '',
    product_name:      line.name || line.productName || line.hepsiburadaSku || '',
    quantity:          parseInt(line.quantity || line.requestedQuantity || 1),
    price:             parseFloat(line.price?.amount ?? line.price ?? line.unitPrice?.amount ?? line.salePrice ?? 0),
    raw_status:        rawStatus,
    status:            HB_STATUS_MAP[rawStatus] || 'bekliyor',
    status_tr:         HB_STATUS_TR[rawStatus] || 'Satıcıda Bekliyor',
    should_deduct:     false,
    commission_amount: parseFloat(line.commission?.amount ?? line.commissionAmount ?? 0) || null,
    commission_rate:   parseFloat(line.commissionRate ?? 0) || null,
    cargo_desi:        null,
  }));

  // HB timestamps come without timezone ("2026-05-06T23:22:41.823") — treat as Turkey (UTC+3)
  const parseHBDate = (str) => {
    if (!str) return new Date();
    if (str.includes('+') || str.endsWith('Z')) return new Date(str);
    return new Date(str + '+03:00');
  };

  // /orders endpoint'ten gelen bekliyor siparişler:
  // Paket numarası varsa onu birincil anahtar olarak kullan (/packages endpoint'iyle uyumlu olur)
  // Yoksa sipariş numarasını kullan
  const pkgNumFromOrder = String(
    order.packageId || order.packageNumber ||
    (order.lineItems?.[0]?.packageId) ||
    (order.lineItems?.[0]?.packageNumber) || ''
  );
  const orderNumFromOrder = String(order.orderNumber || order.id || order.orderId || '');
  const orderId = pkgNumFromOrder || orderNumFromOrder;

  console.log(`[HepsiB][ORDER] orderNumber=${orderNumFromOrder} packageNumber=${pkgNumFromOrder} → order_id=${orderId}`);

  return {
    platform:              'hepsiburada',
    order_id:              orderId,
    order_number:          orderNumFromOrder,  // sipariş numarası her zaman gösterim için
    status:                HB_STATUS_MAP[rawStatus] || 'bekliyor',
    status_tr:             HB_STATUS_TR[rawStatus] || 'Satıcıda Bekliyor',
    raw_status:            rawStatus,
    customer_name:         order.customer?.fullName || order.customerName || '',
    order_date:            parseHBDate(order.orderDate),
    total_price:           parseFloat(order.totalPrice?.amount ?? order.totalPrice ?? order.grossAmount ?? 0),
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

/**
 * Paket normalleştiricisi — iki farklı HB endpoint formatını destekler:
 *  A) Base /packages/ → camelCase, lineItems dizisi var
 *  B) /shipped, /delivered, /undelivered → PascalCase, düz paket kaydı (line items yok)
 *
 * forcedRawStatus: çağıran endpoint'in bilinen status değeri (B formatı için zorunlu)
 */
function normalizeHBPackage(pkg, forcedRawStatus) {
  // A formatı: pkg.status var | B formatı: yoksa forcedRawStatus kullan
  const rawStatus  = pkg.status || pkg.Status || forcedRawStatus || '';
  const internalSt = HB_PKG_STATUS_MAP[rawStatus] || HB_STATUS_MAP[rawStatus] || 'bekliyor';
  const statusTr   = HB_PKG_STATUS_TR[rawStatus] || HB_STATUS_TR[rawStatus] || rawStatus;
  const isReturned = HB_RETURN_STATUSES.has(rawStatus);

  // HB timestamps come without timezone — treat as Turkey (UTC+3)
  const parseHBDate = (str) => {
    if (!str) return new Date();
    if (str.includes('+') || str.endsWith('Z')) return new Date(str);
    return new Date(str + '+03:00');
  };

  // B formatı (shipped/delivered) PascalCase kullanır ve line items içermez.
  // Bu durumda paketteki Barcode alanından sentetik bir item oluştururuz.
  const rawLines = pkg.lineItems || pkg.lines || pkg.items || [];
  const isFlatFormat = rawLines.length === 0 && (pkg.Barcode || pkg.PackageNumber);

  let items;
  if (isFlatFormat) {
    // Flat format: /shipped, /delivered, /undelivered endpoint'leri
    // MerchantSku (Satıcı Stok Kodu) öncelikli; yoksa kargo barkodunu kullan (zenginleştirme ile üzerine yazılacak)
    const merchantSku = (pkg.MerchantSku || pkg.merchantSku || '').trim();
    const pkgBarcode  = merchantSku || (pkg.Barcode || pkg.barcode || '').trim();
    const pkgDesi     = parseFloat(pkg.Deci || pkg.deci || 0) || null;
    items = pkgBarcode ? [{
      item_id:           String(pkg.Id || pkg.id || ''),
      barcode:           pkgBarcode,
      sku:               pkg.HepsiburadaSku || pkg.hepsiburadaSku || '',
      product_name:      '',
      quantity:          1,
      price:             0,
      raw_status:        rawStatus,
      status:            internalSt,
      status_tr:         statusTr,
      should_deduct:     HB_DEDUCT_STATUSES.has(rawStatus),
      commission_amount: null,
      commission_rate:   null,
      cargo_desi:        pkgDesi,
    }] : [];
  } else {
    // Full format: base /packages/ endpoint'i — line items var
    items = rawLines.map(line => {
      const lineStatus = line.status || rawStatus;
      return {
        item_id:           String(line.id || line.lineItemId || line.lineId || ''),
        barcode:           (line.merchantSku || line.merchantSkuId || line.barcode || line.merchantBarcode || line.productBarcode || '').trim(),
        sku:               line.merchantSku || line.sku || '',
        product_name:      line.name || line.productName || line.hepsiburadaSku || '',
        quantity:          parseInt(line.quantity || 1),
        price:             parseFloat(line.price?.amount ?? line.price ?? line.unitPrice?.amount ?? line.salePrice ?? 0),
        raw_status:        lineStatus,
        status:            HB_PKG_STATUS_MAP[lineStatus] || HB_STATUS_MAP[lineStatus] || internalSt,
        status_tr:         HB_PKG_STATUS_TR[lineStatus] || HB_STATUS_TR[lineStatus] || lineStatus,
        should_deduct:     HB_DEDUCT_STATUSES.has(rawStatus),
        commission_amount: parseFloat(line.commission?.amount ?? line.commissionAmount ?? line.merchantCommissionAmount ?? 0) || null,
        commission_rate:   parseFloat(line.commissionRate ?? line.merchantCommissionRate ?? 0) || null,
        cargo_desi:        parseFloat(line.desi || line.cargoDeciWeight || 0) || null,
      };
    });
  }

  const totalCommission   = items.reduce((s, i) => s + (i.commission_amount || 0), 0);
  const commRates         = items.filter(i => i.commission_rate).map(i => i.commission_rate);
  const avgCommissionRate = commRates.length
    ? Math.round(commRates.reduce((a,b)=>a+b,0) / commRates.length * 100) / 100
    : null;
  const totalDesi = items.reduce((s, i) => s + (i.cargo_desi || 0), 0);

  // Paket numarası = birincil DB anahtarı (her iki endpoint'te tutarlı)
  // Sipariş numarası = gösterim alanı (HB portaldaki "Sipariş No" ile eşleşir)
  const pkgNumber  = String(
    pkg.PackageNumber || pkg.packageNumber ||
    pkg.Id || pkg.id || pkg.packageId || ''
  );
  const orderNum   = String(
    pkg.OrderNumber || pkg.orderNumber || ''
  );
  // Birincil anahtar: paket numarası varsa onu kullan, yoksa sipariş numarasına düş
  const orderId    = pkgNumber || orderNum;
  // Gösterim: sipariş numarası varsa onu göster (HB portaldaki değer), yoksa paket numarası
  const displayNum = orderNum  || pkgNumber;

  // DEBUG: ilk paket için tam field mapping'i logla (Railway'den izlenebilir)
  if (orderId) {
    console.log(`[HepsiB][PKG] PackageNumber=${pkgNumber} OrderNumber=${orderNum} → order_id=${orderId} order_number=${displayNum} status=${rawStatus}`);
  }

  // order_date: flat format ShippedDate/DeliveredDate kullanır
  const dateStr = pkg.ShippedDate || pkg.DeliveredDate || pkg.UnDeliveredDate || pkg.orderDate;

  // cargo_desi: flat format Deci (PascalCase)
  const pkgDesi = parseFloat(pkg.Deci || pkg.desi || 0) || null;

  return {
    platform:              'hepsiburada',
    order_id:              orderId,
    order_number:          displayNum,
    status:                internalSt,
    status_tr:             statusTr,
    raw_status:            rawStatus,
    customer_name:         pkg.customer?.fullName || pkg.customerName || '',
    order_date:            parseHBDate(dateStr),
    total_price:           parseFloat(pkg.totalPrice?.amount ?? pkg.totalPrice ?? pkg.grossAmount ?? 0),
    currency:              'TRY',
    cargo_company:         pkg.cargoCompany || pkg.shippingCompany || null,
    cargo_tracking_number: pkg.trackingNumber || pkg.cargoTrackingNumber || null,
    cargo_status:          rawStatus,
    cargo_cost:            parseFloat(pkg.shippingCost || 0) || null,
    commission_amount:     totalCommission > 0 ? totalCommission : null,
    commission_rate:       avgCommissionRate,
    cargo_desi:            totalDesi > 0 ? totalDesi : pkgDesi,
    is_returned:           isReturned,
    return_reason:         isReturned ? (pkg.returnReason || '') : null,
    return_date:           isReturned && pkg.returnDate ? new Date(pkg.returnDate) : null,
    items,
  };
}

/**
 * HB listing'lerini çek — tam ürün bilgisiyle (ad, barkod, fiyat, stok, kargo vb.)
 * GET https://listing-external-sit.hepsiburada.com/listings/merchantid/{merchantId}
 * Prod: https://listing-external.hepsiburada.com/listings/merchantid/{merchantId}
 *
 * Ham yanıtı da döndürür; çağıran taraf field mapping'i doğrulayabilir.
 */
async function fetchHBListings(creds, limit = 50) {
  const { merchantId, username, apiKey, environment } = creds;
  const listingBase = environment === 'production'
    ? 'https://listing-external.hepsiburada.com'
    : 'https://listing-external-sit.hepsiburada.com';

  const headers = makeHBHeaders(merchantId, apiKey, username);
  const url = `${listingBase}/listings/merchantid/${merchantId}?offset=0&limit=${limit}`;
  console.log(`[HepsiB Listings] GET ${url}`);

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const rawText = await res.text();
  console.log(`[HepsiB Listings] HTTP ${res.status} | body[0..500]: ${rawText.substring(0, 500)}`);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(rawText); } catch { return { listings: [], raw: rawText }; }

  // HB listing API yanıt formatı değişkenlik gösterebilir
  const rows = Array.isArray(data)
    ? data
    : (data.listings || data.data || data.result || data.items || []);

  const listings = rows.map(l => {
    // Tüm olası field adlarını dene
    const listingId   = String(l.id || l.listingId || l.ListingId || l.hepsiburadaId || '');
    const merchantSku = String(l.merchantSku || l.MerchantSku || l.barcode || l.Barcode || '');
    const sku         = String(l.hepsiburadaSku || l.HepsiburadaSku || l.sku || l.Sku || l.hepsiburadaId || listingId);
    const name        = String(
      l.productName || l.ProductName ||
      l.name || l.Name ||
      l.title || l.Title ||
      merchantSku || sku || ''
    );
    const price       = parseFloat(l.price || l.Price || l.salePrice || l.SalePrice || l.listPrice || 0);
    const stock       = parseInt(l.availableStock || l.stock || l.quantity || l.stockCount || 0, 10);
    const cargoId     = parseInt(l.cargoCompanyId || l.CargoCompanyId || 1, 10);
    const deliveryId  = parseInt(l.deliveryOptionId || l.DeliveryOptionId || 1, 10);
    const vat         = parseInt(l.vat || l.Vat || l.vatRate || 20, 10);

    return { listingId, merchantSku, sku, name, price, stock, cargoId, deliveryId, vat, _raw: l };
  }).filter(l => l.listingId);

  console.log(`[HepsiB Listings] ${listings.length} listing bulundu. İlk örnek:`, JSON.stringify(listings[0]?._raw || {}).substring(0, 400));

  return { listings, raw: data };
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

/**
 * 1. KATALOG: HB'ye ürün gönder, trackingId al
 * POST https://mpop-sit.hepsiburada.com/product/api/products/import
 * Body: multipart/form-data — "file" alanında integrator.json
 */
async function submitHBCatalogProduct(creds, products) {
  const { merchantId, username, apiKey, environment } = creds;
  const base = environment === 'production'
    ? 'https://mpop.hepsiburada.com'
    : 'https://mpop-sit.hepsiburada.com';

  // Basic Auth header — Content-Type FormData tarafından otomatik set edilecek
  const credentials = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
  const authHeaders = {
    'Authorization': `Basic ${credentials}`,
    'User-Agent':    username || 'BagStock',
    'Accept':        'application/json'
    // Content-Type YOK — fetch FormData için boundary'li multipart/form-data'yı kendi set eder
  };

  // Multipart form: JSON içeriği 'file' alanına 'integrator.json' adıyla eklenir
  const jsonContent = JSON.stringify(products);
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const form = new FormData();
  form.append('file', blob, 'integrator.json');

  const url = `${base}/product/api/products/import`;
  console.log(`[HepsiB Katalog] POST ${url} | Ürün sayısı: ${products.length}`);
  console.log(`[HepsiB Katalog] İçerik: ${jsonContent.substring(0, 300)}`);

  const res = await fetch(url, {
    method:  'POST',
    headers: authHeaders,
    body:    form,
    signal:  AbortSignal.timeout(30000)
  });
  const rawText = await res.text();
  console.log(`[HepsiB Katalog] HTTP ${res.status} | ${rawText.substring(0, 500)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 400)}`);
  try { return JSON.parse(rawText); } catch { return { raw: rawText }; }
}

/**
 * TrackingId durumunu sorgula — fallback zinciri
 * Deneme sırası (hepsi /product/ prefix ile):
 *   1. GET /product/api/products/import/{trackingId}        (import path + id)
 *   2. GET /product/api/products/imports/{trackingId}       (çoğul imports)
 *   3. GET /product/api/products?trackingId={trackingId}    (query param)
 *   4. GET /product/api/products/trackingId/{trackingId}    (eski deneme)
 */
async function getHBTrackingStatus(creds, trackingId) {
  const { merchantId, username, apiKey, environment } = creds;
  const base = environment === 'production'
    ? 'https://mpop.hepsiburada.com'
    : 'https://mpop-sit.hepsiburada.com';

  const headers = makeHBHeaders(merchantId, apiKey, username);

  const candidates = [
    `${base}/product/api/products/import/${trackingId}`,
    `${base}/product/api/products/imports/${trackingId}`,
    `${base}/product/api/products?trackingId=${trackingId}`,
    `${base}/product/api/products/trackingId/${trackingId}`,
  ];

  for (const url of candidates) {
    console.log(`[HepsiB Katalog Tracking] GET ${url}`);
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      const rawText = await res.text();
      console.log(`[HepsiB Katalog Tracking] HTTP ${res.status} | ${rawText.substring(0, 400)}`);

      if (res.status === 404) continue;   // bu URL yanlış, sıradakini dene
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 300)}`);

      try { return JSON.parse(rawText); } catch { return { raw: rawText }; }
    } catch (e) {
      if (e.message.startsWith('HTTP')) throw e;   // gerçek hata, dur
      console.warn(`[HepsiB Katalog Tracking] ${url} bağlanamadı: ${e.message}`);
    }
  }

  throw new Error('Tracking URL bulunamadı — 4 farklı path denendi, hepsi 404 döndü');
}

/**
 * 2. LİSTELEME: Stok ve fiyat güncelle
 * POST https://listing-external-sit.hepsiburada.com/listings/merchantid/{merchantId}/inventory-uploads
 *
 * Docs: https://developers.hepsiburada.com/hepsiburada/reference/listing-envanter-guncelleme
 * Body alanları: hepsiburadaSku | merchantSku, price (double), availableStock (int32)
 */
async function updateHBListingStockPrice(creds, updates) {
  const { merchantId, username, apiKey, environment } = creds;
  const base = environment === 'production'
    ? 'https://listing-external.hepsiburada.com'
    : 'https://listing-external-sit.hepsiburada.com';

  const headers = makeHBHeaders(merchantId, apiKey, username);

  // Doğru endpoint: /inventory-uploads (docs'tan doğrulandı)
  const url = `${base}/listings/merchantid/${merchantId}/inventory-uploads`;
  console.log(`[HepsiB Listeleme] POST ${url} — ${updates.length} ürün`);
  console.log(`[HepsiB Listeleme] Body[0]: ${JSON.stringify(updates[0]).substring(0, 300)}`);

  const res = await fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify(updates),
    signal:  AbortSignal.timeout(20000)
  });
  const rawText = await res.text();
  console.log(`[HepsiB Listeleme] HTTP ${res.status} | ${rawText.substring(0, 500)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawText.substring(0, 400)}`);
  try { return JSON.parse(rawText); } catch { return { raw: rawText }; }
}

/**
 * 3. SİPARİŞ: Kalem veya Kalemleri Paketleme
 *
 * DOĞRU FORMAT (developers.hepsiburada.com'dan doğrulandı):
 *   POST /packages/merchantid/{merchantId}
 *   Body: { lineItemRequests: [{ id: <lineItemId>, quantity: <n> }] }
 *   Başarı: HTTP 201 Created
 *
 * ÖNEMLİ:
 *   - Alan adı "lineItemRequests" (lineItems DEĞİL)
 *   - Her item'da "id" kullan (lineItemId DEĞİL)
 *   - lineItemId'ler MUTLAKA orders endpoint'inden (ödemesi tamamlanmış) alınmalı
 *   - packages list endpoint'indeki lineItemId'ler "zaten pakette" 409 verir — kullanma!
 */
async function packHBOrder(creds, packageNumber, packageUuid, fallbackItems = []) {
  const { merchantId, username, apiKey, environment } = creds;
  const base    = getHBBase(environment);
  const headers = makeHBHeaders(merchantId, apiKey, username);
  const ROOT    = `${base}/packages/merchantid/${merchantId}`;

  console.log(`[HepsiB Pack] START packageNumber=${packageNumber} fallbackItems=${fallbackItems.length}`);
  console.log(`[HepsiB Pack] fallbackItems: ${JSON.stringify(fallbackItems)}`);

  if (fallbackItems.length === 0) {
    throw new Error('Pack için lineItem listesi boş — orders endpoint\'inden lineItemId alınamadı');
  }

  // HB API beklediği format: { lineItemRequests: [{ id, quantity }] }
  const lineItemRequests = fallbackItems.map(i => ({
    id:       String(i.lineItemId || i.id || ''),
    quantity: i.quantity || 1,
  })).filter(i => i.id);

  console.log(`[HepsiB Pack] lineItemRequests (${lineItemRequests.length}): ${JSON.stringify(lineItemRequests)}`);

  // Doğru format ile tek deneme — 201 bekleniyor
  // 409: lineItems zaten başka bir pakette → unpack gerekiyor (route tarafında yapılmalı)
  const body = JSON.stringify({ lineItemRequests });
  console.log(`[HepsiB Pack] POST ${ROOT} | Body: ${body}`);

  const r = await fetch(ROOT, {
    method:  'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout(15000)
  });
  const t = await r.text();
  console.log(`[HepsiB Pack] HTTP ${r.status} | ${t.substring(0, 500)}`);

  // 201 Created = paket başarıyla oluşturuldu
  if (r.status === 201 || r.ok) {
    try { return { success: true, status: r.status, data: JSON.parse(t) }; }
    catch { return { success: true, status: r.status, raw: t }; }
  }

  // 409 = lineItemler zaten bir pakette (unpack yapılmadan çağrıldı)
  if (r.status === 409) {
    let body409;
    try { body409 = JSON.parse(t); } catch {}
    throw new Error(`409 Conflict: lineItemler zaten pakette. Paket Bozma yapılıp tekrar deneyin. Detay: ${t.substring(0,200)}`);
  }

  // 400 = hatalı istek (lineItemId formatı yanlış, durum uyumsuz, vb.)
  throw new Error(`Pack başarısız HTTP ${r.status}: ${t.substring(0, 300)}`);
}

module.exports = {
  fetchHepsiburadaOrders,
  fetchHBListings,
  createHBTestOrder,
  submitHBCatalogProduct,
  getHBTrackingStatus,
  updateHBListingStockPrice,
  packHBOrder,
  getHBBase,
  makeHBHeaders,
  HB_STATUS_MAP,
  HB_STATUS_TR,
  HB_PKG_STATUS_MAP,
  HB_DEDUCT_STATUSES,
  formatHBDate,
};
