# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BagStock is a Turkish women's handbag inventory management system for a seller on Trendyol and Hepsiburada marketplaces. It tracks stock, records sales, syncs marketplace orders, and sends email notifications. Deployed on **Railway.app** with a **PostgreSQL** database (Railway managed).

## Commands

```bash
# Run locally (requires DATABASE_URL, JWT_SECRET env vars)
node server.js

# Initialize database schema from scratch
npm run db:init         # runs: psql $DATABASE_URL -f db/schema.sql

# Run setup script (seeds initial data)
npm run setup           # runs: node scripts/setup.js
```

There are no tests. There is no build step — this is plain Node.js.

## Required Environment Variables (Railway)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Railway auto-provides) |
| `JWT_SECRET` | JWT signing key |
| `RESEND_API_KEY` | Resend.com API key for email notifications |
| `NOTIFY_FROM` | Sender email address (optional, defaults to onboarding@resend.dev) |
| `NOTIFY_FROM_NAME` | Sender display name (optional) |
| `NOTIFY_TO` | Override recipient email (optional; falls back to users table) |
| `APP_URL` | Public base URL for product image links in emails |

## Architecture

### Stack
- **Backend**: Node.js / Express (`server.js` + `routes/` + `services/`)
- **Database**: PostgreSQL via `pg` Pool — one Pool per file, not shared globally
- **Frontend**: Vanilla JS SPA (`public/app.js` ~3000 lines + `public/dashboard.html`)
- **Auth**: JWT Bearer tokens; `middleware/auth.js` exports `authMiddleware` and `adminOnly`
- **Email**: Resend HTTP API (not SMTP) via `services/notify.js`
- **Deploy**: Railway — push to `main` branch triggers deploy via Nixpacks; start command is `node server.js`

### Route Map
```
/api/auth          → routes/auth.js         (login, /me)
/api/products      → routes/products.js
/api/product-types → routes/product-types.js
/api/materials     → routes/materials.js
/api/sales         → routes/sales.js
/api/uploads       → routes/uploads.js      (product images, stored as base64 in DB)
/api/columns       → routes/columns.js      (per-user column visibility/width prefs)
/api/users         → routes/users.js
/api/export        → routes/export.js       (Excel export)
/api/stockcount    → routes/stockcount.js   (physical inventory count sessions)
/api/settings      → routes/settings.js     (marketplace credentials, logo, email config)
/api/marketplace   → routes/marketplace.js  (order sync, HB override management)
/api/backup        → server.js inline       (JSON backup download)
```

### Key Database Tables
- `products` — core inventory; barcode is the primary matching key (6 barcode fields: `barcode` through `barcode6`)
- `sales` — stock movement log; negative `quantity_change` = sold, positive = received/returned
- `marketplace_orders` — synced orders from TY/HB with status, `kargoda_at` timestamp
- `marketplace_order_items` — individual line items with per-item `stock_deducted` flag
- `app_settings` — key-value store for credentials, migration flags, overrides, config

### Migration System
All schema changes live in `runMigrations()` inside `server.js` and run **on every deploy**. New one-time data fixes use an `app_settings` flag as a guard (check if key exists → run → insert key). If a migration needs to repeat each deploy it runs without a flag. Never modify existing migration blocks; always append new ones at the bottom.

## Marketplace Sync Flow

Sync runs automatically every 15 minutes via `setInterval` in `server.js` and can be triggered manually via `POST /api/marketplace/sync`.

```
syncPlatform(db, platform, creds)
  → fetchTrendyolOrders() or fetchHepsiburadaOrders()
  → upsertOrder(db, order)  [per order, in a transaction]
```

### Stock Deduction Logic (critical — read carefully)

Stock is deducted once per item, guarded by two flags:
1. `marketplace_orders.stock_deducted` (order-level) — set TRUE when order is fully processed
2. `marketplace_order_items.stock_deducted` (item-level) — set TRUE when that specific item is deducted

In `upsertOrder()`:
- If `orderAlreadyDeducted = TRUE` → enter "catch-up" branch: only deduct items where `item.stock_deducted = FALSE` and `product_id IS NOT NULL`
- If `orderAlreadyDeducted = FALSE` → standard branch: deduct all items with `item.should_deduct = TRUE`
- `item.should_deduct` is set during normalization in the platform service when `raw_status` is in the deduct set

**TY deduct statuses**: `Shipped`, `Delivered`
**HB deduct statuses**: `Shipped`, `Delivered`, `IN_CARGO`, `DELIVERED`

### Barcode Matching
Products are matched by barcode using case-insensitive, trimmed comparison across all 6 barcode fields:
```sql
WHERE LOWER(TRIM(barcode))=$1 OR LOWER(TRIM(barcode2))=$1 ... OR LOWER(TRIM(barcode6))=$1
```
Always use `String(item.barcode || '').toLowerCase().trim()` as the query parameter.

### Hepsiburada Barcode Conversion
HB order/package APIs return EAN barcodes (`6225...`) and `hepsiburadaSku` (`HBCV...`) but never `merchantSku`. The Listings API maps `HBCV → merchantSku (HF00...)`. Conversion in `services/hepsiburada.js`:
1. Fetch Listings API **with pagination** (100/page, max 20 pages) to build `listingsMap`
2. Merge manual overrides from `app_settings` key `hb_sku_overrides` (JSON `{"HBCV...": "HF00..."}`)
3. For each item: try `listingsMap[item.barcode]` first, then `listingsMap[item.sku]` (HBCV lookup)
4. Unmapped HBCV codes logged as warnings; can be manually mapped via **Settings → API Entegrasyonu → HB Ürün Kodu Eşleştirme**

### `kargoda_at` Timestamp
Set once when an order first transitions to `kargoda` status. Used as `sale_date` for `sales` table entries (Istanbul timezone). Never overwritten once set (CASE WHEN in UPSERT). Old orders missing it fall back to `order_date`.

## Email Notifications

Two types sent via `services/notify.js` → Resend API:
1. **Stock alert**: triggered after stock deduction if any product hits 0 or crosses critical threshold
2. **Daily cargo report**: scheduled via `startDailyReportScheduler()` in `server.js`; time configurable in `app_settings` key `daily_report_time` (format: `"HH:MM"`); checks every minute in Istanbul time

Recipients: users table `email` column, or `NOTIFY_TO` env override. Product images in emails are served via `/api/products/:id/image` (not base64 inline — Gmail blocks data URIs).

## Frontend Architecture

Single-page app — `dashboard.html` + `public/app.js`. All state is in global variables; no framework. Key patterns:
- `apiFetch(url, options)` — wraps `fetch` with JWT header injection and 401 → logout handling
- `switchSection(name)` — shows/hides `.section` divs, saves to `localStorage`
- `switchSettingsTab(tab)` — shows/hides `.settings-panel` divs, loads tab-specific data
- `DEFAULT_COLUMNS` array in `app.js` defines inventory table columns; order/visibility persisted per-user via `/api/columns`
- `escHtml(str)` — must be used in all dynamically built HTML to prevent XSS

## Common Pitfalls

- **Each route file creates its own `pg.Pool`** — this is intentional for Railway's connection model; do not try to share a global pool across files
- **Migration flags in `app_settings`**: if a migration ran but had a bug, fix the bug AND delete the flag row from the DB directly, then redeploy
- **Railway deploy**: push to `main` branch. If Railway redeploys an old commit, trigger a manual redeploy from the Railway dashboard. The webhook sometimes doesn't fire — check the Deployments tab
- **HB environment**: credentials have an `environment` field (`sit` or `production`). Wrong environment = wrong base URL = 401/404 errors. Check `app_settings` key `marketplace_credentials`
- **`stock_deducted` reset**: if items were deducted with `product_id IS NULL` (meaning no actual deduction occurred), run the `fix_false_stock_deducted_v1` migration pattern to reset them safely
