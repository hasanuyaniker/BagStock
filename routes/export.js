const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { Pool } = require('pg');
const authMiddleware = require('../middleware/auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
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

// GET /api/export/products
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.name, pt.name AS product_type, p.barcode, p.supplier_name,
              p.stock_quantity, p.cost_price, p.critical_stock,
              p.trendyol_price, p.trendyol_commission,
              p.hepsiburada_price, p.hepsiburada_commission
       FROM products p LEFT JOIN product_types pt ON p.product_type_id = pt.id
       ORDER BY p.name`
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Envanter');

    sheet.columns = [
      { header: 'Ürün Adı', key: 'name', width: 30 },
      { header: 'Ürün Tipi', key: 'product_type', width: 15 },
      { header: 'Barkod', key: 'barcode', width: 20 },
      { header: 'Tedarikçi', key: 'supplier_name', width: 20 },
      { header: 'Stok', key: 'stock_quantity', width: 10 },
      { header: 'Alış Fiyatı', key: 'cost_price', width: 15 },
      { header: 'Kritik Stok', key: 'critical_stock', width: 12 },
      { header: 'TY Fiyat', key: 'trendyol_price', width: 15 },
      { header: 'TY Komisyon %', key: 'trendyol_commission', width: 13 },
      { header: 'HB Fiyat', key: 'hepsiburada_price', width: 15 },
      { header: 'HB Komisyon %', key: 'hepsiburada_commission', width: 13 }
    ];

    result.rows.forEach(row => sheet.addRow(row));
    styleHeaderRow(sheet);

    ['F','H','J'].forEach(col => {
      sheet.getColumn(col).numFmt = CURRENCY_FORMAT;
    });

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
