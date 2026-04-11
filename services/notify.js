/**
 * Stok Takip Sistemi — Email Bildirim Servisi
 * Kritik stok ve tükenen ürünlerde tüm kullanıcılara email gönderir.
 * Gerekli Railway env değişkenleri: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 */
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

// ── Email transporter ──────────────────────────────────────────────────────
function createTransporter() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[Bildirim] SMTP ayarları eksik. Railway Variables kontrol et: SMTP_HOST, SMTP_USER, SMTP_PASS');
    return null;
  }

  const port = parseInt(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === 'true';

  console.log(`[Bildirim] Transporter: host=${SMTP_HOST} port=${port} secure=${secure} user=${SMTP_USER}`);

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });
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
        <thead>
          <tr style="background:#fef2f2;">
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;">Ürün Adı</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;">Renk</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fee2e2;">Barkod</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #fee2e2;">Durum</th>
          </tr>
        </thead>
        <tbody>`;
    outOfStock.forEach(p => {
      html += `
          <tr>
            <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;">${p.name}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;">${p.color || '-'}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;font-family:monospace;">${p.barcode || '-'}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #f3f4f6;text-align:center;">
              <span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;">TÜKENDİ</span>
            </td>
          </tr>`;
    });
    html += `</tbody></table>`;
  }

  if (critical.length > 0) {
    html += `
      <h3 style="color:#d97706;margin-top:${outOfStock.length > 0 ? '16px' : '0'};">⚠️ Kritik Stok Ürünler (${critical.length} adet)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#fffbeb;">
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fde68a;">Ürün Adı</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fde68a;">Renk</th>
            <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #fde68a;">Barkod</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #fde68a;">Mevcut Stok</th>
            <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #fde68a;">Kritik Seviye</th>
          </tr>
        </thead>
        <tbody>`;
    critical.forEach(p => {
      html += `
          <tr>
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
// products: [{ name, barcode, color, new_stock, critical_stock, prev_stock }]
async function sendStockAlert(products) {
  if (!products || products.length === 0) return;

  // Sadece eşiği yeni geçen ürünleri al (flood önleme)
  const outOfStock = products.filter(p => p.new_stock === 0 && p.prev_stock > 0);
  const critical   = products.filter(p =>
    p.new_stock > 0 &&
    p.critical_stock > 0 &&
    p.new_stock <= p.critical_stock &&
    p.prev_stock > p.critical_stock
  );

  console.log(`[Bildirim] Kontrol: ${products.length} ürün → ${outOfStock.length} yeni tükendi, ${critical.length} yeni kritik`);

  if (outOfStock.length === 0 && critical.length === 0) {
    console.log('[Bildirim] Bildirim gönderilmedi: stok geçiş yok');
    return;
  }

  const transporter = createTransporter();
  if (!transporter) return;

  const users = await getAllUserEmails();
  if (users.length === 0) {
    console.log('[Bildirim] Kayıtlı email adresi olan kullanıcı yok');
    return;
  }

  const html = buildEmailHtml(outOfStock, critical);
  const outCount = outOfStock.length;
  const critCount = critical.length;
  const subject = outCount > 0
    ? `🚫 Stok Uyarısı: ${outCount} ürün tükendi`
    : `⚠️ Stok Uyarısı: ${critCount} ürün kritik seviyede`;

  console.log(`[Bildirim] ${users.length} kullanıcıya gönderiliyor: "${subject}"`);

  for (const user of users) {
    try {
      await transporter.sendMail({
        from: `"Stok Takip Sistemi" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to: user.email,
        subject,
        html
      });
      console.log(`[Bildirim] ✓ Gönderildi → ${user.email}`);
    } catch (err) {
      console.error(`[Bildirim] ✗ Hata (${user.email}): ${err.message}`);
    }
  }
}

module.exports = { sendStockAlert, createTransporter, getAllUserEmails };
