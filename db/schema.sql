-- Çanta Stok Yönetim Sistemi - Veritabanı Şeması
-- PostgreSQL

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  pin_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'standard',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  barcode VARCHAR(100) UNIQUE NOT NULL,
  product_type_id INTEGER REFERENCES product_types(id) ON DELETE SET NULL,
  supplier_name VARCHAR(200),
  stock_quantity INTEGER DEFAULT 0,
  product_image_url VARCHAR(500),
  cost_price NUMERIC(10,2),
  critical_stock INTEGER DEFAULT 5,
  trendyol_price NUMERIC(10,2),
  trendyol_commission NUMERIC(5,2),
  hepsiburada_price NUMERIC(10,2),
  hepsiburada_commission NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  quantity_change INTEGER NOT NULL,
  sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note VARCHAR(500),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS column_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  table_name VARCHAR(100) NOT NULL,
  column_key VARCHAR(100) NOT NULL,
  is_visible BOOLEAN DEFAULT TRUE,
  column_order INTEGER DEFAULT 0,
  column_width INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, table_name, column_key)
);

CREATE TABLE IF NOT EXISTS stock_count_sessions (
  id SERIAL PRIMARY KEY,
  count_date DATE NOT NULL,
  note VARCHAR(500),
  status VARCHAR(20) DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_count_items (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  product_name_snapshot VARCHAR(200),
  product_image_snapshot VARCHAR(500),
  system_quantity INTEGER NOT NULL,
  counted_quantity INTEGER NOT NULL,
  difference INTEGER GENERATED ALWAYS AS (counted_quantity - system_quantity) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS color VARCHAR(100);

-- Varsayılan ürün tipleri
INSERT INTO product_types (name) VALUES
  ('Deri'),('Suni Deri'),('Kumaş'),('Hasır'),('Naylon'),('Diğer')
ON CONFLICT (name) DO NOTHING;
