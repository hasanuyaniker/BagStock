/**
 * Stok Takip Sistemi — Email Bildirim Servisi
 * Resend HTTP API kullanır (SMTP port engeli yok)
 * Gerekli Railway env: RESEND_API_KEY
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// ── Resend HTTP API ile email gönder ──────────────────────────────────────
async function sendViaResend(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY eksik');

  const from = process.env.NOTIFY_FROM || 'onboarding@resend.dev';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  });

  let data;
  try { data = await res.json(); } catch(e) { data = {}; }

  console.log(`[Resend] HTTP ${res.status}:`, JSON.stringify(data));

  if (!res.ok) {
    const msg = data.message || data.name || data.error || JSON.stringify(data) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ── Tüm kullanıcıların email listesini getir ──────────────────────────────
async function getAllUserEmails() {
  try {
    const result = await pool.query(
      `SELECT username, email FROM users WHERE email IS NOT NULL AND email <> ''`
    );
    return result.rows;
  } catch (err) {
    console.error('[Bildirim] Kullanıcı email listesi hatası:', err.message);
    return [];
  }
}

// ── HTML email içeriği oluştur ─────────────────────────────────────────────
function buildEmailHtml(outOfStock, critical) {
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  let html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#1e3f8a;color:#fff;padding:20px 28px;border-radius:10px 10px 0 0;">
      <h2 style="margin:0;font-size:20px;">📦 Stok Takip Sistemi — Stok Uyarısı</h2>
      <p style="margin:6px 0 0;opacity:.8;font-size:13px;">${now}</p>
    </div>
    <div style="background:#fff;padding:24px 28px;border:1px solid #e5e7eb;border-top:none;">`;

  if (outOfStock.length > 0) {
    html += `
      <h3 style="color:#ef4444;margin-top:0;">🚫 Tükenen Ürünler (${outOfStock.length} adet)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <thead><tr style="background:#fef2f2;">
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;">Ürün Adı</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;">Renk</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;">Barkod</th>
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #fee2e2;">Durum</th>
        </tr></thead>
        <tbody>`;
    outOfStock.forEach(p => {
      html += `<tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;">${p.name}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;">${p.color || '-'}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-family:monospace;">${p.barcode || '-'}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:center;">
          <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">TÜKENDİ</span>
        </td></tr>`;
    });
    html += `</tbody></table>`;
  }

  if (critical.length > 0) {
    html += `
      <h3 style="color:#d97706;margin-top:${outOfStock.length > 0 ? '16px' : '0'};">⚠️ Kritik Stok Ürünler (${critical.length} adet)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#fffbeb;">
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fde68a;">Ürün Adı</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fde68a;">Renk</th>
          <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fde68a;">Barkod</th>
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #fde68a;">Mevcut Stok</th>
          <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #fde68a;">Kritik Seviye</th>
        </tr></thead>
        <tbody>`;
    critical.forEach(p => {
      html += `<tr>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;">${p.name}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;">${p.color || '-'}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-family:monospace;">${p.barcode || '-'}</td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:center;">
          <strong style="color:#d97706;">${p.new_stock}</strong>
        </td>
        <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:center;">${p.critical_stock}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  html += `
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;padding-top:16px;border-top:1px solid #f3f4f6;">
        Bu mesaj Stok Takip Sistemi tarafından otomatik gönderilmiştir.
      </p>
    </div>
  </div>`;

  return html;
}

// ── Ana fonksiyon: stok uyarısı gönder ────────────────────────────────────
async function sendStockAlert(products) {
  if (!products || products.length === 0) return;

  const outOfStock = products.filter(p => p.new_stock === 0 && p.prev_stock > 0);
  const critical   = products.filter(p =>
    p.new_stock > 0 &&
    p.critical_stock > 0 &&
    p.new_stock <= p.critical_stock &&
    p.prev_stock > p.critical_stock
  );

  console.log(`[Bildirim] ${products.length} ürün → ${outOfStock.length} tükendi, ${critical.length} kritik`);
  if (outOfStock.length === 0 && critical.length === 0) return;

  if (!process.env.RESEND_API_KEY) {
    console.log('[Bildirim] RESEND_API_KEY eksik, bildirim atlandı');
    return;
  }

  const html = buildEmailHtml(outOfStock, critical);
  const subject = outOfStock.length > 0
    ? `🚫 Stok Uyarısı: ${outOfStock.length} ürün tükendi`
    : `⚠️ Stok Uyarısı: ${critical.length} ürün kritik seviyede`;

  // NOTIFY_TO varsa sadece o adrese gönder (domain doğrulaması olmadan)
  // Yoksa tüm kullanıcılara gönder (domain doğrulaması gerekir)
  let recipients;
  if (process.env.NOTIFY_TO) {
    recipients = [{ email: process.env.NOTIFY_TO, username: 'admin' }];
    console.log(`[Bildirim] Sabit adrese gönderiliyor: ${process.env.NOTIFY_TO}`);
  } else {
    recipients = await getAllUserEmails();
    if (recipients.length === 0) {
      console.log('[Bildirim] Email adresi olan kullanıcı yok');
      return;
    }
  }

  for (const user of recipients) {
    try {
      await sendViaResend(user.email, subject, html);
      console.log(`[Bildirim] ✓ Gönderildi → ${user.email}`);
    } catch (err) {
      console.error(`[Bildirim] ✗ Hata (${user.email}): ${err.message}`);
    }
  }
}

module.exports = { sendStockAlert, sendViaResend, getAllUserEmails };
