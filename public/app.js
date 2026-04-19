// ==================== GLOBAL STATE ====================
let currentUser = null;
let products = [];
let productTypes = [];
let materials = [];
let allSales = [];
let columnSettings = [];
let stockChart = null;
let typeChart = null;
let currentCountSession = null;

const DEFAULT_COLUMNS = [
  { key: 'image', label: 'Görsel', visible: true, width: 60 },
  { key: 'name', label: 'Ürün Adı', visible: true, width: 180 },
  { key: 'color', label: 'Renk', visible: true, width: 90 },
  { key: 'product_type_name', label: 'Ürün Tipi', visible: true, width: 100 },
  { key: 'material_name', label: 'Materyal', visible: true, width: 100 },
  { key: 'barcode', label: 'Barkod', visible: true, width: 120 },
  { key: 'supplier_name', label: 'Tedarikçi', visible: true, width: 120 },
  { key: 'stock_quantity', label: 'Stok', visible: true, width: 70 },
  { key: 'cost_price', label: 'Alış (₺)', visible: true, width: 90 },
  { key: 'critical_stock', label: 'Krit.', visible: true, width: 60 },
  { key: 'trendyol_price', label: 'TY Fiyat', visible: true, width: 90 },
  { key: 'trendyol_commission', label: 'TY Kom.', visible: true, width: 80 },
  { key: 'hepsiburada_price', label: 'HB Fiyat', visible: true, width: 90 },
  { key: 'hepsiburada_commission', label: 'HB Kom.', visible: true, width: 80 },
  { key: 'status', label: 'Durum', visible: true, width: 80 },
  { key: 'actions', label: 'İşlem', visible: true, width: 100 }
];

let inventorySort = { key: null, dir: 'asc' };

// ==================== AUTH ====================
const token = localStorage.getItem('token');
if (!token) { window.location.href = '/index.html'; }

function getHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
}

async function apiFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  options.headers['Authorization'] = 'Bearer ' + token;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, options);
  if (res.status === 401) { logout(); return null; }
  return res;
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/index.html';
}

// ==================== INIT ====================
// Veri yüklenme bayrağı — tekrar çağrılarda gereksiz API isteği önler
let _dataLoaded = false;

(async function init() {
  try {
    const res = await apiFetch('/api/auth/me');
    if (!res) return;
    currentUser = await res.json();

    // UI user info
    document.getElementById('userAvatar').textContent = currentUser.username.charAt(0).toUpperCase();
    document.getElementById('userName').textContent = currentUser.username;
    const roleBadge = document.getElementById('userRole');
    roleBadge.textContent = currentUser.role === 'admin' ? 'Admin' : 'Standart';
    roleBadge.className = 'role-badge ' + currentUser.role;

    // Show admin-only features
    if (currentUser.role === 'admin') {
      document.getElementById('stockcountNav').style.display = '';
    } else {
      document.getElementById('settingsTabUsers') && (document.getElementById('settingsTabUsers').style.display = 'none');
      document.getElementById('addUserBtn')      && (document.getElementById('addUserBtn').style.display = 'none');
    }

    // Set today on sales date
    document.getElementById('salesDate').value = new Date().toISOString().split('T')[0];

    // Tüm verileri paralel yükle (bir kez)
    await Promise.all([loadProductTypes(), loadMaterials(), loadProducts(), loadStats(), loadLogoFromDB()]);
    _dataLoaded = true;

    // Load saved section (veriler hazır olduktan sonra)
    const saved = localStorage.getItem('activeSection');
    if (saved && saved !== 'stockcount') switchSection(saved);
    else if (saved === 'stockcount' && currentUser.role === 'admin') switchSection(saved);
    else switchSection('dashboard');

  } catch (err) {
    console.error('Init error:', err);
  }
})();

// ==================== NAVIGATION ====================
function switchSection(name) {
  // Access control
  if (name === 'stockcount' && currentUser?.role !== 'admin') {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById('section-stockcount');
    sec.classList.add('active');
    sec.innerHTML = '<div class="access-denied"><h2>Erişim Engellendi</h2><p>Bu sayfaya erişim yetkiniz yok.</p></div>';
    return;
  }

  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));

  document.getElementById('section-' + name)?.classList.add('active');
  document.querySelector(`.sidebar-item[data-section="${name}"]`)?.classList.add('active');
  localStorage.setItem('activeSection', name);

  // Load section data
  // Envanter ve dashboard: init'te zaten yüklendiği için cache kullan, sadece render et
  if (name === 'dashboard') {
    if (_dataLoaded) loadStats();
    else loadStats();
  }
  if (name === 'inventory') {
    if (_dataLoaded && products.length > 0) { loadColumnSettings(); renderInventoryTable(); }
    else { loadProducts(); loadColumnSettings(); }
  }
  if (name === 'sales') loadSalesView();
  if (name === 'salesreport') initSalesReport();
  if (name === 'stockcount') loadStockCount();
  if (name === 'settings') loadSettings();
  if (name === 'reports') loadReportOptions();
}

// ==================== TOAST ====================
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 3000);
}

// ==================== CONFIRM DIALOG ====================
let confirmCallback = null;
function showConfirm(title, message, btnText, callback) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const btn = document.getElementById('confirmAction');
  btn.textContent = btnText;
  confirmCallback = callback;
  btn.onclick = () => { closeConfirm(); callback(); };
  document.getElementById('confirmOverlay').classList.add('active');
}
function closeConfirm() { document.getElementById('confirmOverlay').classList.remove('active'); }

// ==================== CURRENCY FORMAT ====================
function formatCurrency(val) {
  if (val == null || val === '') return '-';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(val);
}

function formatNumber(val) {
  if (val == null) return '-';
  return new Intl.NumberFormat('tr-TR').format(val);
}

// ==================== PRODUCT TYPES ====================
async function loadProductTypes() {
  const res = await apiFetch('/api/product-types');
  if (!res) return;
  productTypes = await res.json();
}

// ==================== MATERIALS ====================
async function loadMaterials() {
  const res = await apiFetch('/api/materials');
  if (!res) return;
  materials = await res.json();
}

// ==================== STATS / DASHBOARD ====================
async function loadStats() {
  try {
    const res = await apiFetch('/api/products/stats');
    if (!res) return;
    const stats = await res.json();

    document.getElementById('kpiTotalValue').textContent = formatCurrency(stats.totalValue);
    document.getElementById('kpiTotalSku').textContent = stats.totalSkus;
    document.getElementById('kpiOutOfStock').textContent = stats.outOfStock;
    document.getElementById('kpiCritical').textContent = stats.criticalStock;

    // Alert bar
    const alertBar = document.getElementById('alertBar');
    let alertHTML = '';
    if (stats.criticalStock > 0) {
      alertHTML += `<span class="alert-item" style="color:#fff;">⚠️ ${stats.criticalStock} ürün kritik stokta: ${stats.criticalProducts.map(p => p.name + ' (' + p.stock_quantity + ')').join(', ')}</span>`;
    }
    if (stats.outOfStock > 0) {
      alertHTML += `<span class="alert-item" style="color:#fff;">🚫 ${stats.outOfStock} ürün tükendi: ${stats.outOfStockProducts.map(p => p.name).join(', ')}</span>`;
    }
    if (alertHTML) {
      alertBar.innerHTML = alertHTML;
      alertBar.className = 'alert-bar visible';
      alertBar.style.background = stats.outOfStock > 0 ? '#dc2626' : '#d97706';
      alertBar.style.color = '#fff';
    } else {
      alertBar.className = 'alert-bar';
      alertBar.style.background = '';
      alertBar.style.color = '';
    }

    // Charts
    renderStockChart(stats.stockByProduct);
    renderTypeChart(stats.stockByType);
  } catch (err) {
    console.error('Stats error:', err);
  }
}

function renderStockChart(data) {
  const canvasEl = document.getElementById('chartStock');
  const wrapper  = document.getElementById('stockChartWrapper');
  if (stockChart) { stockChart.destroy(); stockChart = null; }
  if (!data || data.length === 0) return;

  // TÜM ürünleri göster — stoka göre büyükten küçüğe
  const sorted = [...data].sort((a, b) => parseInt(b.stock_quantity) - parseInt(a.stock_quantity));
  const labels = sorted.map(d => d.name.length > 26 ? d.name.substring(0, 26) + '…' : d.name);
  const values = sorted.map(d => parseInt(d.stock_quantity) || 0);

  const colors = sorted.map(d => {
    const qty  = parseInt(d.stock_quantity)  || 0;
    const crit = parseInt(d.critical_stock) || 0;
    if (qty === 0)   return 'rgba(244,63,94,0.85)';
    if (qty <= crit) return 'rgba(245,158,11,0.85)';
    return 'rgba(91,61,232,0.82)';
  });

  const hoverColors = sorted.map(d => {
    const qty  = parseInt(d.stock_quantity)  || 0;
    const crit = parseInt(d.critical_stock) || 0;
    if (qty === 0)   return '#f43f5e';
    if (qty <= crit) return '#f59e0b';
    return '#c026a8';
  });

  // Her bar için yeterli yükseklik — çakışmayı önler
  const perBar = 32;
  const wantH  = Math.max(200, sorted.length * perBar + 50);
  const capH   = 400;

  // Wrapper: kaydırmalı kap
  if (wrapper) {
    wrapper.style.height    = Math.min(wantH, capH) + 'px';
    wrapper.style.maxHeight = capH + 'px';
    wrapper.style.overflowY = wantH > capH ? 'auto' : 'hidden';
    wrapper.style.overflowX = 'hidden';
    wrapper.style.position  = 'relative';
  }

  // Canvas: TÜM içeriği barındıracak yükseklik (wrapper scroll eder)
  const containerW = wrapper ? wrapper.clientWidth || 500 : 500;
  canvasEl.style.width  = containerW + 'px';
  canvasEl.style.height = wantH + 'px';
  canvasEl.width  = containerW;
  canvasEl.height = wantH;

  stockChart = new Chart(canvasEl, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        hoverBackgroundColor: hoverColors,
        borderRadius: 5,
        borderSkipped: false,
        barThickness: 22
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: false,          // explicit canvas boyutu kullan
      maintainAspectRatio: false,
      animation: { duration: 400, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,16,53,0.92)',
          titleColor: '#e8eaf6',
          bodyColor: '#c5c8e8',
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (context) => {
              const d    = sorted[context.dataIndex];
              const qty  = parseInt(d.stock_quantity)  || 0;
              const crit = parseInt(d.critical_stock) || 0;
              const s    = qty === 0 ? '🔴 Tükendi' : qty <= crit ? '🟡 Kritik' : '🟢 Normal';
              return ` ${qty} adet  |  ${s}`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(124,58,237,0.07)' },
          ticks: { font: { size: 11 }, color: '#6b7280' }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 11 }, color: '#374151', padding: 4 }
        }
      }
    }
  });
}

function renderTypeChart(data) {
  const ctx = document.getElementById('chartType');
  if (typeChart) { typeChart.destroy(); typeChart = null; }
  if (!data || data.length === 0) return;

  // Gradient palette — resimden ilham
  const colors = [
    '#5b3de8', '#8b45f0', '#c026a8', '#e91e8c',
    '#f43f5e', '#10b981', '#f59e0b', '#3b82f6'
  ];
  const total = data.reduce((s, d) => s + parseInt(d.total_stock || 0), 0);

  typeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.type_name),
      datasets: [{
        data: data.map(d => parseInt(d.total_stock || 0)),
        backgroundColor: colors.slice(0, data.length),
        hoverBackgroundColor: colors.slice(0, data.length).map(c => c + 'dd'),
        borderWidth: 3,
        borderColor: '#ffffff',
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      resizeDelay: 200,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'right',
          labels: {
            font: { size: 11, weight: '600' },
            color: '#374151',
            boxWidth: 12,
            borderRadius: 4,
            padding: 10,
            generateLabels: (chart) => {
              const ds = chart.data.datasets[0];
              return chart.data.labels.map((label, i) => ({
                text: `${label}  ${ds.data[i]}  (%${total > 0 ? Math.round(ds.data[i]/total*100) : 0})`,
                fillStyle: ds.backgroundColor[i],
                strokeStyle: ds.backgroundColor[i],
                lineWidth: 0,
                index: i
              }));
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(13,16,53,0.92)',
          titleColor: '#e8eaf6',
          bodyColor: '#c5c8e8',
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const pct = total > 0 ? Math.round(ctx.parsed / total * 100) : 0;
              return `  ${ctx.parsed} adet  (% ${pct})`;
            }
          }
        }
      }
    },
    plugins: [{
      id: 'centerText',
      beforeDraw(chart) {
        if (!chart.chartArea) return;
        const { ctx: c } = chart;
        c.save();
        const x = (chart.chartArea.left + chart.chartArea.right) / 2;
        const y = (chart.chartArea.top + chart.chartArea.bottom) / 2;
        // Büyük sayı
        c.font = 'bold 26px -apple-system, sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        const grad = c.createLinearGradient(x-30, y-20, x+30, y+20);
        grad.addColorStop(0, '#5b3de8');
        grad.addColorStop(1, '#c026a8');
        c.fillStyle = grad;
        c.fillText(total.toString(), x, y - 10);
        // Alt yazı
        c.font = '600 11px -apple-system, sans-serif';
        c.fillStyle = '#9498bb';
        c.fillText('Toplam Stok', x, y + 12);
        c.restore();
      }
    }]
  });
}

// ==================== PRODUCTS / INVENTORY ====================
async function loadProducts() {
  const res = await apiFetch('/api/products');
  if (!res) return;
  products = await res.json();
  renderInventoryTable();
}

async function loadColumnSettings() {
  try {
    const res = await apiFetch('/api/columns/inventory');
    if (!res) return;
    const saved = await res.json();
    if (saved.length > 0) {
      columnSettings = saved;
    }
  } catch (e) {}
}

function getVisibleColumns() {
  if (columnSettings.length === 0) return DEFAULT_COLUMNS.filter(c => c.visible);
  const merged = DEFAULT_COLUMNS.map(dc => {
    const saved = columnSettings.find(s => s.column_key === dc.key);
    if (saved) return { ...dc, visible: saved.is_visible, order: saved.column_order, width: saved.column_width || dc.width };
    return dc;
  });
  merged.sort((a, b) => (a.order || 0) - (b.order || 0));
  return merged.filter(c => c.visible);
}

function renderInventoryTable() {
  const cols = getVisibleColumns();
  const thead = document.getElementById('inventoryThead');
  const tbody = document.getElementById('inventoryTbody');

  // Build header
  let th = '<tr>';
  cols.forEach(col => {
    const arrow = inventorySort.key === col.key ? (inventorySort.dir === 'asc' ? '▲' : '▼') : '↕';
    const sorted = inventorySort.key === col.key ? ' sorted' : '';
    th += `<th style="width:${col.width}px;" class="${sorted}" onclick="sortInventory('${col.key}')">
      ${col.label}<span class="sort-arrow">${arrow}</span>
      <div class="resize-handle" onmousedown="startResize(event, '${col.key}')"></div>
    </th>`;
  });
  th += '</tr>';
  thead.innerHTML = th;

  // Build body
  let filtered = filterProductList(products);
  if (inventorySort.key) {
    filtered.sort((a, b) => {
      let va = a[inventorySort.key], vb = b[inventorySort.key];
      if (inventorySort.key === 'status') {
        va = getStatusOrder(a); vb = getStatusOrder(b);
      }
      if (va == null) va = '';
      if (vb == null) vb = '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return inventorySort.dir === 'asc' ? -1 : 1;
      if (va > vb) return inventorySort.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  let rows = '';
  filtered.forEach(p => {
    rows += '<tr>';
    cols.forEach(col => {
      rows += '<td>';
      switch (col.key) {
        case 'image':
          if (p.product_image_url) {
            rows += `<img src="${p.product_image_url}" class="product-thumb" style="cursor:zoom-in;" onclick="openLightbox('${p.product_image_url.startsWith('data:') ? `/api/products/${p.id}/image` : p.product_image_url}')" onerror="this.style.display='none'">`;
          } else {
            rows += '<div class="product-thumb-placeholder">📦</div>';
          }
          break;
        case 'name': rows += escHtml(p.name); break;
        case 'product_type_name':
          rows += p.product_type_name ? `<span class="type-badge">${escHtml(p.product_type_name)}</span>` : '-';
          break;
        case 'material_name':
          rows += p.material_name ? `<span class="type-badge" style="background:#e0f2fe;color:#0369a1;">${escHtml(p.material_name)}</span>` : '-';
          break;
        case 'barcode': rows += escHtml(p.barcode); break;
        case 'color': rows += p.color ? `<span class="type-badge" style="background:#f3f4f6;color:#374151;">${escHtml(p.color)}</span>` : '-'; break;
        case 'supplier_name': rows += escHtml(p.supplier_name || '-'); break;
        case 'stock_quantity': rows += `<strong>${p.stock_quantity}</strong>`; break;
        case 'cost_price': rows += formatCurrency(p.cost_price); break;
        case 'critical_stock': rows += p.critical_stock; break;
        case 'trendyol_price': rows += formatCurrency(p.trendyol_price); break;
        case 'trendyol_commission': rows += p.trendyol_commission != null ? '%' + p.trendyol_commission : '-'; break;
        case 'hepsiburada_price': rows += formatCurrency(p.hepsiburada_price); break;
        case 'hepsiburada_commission': rows += p.hepsiburada_commission != null ? '%' + p.hepsiburada_commission : '-'; break;
        case 'status':
          if (p.stock_quantity === 0) rows += '<span class="status-badge outofstock">Tükendi</span>';
          else if (p.stock_quantity <= p.critical_stock) rows += '<span class="status-badge critical">Kritik</span>';
          else rows += '<span class="status-badge normal">Normal</span>';
          break;
        case 'actions':
          rows += `<button class="btn btn-secondary btn-sm" onclick="editProduct(${p.id})" style="margin-right:4px;">Düzenle</button>`;
          rows += `<button class="btn btn-danger btn-sm" onclick="deleteProduct(${p.id}, '${escHtml(p.name)}')">Sil</button>`;
          break;
        default: rows += p[col.key] || '-';
      }
      rows += '</td>';
    });
    rows += '</tr>';
  });

  tbody.innerHTML = rows || '<tr><td colspan="99" style="text-align:center;padding:40px;color:#6b7280;">Ürün bulunamadı</td></tr>';
}

function getStatusOrder(p) {
  if (p.stock_quantity === 0) return 0;
  if (p.stock_quantity <= p.critical_stock) return 1;
  return 2;
}

function sortInventory(key) {
  if (key === 'image' || key === 'actions') return;
  if (inventorySort.key === key) {
    inventorySort.dir = inventorySort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    inventorySort.key = key;
    inventorySort.dir = 'asc';
  }
  renderInventoryTable();
}

function filterInventory() {
  renderInventoryTable();
}

function filterProductList(list) {
  const q = (document.getElementById('inventorySearch')?.value || '').toLowerCase().trim();
  if (!q) return list;
  return list.filter(p =>
    (p.name && p.name.toLowerCase().includes(q)) ||
    (p.barcode && p.barcode.toLowerCase().includes(q)) ||
    (p.product_type_name && p.product_type_name.toLowerCase().includes(q)) ||
    (p.color && p.color.toLowerCase().includes(q))
  );
}

// Column resize
let resizeCol = null, resizeStart = 0, resizeWidth = 0;
function startResize(e, key) {
  e.stopPropagation();
  resizeCol = key;
  resizeStart = e.clientX;
  const th = e.target.parentElement;
  resizeWidth = th.offsetWidth;
  document.addEventListener('mousemove', doResize);
  document.addEventListener('mouseup', stopResize);
}
function doResize(e) {
  const diff = e.clientX - resizeStart;
  const newWidth = Math.max(40, resizeWidth + diff);
  const col = DEFAULT_COLUMNS.find(c => c.key === resizeCol);
  if (col) col.width = newWidth;
  renderInventoryTable();
}
function stopResize() {
  document.removeEventListener('mousemove', doResize);
  document.removeEventListener('mouseup', stopResize);
  saveColumnSettings();
}

// Column panel
function toggleColumnPanel() {
  const panel = document.getElementById('columnPanel');
  if (panel.classList.contains('active')) { panel.classList.remove('active'); return; }

  let html = '';
  DEFAULT_COLUMNS.forEach((col, i) => {
    const checked = col.visible !== false ? 'checked' : '';
    html += `<div class="column-panel-item" draggable="true" data-key="${col.key}">
      <input type="checkbox" ${checked} onchange="toggleColumn('${col.key}', this.checked)">
      <span>${col.label}</span>
    </div>`;
  });
  panel.innerHTML = html;
  panel.classList.add('active');

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!panel.contains(e.target) && !e.target.closest('.btn-secondary')) {
        panel.classList.remove('active');
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

function toggleColumn(key, visible) {
  const col = DEFAULT_COLUMNS.find(c => c.key === key);
  if (col) col.visible = visible;
  renderInventoryTable();
  saveColumnSettings();
}

async function saveColumnSettings() {
  const data = DEFAULT_COLUMNS.map((col, i) => ({
    column_key: col.key,
    is_visible: col.visible !== false,
    column_order: i,
    column_width: col.width
  }));
  await apiFetch('/api/columns/inventory', { method: 'PUT', body: data });
}

// Product Modal
function openProductModal(product = null) {
  document.getElementById('productEditId').value = product ? product.id : '';
  document.getElementById('productModalTitle').textContent = product ? 'Ürünü Düzenle' : 'Yeni Ürün Ekle';

  // Fill type dropdown
  const sel = document.getElementById('pType');
  sel.innerHTML = '<option value="">Seçiniz</option>';
  productTypes.forEach(t => { sel.innerHTML += `<option value="${t.id}">${escHtml(t.name)}</option>`; });

  // Fill material dropdown
  const msel = document.getElementById('pMaterial');
  msel.innerHTML = '<option value="">Seçiniz</option>';
  materials.forEach(m => { msel.innerHTML += `<option value="${m.id}">${escHtml(m.name)}</option>`; });

  if (product) {
    document.getElementById('pName').value = product.name || '';
    document.getElementById('pBarcode').value = product.barcode || '';
    document.getElementById('pType').value = product.product_type_id || '';
    document.getElementById('pMaterial').value = product.material_id || '';
    document.getElementById('pColor').value = product.color || '';
    document.getElementById('pSupplier').value = product.supplier_name || '';
    document.getElementById('pStock').value = product.stock_quantity || 0;
    document.getElementById('pCost').value = product.cost_price || '';
    document.getElementById('pCritical').value = product.critical_stock || 5;
    document.getElementById('pTYPrice').value = product.trendyol_price || '';
    document.getElementById('pTYComm').value = product.trendyol_commission || '';
    document.getElementById('pHBPrice').value = product.hepsiburada_price || '';
    document.getElementById('pHBComm').value = product.hepsiburada_commission || '';
    // Mevcut görsel URL'sini sakla — kaydetme sırasında kullanılır
    document.getElementById('productCurrentImageUrl').value = product.product_image_url || '';
    // Image preview
    const preview = document.getElementById('productImagePreview');
    if (product.product_image_url) {
      preview.src = product.product_image_url;
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
  } else {
    ['pName','pBarcode','pColor','pSupplier','pCost','pTYPrice','pTYComm','pHBPrice','pHBComm'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('pStock').value = 0;
    document.getElementById('pCritical').value = 5;
    document.getElementById('pType').value = '';
    document.getElementById('pMaterial').value = '';
    document.getElementById('productCurrentImageUrl').value = '';
    document.getElementById('productImagePreview').style.display = 'none';
  }

  document.getElementById('productModal').classList.add('active');
}

function closeProductModal() { document.getElementById('productModal').classList.remove('active'); }

function editProduct(id) {
  const product = products.find(p => p.id === id);
  if (product) openProductModal(product);
}

async function saveProduct() {
  const editId = document.getElementById('productEditId').value;
  const fileInput = document.getElementById('productImageInput');
  const hasNewImage = fileInput.files.length > 0;
  // Düzenlemede yeni görsel seçilmediyse mevcut URL'yi koru
  const existingImageUrl = document.getElementById('productCurrentImageUrl').value || null;

  const data = {
    name: document.getElementById('pName').value.trim(),
    barcode: document.getElementById('pBarcode').value.trim(),
    product_type_id: document.getElementById('pType').value || null,
    material_id: document.getElementById('pMaterial').value || null,
    color: document.getElementById('pColor').value.trim() || null,
    supplier_name: document.getElementById('pSupplier').value.trim() || null,
    stock_quantity: parseInt(document.getElementById('pStock').value) || 0,
    cost_price: parseFloat(document.getElementById('pCost').value) || null,
    critical_stock: parseInt(document.getElementById('pCritical').value) || 5,
    trendyol_price: parseFloat(document.getElementById('pTYPrice').value) || null,
    trendyol_commission: parseFloat(document.getElementById('pTYComm').value) || null,
    hepsiburada_price: parseFloat(document.getElementById('pHBPrice').value) || null,
    hepsiburada_commission: parseFloat(document.getElementById('pHBComm').value) || null,
    // Mevcut görsel URL'sini koru — yeni görsel yüklendiyse upload endpoint ayrıca günceller
    product_image_url: existingImageUrl
  };

  if (!data.name || !data.barcode) {
    showToast('Ürün adı ve barkod zorunludur', 'error');
    return;
  }

  try {
    const url = editId ? `/api/products/${editId}` : '/api/products';
    const method = editId ? 'PUT' : 'POST';
    const res = await apiFetch(url, { method, body: data });
    const result = await res.json();

    if (!res.ok) { showToast(result.error || 'Hata oluştu', 'error'); return; }

    // Upload image if selected
    if (hasNewImage) {
      const productId = editId || result.id;
      const formData = new FormData();
      formData.append('image', fileInput.files[0]);
      await fetch(`/api/uploads/product/${productId}`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
    }

    showToast(editId ? 'Ürün güncellendi' : 'Ürün eklendi');
    closeProductModal();
    fileInput.value = '';
    await loadProducts();
    loadStats();
  } catch (err) {
    showToast('Bir hata oluştu', 'error');
  }
}

function deleteProduct(id, name) {
  showConfirm('Ürünü Sil', `"${name}" ürününü silmek istediğinize emin misiniz?`, 'Sil', async () => {
    const res = await apiFetch(`/api/products/${id}`, { method: 'DELETE' });
    if (res?.ok) {
      showToast('Ürün silindi');
      loadProducts();
      loadStats();
    } else {
      showToast('Silme başarısız', 'error');
    }
  });
}

// Image preview & drag drop
function previewProductImage(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const preview = document.getElementById('productImagePreview');
      preview.src = e.target.result;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(input.files[0]);
  }
}

const dropArea = document.getElementById('productImageDrop');
if (dropArea) {
  ['dragenter','dragover'].forEach(e => dropArea.addEventListener(e, (ev) => { ev.preventDefault(); dropArea.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(e => dropArea.addEventListener(e, (ev) => { ev.preventDefault(); dropArea.classList.remove('dragover'); }));
  dropArea.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      document.getElementById('productImageInput').files = files;
      previewProductImage(document.getElementById('productImageInput'));
    }
  });
}

// ==================== EXPORT ====================
function exportExcel(type) {
  const a = document.createElement('a');
  a.href = `/api/export/${type}`;
  a.setAttribute('download', '');
  // Add auth via fetch
  apiFetch(`/api/export/${type}`).then(res => res.blob()).then(blob => {
    const url = URL.createObjectURL(blob);
    a.href = url;
    const disposition = 'envanter.xlsx';
    a.download = disposition;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ==================== SALES ====================
async function loadSalesView() {
  const date = document.getElementById('salesDate').value;
  await loadProducts();

  // Render product cards
  renderSalesProducts(products);

  // Load day's sales
  const res = await apiFetch(`/api/sales?date=${date}`);
  if (!res) return;
  allSales = await res.json();
  renderSalesHistory();
}

function renderSalesProducts(list) {
  const q = (document.getElementById('salesSearch')?.value || '').toLowerCase();
  const filtered = q ? list.filter(p =>
    p.name.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q)
  ) : list;

  const container = document.getElementById('salesProductList');
  let html = '';

  filtered.forEach(p => {
    const stockColor = p.stock_quantity === 0 ? 'background:#fee2e2;color:#991b1b' :
                        p.stock_quantity <= p.critical_stock ? 'background:#fef3c7;color:#92400e' :
                        'background:#dcfce7;color:#166534';

    html += `<div class="sales-product-card">
      <div style="width:40px;height:40px;border-radius:6px;overflow:hidden;background:#f3f4f6;flex-shrink:0;">
        ${p.product_image_url ? `<img src="/api/products/${p.id}/image" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" onclick="openLightbox('/api/products/${p.id}/image')">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9ca3af;">📦</div>'}
      </div>
      <div class="sales-product-info">
        <div class="sales-product-name">${escHtml(p.name)}</div>
        <div class="sales-product-meta">
          ${p.product_type_name ? `<span class="type-badge">${escHtml(p.product_type_name)}</span>` : ''}
          ${p.material_name ? `<span class="type-badge" style="background:#e0f2fe;color:#0369a1;">${escHtml(p.material_name)}</span>` : ''}
          ${p.color ? `<span class="type-badge" style="background:#ede9fe;color:#6d28d9;">${escHtml(p.color)}</span>` : ''}
          <span>${escHtml(p.barcode)}</span>
        </div>
      </div>
      <span class="sales-stock-badge" style="${stockColor}">Stok: ${p.stock_quantity}</span>
      <div class="sales-actions">
        <input type="number" class="sales-qty-input" id="saleQty_${p.id}" value="1" min="1">
        <button class="btn btn-success btn-sm" onclick="confirmSale(${p.id}, 1)">+ Giriş</button>
        <button class="btn btn-danger btn-sm" onclick="confirmSale(${p.id}, -1)">- Çıkış</button>
      </div>
    </div>`;
  });

  container.innerHTML = html || '<p style="text-align:center;padding:40px;color:#6b7280;">Ürün bulunamadı</p>';
}

function filterSalesProducts() { renderSalesProducts(products); }

function confirmSale(productId, direction) {
  const qtyInput = document.getElementById(`saleQty_${productId}`);
  const qty = parseInt(qtyInput?.value) || 1;
  if (qty <= 0) { showToast('Geçerli bir miktar girin', 'error'); return; }
  const msg = direction > 0
    ? `${qty} adet stok girişi yapmak istediğinizden emin misiniz?`
    : `${qty} adet stok çıkışı yapmak istediğinizden emin misiniz?`;
  showConfirm(direction > 0 ? 'Stok Girişi' : 'Stok Çıkışı', msg, 'Evet', () => recordSale(productId, direction));
}

async function recordSale(productId, direction) {
  const qtyInput = document.getElementById(`saleQty_${productId}`);
  const qty = parseInt(qtyInput?.value) || 1;
  const date = document.getElementById('salesDate').value;

  const res = await apiFetch('/api/sales', {
    method: 'POST',
    body: { product_id: productId, quantity_change: qty * direction, sale_date: date, note: '' }
  });

  if (res?.ok) {
    showToast(direction > 0 ? `${qty} adet giriş yapıldı` : `${qty} adet çıkış yapıldı`);
    loadSalesView();
    loadStats();
  } else {
    const err = await res?.json();
    showToast(err?.error || 'Hata oluştu', 'error');
  }
}

function renderSalesHistory() {
  const tbody = document.getElementById('salesHistoryBody');
  let html = '';
  let totalIn = 0, totalOut = 0;

  allSales.forEach(s => {
    const isIn = s.quantity_change > 0;
    if (isIn) totalIn += s.quantity_change;
    else totalOut += Math.abs(s.quantity_change);

    html += `<tr>
      <td>${escHtml(s.product_name)}</td>
      <td>${s.product_color ? `<span class="type-badge" style="background:#ede9fe;color:#6d28d9;">${escHtml(s.product_color)}</span>` : '-'}</td>
      <td>${s.product_type_name ? `<span class="type-badge">${escHtml(s.product_type_name)}</span>` : '-'}</td>
      <td><strong style="color:${isIn ? 'var(--green)' : 'var(--red)'};">${isIn ? '+' : ''}${s.quantity_change}</strong></td>
      <td>${escHtml(s.note || '-')}</td>
      <td>${escHtml(s.created_by_username || '-')}</td>
    </tr>`;
  });

  tbody.innerHTML = html || '<tr><td colspan="6" style="text-align:center;padding:20px;color:#6b7280;">Kayıt yok</td></tr>';

  document.getElementById('salesSummary').innerHTML = `
    <span class="sales-summary-item" style="color:var(--green);">Toplam Giriş: +${totalIn}</span>
    <span class="sales-summary-item" style="color:var(--red);">Toplam Çıkış: -${totalOut}</span>
    <span class="sales-summary-item">Net: ${totalIn - totalOut}</span>
  `;
}

// ==================== STOCK COUNT ====================
let countSessions = [];
let activeCountSession = null;

async function loadStockCount() {
  if (currentUser?.role !== 'admin') return;
  switchCountView('new');
}

function switchCountView(view) {
  document.getElementById('countToggleNew').className = 'toggle-btn' + (view === 'new' ? ' active' : '');
  document.getElementById('countToggleHistory').className = 'toggle-btn' + (view === 'history' ? ' active' : '');
  document.getElementById('countNewView').style.display = view === 'new' ? '' : 'none';
  document.getElementById('countHistoryView').style.display = view === 'history' ? '' : 'none';

  if (view === 'new') loadNewCount();
  if (view === 'history') loadCountHistory();
}

async function loadNewCount() {
  const res = await apiFetch('/api/stockcount/sessions');
  if (!res) return;
  const sessions = await res.json();

  // Find draft session
  const draft = sessions.find(s => s.status === 'draft');
  if (!draft) {
    document.getElementById('countNewView').innerHTML = `
      <div style="text-align:center;padding:60px;">
        <p style="color:#6b7280;margin-bottom:16px;">Aktif sayım oturumu yok</p>
        <button class="btn btn-primary" onclick="startNewCount()">Yeni Sayım Başlat</button>
      </div>`;
    return;
  }

  // Load full session
  const detRes = await apiFetch(`/api/stockcount/sessions/${draft.id}`);
  if (!detRes) return;
  activeCountSession = await detRes.json();
  renderCountSession();
}

async function startNewCount() {
  const res = await apiFetch('/api/stockcount/sessions', {
    method: 'POST',
    body: { count_date: new Date().toISOString().split('T')[0], note: '' }
  });
  if (res?.ok) {
    showToast('Yeni sayım başlatıldı');
    loadNewCount();
  } else {
    const err = await res?.json();
    showToast(err?.error || 'Hata oluştu', 'error');
  }
}

function renderCountSession() {
  const s = activeCountSession;
  if (!s) return;

  const items = s.items || [];
  const counted = items.filter(i => i.counted_quantity !== i.system_quantity).length;
  const increased = items.filter(i => i.counted_quantity > i.system_quantity).length;
  const decreased = items.filter(i => i.counted_quantity < i.system_quantity).length;
  const unchanged = items.filter(i => i.counted_quantity === i.system_quantity).length;

  let html = `
    <div class="stock-count-info-bar">
      <div class="form-group" style="margin:0;">
        <label style="font-size:11px;">Tarih</label>
        <input type="date" value="${s.count_date?.split('T')[0] || ''}" disabled style="font-size:12px;">
      </div>
      <div class="form-group" style="margin:0;flex:1;">
        <label style="font-size:11px;">Not</label>
        <input type="text" value="${escHtml(s.note || '')}" disabled style="font-size:12px;padding:6px 10px;">
      </div>
      <span class="count-progress">${counted}/${items.length} sayıldı</span>
      <button class="btn btn-primary" onclick="openApplyModal()">Onayla ve Aktar</button>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Ürün</th>
            <th>Sistemdeki Stok</th>
            <th>Sayılan Adet</th>
            <th>Fark</th>
          </tr>
        </thead>
        <tbody>`;

  items.forEach(item => {
    const diff = item.counted_quantity - item.system_quantity;
    const diffClass = diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-zero';
    const diffText = diff > 0 ? `+${diff}` : diff === 0 ? '=' : diff.toString();

    html += `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:32px;height:32px;border-radius:4px;overflow:hidden;background:#f3f4f6;flex-shrink:0;">
            ${item.product_image_snapshot ? `<img src="${item.product_image_snapshot}" style="width:100%;height:100%;object-fit:cover;">` : ''}
          </div>
          <span>${escHtml(item.product_name_snapshot)}</span>
        </div>
      </td>
      <td>${item.system_quantity}</td>
      <td><input type="number" value="${item.counted_quantity}" min="0" class="sales-qty-input" style="width:80px;"
           oninput="updateCountItem(${s.id}, ${item.product_id}, this.value)"></td>
      <td><span class="${diffClass}">${diffText}</span></td>
    </tr>`;
  });

  html += `</tbody></table></div>
    <div style="display:flex;gap:16px;margin-top:12px;font-size:13px;">
      <span style="color:var(--green);">Artan: ${increased}</span>
      <span style="color:var(--red);">Azalan: ${decreased}</span>
      <span style="color:#6b7280;">Değişmeyen: ${unchanged}</span>
    </div>`;

  document.getElementById('countNewView').innerHTML = html;
}

let countDebounce = {};
function updateCountItem(sessionId, productId, value) {
  const key = `${sessionId}_${productId}`;
  clearTimeout(countDebounce[key]);
  countDebounce[key] = setTimeout(async () => {
    await apiFetch(`/api/stockcount/sessions/${sessionId}/items`, {
      method: 'PATCH',
      body: { product_id: productId, counted_quantity: parseInt(value) || 0 }
    });
    // Reload to update diffs
    const detRes = await apiFetch(`/api/stockcount/sessions/${sessionId}`);
    if (detRes) {
      activeCountSession = await detRes.json();
      renderCountSession();
    }
  }, 600);
}

function openApplyModal() {
  const s = activeCountSession;
  if (!s) return;
  const items = s.items || [];
  const increased = items.filter(i => i.counted_quantity > i.system_quantity).length;
  const decreased = items.filter(i => i.counted_quantity < i.system_quantity).length;
  const unchanged = items.filter(i => i.counted_quantity === i.system_quantity).length;

  document.getElementById('applyCountSummary').innerHTML = `
    <div style="background:#f9fafb;border-radius:8px;padding:14px;font-size:13px;">
      <p><strong>Tarih:</strong> ${s.count_date?.split('T')[0]}</p>
      <p><strong>Toplam Ürün:</strong> ${items.length}</p>
      <p style="color:var(--green);"><strong>Artan:</strong> ${increased}</p>
      <p style="color:var(--red);"><strong>Azalan:</strong> ${decreased}</p>
      <p><strong>Değişmeyen:</strong> ${unchanged}</p>
    </div>`;

  document.getElementById('applyCountModal').classList.add('active');
}

function closeApplyModal() { document.getElementById('applyCountModal').classList.remove('active'); }

async function applyStockCount() {
  if (!activeCountSession) return;
  const res = await apiFetch(`/api/stockcount/sessions/${activeCountSession.id}/apply`, { method: 'POST' });

  if (res?.ok) {
    showToast('Stoklar başarıyla güncellendi!');
    closeApplyModal();
    loadNewCount();
    loadStats();
    loadProducts();
  } else {
    const err = await res?.json();
    showToast(err?.error || 'Hata oluştu', 'error');
  }
}

async function loadCountHistory() {
  const res = await apiFetch('/api/stockcount/sessions');
  if (!res) return;
  countSessions = await res.json();

  const container = document.getElementById('countHistoryView');
  if (countSessions.length === 0) {
    container.innerHTML = '<p style="text-align:center;padding:40px;color:#6b7280;">Henüz sayım kaydı yok</p>';
    return;
  }

  let html = '';
  countSessions.forEach(s => {
    const date = s.count_date?.split('T')[0] || '';
    const statusBadge = s.status === 'applied'
      ? '<span class="status-badge normal">Uygulandı</span>'
      : '<span class="status-badge critical">Taslak</span>';

    html += `<div class="session-row" onclick="toggleSessionDetail(${s.id})">
      <div class="session-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <strong>${date}</strong>
          <span style="font-size:12px;color:#6b7280;">${escHtml(s.created_by_username || '')}</span>
          ${statusBadge}
        </div>
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
          <span>${s.total_products || 0} ürün</span>
          <span style="color:var(--green);">+${s.increased_count || 0}</span>
          <span style="color:var(--red);">-${s.decreased_count || 0}</span>
          <span style="color:#6b7280;">=${s.unchanged_count || 0}</span>
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); exportStockCount(${s.id})">Excel</button>
          ${s.status === 'draft' ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteCountSession(${s.id})">Taslağı Sil</button>` : ''}
        </div>
      </div>
      <div class="session-detail" id="sessionDetail_${s.id}"></div>
    </div>`;
  });

  container.innerHTML = html;
}

async function toggleSessionDetail(sessionId) {
  const detail = document.getElementById(`sessionDetail_${sessionId}`);
  if (detail.classList.contains('expanded')) {
    detail.classList.remove('expanded');
    return;
  }

  const res = await apiFetch(`/api/stockcount/sessions/${sessionId}`);
  if (!res) return;
  const session = await res.json();

  let tableHTML = '<table style="margin-top:8px;"><thead><tr><th>Ürün</th><th>Sistem</th><th>Sayılan</th><th>Fark</th></tr></thead><tbody>';
  (session.items || []).forEach(item => {
    const diff = item.counted_quantity - item.system_quantity;
    const cls = diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-zero';
    tableHTML += `<tr><td>${escHtml(item.product_name_snapshot)}</td><td>${item.system_quantity}</td><td>${item.counted_quantity}</td><td class="${cls}">${diff > 0 ? '+' : ''}${diff}</td></tr>`;
  });
  tableHTML += '</tbody></table>';

  detail.innerHTML = tableHTML;
  detail.classList.add('expanded');
}

function exportStockCount(id) {
  apiFetch(`/api/export/stock-count/${id}`).then(res => res.blob()).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stok_sayim_${id}.xlsx`;
    a.click();
  });
}

async function deleteCountSession(id) {
  showConfirm('Taslağı Sil', 'Bu sayım taslağını silmek istediğinize emin misiniz?', 'Sil', async () => {
    const res = await apiFetch(`/api/stockcount/sessions/${id}`, { method: 'DELETE' });
    if (res?.ok) {
      showToast('Taslak silindi');
      loadCountHistory();
      loadNewCount();
    } else {
      showToast('Silme başarısız', 'error');
    }
  });
}

// ==================== REPORTS ====================
function onReportTypeChange() {
  const type = document.getElementById('reportType').value;
  document.getElementById('reportDateFields').style.display =
    (type === 'sales-daily' || type === 'sales-range') ? '' : 'none';
  document.getElementById('reportSessionField').style.display =
    type === 'stock-count' ? '' : 'none';

  if (type === 'stock-count') loadReportSessions();
}

async function loadReportOptions() {
  onReportTypeChange();
}

async function loadReportSessions() {
  const res = await apiFetch('/api/stockcount/sessions');
  if (!res) return;
  const sessions = await res.json();
  const sel = document.getElementById('reportSessionId');
  sel.innerHTML = sessions.map(s =>
    `<option value="${s.id}">${s.count_date?.split('T')[0]} - ${s.status === 'applied' ? 'Uygulandı' : 'Taslak'}</option>`
  ).join('');
}

async function downloadReport() {
  const type = document.getElementById('reportType').value;
  let url = '';

  switch (type) {
    case 'products': url = '/api/export/products'; break;
    case 'critical-stock': url = '/api/export/critical-stock'; break;
    case 'sales-daily': {
      const from = document.getElementById('reportFrom').value;
      const to = document.getElementById('reportTo').value;
      url = `/api/export/sales?from=${from}&to=${to || from}`;
      break;
    }
    case 'sales-range': {
      const from = document.getElementById('reportFrom').value;
      const to = document.getElementById('reportTo').value;
      url = `/api/export/sales?from=${from}&to=${to}`;
      break;
    }
    case 'stock-value': url = '/api/export/stock-value'; break;
    case 'stock-count': {
      const sessionId = document.getElementById('reportSessionId').value;
      if (!sessionId) { showToast('Oturum seçiniz', 'error'); return; }
      url = `/api/export/stock-count/${sessionId}`;
      break;
    }
  }

  try {
    const res = await apiFetch(url);
    if (!res.ok) { showToast('Rapor oluşturulamadı', 'error'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rapor_${new Date().toISOString().split('T')[0]}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Rapor indirildi');
  } catch (err) {
    showToast('İndirme hatası', 'error');
  }
}

// ==================== SETTINGS ====================
function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.settings-tab[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(`panel-${tab}`)?.classList.add('active');

  if (tab === 'users') loadUsers();
  if (tab === 'types') loadTypes();
  if (tab === 'materials') loadMaterialsPanel();
  if (tab === 'media') loadMediaPanel();
  if (tab === 'email') loadEmailSettings();
}

async function loadSettings() {
  if (currentUser?.role === 'admin') {
    loadUsers();
  } else {
    switchSettingsTab('types');
  }
}

// Users
async function loadUsers() {
  if (currentUser?.role !== 'admin') return;
  const res = await apiFetch('/api/users');
  if (!res) return;
  const users = await res.json();

  let html = '';
  users.forEach(u => {
    const initials = u.username.charAt(0).toUpperCase();
    const badge = u.role === 'admin'
      ? '<span class="role-badge admin">Admin</span>'
      : '<span class="role-badge standard" style="background:#f3f4f6;color:#374151;">Standart</span>';

    const contactInfo = u.email
      ? `<span title="E-posta">📧 ${escHtml(u.email)}</span>`
      : '';

    html += `<div class="user-list-item">
      <div class="user-list-left">
        <div class="user-avatar" style="background:var(--navy-100);color:var(--navy-700);">${initials}</div>
        <div>
          <div style="font-weight:600;font-size:14px;">${escHtml(u.username)}</div>
          ${badge}
          ${contactInfo ? `<div style="font-size:11px;color:#6b7280;margin-top:3px;">${contactInfo}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" onclick="editUser(${u.id}, '${escHtml(u.username)}', '${u.role}', '${escHtml(u.email || '')}')">Düzenle</button>
        ${u.id !== currentUser.id ? `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${escHtml(u.username)}')">Sil</button>` : ''}
      </div>
    </div>`;
  });
  document.getElementById('usersList').innerHTML = html;
}

function openUserModal(user = null) {
  document.getElementById('userEditId').value = user ? user.id : '';
  document.getElementById('userModalTitle').textContent = user ? 'Kullanıcıyı Düzenle' : 'Yeni Kullanıcı';
  document.getElementById('uName').value = user ? user.username : '';
  document.getElementById('uPin').value = '';
  document.getElementById('uPinConfirm').value = '';
  document.getElementById('uRole').value = user ? user.role : 'standard';
  document.getElementById('uEmail').value = user ? (user.email || '') : '';
  document.getElementById('userModal').classList.add('active');
}

function closeUserModal() { document.getElementById('userModal').classList.remove('active'); }

function editUser(id, username, role, email) {
  openUserModal({ id, username, role, email });
}

async function saveUser() {
  const editId = document.getElementById('userEditId').value;
  const username = document.getElementById('uName').value.trim();
  const pin = document.getElementById('uPin').value;
  const pinConfirm = document.getElementById('uPinConfirm').value;
  const role = document.getElementById('uRole').value;

  if (!username) { showToast('Kullanıcı adı zorunludur', 'error'); return; }
  if (!editId && !pin) { showToast('PIN zorunludur', 'error'); return; }
  if (pin && pin !== pinConfirm) { showToast('PIN kodları eşleşmiyor', 'error'); return; }
  if (pin && !/^\d{4}$/.test(pin)) { showToast('PIN 4 haneli olmalıdır', 'error'); return; }

  const email = document.getElementById('uEmail').value.trim() || null;

  const body = { username, role, email };
  if (pin) body.pin = pin;

  const url = editId ? `/api/users/${editId}` : '/api/users';
  const method = editId ? 'PUT' : 'POST';

  const res = await apiFetch(url, { method, body });
  const data = await res?.json();

  if (res?.ok) {
    showToast(editId ? 'Kullanıcı güncellendi' : 'Kullanıcı oluşturuldu');
    closeUserModal();
    loadUsers();
  } else {
    showToast(data?.error || 'Hata oluştu', 'error');
  }
}

function deleteUser(id, name) {
  showConfirm('Kullanıcıyı Sil', `"${name}" kullanıcısını silmek istediğinize emin misiniz?`, 'Sil', async () => {
    const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    if (res?.ok) { showToast('Kullanıcı silindi'); loadUsers(); }
    else { const d = await res?.json(); showToast(d?.error || 'Silme başarısız', 'error'); }
  });
}

// Product Types
async function loadTypes() {
  await loadProductTypes();
  let html = '';
  productTypes.forEach(t => {
    html += `<div class="type-list-item" id="typeItem_${t.id}">
      <span id="typeName_${t.id}">${escHtml(t.name)}</span>
      <input id="typeInput_${t.id}" type="text" class="form-control" value="${escHtml(t.name)}" style="display:none;max-width:200px;padding:4px 8px;font-size:13px;">
      <div style="display:flex;gap:6px;">
        <button id="typeEditBtn_${t.id}" class="btn btn-secondary btn-sm" onclick="startEditType(${t.id})">Düzenle</button>
        <button id="typeSaveBtn_${t.id}" class="btn btn-primary btn-sm" style="display:none;" onclick="saveEditType(${t.id})">Kaydet</button>
        <button id="typeCancelBtn_${t.id}" class="btn btn-secondary btn-sm" style="display:none;" onclick="cancelEditType(${t.id}, '${escHtml(t.name)}')">İptal</button>
        <button class="btn btn-danger btn-sm" onclick="deleteType(${t.id}, '${escHtml(t.name)}')">Sil</button>
      </div>
    </div>`;
  });
  document.getElementById('typesList').innerHTML = html || '<p style="color:#6b7280;">Tip bulunamadı</p>';
}

async function addProductType() {
  const name = document.getElementById('newTypeName').value.trim();
  if (!name) { showToast('Tip adı giriniz', 'error'); return; }

  const res = await apiFetch('/api/product-types', { method: 'POST', body: { name } });
  if (res?.ok) {
    showToast('Tip eklendi');
    document.getElementById('newTypeName').value = '';
    loadTypes();
  } else {
    const d = await res?.json();
    showToast(d?.error || 'Hata', 'error');
  }
}

function startEditType(id) {
  document.getElementById(`typeName_${id}`).style.display = 'none';
  document.getElementById(`typeInput_${id}`).style.display = '';
  document.getElementById(`typeEditBtn_${id}`).style.display = 'none';
  document.getElementById(`typeSaveBtn_${id}`).style.display = '';
  document.getElementById(`typeCancelBtn_${id}`).style.display = '';
  document.getElementById(`typeInput_${id}`).focus();
}

function cancelEditType(id, originalName) {
  document.getElementById(`typeName_${id}`).style.display = '';
  document.getElementById(`typeInput_${id}`).style.display = 'none';
  document.getElementById(`typeInput_${id}`).value = originalName;
  document.getElementById(`typeEditBtn_${id}`).style.display = '';
  document.getElementById(`typeSaveBtn_${id}`).style.display = 'none';
  document.getElementById(`typeCancelBtn_${id}`).style.display = 'none';
}

async function saveEditType(id) {
  const newName = document.getElementById(`typeInput_${id}`).value.trim();
  if (!newName) { showToast('Tip adı boş olamaz', 'error'); return; }
  const res = await apiFetch(`/api/product-types/${id}`, { method: 'PUT', body: { name: newName } });
  if (res?.ok) {
    showToast('Tip güncellendi');
    loadTypes();
    loadProductTypes();
  } else {
    const d = await res?.json();
    showToast(d?.error || 'Güncelleme başarısız', 'error');
  }
}

function deleteType(id, name) {
  showConfirm('Tipi Sil', `"${name}" tipini silmek istediğinize emin misiniz?`, 'Sil', async () => {
    const res = await apiFetch(`/api/product-types/${id}`, { method: 'DELETE' });
    if (res?.ok) { showToast('Tip silindi'); loadTypes(); }
    else showToast('Silme başarısız', 'error');
  });
}

// ==================== MATERIALS PANEL ====================
async function loadMaterialsPanel() {
  await loadMaterials();
  let html = '';
  materials.forEach(m => {
    html += `<div class="type-list-item" id="matItem_${m.id}">
      <span id="matName_${m.id}">${escHtml(m.name)}</span>
      <input id="matInput_${m.id}" type="text" class="form-control" value="${escHtml(m.name)}" style="display:none;max-width:200px;padding:4px 8px;font-size:13px;">
      <div style="display:flex;gap:6px;">
        <button id="matEditBtn_${m.id}" class="btn btn-secondary btn-sm" onclick="startEditMaterial(${m.id})">Düzenle</button>
        <button id="matSaveBtn_${m.id}" class="btn btn-primary btn-sm" style="display:none;" onclick="saveEditMaterial(${m.id})">Kaydet</button>
        <button id="matCancelBtn_${m.id}" class="btn btn-secondary btn-sm" style="display:none;" onclick="cancelEditMaterial(${m.id}, '${escHtml(m.name)}')">İptal</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMaterial(${m.id}, '${escHtml(m.name)}')">Sil</button>
      </div>
    </div>`;
  });
  document.getElementById('materialsList').innerHTML = html || '<p style="color:#6b7280;">Materyal bulunamadı</p>';
}

async function addMaterial() {
  const name = document.getElementById('newMaterialName').value.trim();
  if (!name) { showToast('Materyal adı giriniz', 'error'); return; }
  const res = await apiFetch('/api/materials', { method: 'POST', body: { name } });
  if (res?.ok) {
    showToast('Materyal eklendi');
    document.getElementById('newMaterialName').value = '';
    loadMaterialsPanel();
    loadMaterials();
  } else {
    const d = await res?.json();
    showToast(d?.error || 'Hata', 'error');
  }
}

function startEditMaterial(id) {
  document.getElementById(`matName_${id}`).style.display = 'none';
  document.getElementById(`matInput_${id}`).style.display = '';
  document.getElementById(`matEditBtn_${id}`).style.display = 'none';
  document.getElementById(`matSaveBtn_${id}`).style.display = '';
  document.getElementById(`matCancelBtn_${id}`).style.display = '';
  document.getElementById(`matInput_${id}`).focus();
}

function cancelEditMaterial(id, originalName) {
  document.getElementById(`matName_${id}`).style.display = '';
  document.getElementById(`matInput_${id}`).style.display = 'none';
  document.getElementById(`matInput_${id}`).value = originalName;
  document.getElementById(`matEditBtn_${id}`).style.display = '';
  document.getElementById(`matSaveBtn_${id}`).style.display = 'none';
  document.getElementById(`matCancelBtn_${id}`).style.display = 'none';
}

async function saveEditMaterial(id) {
  const newName = document.getElementById(`matInput_${id}`).value.trim();
  if (!newName) { showToast('Materyal adı boş olamaz', 'error'); return; }
  const res = await apiFetch(`/api/materials/${id}`, { method: 'PUT', body: { name: newName } });
  if (res?.ok) {
    showToast('Materyal güncellendi');
    loadMaterialsPanel();
    loadMaterials();
  } else {
    const d = await res?.json();
    showToast(d?.error || 'Güncelleme başarısız', 'error');
  }
}

function deleteMaterial(id, name) {
  showConfirm('Materyal Sil', `"${name}" materyalini silmek istediğinize emin misiniz?`, 'Sil', async () => {
    const res = await apiFetch(`/api/materials/${id}`, { method: 'DELETE' });
    if (res?.ok) { showToast('Materyal silindi'); loadMaterialsPanel(); loadMaterials(); }
    else showToast('Silme başarısız', 'error');
  });
}

// Media / Logo
async function loadLogoFromDB() {
  try {
    const res = await apiFetch('/api/settings/logo');
    if (res && res.ok) {
      const data = await res.json();
      if (data.logo) {
        // Topbar logo güncelle
        const topLogo = document.getElementById('topbarLogo');
        if (topLogo) topLogo.innerHTML = `<img src="${data.logo}" style="width:100%;height:100%;object-fit:contain;">`;
        // Login sayfası için localStorage'a kaydet
        localStorage.setItem('appLogo', data.logo);
        return data.logo;
      }
    }
  } catch (e) {}
  return null;
}

async function loadMediaPanel() {
  // Logo preview DB'den yükle
  const logoPreview = document.getElementById('logoPreview');
  const logoData = await loadLogoFromDB();
  if (logoData) {
    logoPreview.innerHTML = `<img src="${logoData}" style="width:100%;height:100%;object-fit:contain;">`;
  } else {
    logoPreview.innerHTML = '<span style="color:var(--navy-400);font-size:24px;">ST</span>';
  }

  // Product list with image upload
  await loadProducts();
  let html = '';
  products.forEach(p => {
    html += `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #f3f4f6;">
      <div style="width:48px;height:48px;border-radius:6px;overflow:hidden;background:#f3f4f6;">
        ${p.product_image_url ? `<img src="${p.product_image_url}" style="width:100%;height:100%;object-fit:cover;">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9ca3af;">📦</div>'}
      </div>
      <span style="flex:1;font-size:13px;font-weight:500;">${escHtml(p.name)}</span>
      <input type="file" id="mediaUpload_${p.id}" accept="image/jpeg,image/png,image/webp" style="display:none;" onchange="uploadProductImage(${p.id}, this)">
      <button class="btn btn-secondary btn-sm" onclick="document.getElementById('mediaUpload_${p.id}').click()">Görsel Yükle</button>
    </div>`;
  });
  document.getElementById('mediaProductList').innerHTML = html;
}

async function uploadLogo() {
  const input = document.getElementById('logoInput');
  if (!input.files.length) return;
  const formData = new FormData();
  formData.append('logo', input.files[0]);

  const res = await fetch('/api/settings/logo', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: formData
  });

  if (res.ok) {
    showToast('Logo güncellendi');
    loadMediaPanel();
    loadLogoFromDB();
  } else {
    showToast('Logo yüklenemedi', 'error');
  }
}

async function uploadProductImage(productId, input) {
  if (!input.files.length) return;
  const formData = new FormData();
  formData.append('image', input.files[0]);

  const res = await fetch(`/api/uploads/product/${productId}`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: formData
  });

  if (res.ok) {
    showToast('Görsel güncellendi');
    loadMediaPanel();
    loadProducts();
  } else {
    showToast('Görsel yüklenemedi', 'error');
  }
}

// Change Password
async function changePassword() {
  const currentPin = document.getElementById('currentPin').value;
  const newPin = document.getElementById('newPin').value;
  const newPinConfirm = document.getElementById('newPinConfirm').value;

  if (!currentPin || !newPin || !newPinConfirm) {
    showToast('Tüm alanları doldurunuz', 'error'); return;
  }
  if (newPin !== newPinConfirm) {
    showToast('Yeni PIN kodları eşleşmiyor', 'error'); return;
  }
  if (!/^\d{4}$/.test(newPin)) {
    showToast('PIN 4 haneli olmalıdır', 'error'); return;
  }

  // Verify current pin
  const loginRes = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser.username, pin: currentPin })
  });

  if (!loginRes.ok) {
    showToast('Mevcut PIN hatalı', 'error'); return;
  }

  const res = await apiFetch(`/api/users/${currentUser.id}`, {
    method: 'PUT',
    body: { username: currentUser.username, pin: newPin, role: currentUser.role }
  });

  if (res?.ok) {
    showToast('PIN değiştirildi');
    document.getElementById('currentPin').value = '';
    document.getElementById('newPin').value = '';
    document.getElementById('newPinConfirm').value = '';
  } else {
    showToast('PIN değiştirilemedi', 'error');
  }
}

// Backup
function downloadBackup() {
  apiFetch('/api/backup').then(res => {
    if (!res.ok) throw new Error();
    return res.blob();
  }).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yedek_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Yedek indirildi');
  }).catch(() => showToast('Yedekleme hatası', 'error'));
}

// ==================== EMAIL TEST ====================
async function testEmail() {
  const btn = document.getElementById('testEmailBtn');
  const resultDiv = document.getElementById('testEmailResult');
  btn.disabled = true;
  btn.textContent = 'Gönderiliyor...';
  resultDiv.style.display = 'none';

  try {
    const res = await apiFetch('/api/settings/test-email', { method: 'POST' });
    const data = await res.json();

    let html = '';
    if (data.ok) {
      html = `<div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:8px;padding:14px;">
        <strong style="color:#166534;">✅ ${data.message}</strong>
        ${data.results ? '<ul style="margin:8px 0 0;padding-left:20px;font-size:13px;">' +
          data.results.map(r => `<li style="color:${r.status==='ok'?'#166534':'#991b1b'};">${r.email} — ${r.status==='ok'?'Gönderildi':'HATA: '+r.detail}</li>`).join('') +
          '</ul>' : ''}
      </div>`;
    } else if (data.step === 'send' && data.results) {
      // Gönderim adımında sonuçları göster
      html = `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:14px;">
        <strong style="color:#92400e;">⚠️ ${data.message || 'Bazı emailler gönderilemedi'}</strong>
        <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;">
          ${data.results.map(r => `<li style="color:${r.status==='ok'?'#166534':'#991b1b'};">${r.email} — ${r.status==='ok'?'✓ Gönderildi':'✗ '+r.detail}</li>`).join('')}
        </ul>
      </div>`;
    } else {
      const adim = { config: '1. Ayar Kontrolü', recipients: '2. Alıcı Kontrolü', error: 'Hata', timeout: 'Zaman Aşımı' };
      html = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;">
        <strong style="color:#991b1b;">❌ ${adim[data.step] || data.step || 'Hata'}</strong>
        <p style="margin:6px 0 0;font-size:13px;color:#7f1d1d;">${data.error || data.message || 'Bilinmeyen hata'}</p>
        ${data.detail ? `<p style="margin:4px 0 0;font-size:12px;color:#9ca3af;word-break:break-all;">${typeof data.detail === 'object' ? JSON.stringify(data.detail) : data.detail}</p>` : ''}
        ${data.tip ? `<p style="margin:8px 0 0;font-size:12px;color:#92400e;background:#fef3c7;padding:8px;border-radius:6px;">💡 ${data.tip}</p>` : ''}
      </div>`;
    }

    resultDiv.innerHTML = html;
    resultDiv.style.display = 'block';
  } catch (err) {
    resultDiv.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;color:#991b1b;">❌ İstek başarısız: ${err.message}</div>`;
    resultDiv.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Test Emaili Gönder';
}

// ── Günlük rapor ayarları ─────────────────────────────────────────────────
async function loadEmailSettings() {
  const res = await apiFetch('/api/settings/daily-report-time');
  if (!res) return;
  const data = await res.json();
  const input = document.getElementById('dailyReportTime');
  const status = document.getElementById('dailyReportStatus');
  if (input) input.value = data.time || '';
  if (status) status.textContent = data.time
    ? `✓ Otomatik rapor her gün saat ${data.time}'de gönderilir (İstanbul saati)`
    : 'Otomatik gönderim kapalı';
}

async function saveDailyReportTime() {
  const time = document.getElementById('dailyReportTime').value;
  if (!time) { showToast('Lütfen bir saat seçin', 'error'); return; }
  const res = await apiFetch('/api/settings/daily-report-time', { method: 'POST', body: { time } });
  if (res?.ok) {
    showToast(`Günlük rapor saati ${time} olarak kaydedildi`);
    loadEmailSettings();
  }
}

async function clearDailyReportTime() {
  const res = await apiFetch('/api/settings/daily-report-time', { method: 'POST', body: { time: '' } });
  if (res?.ok) {
    document.getElementById('dailyReportTime').value = '';
    document.getElementById('dailyReportStatus').textContent = 'Otomatik gönderim kapalı';
    showToast('Günlük rapor otomatik gönderimi kapatıldı');
  }
}

async function sendDailyReportNow() {
  const btn = document.getElementById('sendDailyReportBtn');
  const resultDiv = document.getElementById('dailyReportResult');
  btn.disabled = true;
  btn.textContent = 'Gönderiliyor...';

  const res = await apiFetch('/api/settings/send-daily-report', { method: 'POST' });
  const data = await res?.json();

  if (data?.ok) {
    resultDiv.innerHTML = `<div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:8px;padding:12px;font-size:13px;color:#166534;">✅ ${data.message}</div>`;
  } else {
    resultDiv.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;color:#991b1b;">❌ ${data?.error || 'Hata oluştu'}</div>`;
  }
  resultDiv.style.display = 'block';
  btn.disabled = false;
  btn.textContent = 'Şimdi Gönder';
}

// ==================== SALES REPORT ====================
function initSalesReport() {
  // Varsayılan tarihler: bu ayın 1'i ile bugün
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById('srFrom').value = firstDay.toISOString().split('T')[0];
  document.getElementById('srTo').value = today.toISOString().split('T')[0];
}

async function loadSalesReport() {
  const from = document.getElementById('srFrom').value;
  const to = document.getElementById('srTo').value;

  if (!from || !to) {
    showToast('Başlangıç ve bitiş tarihi seçiniz', 'error');
    return;
  }

  try {
    const res = await apiFetch(`/api/sales/report?from=${from}&to=${to}`);
    if (!res || !res.ok) {
      showToast('Rapor alınamadı', 'error');
      return;
    }

    const data = await res.json();
    renderSalesReport(data);
  } catch (err) {
    showToast('Rapor yüklenirken hata oluştu', 'error');
  }
}

function renderSalesReport(data) {
  const { details, summary } = data;

  // Özet kartları
  const totalSold = summary.reduce((s, r) => s + parseInt(r.total_sold || 0), 0);
  const totalCost = summary.reduce((s, r) => s + parseFloat(r.total_cost || 0), 0);
  const uniqueProducts = summary.length;

  document.getElementById('srSummary').style.display = '';
  document.getElementById('srTotalQty').textContent = formatNumber(totalSold);
  document.getElementById('srTotalCost').textContent = formatCurrency(totalCost);
  document.getElementById('srUniqueProducts').textContent = uniqueProducts;

  // Ürün bazlı özet tablo
  let html = '<h4 style="font-size:14px;color:var(--navy-700);margin:16px 0 8px;">Ürün Bazlı Satış Özeti</h4>';
  html += '<div class="table-container"><table><thead><tr>';
  html += '<th>Ürün Adı</th><th>Renk</th><th>Barkod</th><th>Alış Maliyeti</th><th>Satılan Adet</th><th>Toplam Maliyet</th>';
  html += '</tr></thead><tbody>';

  if (summary.length === 0) {
    html += '<tr><td colspan="6" style="text-align:center;padding:30px;color:#6b7280;">Bu tarih aralığında satış kaydı bulunamadı</td></tr>';
  } else {
    summary.forEach(row => {
      html += `<tr>
        <td><strong>${escHtml(row.product_name)}</strong></td>
        <td>${row.color ? `<span class="type-badge" style="background:#f3f4f6;color:#374151;">${escHtml(row.color)}</span>` : '-'}</td>
        <td>${escHtml(row.barcode)}</td>
        <td>${formatCurrency(row.cost_price)}</td>
        <td><strong style="color:var(--red);">${row.total_sold}</strong></td>
        <td>${formatCurrency(row.total_cost)}</td>
      </tr>`;
    });

    // Toplam satırı
    html += `<tr style="background:#f9fafb;font-weight:700;">
      <td colspan="4" style="text-align:right;">TOPLAM</td>
      <td style="color:var(--red);">${totalSold}</td>
      <td>${formatCurrency(totalCost)}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';

  // Detaylı satış kayıtları
  if (details.length > 0) {
    html += '<h4 style="font-size:14px;color:var(--navy-700);margin:24px 0 8px;">Detaylı Satış Kayıtları</h4>';
    html += '<div class="table-container"><table><thead><tr>';
    html += '<th>Satış Tarihi</th><th>Ürün Adı</th><th>Renk</th><th>Barkod</th><th>Alış Maliyeti</th><th>Miktar</th>';
    html += '</tr></thead><tbody>';

    details.forEach(row => {
      const isOut = row.quantity_change < 0;
      const dateStr = row.sale_date ? new Date(row.sale_date).toLocaleDateString('tr-TR') : '-';

      html += `<tr>
        <td>${dateStr}</td>
        <td>${escHtml(row.product_name)}</td>
        <td>${row.color ? `<span class="type-badge" style="background:#f3f4f6;color:#374151;">${escHtml(row.color)}</span>` : '-'}</td>
        <td>${escHtml(row.barcode)}</td>
        <td>${formatCurrency(row.cost_price)}</td>
        <td><strong style="color:${isOut ? 'var(--red)' : 'var(--green)'};">${isOut ? '' : '+'}${row.quantity_change}</strong></td>
      </tr>`;
    });

    html += '</tbody></table></div>';
  }

  document.getElementById('srResults').innerHTML = html;
}

function exportSalesReport() {
  const from = document.getElementById('srFrom').value;
  const to   = document.getElementById('srTo').value;

  if (!from || !to) {
    showToast('Tarih aralığı seçiniz', 'error');
    return;
  }

  apiFetch(`/api/export/sales-report?from=${from}&to=${to}`)
    .then(res => {
      if (!res.ok) throw new Error();
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `satis_raporu_${from}_${to}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Rapor indirildi');
    })
    .catch(() => showToast('İndirme hatası', 'error'));
}

// ==================== UTILS ====================
function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Lightbox ──────────────────────────────────────────────────────────────
function openLightbox(src) {
  const lb  = document.getElementById('imageLightbox');
  const img = document.getElementById('lightboxImg');
  img.src = src;
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('imageLightbox').style.display = 'none';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

document.getElementById('salesDate').addEventListener('change', loadSalesView);