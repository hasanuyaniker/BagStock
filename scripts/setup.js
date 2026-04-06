#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

async function setup() {
  const args = process.argv.slice(2);
  let username = null;
  let pin = null;

  // Argümanları parse et
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) {
      username = args[i + 1];
      i++;
    } else if (args[i] === '--pin' && args[i + 1]) {
      pin = args[i + 1];
      i++;
    }
  }

  if (!username || !pin) {
    console.error('Kullanım: node scripts/setup.js --username admin --pin 1234');
    process.exit(1);
  }

  // PIN doğrulama
  if (!/^\d{4}$/.test(pin)) {
    console.error('Hata: PIN 4 haneli bir sayı olmalıdır.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
  });

  try {
    // Kullanıcı zaten var mı kontrol et
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      console.error(`Hata: Bu kullanıcı adı zaten mevcut: ${username}`);
      process.exit(1);
    }

    // PIN'i hashle
    const pinHash = await bcrypt.hash(pin, 10);

    // Admin kullanıcısını oluştur
    await pool.query(
      "INSERT INTO users (username, pin_hash, role) VALUES ($1, $2, 'admin')",
      [username, pinHash]
    );

    console.log(`Admin kullanıcısı oluşturuldu: ${username}`);
    console.log('Giriş yapmak için bu kullanıcı adı ve PIN kodunu kullanın.');
  } catch (err) {
    console.error('Hata:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

setup();
