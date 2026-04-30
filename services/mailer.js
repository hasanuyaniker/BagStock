/**
 * Kargo Bildirim Servisi
 * Bekliyor → Kargoda geçişinde e-posta gönderir.
 * Resend HTTP API kullanır (notify.js ile aynı altyapı).
 */

const { sendViaResend, getRecipients } = require('./notify');

/**
 * Kargo bildirimi HTML içeriği
 */
function buildShippingHtml(order) {
  const platform = order.platform === 'trendyol'    ? '🟠 Trendyol'
                 : order.platform === 'hepsiburada' ? '🔴 Hepsiburada'
                 : order.platform || 'Marketplace';

  const orderNo  = order.order_number || order.order_id || '?';
  const customer = order.customer_name || 'Bilinmiyor';
  const amount   = order.total_price
    ? parseFloat(order.total_price).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })
    : '—';

  const itemRows = (order.items || []).map(i => {
    const name = i.p_name || i.product_name || i.barcode || 'Bilinmeyen ürün';
    return `<tr>
      <td style="padding:7px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;">${name}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:center;">×${i.quantity || 1}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="2" style="padding:8px;color:#9ca3af;font-size:13px;">—</td></tr>`;

  const cargoLine = [
    order.cargo_company ? `<strong>Kargo:</strong> ${order.cargo_company}` : '',
    order.cargo_tracking_number ? `<strong>Takip No:</strong> <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${order.cargo_tracking_number}</code>` : ''
  ].filter(Boolean).join('<br>') || 'Kargo bilgisi henüz mevcut değil.';

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:540px;margin:0 auto;">
  <div style="background:linear-gradient(135deg,#5b3de8,#c026a8);padding:20px 28px;border-radius:10px 10px 0 0;">
    <h2 style="color:#fff;margin:0;font-size:20px;">🚚 Sipariş Kargoya Verildi</h2>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:13px;">${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}</p>
  </div>
  <div style="background:#fff;padding:22px 28px;border:1px solid #e5e7eb;border-top:none;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:120px;">Platform</td><td style="padding:6px 0;font-weight:600;">${platform}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Sipariş No</td><td style="padding:6px 0;font-family:monospace;font-size:13px;">${orderNo}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Müşteri</td><td style="padding:6px 0;">${customer}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Tutar</td><td style="padding:6px 0;font-weight:700;color:#059669;">${amount}</td></tr>
    </table>
    <hr style="border:none;border-top:1px solid #f3f4f6;margin:14px 0;">
    <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;">📦 Ürünler</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f9fafb;">
        <th style="padding:7px 8px;text-align:left;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;">Ürün</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;">Adet</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <hr style="border:none;border-top:1px solid #f3f4f6;margin:14px 0;">
    <div style="font-size:13px;color:#374151;line-height:1.8;">${cargoLine}</div>
  </div>
  <div style="padding:10px 28px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;font-size:11px;color:#9ca3af;">
    BagStock Stok Yönetim Sistemi — Otomatik Bildirim
  </div>
</div>`.trim();
}

/**
 * Tek bir siparişin kargoya verildiğini bildirir (Resend API)
 * @param {object} order - marketplace_orders satırı (+ items array)
 */
async function sendShippingNotification(order) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Mailer] RESEND_API_KEY eksik — kargo bildirimi gönderilemedi');
    return;
  }

  // Alıcıları belirle: NOTIFY_TO veya DB'deki kullanıcılar
  let recipients;
  if (process.env.NOTIFY_TO || process.env.NOTIFY_EMAIL) {
    const email = process.env.NOTIFY_TO || process.env.NOTIFY_EMAIL;
    recipients = [{ email, username: 'admin' }];
  } else {
    recipients = await getRecipients();
  }

  if (!recipients || recipients.length === 0) {
    console.warn('[Mailer] Alıcı bulunamadı — kargo bildirimi gönderilemedi');
    return;
  }

  const platform = order.platform === 'trendyol' ? 'Trendyol' : order.platform === 'hepsiburada' ? 'Hepsiburada' : (order.platform || 'Marketplace');
  const orderNo  = order.order_number || order.order_id || '?';
  const subject  = `🚚 Kargoya Verildi — ${platform} #${orderNo}`;
  const html     = buildShippingHtml(order);

  for (const user of recipients) {
    try {
      await sendViaResend(user.email, subject, html);
      console.log(`[Mailer] ✓ Kargo bildirimi gönderildi → ${user.email} (Sipariş #${orderNo})`);
    } catch (err) {
      console.error(`[Mailer] ✗ E-posta gönderilemedi → ${user.email} (Sipariş #${orderNo}): ${err.message}`);
    }
  }
}

/**
 * Test kargo bildirimi gönderir (son kargoda siparişi kullanır)
 */
async function sendTestShippingNotification(db) {
  const result = await db.query(`
    SELECT mo.*, json_agg(json_build_object(
      'item_id',moi.item_id,'barcode',moi.barcode,'product_name',moi.product_name,
      'quantity',moi.quantity,'price',moi.price,'p_name',p.name
    ) ORDER BY moi.id) AS items
    FROM marketplace_orders mo
    LEFT JOIN marketplace_order_items moi ON moi.marketplace_order_id = mo.id
    LEFT JOIN products p ON p.id = moi.product_id
    WHERE mo.status = 'kargoda'
    GROUP BY mo.id
    ORDER BY mo.updated_at DESC LIMIT 1
  `);

  if (!result.rows.length) {
    throw new Error('Sistemde "kargoda" durumunda sipariş bulunamadı');
  }

  const order = result.rows[0];
  // items JSON agg null filtrele
  order.items = (order.items || []).filter(i => i && i.barcode);

  await sendShippingNotification(order);
  return { orderNo: order.order_number, platform: order.platform };
}

/**
 * Birden fazla siparişi toplu bildirir
 */
async function sendShippingEmails(orders) {
  if (!orders || !orders.length) return;
  for (const order of orders) {
    await sendShippingNotification(order);
  }
}

module.exports = { sendShippingNotification, sendShippingEmails, sendTestShippingNotification };
