/**
 * Stok Takip Sistemi — Email Bildirim Servisi
 * Resend HTTP API kullanır (SMTP port engeli yok)
 * Gerekli Railway env: RESEND_API_KEY
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Uygulama base URL (ürün görselleri için) ──────────────────────────────
function getBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return '';
}

// ── İstanbul saati (Intl.DateTimeFormat — Railway/Docker ortamında güvenilir) ──
function getIstanbulDateTime() {
  const now = new Date();
  try {
    // Intl.DateTimeFormat formatToParts: tüm Node.js sürümlerinde çalışır
    const fmt = new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value || '00';
    const day   = get('day').padStart(2, '0');
    const month = get('month').padStart(2, '0');
    const year  = get('year');
    let   hour  = get('hour').padStart(2, '0');
    const min   = get('minute').padStart(2, '0');
    if (hour === '24') hour = '00'; // bazı sistemlerde gece yarısı 24:00 döner
    return { date: `${year}-${month}-${day}`, hhmm: `${hour}:${min}` };
  } catch (e) {
    // Fallback: UTC+3 manuel hesap
    const istanbul = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const iso = istanbul.toISOString();
    return {
      date: iso.substring(0, 10),
      hhmm: iso.substring(11, 16)
    };
  }
}

// ── Resend HTTP API ile email gönder ──────────────────────────────────────
async function sendViaResend(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY eksik');

  const fromAddress = process.env.NOTIFY_FROM || 'onboarding@resend.dev';
  const fromName = process.env.NOTIFY_FROM_NAME || 'HUFlex Stok Takip';
  const from = `${fromName} <${fromAddress}>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  });

  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  console.log(`[Resend] HTTP ${res.status}:`, JSON.stringify(data));

  if (!res.ok) {
    const msg = data.message || data.name || data.error || JSON.stringify(data) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Alıcı listesini getir ─────────────────────────────────────────────────
async function getRecipients() {
  if (process.env.NOTIFY_TO) {
    return [{ email: process.env.NOTIFY_TO, username: 'admin' }];
  }
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (email) username, email FROM users WHERE email IS NOT NULL AND email <> '' ORDER BY email, id`
    );
    return result.rows;
  } catch (err) {
    console.error('[Bildirim] Kullanıcı listesi hatası:', err.message);
    return [];
  }
}

// ── Logo URL'si (email istemcileri data: URI desteklemez, HTTP URL gerekir) ──
async function getLogoUrl() {
  try {
    const result = await pool.query("SELECT value FROM app_settings WHERE key = 'logo'");
    if (!result.rows[0]?.value) return null;
    return `${getBaseUrl()}/api/settings/logo-img`;
  } catch { return null; }
}

// ── Email başlığı (logo ile) ──────────────────────────────────────────────
function emailHeader(logoUrl, title, subtitle) {
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" style="height:44px;max-width:140px;object-fit:contain;margin-bottom:10px;display:block;">`
    : '';
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;">
    <div style="background:#1e3f8a;color:#fff;padding:20px 28px;border-radius:10px 10px 0 0;">
      ${logoHtml}
      <h2 style="margin:0;font-size:20px;">${title}</h2>
      <p style="margin:6px 0 0;opacity:.8;font-size:13px;">${subtitle}</p>
    </div>
    <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-top:none;">`;
}

function emailFooter() {
  return `
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;padding-top:16px;border-top:1px solid #f3f4f6;">
        Bu mesaj Stok Takip Sistemi tarafından otomatik gönderilmiştir.
      </p>
    </div>
  </div>`;
}

// ── Ürün görseli HTML (email için) ───────────────────────────────────────
// productId verilirse /api/products/:id/image HTTP endpoint'i kullanır (email istemcileri data: URI desteklemez)
function productImg(url, productId) {
  let imgUrl = null;
  if (productId && url) {
    // DB'de base64 varsa HTTP endpoint üzerinden servis et (Gmail data: URI'yi engeller)
    imgUrl = `${getBaseUrl()}/api/products/${productId}/image`;
  } else if (url && url.startsWith('http')) {
    imgUrl = url;
  }
  return imgUrl
    ? `<img src="${imgUrl}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;">`
    : `<div style="width:48px;height:48px;background:#f3f4f6;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:20px;">📦</div>`;
}

// ── Stok uyarı emaili HTML ────────────────────────────────────────────────
async function buildStockAlertHtml(outOfStock, critical) {
  const logoUrl = await getLogoUrl();
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  let html = emailHeader(logoUrl, '📦 Stok Uyarısı', now);

  if (outOfStock.length > 0) {
    html += `<h3 style="color:#ef4444;margin-top:0;">🚫 Tükenen Ürünler (${outOfStock.length} adet)</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
      <thead><tr style="background:#fef2f2;">
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fee2e2;width:56px;">Görsel</th>
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fee2e2;">Ürün Adı</th>
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fee2e2;">Renk</th>
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fee2e2;">Barkod</th>
        <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #fee2e2;">Durum</th>
      </tr></thead><tbody>`;
    outOfStock.forEach(p => {
      html += `<tr>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;">${productImg(p.image_url, p.id)}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;font-weight:600;">${p.name}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;">${p.color || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;font-family:monospace;font-size:12px;">${p.barcode || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;text-align:center;">
          <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">TÜKENDİ</span>
        </td></tr>`;
    });
    html += `</tbody></table>`;
  }

  if (critical.length > 0) {
    html += `<h3 style="color:#d97706;margin-top:${outOfStock.length > 0 ? '16px' : '0'};">⚠️ Kritik Stok Ürünler (${critical.length} adet)</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#fffbeb;">
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fde68a;width:56px;">Görsel</th>
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fde68a;">Ürün Adı</th>
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fde68a;">Renk</th>
        <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #fde68a;">Barkod</th>
        <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #fde68a;">Stok</th>
        <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #fde68a;">Kritik</th>
      </tr></thead><tbody>`;
    critical.forEach(p => {
      html += `<tr>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;">${productImg(p.image_url, p.id)}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;font-weight:600;">${p.name}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;">${p.color || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;font-family:monospace;font-size:12px;">${p.barcode || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;text-align:center;"><strong style="color:#d97706;">${p.new_stock}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #f3f4f6;text-align:center;">${p.critical_stock}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  return html + emailFooter();
}

// ── Günlük satış raporu emaili HTML ──────────────────────────────────────
async function buildDailySalesHtml(sales, date) {
  const logoUrl = await getLogoUrl();
  const dateStr = new Date(date + 'T00:00:00').toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });

  let totalOut = 0, totalIn = 0;
  sales.forEach(s => { totalOut += Number(s.sold || 0); totalIn += Number(s.received || 0); });

  let html = emailHeader(logoUrl, '📊 Günlük Satış Raporu', dateStr);

  if (sales.length === 0) {
    html += `<p style="color:#6b7280;text-align:center;padding:20px;">Bugün kayıt yok.</p>`;
    return html + emailFooter();
  }

  html += `
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr style="background:#f0f4ff;">
      <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #dbeafe;width:56px;">Görsel</th>
      <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #dbeafe;">Ürün Adı</th>
      <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #dbeafe;">Renk</th>
      <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #dbeafe;">Barkod</th>
      <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #dbeafe;">Çıkış</th>
      <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #dbeafe;">Giriş</th>
    </tr></thead><tbody>`;

  sales.forEach(s => {
    html += `<tr>
      <td style="padding:8px;border-bottom:1px solid #f3f4f6;">${productImg(s.product_image_url, s.id)}</td>
      <td style="padding:8px;border-bottom:1px solid #f3f4f6;font-weight:600;">${s.name}</td>
      <td style="padding:8px;border-bottom:1px solid #f3f4f6;">${s.color || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #f3f4f6;font-family:monospace;font-size:12px;">${s.barcode || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #f3f4f6;text-align:center;color:#dc2626;font-weight:600;">${Number(s.sold) > 0 ? '-' + s.sold : '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #f3f4f6;text-align:center;color:#16a34a;font-weight:600;">${Number(s.received) > 0 ? '+' + s.received : '-'}</td>
    </tr>`;
  });

  html += `</tbody></table>
  <div style="margin-top:16px;padding:12px 16px;background:#f9fafb;border-radius:8px;display:flex;gap:24px;font-size:13px;">
    <span style="color:#dc2626;font-weight:600;">Toplam Çıkış: ${totalOut} adet</span>
    <span style="color:#16a34a;font-weight:600;">Toplam Giriş: ${totalIn} adet</span>
  </div>`;

  return html + emailFooter();
}

// ── Stok uyarısı gönder ───────────────────────────────────────────────────
async function sendStockAlert(products) {
  if (!products || products.length === 0) return;

  const outOfStock = products.filter(p => p.new_stock === 0 && p.prev_stock > 0);
  const critical   = products.filter(p =>
    p.new_stock > 0 && p.critical_stock > 0 &&
    p.new_stock <= p.critical_stock && p.prev_stock > p.critical_stock
  );

  console.log(`[Bildirim] ${products.length} ürün → ${outOfStock.length} tükendi, ${critical.length} kritik`);
  if (outOfStock.length === 0 && critical.length === 0) return;
  if (!process.env.RESEND_API_KEY) { console.log('[Bildirim] RESEND_API_KEY eksik'); return; }

  const recipients = await getRecipients();
  if (recipients.length === 0) { console.log('[Bildirim] Alıcı yok'); return; }

  // Ürün görsellerini de aktar
  const outWithImg = outOfStock.map(p => ({ ...p, image_url: p.product_image_url || p.image_url }));
  const critWithImg = critical.map(p => ({ ...p, image_url: p.product_image_url || p.image_url }));

  const html = await buildStockAlertHtml(outWithImg, critWithImg);
  const subject = outOfStock.length > 0
    ? `HUFlex Stok Bilgilendirme — ${outOfStock.length} ürün tükendi`
    : `HUFlex Stok Bilgilendirme — ${critical.length} ürün kritik seviyede`;

  for (const user of recipients) {
    try {
      await sendViaResend(user.email, subject, html);
      console.log(`[Bildirim] ✓ Gönderildi → ${user.email}`);
    } catch (err) {
      console.error(`[Bildirim] ✗ Hata (${user.email}): ${err.message}`);
    }
  }
}

// ── Günlük satış raporu gönder ────────────────────────────────────────────
async function sendDailySalesReport() {
  if (!process.env.RESEND_API_KEY) { console.log('[Günlük Rapor] RESEND_API_KEY eksik'); return; }

  const { date } = getIstanbulDateTime();
  console.log(`[Günlük Rapor] ${date} raporu hazırlanıyor...`);

  try {
    const result = await pool.query(`
      SELECT p.id, p.name, p.color, p.barcode, p.product_image_url,
             ABS(SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END)) AS sold,
             SUM(CASE WHEN s.quantity_change > 0 THEN s.quantity_change ELSE 0 END) AS received
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.sale_date = $1
      GROUP BY p.id
      ORDER BY sold DESC, received DESC
    `, [date]);

    const sales = result.rows;
    if (sales.length === 0) {
      console.log('[Günlük Rapor] Bugün satış kaydı yok, rapor gönderilmedi');
      return;
    }

    const html = await buildDailySalesHtml(sales, date);
    const subject = `HUFlex Günlük Satış Bilgilendirme — ${new Date(date + 'T00:00:00').toLocaleDateString('tr-TR')}`;

    const recipients = await getRecipients();
    for (const user of recipients) {
      try {
        await sendViaResend(user.email, subject, html);
        console.log(`[Günlük Rapor] ✓ Gönderildi → ${user.email}`);
      } catch (err) {
        console.error(`[Günlük Rapor] ✗ Hata (${user.email}): ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[Günlük Rapor] Sorgu hatası:', err.message);
  }
}

module.exports = { sendStockAlert, sendDailySalesReport, sendViaResend, getRecipients, getIstanbulDateTime };
