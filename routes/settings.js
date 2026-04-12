const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
const { sendViaResend, getRecipients, sendDailySalesReport } = require('../services/notify');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
});

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Sadece JPEG, PNG ve WebP kabul edilir'), false);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// GET /api/settings/logo — logoyu base64 olarak döner (auth gerekmez - login sayfasında da kullanılır)
router.get('/logo', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'logo'"
    );
    if (result.rows.length === 0 || !result.rows[0].value) {
      return res.status(404).json({ error: 'Logo bulunamadı' });
    }
    res.json({ logo: result.rows[0].value });
  } catch (err) {
    res.status(500).json({ error: 'Logo alınamadı' });
  }
});

// POST /api/settings/logo — logoyu DB'ye base64 olarak kaydet (auth gerekli)
router.post('/logo', authMiddleware, upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya gerekli' });
  try {
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('logo', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [base64]
    );
    res.json({ logo: base64 });
  } catch (err) {
    console.error('Logo kayıt hatası:', err);
    res.status(500).json({ error: 'Logo kaydedilemedi' });
  }
});

// GET /api/settings/logo-img — logoyu doğrudan image olarak serve et (email için, auth gerekmez)
router.get('/logo-img', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM app_settings WHERE key = 'logo'");
    const dataUrl = result.rows[0]?.value;
    if (!dataUrl || !dataUrl.startsWith('data:')) return res.status(404).end();
    const [meta, base64] = dataUrl.split(',');
    const mimeType = meta.match(/data:([^;]+)/)[1];
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(base64, 'base64'));
  } catch (err) {
    res.status(500).end();
  }
});

// GET /api/settings/daily-report-time
router.get('/daily-report-time', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM app_settings WHERE key = 'daily_report_time'");
    res.json({ time: result.rows[0]?.value || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/daily-report-time
router.post('/daily-report-time', authMiddleware, async (req, res) => {
  try {
    const { time } = req.body; // "20:00"
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: 'Geçersiz saat formatı (HH:MM olmalı)' });
    }
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('daily_report_time', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [time || null]
    );
    res.json({ ok: true, time });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/send-daily-report — Manuel tetikleme
router.post('/send-daily-report', authMiddleware, async (req, res) => {
  try {
    if (!process.env.RESEND_API_KEY) {
      return res.status(400).json({ ok: false, error: 'RESEND_API_KEY eksik' });
    }
    sendDailySalesReport().catch(err => console.error('[Manuel Rapor]', err.message));
    res.json({ ok: true, message: 'Günlük rapor gönderimi başlatıldı' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/settings/test-email — Resend HTTP API ile test emaili gönder
router.post('/test-email', authMiddleware, async (req, res) => {
  try {
    // 1. API key kontrolü
    if (!process.env.RESEND_API_KEY) {
      return res.status(400).json({
        ok: false,
        step: 'config',
        error: 'RESEND_API_KEY eksik',
        detail: 'Railway Variables kısmına RESEND_API_KEY ekleyin (resend.com → API Keys)'
      });
    }

    // 2. Alıcı listesi
    let recipients;
    if (process.env.NOTIFY_TO) {
      recipients = [{ email: process.env.NOTIFY_TO, username: 'admin' }];
    } else {
      recipients = await getRecipients();
      if (recipients.length === 0) {
        return res.status(400).json({
          ok: false,
          step: 'recipients',
          error: 'Kayıtlı email adresi olan kullanıcı bulunamadı',
          detail: 'Ayarlar → Kullanıcılar bölümünden kullanıcılara email adresi ekleyin'
        });
      }
    }

    // 3. Test emaili gönder
    const results = [];
    for (const user of recipients) {
      try {
        await sendViaResend(
          user.email,
          '✅ Stok Takip Sistemi — Email Test',
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;">
            <h2 style="color:#1e3f8a;">✅ Email Bildirimi Çalışıyor!</h2>
            <p>Bu bir test emailidir. Email bildirimleri başarıyla yapılandırılmıştır.</p>
            <p style="color:#6b7280;font-size:13px;">Alıcı: ${user.username} (${user.email})</p>
          </div>`
        );
        results.push({ email: user.email, status: 'ok' });
      } catch (err) {
        results.push({ email: user.email, status: 'error', detail: err.message || String(err) });
      }
    }

    const allOk = results.every(r => r.status === 'ok');
    res.json({
      ok: allOk,
      step: 'send',
      message: allOk
        ? `Test emaili ${results.length} kullanıcıya başarıyla gönderildi`
        : 'Bazı emailler gönderilemedi',
      results
    });

  } catch (err) {
    res.status(500).json({ ok: false, step: 'error', error: err.message });
  }
});

module.exports = router;
