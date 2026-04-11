const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const multer = require('multer');
const authMiddleware = require('../middleware/auth');
const { sendViaResend, getAllUserEmails } = require('../services/notify');

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

    // 2. Kullanıcı email listesi
    const users = await getAllUserEmails();
    if (users.length === 0) {
      return res.status(400).json({
        ok: false,
        step: 'recipients',
        error: 'Kayıtlı email adresi olan kullanıcı bulunamadı',
        detail: 'Ayarlar → Kullanıcılar bölümünden kullanıcılara email adresi ekleyin'
      });
    }

    // 3. Test emaili gönder
    const results = [];
    for (const user of users) {
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
        results.push({ email: user.email, status: 'error', detail: err.message });
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
