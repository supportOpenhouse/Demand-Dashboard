// ── State ──────────────────────────────────────────────────────────────
const state = {
  user: null,
  rows: [],
  total: 0,
  openUid: null,
  sortKey: null,
  sortDir: 'desc',
  // Distinct filter values from the full supply-ready pool. Populated by /api/list
  // so the dropdowns stay stable regardless of currently-selected filters.
  distinct: { cities: [], sources: [], pocs: [] },
  filters: {
    search: '',
    city: '',
    source: '',
    poc: '',
    dateField: 'ama_date',
    from: '',
    to: '',
  },
  // homeId (number) → string[] of image URLs, fetched from backend photos API.
  homePhotos: {},
};

// ── Helpers ────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toLakhs(num) {
  if (num == null || num === '') return '';
  const n = Number(num);
  if (isNaN(n)) return '';
  // Backend stores money as plain numbers in lakhs (matching supply tracker convention).
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 1 })} L`;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateInput(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function parseJsonish(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

function dash(v) {
  return (v == null || v === '') ? '<span class="field-val muted">—</span>' : esc(v);
}

function showToast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 2500);
}

function canEdit() { return state.user && (state.user.role === 'admin' || state.user.role === 'manager'); }
function isAdmin() { return state.user && state.user.role === 'admin'; }
function isViewer() { return state.user && state.user.role === 'viewer'; }

// Display-only label mapping for the `source` field. Underlying DB values
// ("Direct", "CP", etc.) stay intact — only the visible label is shortened.
const SOURCE_LABELS = { 'Direct': 'D', 'CP': 'C' };
function fmtSource(v) {
  if (v == null || v === '') return '';
  return SOURCE_LABELS[v] || v;
}

// Demand-side availability. Drives the colored pill in the main row's
// "Status" column AND the dropdown in the expand panel's Property header.
const AVAILABILITY_OPTIONS = ['Available', 'Booked', 'Sold'];
const AVAILABILITY_CLASS = {
  'Available': 'avail-green',
  'Booked':    'avail-amber',
  'Sold':      'avail-red',
};
function renderAvailabilityPill(value) {
  const v = value || 'Available';
  const cls = AVAILABILITY_CLASS[v] || 'avail-green';
  return `<span class="avail-pill ${cls}">${esc(v)}</span>`;
}

// Inline status selector for the Property section header. Posts to
// /api/demand-details via the delegated change handler.
function renderAvailabilityHeaderControl(r) {
  const current = r.availability_status || 'Available';
  const cls = AVAILABILITY_CLASS[current] || 'avail-green';
  const opts = AVAILABILITY_OPTIONS.map(o =>
    `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o)}</option>`
  ).join('');
  return `
    <span class="avail-header-control">
      <select class="inline-select avail-select ${cls}"
              data-uid="${esc(r.uid)}" data-field="availability_status">
        ${opts}
      </select>
    </span>`;
}

// Submit Details button — rendered on its own row below the section header
// (instead of next to the dropdown) so it doesn't crowd the header or push the
// property fields. Present in the DOM for editors; visibility toggled by
// availability_status === 'Booked'.
function renderSubmitDetailsRow(r) {
  const isBooked = (r.availability_status || 'Available') === 'Booked';
  const hidden = isBooked ? '' : 'style="display:none"';
  return `
    <div class="submit-details-row" data-submit-row-for="${esc(r.uid)}" ${hidden}>
      <button type="button" class="btn-submit-details"
              data-submit-booking-uid="${esc(r.uid)}"
              title="Capture booking details and email">📨 Submit Details</button>
    </div>`;
}

// ── Canonical option lists ──────────────────────────────────────────────
// Mirror of backend-form's routes/config.js. Used by editable dropdowns to
// keep `properties` field values aligned with what the supply-side forms
// produce — preventing demand-side edits from polluting the canonical set.
// If backend-form adds new entries later, update these arrays here.
const CANONICAL_SOURCES = ['CP', 'Direct'];
const CANONICAL_POCS = [
  'Abhishek Rathore', 'Aman Dixit', 'Animesh Singh', 'Arti Ahirwar',
  'Deepak Mishra', 'Deepak Rana', 'Kavita Rawat', 'Nisha Deewan',
  'Rahul Sheel', 'Rupali Prasad', 'Sahil Singh', 'Shashank Kumar',
  'Sushmita Roy', 'Test Sahaj',
];
const CANONICAL_BANKS = [
  'Au Small Finance Bank Ltd.', 'Axis Bank Ltd.', 'Bandhan Bank Ltd.',
  'Bank of Baroda', 'Bank of India', 'Bank of Maharashtra', 'Canara Bank',
  'Central Bank of India', 'City Union Bank Ltd.', 'CSB Bank Limited',
  'DCB Bank Ltd.', 'Dhanlaxmi Bank Ltd.', 'Federal Bank Ltd.',
  'Godrej Housing Finance', 'HDFC Bank Ltd', 'HSBC India', 'ICICI Bank Ltd.',
  'IDBI Bank Limited', 'IDFC FIRST Bank Limited', 'Indian Bank',
  'Indian Overseas Bank', 'IndusInd Bank Ltd', 'Jammu & Kashmir Bank Ltd.',
  'Karnataka Bank Ltd.', 'Karur Vysya Bank Ltd.', 'Kotak Mahindra Bank Ltd',
  'Nainital bank Ltd.', 'Punjab & Sind Bank', 'Punjab National Bank',
  'RBL Bank Ltd.', 'South Indian Bank Ltd.', 'Standard Charted India',
  'State Bank of India', 'Tamilnad Mercantile Bank Ltd.', 'UCO Bank',
  'Union Bank of India', 'YES Bank Ltd.',
];

// ── Bootstrap ──────────────────────────────────────────────────────────
(async function init() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) { window.location.href = '/login'; return; }
    const data = await r.json();
    if (!data.success) { window.location.href = '/login'; return; }
    state.user = data.user;
    renderUserMenu();
    bindUI();
    await Promise.all([loadData(), fetchHomePhotos()]);
  } catch (e) {
    console.error('init failed', e);
    window.location.href = '/login';
  }
})();

function renderUserMenu() {
  const u = state.user;
  $('#userName').textContent = u.name || u.email;
  $('#userEmail').textContent = u.email;
  const badge = $('#userRoleBadge');
  badge.textContent = u.role;
  badge.className = 'user-role-badge ' + u.role;
  // Drives role-based CSS rules (e.g. hiding sensitive columns from viewers).
  document.body.classList.remove('role-admin', 'role-manager', 'role-viewer');
  document.body.classList.add('role-' + u.role);
  if (u.picture) {
    $('#userAvatar').src = u.picture;
  } else {
    const initial = (u.name || u.email || '?')[0].toUpperCase();
    $('#userAvatar').src = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><circle cx='16' cy='16' r='16' fill='%234f46e5'/><text x='16' y='21' text-anchor='middle' fill='white' font-family='Inter' font-size='14' font-weight='600'>${initial}</text></svg>`;
  }
  if (isAdmin()) $('#manageUsersBtn').style.display = 'inline-flex';
}

// ── UI bindings ────────────────────────────────────────────────────────
function bindUI() {
  $('#userAvatar').addEventListener('click', () => $('#userDropdown').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) $('#userDropdown').classList.remove('open');
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/login';
  });

  let searchTimer;
  $('#searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.search = e.target.value; loadData(); }, 300);
  });

  $('#filterCity').addEventListener('change', (e) => { state.filters.city = e.target.value; loadData(); });
  $('#filterSource').addEventListener('change', (e) => { state.filters.source = e.target.value; loadData(); });
  $('#filterPoc').addEventListener('change', (e) => { state.filters.poc = e.target.value; loadData(); });
  $('#filterDateField').addEventListener('change', (e) => { state.filters.dateField = e.target.value; loadData(); });
  $('#filterFrom').addEventListener('change', (e) => { state.filters.from = e.target.value; loadData(); });
  $('#filterTo').addEventListener('change', (e) => { state.filters.to = e.target.value; loadData(); });

  $('#clearDateBtn').addEventListener('click', () => {
    $('#filterFrom').value = ''; $('#filterTo').value = '';
    state.filters.from = ''; state.filters.to = '';
    loadData();
  });

  $('#clearAllBtn').addEventListener('click', () => {
    state.filters = { search: '', city: '', source: '', poc: '',
                      dateField: 'ama_date', from: '', to: '' };
    $('#searchInput').value = '';
    $('#filterCity').value = '';
    $('#filterSource').value = '';
    $('#filterPoc').value = '';
    $('#filterDateField').value = 'ama_date';
    $('#filterFrom').value = '';
    $('#filterTo').value = '';
    loadData();
  });

  $('#refreshBtn').addEventListener('click', () => {
    $('#refreshBtn').classList.add('spinning');
    loadData().finally(() => setTimeout(() => $('#refreshBtn').classList.remove('spinning'), 600));
  });

  $('#csvBtn').addEventListener('click', exportCsv);

  $('#manageUsersBtn').addEventListener('click', openUsersModal);

  // Sort handlers
  $$('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = k; state.sortDir = 'asc'; }
      renderTable();
    });
  });

  // Modals
  $$('[data-close]').forEach(b => b.addEventListener('click', () => {
    $('#' + b.dataset.close).classList.remove('open');
  }));
  $$('.modal-overlay').forEach(o => o.addEventListener('click', (e) => {
    if (e.target === o) o.classList.remove('open');
  }));
  $('#addUserBtn').addEventListener('click', addUser);

  // Sticky-top height variable so sticky thead aligns under it.
  // ResizeObserver re-fires whenever the filter bar wraps onto more lines.
  const top = $('.sticky-top');
  const updateH = () => document.documentElement.style.setProperty('--sticky-top-h', top.offsetHeight + 'px');
  updateH();
  new ResizeObserver(updateH).observe(top);

  // Bank autocomplete datalist — referenced by every Bank input via list="bank-list".
  // Injected once here rather than in renderExpand so it isn't rebuilt on each row open.
  if (!document.getElementById('bank-list')) {
    const dl = document.createElement('datalist');
    dl.id = 'bank-list';
    dl.innerHTML = CANONICAL_BANKS.map(b => `<option value="${esc(b)}">`).join('');
    document.body.appendChild(dl);
  }
}

// ── Data load ──────────────────────────────────────────────────────────
async function fetchHomePhotos() {
  try {
    const r = await fetch('/api/home-photos', { credentials: 'include' });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.success || !Array.isArray(data.homePhoto)) return;
    const map = {};
    for (const entry of data.homePhoto) {
      if (entry.homeId != null && Array.isArray(entry.images) && entry.images.length) {
        map[entry.homeId] = entry.images;
      }
    }
    state.homePhotos = map;
  } catch (e) {
    console.warn('[home-photos] fetch failed:', e);
  }
}

async function loadData() {
  $('#loadingBox').style.display = 'flex';
  $('#emptyBox').style.display = 'none';
  $('#propBody').innerHTML = '';

  const f = state.filters;
  const q = new URLSearchParams();
  if (f.search) q.set('search', f.search);
  if (f.city) q.set('city', f.city);
  if (f.source) q.set('source', f.source);
  if (f.poc) q.set('poc', f.poc);
  if (f.dateField) q.set('dateField', f.dateField);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  q.set('limit', '500');

  try {
    const r = await fetch('/api/list?' + q.toString(), { credentials: 'include' });
    if (r.status === 401) { window.location.href = '/login'; return; }
    const data = await r.json();
    if (!data.success) { showToast(data.error || 'Failed to load', 'error'); return; }

    state.rows = data.data;
    state.total = data.total;
    if (data.distinct) state.distinct = data.distinct;
    populateFilterDropdowns();
    renderTable();
    $('#headerSub').textContent =
      (state.filters.city || 'All Cities') + ' · ' + state.total + ' Properties';
  } catch (e) {
    console.error(e);
    showToast('Network error', 'error');
  } finally {
    $('#loadingBox').style.display = 'none';
  }
}

function populateFilterDropdowns() {
  // Pull from state.distinct (full supply-ready pool) — picking one filter
  // never strips options from the others.
  fillSelect('#filterCity', state.distinct.cities || [], state.filters.city, 'All Cities');
  // Sources show short labels (D, C) but the underlying option value stays
  // raw ("Direct", "CP") so the server-side filter still matches the column.
  fillSelect('#filterSource', state.distinct.sources || [], state.filters.source, 'All Sources', fmtSource);
  fillSelect('#filterPoc', state.distinct.pocs || [], state.filters.poc, 'All POCs');
}

function fillSelect(sel, values, current, allLabel, labelFn) {
  const el = $(sel);
  el.innerHTML = `<option value="">${allLabel}</option>` +
    values.map(v => {
      const label = labelFn ? labelFn(v) : v;
      return `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
}

// ── Table render ───────────────────────────────────────────────────────
function renderTable() {
  const body = $('#propBody');
  let rows = [...state.rows];

  if (state.sortKey) {
    rows.sort((a, b) => {
      const av = a[state.sortKey], bv = b[state.sortKey];
      const an = av == null ? '' : av, bn = bv == null ? '' : bv;
      if (an < bn) return state.sortDir === 'asc' ? -1 : 1;
      if (an > bn) return state.sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }

  $$('thead th').forEach(th => {
    th.classList.remove('sorted');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add('sorted');
      th.dataset.arrow = state.sortDir === 'asc' ? '▲' : '▼';
    }
  });

  if (!rows.length) {
    $('#emptyBox').style.display = 'block';
    $('#countBadge').textContent = '0 results';
    return;
  }
  $('#emptyBox').style.display = 'none';
  $('#countBadge').textContent = `${rows.length} of ${state.total} properties`;

  body.innerHTML = rows.map(r => renderRow(r)).join('');

  body.querySelectorAll('tr.data-row').forEach(tr => {
    tr.addEventListener('click', (e) => {
      // Clicks on inputs/selects shouldn't toggle the row.
      if (e.target.closest('input, select, textarea, button, a')) return;
      toggleRow(tr.dataset.uid);
    });
  });

  // Re-attach handlers for inputs in any expanded sections.
  rows.forEach(r => { if (r.uid === state.openUid) attachExpandHandlers(r.uid); });
}

function renderRow(r) {
  const isOpen = r.uid === state.openUid;
  // Legacy rows (imported from CSV into legacy_properties) get an amber badge
  // so they're visually distinct from real supply-pipeline properties.
  const supplyBadge = r.origin === 'legacy'
    ? '<span class="supply-badge legacy" title="Imported from legacy CSV">Legacy</span>'
    : '';

  const listingPriceCell = r.listing_price != null
    ? `<span class="price-val">${esc(toLakhs(r.listing_price))}</span>`
    : '<span class="price-empty">— Not set —</span>';

  // Inline-editable remarks for editor + admin; static text for viewer.
  // Admin gets a 📜 button that opens the full edit history modal.
  const remarksValue = r.internal_remarks || '';
  let remarksCell;
  if (canEdit()) {
    remarksCell = `
      <textarea class="inline-textarea inline-remarks"
                data-uid="${esc(r.uid)}" data-field="internal_remarks"
                placeholder="Add remarks…"
                rows="2">${esc(remarksValue)}</textarea>
      <span class="save-dot" data-dot="internal_remarks-${esc(r.uid)}"></span>`;
  } else {
    remarksCell = remarksValue
      ? `<div class="remarks-readonly">${esc(remarksValue)}</div>`
      : '<span class="field-val muted">—</span>';
  }
  if (isAdmin()) {
    remarksCell += `
      <button class="remarks-history-btn" data-history-uid="${esc(r.uid)}"
              title="View remarks history">📜</button>`;
  }

  const dataRow = `
    <tr class="data-row ${isOpen ? 'open' : ''}" data-uid="${esc(r.uid)}">
      <td><span class="toggle-arrow">▶</span></td>
      <td>
        <div class="prop-cell">
          <div class="prop-name">${esc(r.society_name || '—')} ${supplyBadge}</div>
          <div class="prop-unit">${esc(r.tower_no || '')} ${esc(r.unit_no ? '· Unit ' + r.unit_no : '')} ${r.floor != null ? '· Floor ' + esc(r.floor) : ''}</div>
        </div>
      </td>
      <td>${esc(r.city || '—')}<div class="prop-unit">${esc(r.locality || '')}</div></td>
      <td>${esc(r.configuration || '—')}</td>
      <td>${r.area_sqft ? esc(r.area_sqft) : (r.super_area ? esc(r.super_area) : '—')}</td>
      <td>${listingPriceCell}</td>
      <td class="col-ama-date">${esc(fmtDate(r.ama_date)) || '—'}</td>
      <td class="col-key-handover">${esc(fmtDate(r.key_handover_date)) || '—'}</td>
      <td>${esc(r.owner_name || '—')}<div class="prop-unit col-contact">${esc(r.contact_no || '')}</div></td>
      <td class="col-status">
        ${renderAvailabilityPill(r.availability_status)}
        ${(r.possession_status || r.occupancy_status)
          ? `<div class="prop-unit">${esc(r.possession_status || r.occupancy_status)}</div>`
          : ''}
      </td>
      <td class="td-remarks">${remarksCell}</td>
    </tr>`;

  const expandRow = `
    <tr class="expand-row ${isOpen ? 'open' : ''}" data-uid-expand="${esc(r.uid)}">
      <td colspan="11">${isOpen ? renderExpand(r) : ''}</td>
    </tr>`;

  return dataRow + expandRow;
}

function toggleRow(uid) {
  state.openUid = state.openUid === uid ? null : uid;
  renderTable();
}

// ── Expand panel ───────────────────────────────────────────────────────
function renderExpand(r) {
  const cantEditPrice = !isAdmin();

  // Listing price input — admin-only; editor/viewer see read-only.
  const listingPriceField = `
    <div class="field-row">
      <div class="field-lbl">Listing Price (Lakhs) ${isAdmin() ? '' : '<span class="admin-only-note">— admin only</span>'}</div>
      <input type="number" step="0.01" class="inline-input"
             data-uid="${esc(r.uid)}" data-field="listing_price"
             value="${r.listing_price != null ? esc(r.listing_price) : ''}"
             placeholder="${cantEditPrice ? '—' : 'e.g. 115'}"
             ${cantEditPrice ? 'disabled' : ''}>
      <span class="save-dot" data-dot="listing_price-${esc(r.uid)}"></span>
    </div>`;

  // legacy_raw_values: { "<col>": "<original raw text>" } — populated by the
  // legacy importer when a value had to be transformed. Used here to surface
  // the original via tooltip so admins know the displayed value isn't pristine.
  const legacy = r.legacy_raw_values || {};
  const carpetTooltip = legacy.carpet_area ? `Original CSV value: ${legacy.carpet_area}` : '';

  // Availability status dropdown — placed in the Property section header (top-right
  // of the section) for admin/manager. When status === 'Booked', a Submit Details
  // button is rendered on its own row directly below the header (not next to the
  // dropdown — keeps the header tidy and avoids crowding the property fields).
  // Viewers see neither (the main-row pill is their read-only view of the value).
  const availHeaderControl = canEdit()
    ? renderAvailabilityHeaderControl(r)
    : '';
  const submitDetailsRow = canEdit() ? renderSubmitDetailsRow(r) : '';

  // ── Section: Property
  const sectionProperty = `
    <div class="expand-section">
      <h4>
        <span>🏠 Property</span>
        ${availHeaderControl}
      </h4>
      ${submitDetailsRow}
      ${field('Society', r.society_name)}
      ${field('Unit No', r.unit_no)}
      ${field('Tower', r.tower_no)}
      ${field('Floor', r.floor)}
      ${field('Configuration', r.configuration)}
      ${field('No. of Bedrooms', extractBedrooms(r.configuration))}
      ${field('No. of Baths', r.bathrooms)}
      ${field('No. of Balconies', r.balconies)}
      ${field('Extra Area', formatExtraArea(r.extra_area))}
      ${field('Super Area (sqft)', r.super_area || r.area_sqft)}
      ${field('Carpet Area (sqft)', r.carpet_area, carpetTooltip ? 'tooltipped' : '', carpetTooltip)}
      ${field('Locality', r.locality)}
      ${field('City', r.city)}
      ${field('Origin', r.origin === 'legacy' ? 'Legacy import (CSV)' : 'Supply pipeline', r.origin === 'legacy' ? 'amber' : '')}
      ${editableSelect('Source', 'source', r.source, { uid: r.uid, options: CANONICAL_SOURCES, labelFn: fmtSource })}
      ${editableSelect('POC', 'assigned_by', r.poc, { uid: r.uid, options: CANONICAL_POCS })}
    </div>`;

  // ── Section: Society & Charges
  // 9 numeric fields are inline-editable for admin/manager (writes go to the
  // shared `properties` table; every change is audit-logged in activity_logs).
  const sectionSociety = `
    <div class="expand-section">
      <h4>📐 Society & Charges</h4>
      ${editableNum('Society Age (years)',     'society_age_years',     r.society_age_years,     { uid: r.uid })}
      ${editableNum('Total Units in Society',  'total_units',           r.total_units,           { uid: r.uid, isInt: true })}
      ${editableNum('Total Floors in Tower',   'total_floors_tower',    r.total_floors_tower,    { uid: r.uid, isInt: true })}
      ${editableNum('Total Flats on Floor',    'total_flats_floor',     r.total_flats_floor,     { uid: r.uid, isInt: true })}
      ${field('Exit Facing', r.exit_facing)}
      ${field('Balcony Facing', formatBalconyFacing(r.balcony_details), 'multiline')}
      ${editableNum('Maintenance (per sqft)',  'maintenance_charges',     r.maintenance_charges,     { uid: r.uid })}
      ${editableNum('Society Move-in Charges', 'society_move_in_charges', r.society_move_in_charges, { uid: r.uid })}
      ${editableNum('Electricity / unit',      'electricity_charges',     r.electricity_charges,     { uid: r.uid })}
      ${editableNum('DG Charges / unit',       'dg_charges',              r.dg_charges,              { uid: r.uid })}
      ${editableNum('Circle Rate',             'circle_rate',             r.circle_rate,             { uid: r.uid })}
      ${field('Gas Pipeline', r.gas_pipeline)}
      ${field('Club Facility', r.club_facility)}
      ${field('Society Occupancy', r.current_occupancy_pct != null ? r.current_occupancy_pct + '%' : '')}
    </div>`;

  // ── Section: Possession & Listing
  const sectionPossession = `
    <div class="expand-section">
      <h4>🔑 Possession & Listing</h4>
      ${listingPriceField}
      ${isViewer() ? '' : field('Date of AMA', fmtDate(r.ama_date))}
      ${field('Key Handover Status', r.key_handover_date ? 'Done' : 'Pending', r.key_handover_date ? 'green' : 'amber')}
      ${isViewer()
        ? ''
        : editableDate('Key Handover Date', 'key_handover_date', r.key_handover_date, { uid: r.uid })}
      <span data-occupancy-for="${esc(r.uid)}">${field('Current Occupancy', r.possession_status || r.occupancy_status)}</span>
      ${field('Furnishing Status', r.furnishing)}
      ${field('Furnishing Items', formatList(r.furnishing_details))}
      ${field('Parking', r.parking)}
      ${field('Parking No.', r.parking_number)}
      ${field('Property Tax Status', r.property_tax_status)}
      ${(() => {
        // Legacy rows store the Flexible/Non-Flexible flag in alpha_beta; real
        // properties use ama_payment_structure. The Min %/Max % pair is the
        // same on both sides (ama_beta_min_pct / ama_beta_max_pct columns now
        // exist on legacy_properties too — added via INIT_SQL ALTERs).
        const structureField = r.origin === 'legacy' ? 'alpha_beta' : 'ama_payment_structure';
        const structureValue = r.origin === 'legacy' ? r.alpha_beta : r.ama_payment_structure;
        return `
          ${editableSelect('Payment Structure', structureField, structureValue, {
            uid: r.uid,
            options: ['Flexible', 'Non-Flexible'],
          })}
          <div class="payment-flexible-only" data-payment-flexible-for="${esc(r.uid)}"
               ${structureValue === 'Non-Flexible' ? 'style="display:none"' : ''}>
            ${editableNum('Min %', 'ama_beta_min_pct', r.ama_beta_min_pct, { uid: r.uid })}
            ${editableNum('Max %', 'ama_beta_max_pct', r.ama_beta_max_pct, { uid: r.uid })}
          </div>
        `;
      })()}
    </div>`;

  // ── Section: Owner & Loan
  const sectionOwner = `
    <div class="expand-section">
      <h4>👤 Owner & Loan</h4>
      ${field('Owner Name', r.owner_name)}
      ${isViewer() ? '' : field('Contact No', r.contact_no)}
      ${field('Co-Owner', r.co_owner)}
      ${isViewer() ? '' : field('Co-Owner No', r.co_owner_number)}
      ${field('Owner Physical Location', r.seller_location)}
      ${field('Seller Residential Status', r.seller_residential_status)}
      ${editableText('Loan Status', 'loan_status', r.loan_status, { uid: r.uid, placeholder: 'No Loan / NA / 60 HDFC / etc.' })}
      ${editableNum('Outstanding Loan', 'outstanding_loan', r.outstanding_loan, { uid: r.uid })}
      ${editableText('Bank', 'bank_name_loan', r.bank_name_loan, { uid: r.uid, datalistId: 'bank-list', placeholder: 'Type to search…' })}
      ${field('Documents Available', formatList(r.documents_available))}
    </div>`;

  // Internal Remarks here are the SUPPLY-side remarks (ap_details.internal_remarks),
  // mirroring what the Acquired Property Status dashboard displays. Surfaced for
  // Admin + Manager only — viewers don't see them.
  const supplyRemarksField = canEdit() && r.supply_internal_remarks
    ? `<div class="field-row" style="margin-top:14px;">
         <div class="field-lbl">Internal Remarks (from Acquired Property Status)</div>
         <div class="supply-remarks-box">${esc(r.supply_internal_remarks)}</div>
       </div>`
    : '';

  // ── Section: Media (Property Images card + Balcony Views card + video).
  // Spans 2 grid columns to fill the space freed up by the removed Demand
  // Pipeline section.
  const propImgs = collectPropertyImages(r);
  const hasApiImages = r.core_home_id != null && state.homePhotos[r.core_home_id]?.length > 0;
  const balconyViews = hasApiImages ? [] : collectBalconyViews(r);
  const noMediaMsg = (!propImgs.length && !balconyViews.length)
    ? '<div class="gallery-empty">No images uploaded</div>'
    : '';

  const sectionMedia = `
    <div class="expand-section expand-section--wide">
      <h4>📸 Media</h4>
      ${renderPropertyImagesCard(propImgs)}
      ${renderBalconyViewsCard(balconyViews)}
      ${noMediaMsg}
      <div class="field-row" style="margin-top:14px;">
        <div class="field-lbl">Video Link</div>
        ${r.video_link
          ? `<a class="video-link-pill" href="${esc(r.video_link)}" target="_blank" rel="noopener">▶ Watch Video</a>`
          : '<span class="field-val muted">—</span>'}
      </div>
      ${supplyRemarksField}
    </div>`;

  return `
    <div class="expand-inner">
      ${sectionProperty}
      ${sectionSociety}
      ${sectionPossession}
      ${sectionOwner}
      ${sectionMedia}
    </div>`;
}

// All editable* helpers below render an inline input for admin/manager and
// fall back to `field()` (read-only text) for viewers. They post to
// /api/property-edits/:uid via the delegated change handler — every save is
// audit-logged server-side.

function editableNum(label, fieldName, value, opts) {
  const { uid, isInt, tooltip } = opts;
  if (!canEdit()) return field(label, value, tooltip ? 'tooltipped' : '', tooltip);
  return `
    <div class="field-row">
      <div class="field-lbl">${esc(label)}${tooltip ? ` <span class="info-tip" title="${esc(tooltip)}">ⓘ</span>` : ''}</div>
      <input type="number" class="inline-input"
             data-uid="${esc(uid)}" data-field="${esc(fieldName)}" data-endpoint="property-edits"
             ${isInt ? 'step="1"' : 'step="0.01"'} min="0"
             value="${value != null ? esc(value) : ''}"
             placeholder="—">
      <span class="save-dot" data-dot="${esc(fieldName)}-${esc(uid)}"></span>
    </div>`;
}

function editableText(label, fieldName, value, opts) {
  const { uid, placeholder, datalistId } = opts;
  if (!canEdit()) return field(label, value);
  return `
    <div class="field-row">
      <div class="field-lbl">${esc(label)}</div>
      <input type="text" class="inline-input"
             data-uid="${esc(uid)}" data-field="${esc(fieldName)}" data-endpoint="property-edits"
             ${datalistId ? `list="${esc(datalistId)}"` : ''}
             value="${value != null ? esc(value) : ''}"
             placeholder="${esc(placeholder || '—')}">
      <span class="save-dot" data-dot="${esc(fieldName)}-${esc(uid)}"></span>
    </div>`;
}

function editableDate(label, fieldName, value, opts) {
  const { uid } = opts;
  // Normalize value to YYYY-MM-DD for the date input
  let dateVal = '';
  if (value) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) dateVal = d.toISOString().slice(0, 10);
  }
  if (!canEdit()) return field(label, value ? fmtDate(value) : '');
  return `
    <div class="field-row">
      <div class="field-lbl">${esc(label)}</div>
      <input type="date" class="inline-input"
             data-uid="${esc(uid)}" data-field="${esc(fieldName)}" data-endpoint="property-edits"
             value="${esc(dateVal)}">
      <span class="save-dot" data-dot="${esc(fieldName)}-${esc(uid)}"></span>
    </div>`;
}

// Strict select — current value preserved as a "(legacy)" option if it isn't
// in `options`, so non-canonical historical data is shown but anything saved
// goes through the canonical list. `labelFn` lets the visible label differ
// from the option value (e.g. Source shows "D"/"C" but stores "Direct"/"CP").
function editableSelect(label, fieldName, value, opts) {
  const { uid, options, emptyLabel = '— Unassigned —', labelFn } = opts;
  const lbl = (o) => labelFn ? labelFn(o) : o;
  // Read-only fallback: show the labeled form (e.g. "D" instead of "Direct")
  // so viewers see the same string the dropdown would display.
  if (!canEdit()) return field(label, value ? lbl(value) : '');
  const inOptions = !value || options.includes(value);
  const legacyOpt = inOptions ? '' :
    `<option value="${esc(value)}" selected>${esc(value)} (legacy)</option>`;
  const optsHtml = options.map(o =>
    `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(lbl(o))}</option>`
  ).join('');
  return `
    <div class="field-row">
      <div class="field-lbl">${esc(label)}</div>
      <select class="inline-select"
              data-uid="${esc(uid)}" data-field="${esc(fieldName)}" data-endpoint="property-edits">
        <option value=""${!value ? ' selected' : ''}>${esc(emptyLabel)}</option>
        ${legacyOpt}
        ${optsHtml}
      </select>
      <span class="save-dot" data-dot="${esc(fieldName)}-${esc(uid)}"></span>
    </div>`;
}

function field(label, value, cls, tooltip) {
  const v = (value == null || value === '' || value === 'null') ? '—' : value;
  const isEmpty = v === '—';
  const klass = isEmpty ? 'muted' : (cls || '');
  // Optional ⓘ marker reveals the original raw value on hover (e.g. legacy
  // carpet_area "1230-1300" stored as 1230 — tooltip shows the full range).
  const tipHtml = tooltip ? ` <span class="info-tip" title="${esc(tooltip)}">ⓘ</span>` : '';
  return `
    <div class="field-row">
      <div class="field-lbl">${esc(label)}${tipHtml}</div>
      <div class="field-val ${klass}">${isEmpty ? '—' : esc(v)}</div>
    </div>`;
}

function extractBedrooms(config) {
  if (!config) return '';
  const m = String(config).match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

function formatExtraArea(v) {
  const arr = parseJsonish(v);
  return Array.isArray(arr) && arr.length ? arr.join(', ') : '';
}

function formatList(v) {
  const arr = parseJsonish(v);
  return Array.isArray(arr) && arr.length ? arr.join(', ') : '';
}

function formatBalconyFacing(v) {
  const arr = parseJsonish(v);
  if (!Array.isArray(arr) || !arr.length) return '';
  // Mirrors the captioning of each Balcony Views card: "Room · Facing · View",
  // one line per balcony. Empty fields are dropped from the join so partial
  // entries still read cleanly.
  return arr.map(o => {
    if (typeof o === 'string') return o;
    const room   = o.attached_to || o.room   || o.name      || '';
    const facing = o.facing      || o.direction             || '';
    const view   = o.view        || o.outlook               || '';
    return [room, facing, view].filter(Boolean).join(' · ');
  }).filter(Boolean).join('\n');
}

// ── Media cards ────────────────────────────────────────────────────────
// Each "card" is a labelled subsection inside the Media column.
function renderPropertyImagesCard(propImgs) {
  if (!propImgs.length) return '';
  return `
    <div class="media-card">
      <div class="media-card-title">Property Images</div>
      <div class="gallery">
        ${propImgs.map(img => `
          <div class="gallery-item" data-img="${esc(img.url)}">
            <img src="${esc(img.url)}" alt="${esc(img.caption || '')}" loading="lazy">
            ${img.caption ? `<div class="gallery-caption">${esc(img.caption)}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

function renderBalconyViewsCard(views) {
  if (!views.length) return '';
  return `
    <div class="media-card">
      <div class="media-card-title">Balcony Views</div>
      <div class="balcony-grid">
        ${views.map(v => {
          const caption = [v.room, v.facing, v.view].filter(Boolean).join(' · ');
          return `
          <div class="balcony-card">
            <div class="balcony-imgs">
              ${v.viewImg ? `<div class="balcony-img" data-img="${esc(v.viewImg)}" title="View photo">
                  <img src="${esc(v.viewImg)}" alt="View" loading="lazy">
                </div>` : ''}
              ${v.compassImg ? `<div class="balcony-img balcony-img--compass" data-img="${esc(v.compassImg)}" title="Compass">
                  <img src="${esc(v.compassImg)}" alt="Compass" loading="lazy">
                </div>` : ''}
            </div>
            <div class="balcony-card-meta">
              <div class="balcony-room">${esc(caption || 'Balcony')}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

// Property images: use fresh photos from the backend API (keyed by core_home_id)
// when available; fall back to the compass + additional_images stored in the DB.
function collectPropertyImages(r) {
  const apiImages = r.core_home_id != null ? state.homePhotos[r.core_home_id] : null;
  if (apiImages && apiImages.length) {
    return apiImages.map(url => ({ url, caption: '' }));
  }
  // Fallback: stale DB images
  const imgs = [];
  if (r.exit_compass_image) {
    imgs.push({ url: r.exit_compass_image, caption: 'Exit Compass' });
  }
  const more = parseJsonish(r.additional_images);
  if (Array.isArray(more)) {
    for (const item of more) {
      if (typeof item === 'string') imgs.push({ url: item, caption: '' });
      else if (item && typeof item === 'object') {
        const url = item.url || item.image || item.src;
        if (url) imgs.push({ url, caption: item.caption || item.label || '' });
      }
    }
  }
  return imgs;
}

// Balcony views: each entry returns BOTH the actual view photo and the compass
// dial photo (the supply form captures both per balcony). Field names match
// backend-form/openhouse-forms (attached_to, facing, view, view_image, compass_image),
// with fallbacks for older shapes.
function collectBalconyViews(r) {
  const views = [];
  const balconies = parseJsonish(r.balcony_details);
  if (Array.isArray(balconies)) {
    for (const b of balconies) {
      if (!b || typeof b !== 'object') continue;
      const room       = b.attached_to   || b.room      || b.name      || '';
      const facing     = b.facing        || b.direction                || '';
      const view       = b.view          || b.outlook                  || '';
      const viewImg    = b.view_image    || b.image     || b.image_url || b.url || '';
      const compassImg = b.compass_image || '';
      // Drop entries with no images and no metadata at all.
      if (!viewImg && !compassImg && !room && !facing && !view) continue;
      views.push({ room, facing, view, viewImg, compassImg });
    }
  }
  return views;
}

// Combined list — used by the CSV export's "Photo Links" column. Each balcony
// contributes up to two URLs (view + compass) so neither is dropped.
function collectImages(r) {
  const all = [...collectPropertyImages(r)];
  for (const v of collectBalconyViews(r)) {
    const base = [v.room, v.facing, v.view].filter(Boolean).join(' · ') || 'Balcony';
    if (v.viewImg)    all.push({ url: v.viewImg,    caption: base + ' (View)'    });
    if (v.compassImg) all.push({ url: v.compassImg, caption: base + ' (Compass)' });
  }
  return all;
}

// ── Inline edits ───────────────────────────────────────────────────────
// All `change` events bubble to the document and are handled by the delegated
// listener below. attachExpandHandlers only adds bindings that don't bubble
// reliably (lightbox click on gallery thumbs).
function attachExpandHandlers(uid) {
  const expandTr = document.querySelector(`tr.expand-row[data-uid-expand="${cssEscape(uid)}"]`);
  if (!expandTr) return;
  // Property Images + Balcony View images all participate in one lightbox
  // sequence — clicking any one passes the full URL list + the clicked index
  // so left/right arrows can scrub through every image in the panel.
  const allThumbs = Array.from(expandTr.querySelectorAll('.gallery-item, .balcony-img'));
  const allUrls = allThumbs.map(t => t.dataset.img).filter(Boolean);
  allThumbs.forEach((g, i) => {
    g.addEventListener('click', () => openLightbox(allUrls, i));
  });
}

// Delegated handler — fires once per change regardless of row open/closed state.
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.matches) return;
  const isEditable =
    el.matches('input.inline-input') ||
    el.matches('textarea.inline-textarea') ||
    el.matches('select.inline-select');
  if (!isEditable) return;
  const uid = el.dataset.uid;
  if (!uid) return;

  // Side-effect: when Payment Structure flips to/from Non-Flexible, show/hide
  // the Min %/Max % wrapper inline (no full re-render so we don't lose focus).
  // Real properties drive this off ama_payment_structure; legacy rows use
  // alpha_beta — both surface the same wrapper.
  if (el.dataset.field === 'ama_payment_structure' || el.dataset.field === 'alpha_beta') {
    const wrapper = document.querySelector(
      `.payment-flexible-only[data-payment-flexible-for="${cssEscape(uid)}"]`
    );
    if (wrapper) wrapper.style.display = el.value === 'Non-Flexible' ? 'none' : '';
  }

  // Side-effect: when availability_status changes, recolor both the in-header
  // select AND the main row's Status pill, and show/hide the Submit Details
  // button without re-rendering the row.
  if (el.dataset.field === 'availability_status') {
    syncAvailabilityUI(uid, el.value);
  }

  saveField(uid, el);
});

// Update all DOM nodes tied to a uid's availability_status: header select color,
// main row pill, and Submit Details button visibility.
function syncAvailabilityUI(uid, value) {
  const cls = AVAILABILITY_CLASS[value] || 'avail-green';

  // Header select
  const sel = document.querySelector(`select.avail-select[data-uid="${cssEscape(uid)}"]`);
  if (sel) {
    sel.classList.remove('avail-green', 'avail-amber', 'avail-red');
    sel.classList.add(cls);
  }

  // Main row pill — the row uses a separate <span> render; safest to just
  // replace its outerHTML rather than mutate classes (the row may be collapsed
  // or open, and we control the pill rendering centrally).
  const row = document.querySelector(`tr.data-row[data-uid="${cssEscape(uid)}"]`);
  if (row) {
    const pill = row.querySelector('.avail-pill');
    if (pill) pill.outerHTML = renderAvailabilityPill(value);
  }

  // Submit Details row visibility — rendered on its own line below the section
  // header. Already present in the DOM for editors (display:none until Booked);
  // we just toggle visibility on status change rather than creating/removing.
  const submitRow = document.querySelector(
    `.submit-details-row[data-submit-row-for="${cssEscape(uid)}"]`
  );
  if (submitRow) submitRow.style.display = value === 'Booked' ? '' : 'none';
}

// Remarks history button (admin-only). Live binding via delegation since
// rows re-render on every loadData / sort / row-toggle.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.remarks-history-btn');
  if (!btn) return;
  e.stopPropagation(); // don't toggle the row
  openRemarksHistory(btn.dataset.historyUid);
});

// Submit Details button — opens the booking submission modal.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-submit-details');
  if (!btn) return;
  e.stopPropagation();
  openBookingModal(btn.dataset.submitBookingUid);
});

function cssEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

async function saveField(uid, el) {
  const field = el.dataset.field;
  if (!field) return;
  // Inputs tagged data-endpoint="property-edits" write to the supply-side
  // `properties` table (audit-logged); everything else writes to demand_details.
  const endpoint = el.dataset.endpoint || 'demand-details';
  const value = el.value;
  const dotKey = `${field}-${uid}`;
  const dot = document.querySelector(`[data-dot="${cssEscape(dotKey)}"]`);
  if (dot) dot.className = 'save-dot saving';

  try {
    const r = await fetch('/api/' + endpoint + '/' + encodeURIComponent(uid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ [field]: value }),
    });
    const data = await r.json();
    if (!r.ok || !data.success) {
      if (dot) dot.className = 'save-dot error';
      showToast(data.error || 'Failed to save', 'error');
      return;
    }
    if (dot) dot.className = 'save-dot saved';
    setTimeout(() => { if (dot) dot.className = 'save-dot'; }, 1500);

    // Patch local row in place so subsequent renders / sorts / CSV export
    // reflect the new value without a full /api/list refetch.
    // demand-details returns full row in `data`; property-edits returns only
    // the changed columns in `updated`.
    const row = state.rows.find(r => r.uid === uid);
    if (row) {
      if (data.data) Object.assign(row, data.data);
      if (data.updated) Object.assign(row, data.updated);
    }

    // Server-side auto-vacant: when key_handover_date is changed, the
    // property-edits endpoint also flips possession_status / occupancy_status
    // to 'Vacant' (only if currently Tenant or Owner Staying). Surgically
    // refresh the Status column subtitle + the expand panel's Current
    // Occupancy field so the user sees the flip immediately — without a
    // full re-render that would wipe unsaved edits in the expand panel.
    if (data.updated && (
        data.updated.possession_status !== undefined ||
        data.updated.occupancy_status  !== undefined)) {
      syncOccupancyDisplay(uid);
    }
  } catch (e) {
    console.error(e);
    if (dot) dot.className = 'save-dot error';
    showToast('Network error', 'error');
  }
}

// Re-renders the Status column subtitle (main row) and the Current Occupancy
// field-row (expand panel) for one uid, sourcing values from state.rows.
// Called after saveField when the server auto-derived an occupancy change.
function syncOccupancyDisplay(uid) {
  const r = state.rows.find(x => x.uid === uid);
  if (!r) return;
  const subtitle = r.possession_status || r.occupancy_status;

  // Main row — Status cell: keep the pill, replace the subtitle line.
  const tr = document.querySelector(`tr.data-row[data-uid="${cssEscape(uid)}"]`);
  if (tr) {
    const cell = tr.querySelector('.col-status');
    if (cell) {
      cell.innerHTML = `
        ${renderAvailabilityPill(r.availability_status)}
        ${subtitle ? `<div class="prop-unit">${esc(subtitle)}</div>` : ''}
      `;
    }
  }

  // Expand panel — Current Occupancy field-row. Wrapped in a <span> tagged
  // data-occupancy-for=<uid> so we can swap its contents without re-rendering
  // the whole expand panel.
  const occWrap = document.querySelector(`[data-occupancy-for="${cssEscape(uid)}"]`);
  if (occWrap) {
    occWrap.innerHTML = field('Current Occupancy', subtitle);
  }
}

// ── Lightbox ───────────────────────────────────────────────────────────
// Supports both the legacy single-URL call and the new (urls, index) form.
// Keeps a module-level cursor so the keydown listener (mounted once) can
// scrub through the gallery without needing closure access.
const lightbox = { urls: [], index: 0 };

function openLightbox(urlsOrUrl, startIndex) {
  // Backwards-compat: openLightbox('http://…') still works.
  if (typeof urlsOrUrl === 'string') {
    lightbox.urls = [urlsOrUrl];
    lightbox.index = 0;
  } else {
    lightbox.urls = urlsOrUrl || [];
    lightbox.index = Math.max(0, Math.min(startIndex || 0, lightbox.urls.length - 1));
  }
  if (!lightbox.urls.length) return;

  let lb = $('#lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = `
      <button class="lightbox-close" data-lb-action="close" title="Close (Esc)">×</button>
      <button class="lightbox-nav lightbox-prev" data-lb-action="prev" title="Previous (←)">‹</button>
      <img src="" alt="">
      <button class="lightbox-nav lightbox-next" data-lb-action="next" title="Next (→)">›</button>
      <div class="lightbox-counter"></div>`;
    document.body.appendChild(lb);

    lb.addEventListener('click', (e) => {
      const action = e.target.dataset.lbAction;
      if (action === 'close')      lb.classList.remove('open');
      else if (action === 'prev')  navLightbox(-1);
      else if (action === 'next')  navLightbox(1);
      else if (e.target === lb)    lb.classList.remove('open'); // backdrop
    });

    // Keyboard nav. Mounted once on document; gated by lightbox open state.
    document.addEventListener('keydown', (e) => {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); navLightbox(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navLightbox(1); }
      else if (e.key === 'Escape')     { e.preventDefault(); lb.classList.remove('open'); }
    });
  }

  updateLightbox();
  lb.classList.add('open');
}

function navLightbox(delta) {
  const n = lightbox.urls.length;
  if (n < 2) return;
  // Wrap around so right at the end loops to start (and left at start to end).
  lightbox.index = (lightbox.index + delta + n) % n;
  updateLightbox();
}

function updateLightbox() {
  const lb = $('#lightbox');
  if (!lb) return;
  const { urls, index } = lightbox;
  lb.querySelector('img').src = urls[index] || '';
  const counter = lb.querySelector('.lightbox-counter');
  counter.textContent = urls.length > 1 ? `${index + 1} / ${urls.length}` : '';
  // Hide nav arrows when there's only one image.
  const display = urls.length > 1 ? '' : 'none';
  lb.querySelector('.lightbox-prev').style.display = display;
  lb.querySelector('.lightbox-next').style.display = display;
}

// ── CSV export ─────────────────────────────────────────────────────────
function exportCsv() {
  const cols = [
    ['Listing Price (Lacs)', 'listing_price'],
    ['Demand Team Remarks', 'internal_remarks'],
    ['Unit No', 'unit_no'],
    ['Floor', 'floor'],
    ['Configuration', 'configuration'],
    ['Extra Area', r => formatExtraArea(r.extra_area)],
    ['Society Name', 'society_name'],
    ['Locality', 'locality'],
    ['City', 'city'],
    ['Date of AMA', r => fmtDate(r.ama_date)],
    ['Owner Name', 'owner_name'],
    ['Owner Physical Location', 'seller_location'],
    ['Key Handover Status', r => r.key_handover_date ? 'Done' : 'Pending'],
    ['Key Handover Date', r => fmtDate(r.key_handover_date)],
    ['Documents Available', r => formatList(r.documents_available)],
    ['Loan Status', r => r.loan_status || (r.outstanding_loan ? 'Active' : 'No Loan')],
    ['Loan Amount', 'outstanding_loan'],
    ['Property Tax Status', 'property_tax_status'],
    // Payment Structure is "Flexible"/"Non-Flexible" for both origins.
    // Real properties store it in ama_payment_structure (with the Beta range
    // in beta min/max). Legacy uses alpha_beta. Single CSV column with a
    // fallback covers both.
    ['Payment Structure', r => r.ama_payment_structure || r.alpha_beta || ''],
    ['Beta Min %',        'ama_beta_min_pct'],
    ['Beta Max %',        'ama_beta_max_pct'],
    ['Super Area', r => r.super_area || r.area_sqft],
    ['Carpet Area', 'carpet_area'],
    ['No. of Bedrooms', r => extractBedrooms(r.configuration)],
    ['No. of Baths', 'bathrooms'],
    ['No. of Balconies', 'balconies'],
    ['Gas Pipeline', 'gas_pipeline'],
    ['Society Occupancy', r => r.current_occupancy_pct != null ? r.current_occupancy_pct + '%' : ''],
    ['Club Facility', 'club_facility'],
    ['Parking', 'parking'],
    ['Parking No.', 'parking_number'],
    ['Furnishing Status', 'furnishing'],
    ['Furnishing Items', r => formatList(r.furnishing_details)],
    ['Total Floors in Tower', 'total_floors_tower'],
    ['Total Flats on Floor', 'total_flats_floor'],
    ['Exit Facing', 'exit_facing'],
    ['Balcony Facing', r => formatBalconyFacing(r.balcony_details)],
    ['Society Age', 'society_age_years'],
    ['Total Units in Society', 'total_units'],
    ['Maintenance Charges (per sqft)', 'maintenance_charges'],
    ['Society Move-in Charges', 'society_move_in_charges'],
    ['Electricity Charges per unit', 'electricity_charges'],
    ['DG Charges per unit', 'dg_charges'],
    ['Current Occupancy', r => r.possession_status || r.occupancy_status],
    ['Circle Rate', 'circle_rate'],
    ['Photo Links', r => collectImages(r).map(i => i.url).join(' | ')],
    ['Video Link', 'video_link'],
    ['Supply Status', 'supply_status'],
    ['Availability', r => r.availability_status || 'Available'],
    ['Origin', r => r.origin === 'legacy' ? 'Legacy (CSV)' : 'Supply pipeline'],
  ];

  const header = cols.map(c => csvCell(c[0])).join(',');
  const lines = state.rows.map(r => cols.map(c => {
    const v = typeof c[1] === 'function' ? c[1](r) : r[c[1]];
    return csvCell(v);
  }).join(','));

  const csv = [header, ...lines].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `demand-dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\r\n]/.test(s) ? `"${s}"` : s;
}

// ── User Management ────────────────────────────────────────────────────
async function openUsersModal() {
  $('#usersModal').classList.add('open');
  $('#addUserError').textContent = '';
  await loadUsers();
}

async function loadUsers() {
  const r = await fetch('/api/users', { credentials: 'include' });
  const data = await r.json();
  if (!data.success) { showToast(data.error || 'Failed to load users', 'error'); return; }

  const list = $('#usersList');
  list.innerHTML = data.users.map(u => `
    <div class="user-row" data-id="${u.id}">
      <img class="user-row-avatar" src="${u.picture || avatarFallback(u)}" alt="">
      <div class="user-row-info">
        <div class="user-row-name">${esc(u.name || u.email)}${u.id === state.user.id ? ' <span class="user-row-you">you</span>' : ''}</div>
        <div class="user-row-email">${esc(u.email)}</div>
      </div>
      <select class="user-row-role" data-id="${u.id}">
        <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option>
        <option value="manager"${u.role === 'manager' ? ' selected' : ''}>Manager</option>
        <option value="viewer"${u.role === 'viewer' ? ' selected' : ''}>Viewer</option>
      </select>
      ${u.id !== state.user.id ? `<button class="user-row-logout" data-id="${u.id}" title="Force logout — invalidates the user's current session">🚪</button>` : ''}
      <button class="user-row-delete" data-id="${u.id}" title="Remove user">🗑</button>
    </div>`).join('');

  list.querySelectorAll('.user-row-role').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const r = await fetch('/api/users/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role: sel.value }),
      });
      const data = await r.json();
      if (!data.success) { showToast(data.error || 'Failed to update', 'error'); await loadUsers(); }
      else showToast('Role updated', 'success');
    });
  });

  list.querySelectorAll('.user-row-logout').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Force logout this user? Their current session will be invalidated immediately and they will need to sign in again.')) return;
      const r = await fetch('/api/users/' + btn.dataset.id + '/force-logout', {
        method: 'POST', credentials: 'include',
      });
      const data = await r.json();
      if (!data.success) showToast(data.error || 'Failed to force logout', 'error');
      else showToast('User signed out', 'success');
    });
  });

  list.querySelectorAll('.user-row-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this user?')) return;
      const r = await fetch('/api/users/' + btn.dataset.id, {
        method: 'DELETE', credentials: 'include',
      });
      const data = await r.json();
      if (!data.success) showToast(data.error || 'Failed to remove', 'error');
      else { showToast('User removed', 'success'); await loadUsers(); }
    });
  });
}

function avatarFallback(u) {
  const initial = (u.name || u.email || '?')[0].toUpperCase();
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><circle cx='16' cy='16' r='16' fill='%23e4e7ec'/><text x='16' y='21' text-anchor='middle' fill='%236b7280' font-family='Inter' font-size='14' font-weight='600'>${initial}</text></svg>`;
}

// ── Remarks History (admin only) ───────────────────────────────────────
async function openRemarksHistory(uid) {
  const modal = $('#historyModal');
  const body = $('#historyModalBody');
  const subtitle = $('#historyModalSubtitle');

  const row = state.rows.find(r => r.uid === uid);
  subtitle.textContent = row ? `· ${row.society_name || ''} ${row.unit_no ? '· Unit ' + row.unit_no : ''}` : '';
  body.innerHTML = '<div class="loading"><div class="spinner"></div> Loading history…</div>';
  modal.classList.add('open');

  try {
    const r = await fetch('/api/remarks-history/' + encodeURIComponent(uid), { credentials: 'include' });
    const data = await r.json();
    if (!data.success) {
      body.innerHTML = `<div class="empty-state">${esc(data.error || 'Failed to load')}</div>`;
      return;
    }
    if (!data.history.length) {
      body.innerHTML = '<div class="empty-state">No remark changes recorded yet.</div>';
      return;
    }

    body.innerHTML = `
      <div class="history-list">
        ${data.history.map(h => `
          <div class="history-entry">
            <div class="history-meta">
              <span class="history-author">${esc(h.actor_name || h.actor_email || 'Unknown')}</span>
              <span class="history-time">${esc(fmtDateTime(h.created_at))}</span>
            </div>
            <div class="history-value ${h.value ? '' : 'history-cleared'}">
              ${h.value ? esc(h.value) : '— cleared —'}
            </div>
          </div>
        `).join('')}
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Network error</div>`;
  }
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

async function addUser() {
  const email = $('#newUserEmail').value.trim();
  const role = $('#newUserRole').value;
  const errEl = $('#addUserError');
  errEl.textContent = '';

  if (!email || !email.includes('@')) {
    errEl.textContent = 'Please enter a valid email address';
    return;
  }

  const r = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, role }),
  });
  const data = await r.json();
  if (!data.success) { errEl.textContent = data.error || 'Failed to add user'; return; }
  $('#newUserEmail').value = '';
  showToast('User added', 'success');
  await loadUsers();
}

// ── Booking Submission Modal ───────────────────────────────────────────
// 3-step flow (Recipients → Details → Preview → Send). State is local to
// the modal session (resets each open). Uses /api/booking-details/:uid.
const bookingState = {
  uid: null,
  property: null,
  step: 1,
  recipients: [],
  brokers: [],
  fixedRecipients: [],
  paymentMethods: [],
  payMode: 'single',  // 'single' | 'split'
  form: {},
};

async function openBookingModal(uid) {
  bookingState.uid = uid;
  bookingState.step = 1;
  bookingState.form = {};

  // Reset visible form inputs + transient state
  document.querySelectorAll('#bookingModal [data-bf]').forEach(el => { el.value = ''; });
  $('#bookingNewRecipient').value = '';
  $('#bookingNewBroker').value = '';
  // Reset the Send button — sendBookingMail() leaves it as "✓ Sent" / disabled
  // on success to prevent races, so re-opening the modal must restore it.
  const sendBtn = $('#bookingSendBtn');
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📨 Send Mail'; }
  bookingState.recipients = [];
  bookingState.brokers = [];
  bookingState.fixedRecipients = [];
  bookingState.paymentMethods = [];
  bookingState.payMode = 'single';
  applyPayMode('single');
  updateAtsPctHint();

  // Everything we can render from local state (no network) goes FIRST so the
  // modal pops up instantly. The API call is fired in the background — its
  // response only fills in things we don't already have (defaults, suggestions,
  // draft prefill, lockout). Cold-start of the booking-details function used
  // to make the click feel laggy (1–3s of nothing); this keeps it snappy.
  const row = state.rows.find(r => r.uid === uid);
  bookingState.property = row || null;

  const subtitle = row
    ? `· ${row.society_name || ''} ${row.unit_no ? '· Unit ' + row.unit_no : ''}`
    : '';
  $('#bookingModalSubtitle').textContent = subtitle;

  $('#bookingPropertySummary').innerHTML = row ? `
    <div class="bp-row"><span class="bp-lbl">Property</span><span class="bp-val">${esc(row.society_name || '')}</span></div>
    <div class="bp-row"><span class="bp-lbl">Unit</span><span class="bp-val">${esc(row.unit_no || '')} ${row.tower_no ? '· ' + esc(row.tower_no) : ''} ${row.floor != null ? '· Floor ' + esc(row.floor) : ''}</span></div>
    <div class="bp-row"><span class="bp-lbl">Configuration</span><span class="bp-val">${esc(row.configuration || '')} · ${esc(row.super_area || row.area_sqft || '')} sqft</span></div>
    <div class="bp-row"><span class="bp-lbl">City</span><span class="bp-val">${esc(row.city || '')} · ${esc(row.locality || '')}</span></div>
  ` : '';

  // Loading state for the recipients list + disable Next until defaults arrive.
  $('#bookingRecipientsList').innerHTML =
    '<div class="booking-loading-inline"><div class="spinner"></div> Loading defaults…</div>';
  $('#bookingNextBtn').disabled = true;

  goToBookingStep(1);
  $('#bookingModal').classList.add('open');

  // Fetch prefill data: latest booking row (if any), team users, past CP RM
  // emails, payment methods, fixed recipients.
  let data;
  try {
    const r = await fetch('/api/booking-details/' + encodeURIComponent(uid), { credentials: 'include' });
    data = await r.json();
    if (!data.success) throw new Error(data.error || 'Failed to load booking data');
  } catch (e) {
    showToast(e.message, 'error');
    $('#bookingModal').classList.remove('open');
    return;
  }

  // If the user closed the modal during the fetch, or switched to another uid,
  // drop the response so we don't write stale prefill into a closed/new modal.
  if (!$('#bookingModal').classList.contains('open') || bookingState.uid !== uid) {
    return;
  }

  bookingState.paymentMethods = data.paymentMethods || [];
  bookingState.fixedRecipients = data.fixedRecipients || [];

  // Build recipients list: fixed + current user (sender) + property POC + suggestions
  const senderEmail = state.user.email;
  const pocEmail = findPocEmail(row, data.team);

  const defaults = [
    ...bookingState.fixedRecipients,
    senderEmail,
    pocEmail,
  ].filter(Boolean);
  // Dedupe (case-insensitive) preserving order
  const seen = new Set();
  bookingState.recipients = defaults.filter(e => {
    const k = e.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Populate datalist with non-fixed suggestions (past CP RM emails + team)
  const dl = $('#bookingRecipientSuggestions');
  const suggestionSet = new Set([
    ...(data.suggestions || []),
    ...(data.team || []).map(t => t.email).filter(Boolean),
  ]);
  dl.innerHTML = [...suggestionSet]
    .filter(e => !bookingState.recipients.includes(e))
    .map(e => `<option value="${esc(e)}">`)
    .join('');

  // Broker suggestions — distinct emails seen in past bookings' broker_emails.
  const brokerDl = $('#bookingBrokerSuggestions');
  brokerDl.innerHTML = (data.brokerSuggestions || [])
    .map(e => `<option value="${esc(e)}">`)
    .join('');

  // Prefill payment method options on both selects (single mode + split-method-2).
  const methodOpts = '<option value="">Select…</option>' +
    bookingState.paymentMethods.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  document.querySelectorAll('#bookingModal [data-bf="booking_amount_method"], #bookingModal [data-bf="booking_amount_method_2"]')
    .forEach(sel => { sel.innerHTML = methodOpts; });

  // Prefill form if there's a saved draft (latest non-mailed booking row)
  if (data.latest && !data.latest.mail_sent_at) {
    const l = data.latest;
    setBF('buyer_name', l.buyer_name);
    setBF('buyer_email', l.buyer_email);
    setBF('co_buyer_name', l.co_buyer_name);
    setBF('co_buyer_email', l.co_buyer_email);
    setBF('consideration_amount', l.consideration_amount);
    setBF('booking_amount_received', l.booking_amount_received);
    setBF('booking_amount_method', l.booking_amount_method);
    setBF('booking_amount_method_2', l.booking_amount_method_2);
    setBF('booking_amount_split_1', l.booking_amount_split_1);
    setBF('booking_amount_split_2', l.booking_amount_split_2);
    setBF('ats_timeline', l.ats_timeline);
    setBF('registry_timeline', l.registry_timeline);
    setBF('booking_amount_forfeitable', l.booking_amount_forfeitable === true ? 'Yes' : l.booking_amount_forfeitable === false ? 'No' : '');
    setBF('amount_on_ats_pct', l.amount_on_ats_pct);
    setBF('other_conditions', l.other_conditions);
    if (Array.isArray(l.recipients) && l.recipients.length) {
      bookingState.recipients = l.recipients;
    }
    if (Array.isArray(l.broker_emails) && l.broker_emails.length) {
      bookingState.brokers = l.broker_emails;
    }
    if (l.booking_amount_method_2) {
      bookingState.payMode = 'split';
      applyPayMode('split');
    }
    updateAtsPctHint();
    refreshAllAmountHints();
  }

  // If a prior booking has been mailed and the user isn't admin, block.
  if (data.locked && state.user.role !== 'admin') {
    showToast('Booking already submitted. Only admins can re-submit.', 'error');
    $('#bookingModal').classList.remove('open');
    return;
  }

  renderBookingRecipients();
  renderBookingBrokers();
  $('#bookingNextBtn').disabled = false;
}

// Looks up a likely POC email for the property:
// - properties.assigned_by may be a full name like "Shashank Kumar". Match against
//   demand_users.name (case-insensitive) to get their email.
// - Fallback: if assigned_by already looks like an email, use it.
function findPocEmail(row, teamUsers) {
  if (!row || !row.poc) return null;
  const v = String(row.poc).trim();
  if (!v) return null;
  if (v.includes('@')) return v;
  if (!teamUsers || !teamUsers.length) return null;
  const match = teamUsers.find(u =>
    (u.name && u.name.trim().toLowerCase() === v.toLowerCase())
  );
  return match ? match.email : null;
}

function setBF(field, value) {
  const el = document.querySelector(`#bookingModal [data-bf="${cssEscape(field)}"]`);
  if (el != null && value != null) el.value = value;
}

function renderBookingRecipients() {
  const list = $('#bookingRecipientsList');
  list.innerHTML = bookingState.recipients.map((email, i) => {
    const isFixed = bookingState.fixedRecipients.includes(email);
    return `
      <div class="recipient-chip ${isFixed ? 'recipient-chip--fixed' : ''}">
        <span class="recipient-email">${esc(email)}</span>
        ${isFixed
          ? '<span class="recipient-label">default</span>'
          : `<button type="button" class="recipient-remove" data-recipient-idx="${i}" title="Remove">×</button>`}
      </div>`;
  }).join('');
}

// Broker chip list. Parallel to renderBookingRecipients but uses a separate
// data-broker-idx attribute so the click delegation targets the right array.
function renderBookingBrokers() {
  const list = $('#bookingBrokersList');
  if (!list) return;
  if (!bookingState.brokers.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = bookingState.brokers.map((email, i) => `
    <div class="recipient-chip">
      <span class="recipient-email">${esc(email)}</span>
      <button type="button" class="recipient-remove" data-broker-idx="${i}" title="Remove">×</button>
    </div>`).join('');
}

// Formats a rupee amount as "X Lakhs" or "X Crores" using Indian numbering.
// Returns an empty string for amounts below 1 lakh — those don't need a hint.
function formatLakhsCrores(n) {
  const num = Number(n);
  if (!isFinite(num) || num < 100000) return '';
  if (num < 10000000) {
    const lakhs = num / 100000;
    const isInt = Math.abs(lakhs - Math.round(lakhs)) < 1e-9;
    const str = isInt ? String(Math.round(lakhs)) : lakhs.toFixed(2).replace(/\.?0+$/, '');
    return `${str} ${str === '1' ? 'Lakh' : 'Lakhs'}`;
  }
  const crores = num / 10000000;
  const isInt = Math.abs(crores - Math.round(crores)) < 1e-9;
  const str = isInt ? String(Math.round(crores)) : crores.toFixed(2).replace(/\.?0+$/, '');
  return `${str} ${str === '1' ? 'Crore' : 'Crores'}`;
}

// Refreshes the lakhs/crores hint shown below an amount input. Looks up the
// sibling `.amount-hint[data-amount-hint-for="<field>"]` via the input's
// data-amount-hint attribute.
function updateAmountHint(input) {
  const field = input?.dataset?.amountHint;
  if (!field) return;
  const hint = document.querySelector(
    `#bookingModal .amount-hint[data-amount-hint-for="${field}"]`
  );
  if (hint) hint.textContent = formatLakhsCrores(input.value);
}

// Refresh every visible amount hint — used after prefill (draft load) so the
// hints reflect values that weren't entered via an `input` event.
function refreshAllAmountHints() {
  document.querySelectorAll('#bookingModal [data-amount-hint]').forEach(updateAmountHint);
}

// Updates the visibility of payment-mode bodies (single vs split) and the
// readonly state on Method 1's amount input. Called whenever the tabs flip.
function applyPayMode(mode) {
  bookingState.payMode = mode;
  document.querySelectorAll('#bookingModal .pay-mode-tab').forEach(t => {
    const active = t.dataset.payMode === mode;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('#bookingModal [data-pay-show]').forEach(el => {
    el.style.display = el.dataset.payShow === mode ? '' : 'none';
  });
  document.querySelectorAll('#bookingModal [data-pay-label]').forEach(el => {
    el.style.display = el.dataset.payLabel === mode ? '' : 'none';
  });
  // In single mode, clear the split fields so they don't get sent. In split
  // mode, recompute the auto leg from whatever Method 1's amount is currently.
  if (mode === 'single') {
    const s1 = document.querySelector('#bookingModal [data-bf="booking_amount_split_1"]');
    const s2 = document.querySelector('#bookingModal [data-bf="booking_amount_split_2"]');
    const m2 = document.querySelector('#bookingModal [data-bf="booking_amount_method_2"]');
    if (s1) s1.value = '';
    if (s2) s2.value = '';
    if (m2) m2.value = '';
  } else {
    recomputeSplitTwo();
  }
}

// Method 2's split amount = Booking Amount Received − Method 1's split amount.
// Clamped to ≥ 0 and to ≤ received. Renders empty if either input is missing.
function recomputeSplitTwo() {
  const received = parseFloat(document.querySelector('#bookingModal [data-bf="booking_amount_received"]')?.value);
  const s1 = parseFloat(document.querySelector('#bookingModal [data-bf="booking_amount_split_1"]')?.value);
  const s2El = document.querySelector('#bookingModal [data-bf="booking_amount_split_2"]');
  if (!s2El) return;
  if (isNaN(received) || isNaN(s1)) { s2El.value = ''; return; }
  const remainder = Math.max(0, Math.round((received - s1) * 100) / 100);
  s2El.value = remainder;
}

// Live rupee equivalent shown next to the Amount Payable at ATS (%) input.
// e.g. consideration ₹1,27,00,000 × 10% → "= ₹12,70,000". Empty inputs → "= ₹—".
function updateAtsPctHint() {
  const hint = $('#atsPctRupeeHint');
  if (!hint) return;
  const consideration = parseFloat(document.querySelector('#bookingModal [data-bf="consideration_amount"]')?.value);
  const pct = parseFloat(document.querySelector('#bookingModal [data-bf="amount_on_ats_pct"]')?.value);
  if (isNaN(consideration) || isNaN(pct)) { hint.textContent = '= ₹—'; return; }
  const amount = Math.round((consideration * pct) / 100);
  hint.textContent = '= ₹' + amount.toLocaleString('en-IN');
}

// Step navigation
function goToBookingStep(step) {
  bookingState.step = step;
  document.querySelectorAll('#bookingModal .booking-page').forEach(p => {
    p.style.display = (parseInt(p.dataset.page, 10) === step) ? '' : 'none';
  });
  document.querySelectorAll('#bookingModal .booking-step').forEach(s => {
    const n = parseInt(s.dataset.step, 10);
    s.classList.toggle('active', n === step);
    s.classList.toggle('done', n < step);
  });

  // Footer button visibility
  $('#bookingBackBtn').style.display = step === 1 ? 'none' : '';
  $('#bookingPreviewBtn').style.display = step === 2 ? '' : 'none';
  $('#bookingNextBtn').style.display = step === 3 ? 'none' : (step === 2 ? 'none' : '');
  $('#bookingSendBtn').style.display = step === 3 ? '' : 'none';
}

// Collect form values into bookingState.form
function collectBookingForm() {
  const form = {};
  document.querySelectorAll('#bookingModal [data-bf]').forEach(el => {
    const k = el.dataset.bf;
    let v = el.value;
    if (v === '') v = null;
    form[k] = v;
  });
  bookingState.form = form;
  return form;
}

// Validate the booking form before allowing preview/send.
// buyer_email is collected on Page 1; the rest live on Page 2.
function validateBookingForm(form) {
  const required = ['buyer_email', 'buyer_name', 'consideration_amount',
                    'booking_amount_received', 'booking_amount_method',
                    'booking_amount_forfeitable', 'ats_timeline',
                    'registry_timeline', 'amount_on_ats_pct'];
  if (bookingState.payMode === 'split') {
    required.push('booking_amount_method_2', 'booking_amount_split_1');
  }
  const missing = required.filter(k => !form[k] && form[k] !== 0);
  // In split mode the two methods must be different.
  if (bookingState.payMode === 'split' && form.booking_amount_method &&
      form.booking_amount_method_2 && form.booking_amount_method === form.booking_amount_method_2) {
    missing.push('different payment methods (Method 1 and Method 2 must differ)');
  }
  return missing;
}

const EMAIL_RE_FE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bind modal buttons (once)
(function bindBookingModal() {
  document.addEventListener('click', (e) => {
    // Add recipient
    if (e.target.id === 'bookingAddRecipient') {
      const input = $('#bookingNewRecipient');
      const val = input.value.trim();
      if (!val) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        showToast('Enter a valid email', 'error');
        return;
      }
      if (bookingState.recipients.some(e => e.toLowerCase() === val.toLowerCase())) {
        showToast('Already in the list', '');
        input.value = '';
        return;
      }
      bookingState.recipients.push(val);
      input.value = '';
      renderBookingRecipients();
    }
    // Add broker
    if (e.target.id === 'bookingAddBroker') {
      const input = $('#bookingNewBroker');
      const val = input.value.trim().toLowerCase();
      if (!val) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        showToast('Enter a valid broker email', 'error');
        return;
      }
      if (bookingState.brokers.some(b => b.toLowerCase() === val)) {
        showToast('Broker already in the list', '');
        input.value = '';
        return;
      }
      bookingState.brokers.push(val);
      input.value = '';
      renderBookingBrokers();
    }
    // Remove recipient
    const rm = e.target.closest('.recipient-remove[data-recipient-idx]');
    if (rm) {
      const idx = parseInt(rm.dataset.recipientIdx, 10);
      bookingState.recipients.splice(idx, 1);
      renderBookingRecipients();
    }
    // Remove broker
    const rmB = e.target.closest('.recipient-remove[data-broker-idx]');
    if (rmB) {
      const idx = parseInt(rmB.dataset.brokerIdx, 10);
      bookingState.brokers.splice(idx, 1);
      renderBookingBrokers();
    }
    // Payment Mode tabs
    const payTab = e.target.closest('#bookingModal .pay-mode-tab');
    if (payTab) {
      applyPayMode(payTab.dataset.payMode);
    }
    // Next
    if (e.target.id === 'bookingNextBtn') {
      if (bookingState.step === 1) {
        if (!bookingState.recipients.length) {
          showToast('At least one recipient is required', 'error');
          return;
        }
        const buyerEmailEl = document.querySelector('#bookingModal [data-bf="buyer_email"]');
        const buyerEmail = (buyerEmailEl?.value || '').trim();
        if (!buyerEmail || !EMAIL_RE_FE.test(buyerEmail)) {
          showToast('A valid Buyer Email is required', 'error');
          buyerEmailEl?.focus();
          return;
        }
        const coBuyerEmailEl = document.querySelector('#bookingModal [data-bf="co_buyer_email"]');
        const coBuyerEmail = (coBuyerEmailEl?.value || '').trim();
        if (coBuyerEmail && !EMAIL_RE_FE.test(coBuyerEmail)) {
          showToast('Co-buyer Email is not a valid email', 'error');
          coBuyerEmailEl?.focus();
          return;
        }
        goToBookingStep(2);
      }
    }
    // Back
    if (e.target.id === 'bookingBackBtn') {
      if (bookingState.step > 1) goToBookingStep(bookingState.step - 1);
    }
    // Preview (page 2 → server preview → page 3)
    if (e.target.id === 'bookingPreviewBtn') {
      const form = collectBookingForm();
      const missing = validateBookingForm(form);
      if (missing.length) {
        showToast('Missing required fields: ' + missing.join(', '), 'error');
        return;
      }
      generateBookingPreview();
    }
    // Send
    if (e.target.id === 'bookingSendBtn') {
      sendBookingMail();
    }
  });

  // Enter key on the "Add recipient" / "Add broker" inputs
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'bookingNewRecipient') {
      e.preventDefault();
      $('#bookingAddRecipient').click();
    }
    if (e.key === 'Enter' && e.target.id === 'bookingNewBroker') {
      e.preventDefault();
      $('#bookingAddBroker').click();
    }
  });

  // Live numeric updates: ATS % rupee hint + split-amount auto-fill + lakhs/
  // crores hints below amount inputs. Delegated so they don't rebind on each
  // modal open. Percentage inputs are clamped to [0, 100] in real time.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el?.classList?.contains('booking-pct-input')) {
      const n = parseFloat(el.value);
      if (!isNaN(n) && n > 100) el.value = '100';
      else if (!isNaN(n) && n < 0) el.value = '0';
    }
    if (el?.dataset?.amountHint) {
      updateAmountHint(el);
    }
    const field = el?.dataset?.bf;
    if (!field) return;
    if (field === 'consideration_amount' || field === 'amount_on_ats_pct') {
      updateAtsPctHint();
    }
    if (bookingState.payMode === 'split' &&
        (field === 'booking_amount_received' || field === 'booking_amount_split_1')) {
      recomputeSplitTwo();
    }
  });
})();

async function generateBookingPreview() {
  const form = collectBookingForm();
  try {
    const r = await fetch('/api/booking-details/' + encodeURIComponent(bookingState.uid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'preview',
        recipients: bookingState.recipients,
        broker_emails: bookingState.brokers,
        ...form,
      }),
    });
    const data = await r.json();
    if (!data.success) {
      showToast(data.error || 'Preview failed', 'error');
      return;
    }
    $('#bookingPreviewTo').textContent = (data.recipients || []).join(', ');
    $('#bookingPreviewSubject').textContent = data.subject;

    const iframe = $('#bookingPreviewIframe');
    // Write HTML directly into the sandboxed iframe (no script execution).
    iframe.srcdoc = data.html;
    goToBookingStep(3);
  } catch (e) {
    showToast('Network error: ' + e.message, 'error');
  }
}

async function sendBookingMail() {
  const form = bookingState.form;
  const btn = $('#bookingSendBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Sending…';

  try {
    const r = await fetch('/api/booking-details/' + encodeURIComponent(bookingState.uid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'send',
        recipients: bookingState.recipients,
        broker_emails: bookingState.brokers,
        ...form,
      }),
    });
    const data = await r.json();
    if (!data.success) {
      showToast(data.error || 'Send failed', 'error');
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    showToast('Booking submitted and email sent', 'success');
    // Keep the button disabled with a success label — the modal closes a
    // moment later via classList.remove, but the lock prevents any
    // double-click from racing a second send in between.
    btn.textContent = '✓ Sent';
    $('#bookingModal').classList.remove('open');

    // Reflect lockout: refresh row state, sync UI.
    const row = state.rows.find(x => x.uid === bookingState.uid);
    if (row) row.availability_status = 'Booked';
    syncAvailabilityUI(bookingState.uid, 'Booked');
  } catch (e) {
    showToast('Network error: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}
