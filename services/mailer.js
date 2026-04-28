/**
 * E-posta Bildirim Servisi
 * Kargo durumuna geçen siparişler için alıcıya bildirim gönderir.
 *
 * Gerekli env değişkenleri:
 *   SMTP_HOST   - SMTP sunucusu (varsayılan: smtp.gmail.com)
 *   SMTP_PORT   - Port (varsayılan: 587)
 *   SMTP_USER   - Gönderici e-posta adresi
 *   SMTP_PASS   - Şifre veya App Password
 *   NOTIFY_EMAIL - Bildirim alacak e-posta adresi (zorunlu)
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null; // yapılandırılmamış
  }

  _transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: parseInt(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false }
  });

  return _transporter;
}

/**
 * Tek bir siparişin kargoya verildiğini bildirir
 * @param {object} order - marketplace_orders satırı (+ items array)
 */
async function sendShippingNotification(order) {
  const notifyEmail = process.env.NOTIFY_EMAIL;
  const transporter = getTransporter();

  if (!notifyEmail || !transporter) return; // sessizce atla

  const platform = order.platform === 'trendyol'    ? '🟠 Trendyol'
                 : order.platform === 'hepsiburada' ? '🔴 Hepsiburada'
                 : order.platform || 'Marketplace';

  const orderNo  = order.order_number || order.order_id || '?';
  const customer = order.customer_name || 'Bilinmiyor';
  const amount   = order.total_price
    ? parseFloat(order.total_price).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })
    : '—';

  // Ürün listesi
  const itemLines = (order.items || []).map(i => {
    const name = i.p_name || i.product_name || i.barcode || 'Bilinmeyen ürün';
    return `• ${name} ×${i.quantity || 1}`;
  }).join('\n') || '—';

  // Kargo bilgisi
  const cargoLines = [
    order.cargo_company ? `Kargo: ${order.cargo_company}` : '',
    order.cargo_tracking_number ? `Takip No: ${order.cargo_tracking_number}` : ''
  ].filter(Boolean).join('\n') || 'Kargo bilgisi henüz yok';

  const subject = `🚚 Kargoya Verildi — ${platform} #${orderNo}`;

  const text = `
Merhaba,

Aşağıdaki sipariş kargoya verildi:

Platform   : ${platform}
Sipariş No : ${orderNo}
Müşteri    : ${customer}
Tutar      : ${amount}

Ürünler:
${itemLines}

${cargoLines}

---
BagStock Stok Yönetim Sistemi
`.trim();

  const html = `
<div style="font-family:sans-serif;max-width:520px;margin:auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#5b3de8,#c026a8);padding:18px 24px;">
    <h2 style="color:#fff;margin:0;font-size:18px;">🚚 Sipariş Kargoya Verildi</h2>
  </div>
  <div style="padding:20px 24px;background:#fff;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:130px;">Platform</td><td style="padding:6px 0;font-weight:600;">${platform}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Sipariş No</td><td style="padding:6px 0;font-family:monospace;">${orderNo}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Müşteri</td><td style="padding:6px 0;">${customer}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Tutar</td><td style="padding:6px 0;font-weight:700;color:#059669;">${amount}</td></tr>
    </table>
    <hr style="border:none;border-top:1px solid #f3f4f6;margin:14px 0;">
    <div style="font-size:13px;color:#374151;margin-bottom:10px;"><strong>Ürünler:</strong></div>
    <div style="font-size:13px;color:#374151;white-space:pre-line;">${itemLines}</div>
    <hr style="border:none;border-top:1px solid #f3f4f6;margin:14px 0;">
    <div style="font-size:13px;color:#374151;white-space:pre-line;">${cargoLines}</div>
  </div>
  <div style="padding:10px 24px;background:#f9fafb;font-size:11px;color:#9ca3af;">BagStock Stok Yönetim Sistemi</div>
</div>
`.trim();

  try {
    await transporter.sendMail({
      from:    `"BagStock" <${process.env.SMTP_USER}>`,
      to:      notifyEmail,
      subject,
      text,
      html
    });
    console.log(`[Mailer] ✓ Kargo bildirimi gönderildi → ${notifyEmail} (Sipariş #${orderNo})`);
  } catch (err) {
    console.error(`[Mailer] ✗ E-posta gönderilemedi (Sipariş #${orderNo}):`, err.message);
    // Hata app'i durdurmasın — sadece logluyoruz
  }
}

/**
 * Birden fazla siparişi toplu bildirir
 * @param {Array} orders
 */
async function sendShippingEmails(orders) {
  if (!orders || !orders.length) return;
  for (const order of orders) {
    await sendShippingNotification(order);
  }
}

module.exports = { sendShippingNotification, sendShippingEmails };
