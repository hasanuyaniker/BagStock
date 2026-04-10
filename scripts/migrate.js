require('dotenv').config();
const { Pool } = require('pg');

const dbUrl = process.argv[2] || process.env.DATABASE_URL;
if (!dbUrl) { console.error('DATABASE_URL gerekli'); process.exit(1); }

const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✓ app_settings tablosu hazır');

    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color VARCHAR(100)`);
    console.log('✓ products.color kolonu eklendi');

    console.log('✓ Migration tamamlandı!');
  } catch (err) {
    console.error('Migration hatası:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
