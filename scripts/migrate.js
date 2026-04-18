require('dotenv').config();
const { Pool } = require('pg');

const dbUrl = process.argv[2] || process.env.DATABASE_URL;
if (!dbUrl) { console.error('DATABASE_URL gerekli'); process.exit(1); }

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function migrate() {
  try {
    // app_settings tablosu
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ app_settings tablosu hazır');

    // products tablosuna color kolonu
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color VARCHAR(100)`);
    console.log('✓ products.color kolonu eklendi');

    // users tablosuna email ve phone kolonları
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(200)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`);
    console.log('✓ users.email ve users.phone kolonları eklendi');

    console.log('✓ Migration tamamlandı!');
  } catch (err) {
    console.error('Migration hatası:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
