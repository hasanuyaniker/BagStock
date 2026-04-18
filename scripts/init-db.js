require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const dbUrl = process.argv[2] || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('Hata: DATABASE_URL gerekli.');
  console.error('Kullanım: node scripts/init-db.js "postgresql://..."');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

pool.query(sql)
  .then(() => {
    console.log('✓ Tablolar başarıyla oluşturuldu!');
    pool.end();
  })
  .catch(e => {
    console.error('Hata:', e.message);
    pool.end();
    process.exit(1);
  });
