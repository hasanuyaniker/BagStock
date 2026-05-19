const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const multer = require('multer');
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('spreadsheet') || file.originalname.match(/\.(xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Sadece .xlsx veya .xls dosyaları kabul edilir'));
    }
  }
});

router.use(authMiddleware);

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3F8A' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const CURRENCY_FORMAT = '#,##0.00 ₺';
const DATE_FORMAT = 'DD.MM.YYYY';

function styleHeaderRow(sheet) {
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF000000' } }
    };
  });
  headerRow.height = 28;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;
}

// ── GET /api/export/products ─────────────────────────────────────────────────
// Envanter Excel indirme. Aynı format Excel Yükle ile import edilebilir.
// Sütun sırası ve başlık adları import endpoint'iyle eşleşmelidir.
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.name, pt.name AS product_type, m.name AS material,
              p.color, p.barcode, p.barcode2, p.barcode3, p.barcode4, p.barcode5, p.barcode6,
              p.supplier_name, p.stock_quantity, p.cost_price, p.critical_stock,
              p.trendyol_price, p.trendyol_commission,
              p.hepsiburada_price, p.hepsiburada_commission,
              CASE WHEN p.is_active THEN 'Evet' ELSE 'Hayır' END AS is_active
       FROM products p
       LEFT JOIN product_types pt ON p.product_type_id = pt.id
       LEFT JOIN materials m ON p.material_id = m.id
       ORDER BY p.name`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Envanter');

    // ÖNEMLİ: Sütun sırası ve başlık adları, import endpoint'iyle birebir eşleşmeli
    sheet.columns = [
      { header: 'Ürün Adı',       key: 'name',                   width: 32 },
      { header: 'Ürün Tipi',      key: 'product_type',            width: 15 },
      { header: 'Materyal',       key: 'material',                width: 15 },
      { header: 'Renk',           key: 'color',                   width: 12 },
      { header: 'Barkod',         key: 'barcode',                 width: 20 },
      { header: 'Barkod 2',       key: 'barcode2',                width: 20 },
      { header: 'Barkod 3',       key: 'barcode3',                width: 20 },
      { header: 'Barkod 4',       key: 'barcode4',                width: 20 },
      { header: 'Barkod 5',       key: 'barcode5',                width: 20 },
      { header: 'Barkod 6',       key: 'barcode6',                width: 20 },
      { header: 'Tedarikçi',      key: 'supplier_name',           width: 20 },
      { header: 'Stok',           key: 'stock_quantity',          width: 10 },
      { header: 'Alış Fiyatı',    key: 'cost_price',              width: 15 },
      { header: 'Kritik Stok',    key: 'critical_stock',          width: 12 },
      { header: 'TY Fiyat',       key: 'trendyol_price',          width: 15 },
      { header: 'TY Komisyon %',  key: 'trendyol_commission',     width: 13 },
      { header: 'HB Fiyat',       key: 'hepsiburada_price',       width: 15 },
      { header: 'HB Komisyon %',  key: 'hepsiburada_commission',  width: 13 },
      { header: 'Satışta mı?',    key: 'is_active',               width: 12 },
    ];

    result.rows.forEach(row => sheet.addRow(row));
    styleHeaderRow(sheet);

    // Para birimi formatı: Alış Fiyatı (M), TY Fiyat (O), HB Fiyat (Q)
    ['M', 'O', 'Q'].forEach(col => {
      sheet.getColumn(col).numFmt = CURRENCY_FORMAT;
    });

    // Bilgi notu — ikinci satır olarak ekle (gri, italik)
    const noteRow = sheet.insertRow(2, ['⚠ Bu dosyayı düzenleyip "Excel Yükle" butonu ile yükleyebilirsiniz. Barkod zorunludur. Mevcut barkod varsa güncellenir, yoksa yeni ürün eklenir.']);
    noteRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' }, size: 10 };
    noteRow.getCell(1).alignment = { horizontal: 'left' };
    sheet.mergeCells(`A2:S2`);

    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=envanter_${today}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export hatası:', err);
    res.status(500).json({ error: 'Excel oluşturulamadı' });
  }
});

// ── POST /api/export/import-products ─────────────────────────────────────────
// Envanter Excel yükleme: mevcut barkod varsa günceller, yoksa yeni ekler.
// Beklenen sütun başlıkları (export ile aynı):
//   Ürün Adı | Ürün Tipi | Materyal | Renk | Barkod | Barkod 2 | Barkod 3
//   Tedarikçi | Stok | Alış Fiyatı | Kritik Stok | TY Fiyat | TY Komisyon %
//   HB Fiyat | HB Komisyon % | Satışta mı?
router.post('/import-products', xlsxUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya bulunamadı' });

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: 'Excel sayfası bulunamadı' });

    // İlk satırı başlık olarak oku — sütun sırası yerine başlık adına göre eşleştir
    const headerRow = sheet.getRow(1);
    const colMap = {};
    headerRow.eachCell((cell, colNumber) => {
      const h = String(cell.value || '').trim();
      if (h) colMap[h] = colNumber;
    });

    const get = (row, header) => {
      const col = colMap[header];
      if (!col) return null;
      const v = row.getCell(col).value;
      if (v === null || v === undefined) return null;
      if (typeof v === 'object' && v.result !== undefined) return v.result; // formula cell
      return v;
    };
    const str = (row, h) => { const v = get(row, h); return v !== null ? String(v).trim() : null; };
    const num = (row, h) => { const v = get(row, h); const n = parseFloat(v); return isNaN(n) ? null : n; };
    const int = (row, h) => { const v = get(row, h); const n = parseInt(v); return isNaN(n) ? null : n; };

    // Ürün tipi ve materyal adlarını DB'den çek (isim → id)
    const [typeRows, matRows] = await Promise.all([
      pool.query('SELECT id, name FROM product_types'),
      pool.query('SELECT id, name FROM materials')
    ]);
    const typeMap = {};
    typeRows.rows.forEach(r => { typeMap[r.name.trim().toLowerCase()] = r.id; });
    const matMap  = {};
    matRows.rows.forEach(r => { matMap[r.name.trim().toLowerCase()]  = r.id; });

    let inserted = 0, updated = 0, errors = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 2; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        // Boş satırları atla (bilgi notu satırı dahil)
        const firstCell = String(row.getCell(1).value || '').trim();
        if (!firstCell || firstCell.startsWith('⚠')) continue;

        const barcode = str(row, 'Barkod');
        if (!barcode) { errors++; continue; } // Barkod zorunlu

        const name         = str(row, 'Ürün Adı');
        const typeName     = str(row, 'Ürün Tipi');
        const matName      = str(row, 'Materyal');
        const color        = str(row, 'Renk');
        const barcode2     = str(row, 'Barkod 2');
        const barcode3     = str(row, 'Barkod 3');
        const barcode4     = str(row, 'Barkod 4');
        const barcode5     = str(row, 'Barkod 5');
        const barcode6     = str(row, 'Barkod 6');
        const supplier     = str(row, 'Tedarikçi');
        const stock        = int(row, 'Stok') ?? 0;
        const costPrice    = num(row, 'Alış Fiyatı');
        const critStock    = int(row, 'Kritik Stok') ?? 5;
        const tyPrice      = num(row, 'TY Fiyat');
        const tyComm       = num(row, 'TY Komisyon %');
        const hbPrice      = num(row, 'HB Fiyat');
        const hbComm       = num(row, 'HB Komisyon %');
        const activeRaw    = str(row, 'Satışta mı?');
        const isActive     = activeRaw === null ? true : !['hayır','no','false','0'].includes(activeRaw.toLowerCase());

        const typeId = typeName ? (typeMap[typeName.toLowerCase()] || null) : null;
        const matId  = matName  ? (matMap[matName.toLowerCase()]   || null) : null;

        try {
          // Mevcut barkod var mı kontrol et (6 barkod alanının hepsine bak)
          const existing = await client.query(
            `SELECT id FROM products
             WHERE barcode=$1 OR barcode2=$1 OR barcode3=$1
                OR barcode4=$1 OR barcode5=$1 OR barcode6=$1 LIMIT 1`,
            [barcode]
          );

          if (existing.rows.length > 0) {
            // Güncelle
            await client.query(
              `UPDATE products SET
                name=$1, product_type_id=$2, material_id=$3, color=$4,
                barcode2=$5, barcode3=$6, barcode4=$7, barcode5=$8, barcode6=$9,
                supplier_name=$10, stock_quantity=$11, cost_price=$12, critical_stock=$13,
                trendyol_price=$14, trendyol_commission=$15,
                hepsiburada_price=$16, hepsiburada_commission=$17,
                is_active=$18, updated_at=NOW()
               WHERE id=$19`,
              [name, typeId, matId, color,
               barcode2, barcode3, barcode4, barcode5, barcode6,
               supplier, stock, costPrice, critStock,
               tyPrice, tyComm, hbPrice, hbComm,
               isActive, existing.rows[0].id]
            );
            updated++;
          } else {
            // Yeni ekle
            await client.query(
              `INSERT INTO products
                (name, product_type_id, material_id, color,
                 barcode, barcode2, barcode3, barcode4, barcode5, barcode6,
                 supplier_name, stock_quantity, cost_price, critical_stock,
                 trendyol_price, trendyol_commission,
                 hepsiburada_price, hepsiburada_commission, is_active)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [name, typeId, matId, color,
               barcode, barcode2, barcode3, barcode4, barcode5, barcode6,
               supplier, stock, costPrice, critStock,
               tyPrice, tyComm, hbPrice, hbComm, isActive]
            );
            inserted++;
          }
        } catch (rowErr) {
          console.warn(`[Import] Satır ${i} hata: ${rowErr.message.substring(0, 100)}`);
          errors++;
        }
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    console.log(`[Import] Tamamlandı: ${inserted} eklendi, ${updated} güncellendi, ${errors} hata`);
    res.json({ ok: true, inserted, updated, errors });
  } catch (err) {
    console.error('[Import] Kritik hata:', err.message);
    res.status(500).json({ error: 'Import başarısız: ' + err.message.substring(0, 200) });
  }
});

// GET /api/export/sales
router.get('/sales', async (req, res) => {
  try {
    const { from, to } = req.query;
    let query = `
      SELECT s.sale_date, p.name AS product_name, p.color, p.barcode, p.cost_price,
             pt.name AS product_type, s.quantity_change, s.note, u.username AS created_by
      FROM sales s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN product_types pt ON p.product_type_id = pt.id
      LEFT JOIN users u ON s.created_by = u.id
    `;
    const params = [];
    if (from && to) {
      query += ' WHERE s.sale_date >= $1 AND s.sale_date <= $2';
      params.push(from, to);
    }
    query += ' ORDER BY s.sale_date DESC, s.created_at DESC';

    const result = await pool.query(query, params);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Satış Raporu');

    sheet.columns = [
      { header: 'Tarih', key: 'sale_date', width: 14 },
      { header: 'Ürün Adı', key: 'product_name', width: 30 },
      { header: 'Renk', key: 'color', width: 15 },
      { header: 'Barkod', key: 'barcode', width: 20 },
      { header: 'Alış Maliyeti', key: 'cost_price', width: 15 },
      { header: 'Ürün Tipi', key: 'product_type', width: 15 },
      { header: 'Miktar Değişimi', key: 'quantity_change', width: 16 },
      { header: 'Not', key: 'note', width: 25 },
      { header: 'Kullanıcı', key: 'created_by', width: 15 }
    ];

    result.rows.forEach(row => {
      row.sale_date = formatDate(row.sale_date);
      sheet.addRow(row);
    });
    styleHeaderRow(sheet);

    sheet.getColumn('E').numFmt = CURRENCY_FORMAT;

    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=satis_raporu_${today}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Satış export hatası:', err);
    res.status(500).json({ error: 'Excel oluşturulamadı' });
  }
});

// GET /api/export/sales-report — Ürün bazlı satış özet raporu (platform breakdown dahil)
router.get('/sales-report', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'Tarih aralığı gerekli' });

    const result = await pool.query(`
      SELECT
        p.name AS product_name,
        p.color,
        p.barcode,
        p.cost_price,
        -- Toplam satılan
        ABS(SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END))
          AS total_sold,
        -- Platform bazlı dağılım
        ABS(SUM(CASE WHEN s.quantity_change < 0 AND COALESCE(s.marketplace,'normal') = 'normal'
                     THEN s.quantity_change ELSE 0 END))
          AS sold_normal,
        ABS(SUM(CASE WHEN s.quantity_change < 0 AND s.marketplace = 'trendyol'
                     THEN s.quantity_change ELSE 0 END))
          AS sold_ty,
        ABS(SUM(CASE WHEN s.quantity_change < 0 AND s.marketplace = 'hepsiburada'
                     THEN s.quantity_change ELSE 0 END))
          AS sold_hb,
        ABS(SUM(CASE WHEN s.quantity_change < 0
                          AND COALESCE(s.marketplace,'normal') NOT IN ('normal','trendyol','hepsiburada')
                     THEN s.quantity_change ELSE 0 END))
          AS sold_other,
        -- İade: yalnızca marketplace='iade' ile kaydedilen iadeler (stok girişi ≠ iade)
        SUM(CASE WHEN s.marketplace = 'iade' AND s.quantity_change > 0
                 THEN s.quantity_change ELSE 0 END)
          AS total_iade,
        -- Toplam maliyet
        ABS(SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END))
          * COALESCE(p.cost_price, 0) AS total_cost
      FROM sales s
      JOIN products p ON s.product_id = p.id
      WHERE s.sale_date >= $1 AND s.sale_date <= $2
      GROUP BY p.id, p.name, p.color, p.barcode, p.cost_price
      -- Satışı olan VEYA iadesi olan ürünleri göster; saf stok girişleri dahil etme
      HAVING SUM(CASE WHEN s.quantity_change < 0 THEN s.quantity_change ELSE 0 END) < 0
          OR SUM(CASE WHEN s.marketplace = 'iade' AND s.quantity_change > 0
                      THEN s.quantity_change ELSE 0 END) > 0
      ORDER BY total_sold DESC
    `, [from, to]);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Satış Özet Raporu');

    sheet.columns = [
      { header: 'Ürün Adı',        key: 'product_name', width: 30 },
      { header: 'Renk',            key: 'color',        width: 15 },
      { header: 'Barkod',          key: 'barcode',      width: 20 },
      { header: 'Alış Maliyeti',   key: 'cost_price',   width: 15 },
      { header: 'Toplam Satış',    key: 'total_sold',   width: 13 },
      { header: 'Normal',          key: 'sold_normal',  width: 10 },
      { header: '↩️ İade',         key: 'total_iade',   width: 10 },
      { header: '🟠 Trendyol',     key: 'sold_ty',      width: 13 },
      { header: '🔴 Hepsiburada',  key: 'sold_hb',      width: 15 },
      { header: 'Diğer',           key: 'sold_other',   width: 10 },
      { header: 'Toplam Maliyet',  key: 'total_cost',   width: 18 },
    ];

    result.rows.forEach(row => sheet.addRow({
      product_name: row.product_name,
      color:        row.color,
      barcode:      row.barcode,
      cost_price:   parseFloat(row.cost_price) || 0,
      total_sold:   parseInt(row.total_sold)   || 0,
      sold_normal:  parseInt(row.sold_normal)  || 0,
      total_iade:   parseInt(row.total_iade)   || 0,
      sold_ty:      parseInt(row.sold_ty)      || 0,
      sold_hb:      parseInt(row.sold_hb)      || 0,
      sold_other:   parseInt(row.sold_other)   || 0,
      total_cost:   parseFloat(row.total_cost) || 0,
    }));

    styleHeaderRow(sheet);
    sheet.getColumn('D').numFmt = CURRENCY_FORMAT;
    sheet.getColumn('K').numFmt = CURRENCY_FORMAT; // Toplam Maliyet artık K sütununda

    // Platform + İade sütunlarına arka plan rengi ver
    const TY_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } }; // açık turuncu
    const HB_FILL   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEBEE' } }; // açık kırmızı
    const IADE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }; // açık yeşil
    sheet.getColumn('G').eachCell({ includeEmpty: false }, (cell, rowNum) => { if (rowNum > 1) cell.fill = IADE_FILL; });
    sheet.getColumn('H').eachCell({ includeEmpty: false }, (cell, rowNum) => { if (rowNum > 1) cell.fill = TY_FILL; });
    sheet.getColumn('I').eachCell({ includeEmpty: false }, (cell, rowNum) => { if (rowNum > 1) cell.fill = HB_FILL; });

    // Toplam satırı
    const totSold   = result.rows.reduce((s, r) => s + (parseInt(r.total_sold)  || 0), 0);
    const totNormal = result.rows.reduce((s, r) => s + (parseInt(r.sold_normal) || 0), 0);
    const totIade   = result.rows.reduce((s, r) => s + (parseInt(r.total_iade)  || 0), 0);
    const totTY     = result.rows.reduce((s, r) => s + (parseInt(r.sold_ty)     || 0), 0);
    const totHB     = result.rows.reduce((s, r) => s + (parseInt(r.sold_hb)     || 0), 0);
    const totOther  = result.rows.reduce((s, r) => s + (parseInt(r.sold_other)  || 0), 0);
    const totCost   = result.rows.reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);
    const totalRow  = sheet.addRow({
      product_name: 'TOPLAM',
      total_sold: totSold, sold_normal: totNormal, total_iade: totIade,
      sold_ty: totTY, sold_hb: totHB, sold_other: totOther,
      total_cost: totCost
    });
    totalRow.font = { bold: true };
    totalRow.getCell('K').numFmt = CURRENCY_FORMAT;
    totalRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } };
    });

    // Özet platform sayfası
    const sumSheet = workbook.addWorksheet('Platform Özeti');
    sumSheet.columns = [
      { header: 'Platform',      key: 'plat',   width: 18 },
      { header: 'Satılan Adet',  key: 'qty',    width: 14 },
      { header: 'Maliyet (₺)',   key: 'cost',   width: 16 },
    ];
    const sumHeader = sumSheet.getRow(1);
    sumHeader.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3F8A' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    sumHeader.height = 26;

    const platData = [
      { plat: '🟠 Trendyol',    qty: totTY,     cost: result.rows.reduce((s,r) => s + (parseInt(r.sold_ty)||0)*(parseFloat(r.cost_price)||0), 0) },
      { plat: '🔴 Hepsiburada', qty: totHB,     cost: result.rows.reduce((s,r) => s + (parseInt(r.sold_hb)||0)*(parseFloat(r.cost_price)||0), 0) },
      { plat: 'Normal',          qty: totNormal, cost: result.rows.reduce((s,r) => s + (parseInt(r.sold_normal)||0)*(parseFloat(r.cost_price)||0), 0) },
      { plat: 'Diğer',           qty: totOther,  cost: result.rows.reduce((s,r) => s + (parseInt(r.sold_other)||0)*(parseFloat(r.cost_price)||0), 0) },
      { plat: '↩️ İade (Stoğa Giren)', qty: totIade, cost: 0 },
      { plat: 'TOPLAM',          qty: totSold,   cost: totCost },
    ];
    platData.forEach((d, i) => {
      const row = sumSheet.addRow(d);
      row.getCell('cost').numFmt = CURRENCY_FORMAT;
      if (i === platData.length - 1) {
        row.font = { bold: true };
        row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FF' } }; });
      }
    });

    res.setHeader('Content-Disposition', `attachment; filename=satis_raporu_${from}_${to}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Satış özet export hatası:', err);
    res.status(500).json({ error: 'Excel oluşturulamadı' });
  }
});

// GET /api/export/critical-stock
router.get('/critical-stock', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.name, pt.name AS product_type, p.barcode, p.stock_quantity, p.critical_stock,
              CASE WHEN p.stock_quantity = 0 THEN 'Tükendi'
                   WHEN p.stock_quantity <= p.critical_stock THEN 'Kritik'
                   ELSE 'Normal' END AS durum
       FROM products p LEFT JOIN product_types pt ON p.product_type_id = pt.id
       WHERE p.stock_quantity <= p.critical_stock
       ORDER BY p.stock_quantity ASC`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Kritik Stoklar');

    sheet.columns = [
      { header: 'Ürün Adı', key: 'name', width: 30 },
      { header: 'Ürün Tipi', key: 'product_type', width: 15 },
      { header: 'Barkod', key: 'barcode', width: 20 },
      { header: 'Stok', key: 'stock_quantity', width: 10 },
      { header: 'Kritik Stok', key: 'critical_stock', width: 12 },
      { header: 'Durum', key: 'durum', width: 12 }
    ];

    result.rows.forEach(row => sheet.addRow(row));
    styleHeaderRow(sheet);

    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=kritik_stoklar_${today}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Kritik stok export hatası:', err);
    res.status(500).json({ error: 'Excel oluşturulamadı' });
  }
});

// GET /api/export/stock-value
router.get('/stock-value', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.name, pt.name AS product_type, p.stock_quantity, p.cost_price,
              (p.stock_quantity * p.cost_price) AS total_value
       FROM products p LEFT JOIN product_types pt ON p.product_type_id = pt.id
       ORDER BY total_value DESC NULLS LAST`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Stok Değeri');

    sheet.columns = [
      { header: 'Ürün Adı', key: 'name', width: 30 },
      { header: 'Ürün Tipi', key: 'product_type', width: 15 },
      { header: 'Stok Adedi', key: 'stock_quantity', width: 12 },
      { header: 'Birim Maliyet', key: 'cost_price', width: 15 },
      { header: 'Toplam Değer', key: 'total_value', width: 18 }
    ];

    result.rows.forEach(row => sheet.addRow(row));
    styleHeaderRow(sheet);

    sheet.getColumn('D').numFmt = CURRENCY_FORMAT;
    sheet.getColumn('E').numFmt = CURRENCY_FORMAT;

    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Disposition', `attachment; filename=stok_degeri_${today}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Stok değeri export hatası:', err);
    res.status(500).json({ error: 'Excel oluşturulamadı' });
  }
});

// GET /api/export/stock-count/:id
router.get('/stock-count/:id', async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM stock_count_sessions WHERE id = $1', [req.params.id]);
    if (session.rows.length === 0) {
      return res.status(404).json({ error: 'Sayım bulunamadı' });
    }

    const items = await pool.query(
      `SELECT product_name_snapshot AS product_name, system_quantity, counted_quantity, difference
       FROM stock_count_items WHERE session_id = $1 ORDER BY product_name_snapshot`,
      [req.params.id]
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Stok Sayım');

    sheet.columns = [
      { header: 'Ürün Adı', key: 'product_name', width: 30 },
      { header: 'Sistemdeki Stok', key: 'system_quantity', width: 16 },
      { header: 'Sayılan Adet', key: 'counted_quantity', width: 14 },
      { header: 'Fark', key: 'difference', width: 10 }
    ];

    items.rows.forEach((row, i) => {
      const excelRow = sheet.addRow(row);
      const diffCell = excelRow.getCell(4);
      if (row.difference > 0) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        diffCell.font = { color: { argb: 'FF155724' } };
      } else if (row.difference < 0) {
        diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
        diffCell.font = { color: { argb: 'FF721C24' } };
      }
    });
    styleHeaderRow(sheet);

    const countDate = formatDate(session.rows[0].count_date);
    res.setHeader('Content-Disposition', `attachment; filename=stok_sayim_${countDate.replace(/\./g, '-')}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Sayım export hatası:', err);
    res.status(500).json({ error: 'Excel oluşturulamadı' });
  }
});

module.exports = router;
