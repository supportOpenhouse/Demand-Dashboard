// ── State ──────────────────────────────────────────────────────────────
const state = {
  user: null,
  rows: [],
  total: 0,
  // City-scoped pool count (no other filters). Drives the badge denominator
  // and the city-scoped half of the header subtitle.
  scopeTotal: 0,
  // Full pool count (no filters at all). Drives the "of N" tail of the
  // header subtitle so users see how the city scope compares to the whole.
  grandTotal: 0,
  openUid: null,
  sortKey: null,
  sortDir: 'desc',
  // Distinct filter values from the full supply-ready pool. Populated by /api/list
  // so the dropdowns stay stable regardless of currently-selected filters.
  // micromarketsByCity narrows the micromarket dropdown once a city is picked;
  // micromarkets is the flat fallback used when no city is selected.
  distinct: { cities: [], sources: [], pocs: [], micromarkets: [], micromarketsByCity: {} },
  filters: {
    search: '',
    city: '',
    // Multi-select: array of selected micromarket names. Empty = no restriction.
    micromarket: [],
    source: '',
    poc: '',
    affordable: '',
    availability: '',
    occupancy: '',
    dateField: 'ama_date',
    from: '',
    to: '',
  },
  // homeId (number) → string[] of image URLs, fetched from backend photos API.
  homePhotos: {},
  // core_home_id → { loading } | { code, home } | { error } — external listing
  // status, fetched lazily when a row is expanded (see fetchHomeStatus).
  homeStatus: {},
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
// 'Dead' is admin-only: only admins can pick it, and rows with it are hidden
// from /api/list for viewers + managers (backend-enforced).
const AVAILABILITY_OPTIONS = ['Available', 'Booked', 'Sold', 'Dead'];
const AVAILABILITY_CLASS = {
  'Available': 'avail-green',
  'Booked':    'avail-amber',
  'Sold':      'avail-red',
  'Dead':      'avail-gray',
};
function renderAvailabilityPill(value) {
  const v = value || 'Available';
  const cls = AVAILABILITY_CLASS[v] || 'avail-green';
  return `<span class="avail-pill ${cls}">${esc(v)}</span>`;
}

// Inline status selector for the Property section header. Posts to
// /api/demand-details via the delegated change handler. 'Dead' is only
// exposed to admins — the backend also enforces this, but hiding the option
// avoids UX confusion for managers.
function renderAvailabilityHeaderControl(r) {
  const current = r.availability_status || 'Available';
  const cls = AVAILABILITY_CLASS[current] || 'avail-green';
  const opts = AVAILABILITY_OPTIONS
    .filter(o => o !== 'Dead' || isAdmin() || current === 'Dead')
    .map(o => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o)}</option>`)
    .join('');
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
  // Strip any admin-only options from filter dropdowns for non-admins so they
  // can't select filters that would return zero rows for them (Dead units are
  // hidden server-side).
  if (!isAdmin()) {
    $$('option[data-admin-only]').forEach(opt => opt.remove());
  }
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

  $('#filterCity').addEventListener('change', (e) => {
    state.filters.city = e.target.value;
    // A micromarket belongs to one city, so switching city strands picks from the
    // old one — drop those rather than sending pairs that match nothing. Any pick
    // that also exists in the new city survives.
    const stillValid = micromarketsFor(state.filters.city);
    state.filters.micromarket = state.filters.micromarket.filter(m => stillValid.includes(m));
    loadData();
  });
  bindMicromarketFilter();
  $('#filterSource').addEventListener('change', (e) => { state.filters.source = e.target.value; loadData(); });
  $('#filterPoc').addEventListener('change', (e) => { state.filters.poc = e.target.value; loadData(); });
  $('#filterAffordable').addEventListener('change', (e) => { state.filters.affordable = e.target.value; loadData(); });
  $('#filterAvailability').addEventListener('change', (e) => { state.filters.availability = e.target.value; loadData(); });
  $('#filterOccupancy').addEventListener('change', (e) => { state.filters.occupancy = e.target.value; loadData(); });
  $('#filterDateField').addEventListener('change', (e) => { state.filters.dateField = e.target.value; loadData(); });
  $('#filterFrom').addEventListener('change', (e) => { state.filters.from = e.target.value; loadData(); });
  $('#filterTo').addEventListener('change', (e) => { state.filters.to = e.target.value; loadData(); });

  $('#clearDateBtn').addEventListener('click', () => {
    $('#filterFrom').value = ''; $('#filterTo').value = '';
    state.filters.from = ''; state.filters.to = '';
    loadData();
  });

  $('#clearAllBtn').addEventListener('click', () => {
    state.filters = { search: '', city: '', micromarket: [], source: '', poc: '', affordable: '',
                      availability: '', occupancy: '',
                      dateField: 'ama_date', from: '', to: '' };
    $('#searchInput').value = '';
    $('#filterCity').value = '';
    $('#filterMicromarketSearch').value = '';
    $('#filterSource').value = '';
    $('#filterPoc').value = '';
    $('#filterAffordable').value = '';
    $('#filterAvailability').value = '';
    $('#filterOccupancy').value = '';
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

  // Modals. Closing the booking modal flushes any unsaved edit first — waiting
  // for the next 10s tick would lose whatever was typed just before closing.
  const closingBookingModal = (id) => {
    if (id !== 'bookingModal') return;
    if (_draftDirty) saveBookingDraft({ quiet: true });
    stopBookingAutosave();
  };
  $$('[data-close]').forEach(b => b.addEventListener('click', () => {
    closingBookingModal(b.dataset.close);
    $('#' + b.dataset.close).classList.remove('open');
  }));
  $$('.modal-overlay').forEach(o => o.addEventListener('click', (e) => {
    if (e.target === o) { closingBookingModal(o.id); o.classList.remove('open'); }
  }));
  $('#addUserBtn').addEventListener('click', addUser);
  $('#forceLogoutAllBtn').addEventListener('click', forceLogoutAll);

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
  // Repeated param (?micromarket=A&micromarket=B) rather than a delimited string,
  // so a name containing the delimiter could never split into two filters.
  f.micromarket.forEach(m => q.append('micromarket', m));
  if (f.source) q.set('source', f.source);
  if (f.poc) q.set('poc', f.poc);
  if (f.affordable) q.set('affordable', f.affordable);
  if (f.availability) q.set('availability', f.availability);
  if (f.occupancy) q.set('occupancy', f.occupancy);
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
    if (typeof data.scopeTotal === 'number') state.scopeTotal = data.scopeTotal;
    if (typeof data.grandTotal === 'number') state.grandTotal = data.grandTotal;
    if (data.distinct) state.distinct = data.distinct;
    populateFilterDropdowns();
    renderTable();
    // Header subtitle: when a city is picked, show both the city scope and
    // the grand total ("Noida · 35 of 182 Properties") so the user sees the
    // share at a glance. Otherwise just the grand total. Other filters narrow
    // the count badge below, not this denominator.
    const sub = state.filters.city
      ? `${state.filters.city} · ${state.scopeTotal} of ${state.grandTotal} Properties`
      : `All Cities · ${state.grandTotal} Properties`;
    $('#headerSub').textContent = sub;
  } catch (e) {
    console.error(e);
    showToast('Network error', 'error');
  } finally {
    $('#loadingBox').style.display = 'none';
  }
}

// Micromarket options for a city — the full list when no city is picked.
// Falls back to the flat list if the backend couldn't resolve per-city buckets
// (master_societies missing the micro_market column projects NULL throughout).
function micromarketsFor(city) {
  const byCity = state.distinct.micromarketsByCity || {};
  if (city) return byCity[city] || [];
  return state.distinct.micromarkets || [];
}

// ── Micromarket multi-select ───────────────────────────────────────────
// A checkbox popover instead of a native <select> so several areas can be
// active at once. Options come from state.distinct, narrowed to the selected
// city; selections live in state.filters.micromarket as an array of names.

// Reloading on every checkbox tick would fire a request per click while the user
// is still picking, so ticks coalesce into one load shortly after they stop.
let mmApplyTimer = null;
function applyMicromarketFilter() {
  clearTimeout(mmApplyTimer);
  mmApplyTimer = setTimeout(loadData, 300);
}

function bindMicromarketFilter() {
  const wrap = $('#filterMicromarketWrap');

  $('#filterMicromarketBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = !wrap.classList.contains('open');
    wrap.classList.toggle('open', opening);
    $('#filterMicromarketBtn').setAttribute('aria-expanded', String(opening));
    if (opening) $('#filterMicromarketSearch').focus();
  });

  // Clicks inside the panel must not bubble to the document handler that closes it.
  $('#filterMicromarketPanel').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => closeMicromarketPanel());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMicromarketPanel(); });

  // Search narrows the visible options only — it never changes what's selected,
  // so a filtered-out pick stays active.
  $('#filterMicromarketSearch').addEventListener('input', renderMicromarketOptions);

  $('#filterMicromarketOptions').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const name = cb.value;
    const picked = new Set(state.filters.micromarket);
    cb.checked ? picked.add(name) : picked.delete(name);
    state.filters.micromarket = [...picked];
    updateMicromarketLabel();
    applyMicromarketFilter();
  });

  // Select all / Clear act on what's currently visible, so they compose with the
  // search box ("Dwarka" → Select all → every Dwarka area).
  wrap.querySelectorAll('[data-mm-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const visible = visibleMicromarkets();
      const picked = new Set(state.filters.micromarket);
      visible.forEach(m => btn.dataset.mmAction === 'all' ? picked.add(m) : picked.delete(m));
      state.filters.micromarket = [...picked];
      renderMicromarketOptions();
      applyMicromarketFilter();
    });
  });
}

function closeMicromarketPanel() {
  const wrap = $('#filterMicromarketWrap');
  if (!wrap || !wrap.classList.contains('open')) return;
  wrap.classList.remove('open');
  $('#filterMicromarketBtn').setAttribute('aria-expanded', 'false');
}

// Options matching the search box, within the current city scope.
function visibleMicromarkets() {
  const q = ($('#filterMicromarketSearch').value || '').trim().toLowerCase();
  const all = micromarketsFor(state.filters.city);
  return q ? all.filter(m => m.toLowerCase().includes(q)) : all;
}

function renderMicromarketOptions() {
  const box = $('#filterMicromarketOptions');
  const picked = new Set(state.filters.micromarket);
  const visible = visibleMicromarkets();

  box.innerHTML = visible.length
    ? visible.map(m => `
        <label class="multiselect-option">
          <input type="checkbox" value="${esc(m)}"${picked.has(m) ? ' checked' : ''}>
          <span>${esc(m)}</span>
        </label>`).join('')
    : '<div class="multiselect-empty">No micromarkets found</div>';

  updateMicromarketLabel();
}

// Toggle text mirrors the other filters when nothing or one thing is picked, and
// collapses to a count beyond that — names are too long to list in a filter bar.
function updateMicromarketLabel() {
  const picked = state.filters.micromarket;
  $('#filterMicromarketLabel').textContent =
    picked.length === 0 ? 'All Micromarkets'
    : picked.length === 1 ? picked[0]
    : `${picked.length} Micromarkets`;
  $('#filterMicromarketWrap').classList.toggle('active', picked.length > 0);
}

function populateFilterDropdowns() {
  // Pull from state.distinct (full supply-ready pool) — picking one filter
  // never strips options from the others. Micromarket is the one exception:
  // it's a strict sub-division of city, so it narrows to the selected city.
  fillSelect('#filterCity', state.distinct.cities || [], state.filters.city, 'All Cities');
  renderMicromarketOptions();
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
  $('#countBadge').textContent = `${rows.length} of ${state.scopeTotal} properties`;

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

// Shared by renderRow() and renderExpand(); must not live inside either.
const AUTO_PRICE_TIP = 'Auto-derived from the acquisition price. Edit to set your own.';

function renderRow(r) {
  const isOpen = r.uid === state.openUid;
  // Legacy rows (imported from CSV into legacy_properties) get an amber badge
  // so they're visually distinct from real supply-pipeline properties.
  const supplyBadge = r.origin === 'legacy'
    ? '<span class="supply-badge legacy" title="Imported from legacy CSV">Legacy</span>'
    : '';

  // An auto-derived price is marked so it is never mistaken for a quoted one.
  // The marker sits under the figure rather than beside it, so the price column
  // stays scannable.
  const listingPriceCell = r.listing_price != null
    ? `<span class="price-val">${esc(toLakhs(r.listing_price))}</span>`
      + (r.listing_price_is_auto ? `<span class="price-auto" title="${esc(AUTO_PRICE_TIP)}">A</span>` : '')
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

  // Dead units (admin-only) get a light-red row wash so they stand out from
  // live inventory. The class is also applied to the expand row for continuity.
  const deadCls = (r.availability_status === 'Dead') ? 'dead' : '';
  const dataRow = `
    <tr class="data-row ${isOpen ? 'open' : ''} ${deadCls}" data-uid="${esc(r.uid)}">
      <td><span class="toggle-arrow">▶</span></td>
      <td>
        <div class="prop-cell">
          <div class="prop-name">${esc(r.society_name || '—')} ${supplyBadge}</div>
          <div class="prop-unit">${(() => {
            const towerUnit = [r.tower_no, r.unit_no].filter(v => v != null && v !== '').map(esc).join('-');
            const floorPart = r.floor != null ? 'Floor-' + esc(r.floor) : '';
            return [towerUnit, floorPart].filter(Boolean).join('&nbsp;&nbsp;');
          })()}</div>
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
    <tr class="expand-row ${isOpen ? 'open' : ''} ${deadCls}" data-uid-expand="${esc(r.uid)}">
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

  // Acquisition price — the price Openhouse acquires the unit at. Read-only
  // here: the canonical source is `properties.guaranteed_sale_price` in the
  // openhouse-internal DB, owned by the Transaction dashboard's acquisition-price
  // approval flow. Already projected by /api/list (UNIFIED_COLS) and returned by
  // /api/detail via `p.*`, so no query change is needed. Legacy rows carry the
  // same column. The source column is free-text lakhs on the Transaction side,
  // so fall back to the raw string when it isn't numeric.
  //
  // Admin-only, and hidden outright (not shown as "— admin only" the way Listing
  // Price is) — manager/viewer must not see our cost basis at all. The API strips
  // the column for non-admins too, so this isn't the only gate.
  const acqRaw = r.guaranteed_sale_price;
  const acqPriceField = !isAdmin() ? '' : field(
    'Acquisition Price (Lakhs)',
    toLakhs(acqRaw) || (acqRaw != null && acqRaw !== '' ? String(acqRaw) : '')
  );

  // Listing price input — admin-only; editor/viewer see read-only.
  const listingPriceField = `
    <div class="field-row">
      <div class="field-lbl">Listing Price (Lakhs) ${isAdmin() ? '' : '<span class="admin-only-note">— admin only</span>'}${r.listing_price_is_auto ? `<span class="price-auto" title="${esc(AUTO_PRICE_TIP)}">A</span>` : ''}</div>
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
      ${field('OH ID', r.uid)}
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
      ${field('Affordable',
              r.affordable == null ? null : (r.affordable ? 'Yes' : 'No'),
              r.affordable === true ? 'green' : (r.affordable === false ? 'amber' : ''))}
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
      ${editableNum('Society Occupancy %', 'current_occupancy_pct', r.current_occupancy_pct, { uid: r.uid })}
    </div>`;

  // ── Section: Possession & Listing
  const sectionPossession = `
    <div class="expand-section">
      <h4>🔑 Possession & Listing</h4>
      ${acqPriceField}
      ${listingPriceField}
      ${isViewer() ? '' : field('Date of AMA', fmtDate(r.ama_date))}
      ${(() => {
        const done = keyHandoverDone(r);
        // Pending covers "date present but Form 9 not submitted yet" — the tooltip
        // says so, since a filled-in date otherwise makes Pending look like a bug.
        const tip = (!done && r.key_handover_date && r.origin !== 'legacy')
          ? 'Date recorded, but handover is not confirmed: Form 9 (Key Handover '
            + 'Acknowledgement) has not been submitted.'
          : '';
        return field('Key Handover Status', done ? 'Done' : 'Pending',
                     done ? 'green' : 'amber', tip);
      })()}
      ${isViewer()
        ? ''
        : editableDate('Key Handover Date', 'key_handover_date', r.key_handover_date, {
            uid: r.uid,
            adminOnly: true,
            readOnlyTooltip: 'Set by Form 9 (Key Handover Acknowledgement) in the supply forms. Admin-only correction.',
          })}
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
      ${renderUpdateHomeBlock(r)}
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
  const { uid, adminOnly, readOnlyTooltip } = opts;
  // Normalize value to YYYY-MM-DD for the picker
  let dateVal = '';
  if (value) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) dateVal = d.toISOString().slice(0, 10);
  }
  // adminOnly downgrades managers to the read-only view, with a tooltip
  // explaining where the value actually comes from.
  if (!canEdit() || (adminOnly && !isAdmin())) {
    return field(label, value ? fmtDate(value) : '',
                 readOnlyTooltip ? 'tooltipped' : '', readOnlyTooltip);
  }
  // type="text" so flatpickr can manage display via altInput. The original
  // input is hidden by flatpickr but stays the canonical YYYY-MM-DD source
  // (which the delegated change handler + /api/property-edits expect). The
  // visible alt input shows DD/MM/YYYY. flatpickr is wired up per-row in
  // attachExpandHandlers.
  return `
    <div class="field-row">
      <div class="field-lbl">${esc(label)}</div>
      <input type="text" class="inline-input flatpickr-date"
             data-uid="${esc(uid)}" data-field="${esc(fieldName)}" data-endpoint="property-edits"
             value="${esc(dateVal)}"
             placeholder="DD/MM/YYYY">
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

// Key Handover "Done" requires a witnessed handover, not an inferred one:
// Form 9 (Key Handover Acknowledgement) submitted AND a handover date on record.
// Form 9 writes both in a single statement, so in practice they arrive together.
//
// The supply pipeline's computed 'Key Handover Done' status is deliberately NOT
// accepted. That status is derived on read from seven gates (deal transfer, docs
// reviewed, draft AMA, seller approval, AMA date, handover date) and can flip to
// Done on its own when a future-dated handover date simply arrives — nothing
// actually happened. A date alone may also be the tentative value from Form 3 or
// a manual correction.
//
// Legacy rows never pass through the supply forms at all, so the date is the only
// signal that exists for them.
// Kept in sync with syncKeyHandoverVacancy() in api/list.js, which flips occupancy
// on the same definition.
function keyHandoverDone(r) {
  if (r.origin === 'legacy') return !!r.key_handover_date;
  return !!r.key_handover_date && !!r.final_submitted_at;
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

// ── External listing (Coming Soon) status + Update Home ─────────────────
// A dashboard row links to an external "home" via core_home_id (null for legacy
// rows). We surface the live external listing_status and an Update Home action
// in the Media section. Status is fetched lazily (one GET per row, on expand)
// and cached in state.homeStatus so re-renders don't refetch.
// Keyed by BOTH the update-API codes (CS/Rdy/Arc) and the get-home-details
// labels (Coming soon/Ready/Archive), since the two endpoints speak different
// vocabularies for the same states.
const HOME_STATUS_META = {
  CS:            { label: 'Coming Soon', bg: '#dbeafe', fg: '#1e40af' },
  'Coming soon': { label: 'Coming Soon', bg: '#dbeafe', fg: '#1e40af' },
  'Coming Soon': { label: 'Coming Soon', bg: '#dbeafe', fg: '#1e40af' },
  Rdy:           { label: 'Available',   bg: '#dcfce7', fg: '#166534' },
  Ready:         { label: 'Available',   bg: '#dcfce7', fg: '#166534' },
  Ava:           { label: 'Available',   bg: '#dcfce7', fg: '#166534' },
  Available:     { label: 'Available',   bg: '#dcfce7', fg: '#166534' },
  Sold:          { label: 'Sold',        bg: '#fee2e2', fg: '#991b1b' },
  Arc:           { label: 'Archived',    bg: '#f3f4f6', fg: '#6b7280' },
  Archive:       { label: 'Archived',    bg: '#f3f4f6', fg: '#6b7280' },
  Archived:      { label: 'Archived',    bg: '#f3f4f6', fg: '#6b7280' },
};

function homeStatusBadgeStyle(bg, fg) {
  return `display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${bg};color:${fg};`;
}

function renderHomeStatusBadge(entry) {
  if (!entry || entry.loading) {
    return `<span style="${homeStatusBadgeStyle('#f3f4f6', '#6b7280')}">⏳ Checking…</span>`;
  }
  if (entry.error) {
    return `<span title="${esc(entry.error)}" style="${homeStatusBadgeStyle('#f3f4f6', '#6b7280')}">Status unavailable</span>`;
  }
  const m = HOME_STATUS_META[entry.code] || { label: entry.code || 'Unknown', bg: '#f3f4f6', fg: '#374151' };
  return `<span style="${homeStatusBadgeStyle(m.bg, m.fg)}">${esc(m.label)}</span>`;
}

// Pulls the listing status out of the (loosely-typed) get-home-details payload.
function extractListingStatus(home) {
  if (!home || typeof home !== 'object') return null;
  return home.listingStatus || home.listing_status || home.status
      || (home.home && (home.home.listingStatus || home.home.listing_status)) || null;
}

async function fetchHomeStatus(coreHomeId, force) {
  if (coreHomeId == null) return;
  const cur = state.homeStatus[coreHomeId];
  if (!force && cur && (cur.loading || cur.code)) return; // already loading/resolved
  state.homeStatus[coreHomeId] = { loading: true };
  updateHomeStatusBadge(coreHomeId);
  try {
    const r = await fetch('/api/core-home/details?id=' + encodeURIComponent(coreHomeId), { credentials: 'include' });
    const data = await r.json();
    state.homeStatus[coreHomeId] = (!r.ok || !data.success)
      ? { error: data.error || ('HTTP ' + r.status) }
      : { code: extractListingStatus(data.home), home: data.home };
  } catch (e) {
    state.homeStatus[coreHomeId] = { error: e.message };
  }
  updateHomeStatusBadge(coreHomeId);
}

function updateHomeStatusBadge(coreHomeId) {
  document.querySelectorAll(`[data-home-status-for="${cssEscape(String(coreHomeId))}"]`).forEach(el => {
    el.innerHTML = renderHomeStatusBadge(state.homeStatus[coreHomeId]);
  });
}

// The Media-section block: live status badge + Update Home button. Only for
// admin/manager, and only when the row is linked to a core home.
function renderUpdateHomeBlock(r) {
  if (!canEdit()) return '';
  if (r.core_home_id == null) {
    return `
      <div class="field-row" style="margin-top:14px;">
        <div class="field-lbl">Listing</div>
        <span class="field-val muted">Not linked to a core home</span>
      </div>`;
  }
  return `
    <div class="update-home-row" style="margin-top:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div class="field-lbl" style="min-width:auto;">Listing</div>
      <span data-home-status-for="${esc(r.core_home_id)}">${renderHomeStatusBadge(state.homeStatus[r.core_home_id])}</span>
      <button type="button" class="btn btn-primary"
              data-update-home-uid="${esc(r.uid)}" data-core-home-id="${esc(r.core_home_id)}">
        🏠 Update Home
      </button>
    </div>`;
}

// ── Inline edits ───────────────────────────────────────────────────────
// All `change` events bubble to the document and are handled by the delegated
// listener below. attachExpandHandlers only adds bindings that don't bubble
// reliably (lightbox click on gallery thumbs).
function attachExpandHandlers(uid) {
  const expandTr = document.querySelector(`tr.expand-row[data-uid-expand="${cssEscape(uid)}"]`);
  if (!expandTr) return;

  // Lazy-load the external listing status for this row (cached in state).
  const row = state.rows.find(x => x.uid === uid);
  if (row && row.core_home_id != null && canEdit()) fetchHomeStatus(row.core_home_id);

  // Initialize flatpickr on date inputs so they display DD/MM/YYYY instead
  // of the browser-locale default (US locale renders <input type=date> as
  // MM/DD/YYYY which trips up Indian users). The underlying value stays
  // YYYY-MM-DD, which is what saveField + /api/property-edits expect.
  if (window.flatpickr) {
    expandTr.querySelectorAll('input.flatpickr-date').forEach(input => {
      if (input._flatpickr) return;
      flatpickr(input, {
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'd/m/Y',
        allowInput: false,
      });
    });
  }

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
    const row = state.rows.find(x => x.uid === uid);
    const prev = row ? (row.availability_status || 'Available') : null;

    // Releasing a booked unit is the cancellation case — a mail has usually
    // already gone out to the buyer. Confirm before saving, and put the select
    // back if the user backs out so the UI never shows an unsaved status.
    if (prev === 'Booked' && el.value === 'Available' && !confirm(
      'Release this unit back to Available?\n\n' +
      'It is currently Booked and a booking may already have been mailed to the buyer. ' +
      'The existing booking record is kept as history, and this change is recorded in the activity log against your account.\n\n' +
      'You can submit a fresh booking for the unit afterwards.'
    )) {
      el.value = prev;
      syncAvailabilityUI(uid, prev);
      return;
    }

    syncAvailabilityUI(uid, el.value);
  }

  // Key Handover Date already carries a value: warn before overwriting. The date
  // normally comes from Form 9 (Key Handover Acknowledgement), so replacing one
  // puts this dashboard out of step with the form's record — and, through the
  // auto-vacant rule, can re-label the unit's occupancy. Admin-only field, so
  // this confirm is the last guard before an intentional correction.
  if (el.dataset.field === 'key_handover_date') {
    const row = state.rows.find(x => x.uid === uid);
    const prev = row ? row.key_handover_date : null;
    if (prev && !confirm(
      'Overwrite the existing Key Handover Date?\n\n' +
      `Current value: ${fmtDate(prev)}\n\n` +
      'This date is normally set by Form 9 (Key Handover Acknowledgement) in the supply forms. ' +
      'Changing it here will not update that form, and it may flip the unit\'s occupancy to Vacant. ' +
      'The change is recorded in the activity log against your account.'
    )) {
      // Put the picker back so the UI never shows a value that was not saved.
      const revertTo = isoDateOnly(prev);
      if (el._flatpickr) el._flatpickr.setDate(revertTo || null, false);
      else el.value = revertTo;
      return;
    }
  }

  saveField(uid, el);
});

// YYYY-MM-DD for a date value, or '' when absent/unparseable — the format both
// flatpickr and /api/property-edits expect.
function isoDateOnly(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// Update all DOM nodes tied to a uid's availability_status: header select color,
// main row pill, row-level Dead highlight, and Submit Details button visibility.
function syncAvailabilityUI(uid, value) {
  const cls = AVAILABILITY_CLASS[value] || 'avail-green';

  // Header select
  const sel = document.querySelector(`select.avail-select[data-uid="${cssEscape(uid)}"]`);
  if (sel) {
    sel.classList.remove('avail-green', 'avail-amber', 'avail-red', 'avail-gray');
    sel.classList.add(cls);
  }

  // Main row pill — the row uses a separate <span> render; safest to just
  // replace its outerHTML rather than mutate classes (the row may be collapsed
  // or open, and we control the pill rendering centrally).
  const row = document.querySelector(`tr.data-row[data-uid="${cssEscape(uid)}"]`);
  if (row) {
    const pill = row.querySelector('.avail-pill');
    if (pill) pill.outerHTML = renderAvailabilityPill(value);
    row.classList.toggle('dead', value === 'Dead');
  }
  const expandRow = document.querySelector(`tr.expand-row[data-uid-expand="${cssEscape(uid)}"]`);
  if (expandRow) expandRow.classList.toggle('dead', value === 'Dead');

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
    ['Key Handover Status', r => keyHandoverDone(r) ? 'Done' : 'Pending'],
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

// Bulk force-logout. Invalidates every other user's session at once — same
// mechanism as the per-row 🚪 button, applied across the table server-side.
// Two-step confirm because it is disruptive and there is no undo: everyone
// signed in is bounced to the login screen on their next request.
async function forceLogoutAll() {
  const btn = $('#forceLogoutAllBtn');
  if (!confirm('Force logout ALL other users?\n\nEvery signed-in user except you will be signed out immediately and must sign in again. This cannot be undone.')) return;

  btn.disabled = true;
  try {
    const r = await fetch('/api/users/force-logout-all', {
      method: 'POST', credentials: 'include',
    });
    const data = await r.json();
    if (!data.success) {
      showToast(data.error || 'Failed to force logout all', 'error');
    } else {
      showToast(`Signed out ${data.count} user${data.count === 1 ? '' : 's'}`, 'success');
    }
  } finally {
    btn.disabled = false;
  }
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
  previewMode: 'buyer', // 'buyer' | 'cp' — which mail Step 3 is showing/sending
  cpId: null,           // channel_partners.id once a CP is resolved
  draftId: null,        // booking_details row being autosaved into
  loadedCp: null,       // { email, code } the loaded row's details belong to
  form: {},
};

// Who the booking belongs to, as both identifiers. Kept as a pair rather than a
// single key because the two sides are not always populated the same way — a
// stored row may carry only the email while the form carries only the code, and
// collapsing that into one string makes the same CP look like a different one.
function cpIdentity(email, code) {
  return {
    email: String(email || '').trim().toLowerCase() || null,
    code: String(code || '').trim().toUpperCase() || null,
  };
}

// Source now leads page 1 and decides whether a channel partner is involved at
// all. Direct means there is no CP, so the lookup is hidden rather than blocking
// a booking that can never satisfy it.
function isDirectDeal() {
  return currentSource() === 'Direct';
}

function applyDirectDeal(direct) {
  const block = $('.cp-lookup');
  if (block) block.classList.toggle('is-direct', direct);
  if (direct) {
    bookingState.cpId = null;
    ['cpLookupCode', 'cpLookupPhone', 'cpName', 'cpCompany']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const m = $('#cpLookupMatches'); if (m) { m.hidden = true; m.innerHTML = ''; }
    setCpFieldsLocked(true);
    cpStatus('');
  }
}

function currentCpIdentity() {
  return cpIdentity(bookingState.brokers[0], (($('#cpLookupCode') || {}).value) || '');
}

// Compare on the code when both sides have one — it is the stable key — else on
// the email. When there is nothing comparable, treat it as the SAME CP: this
// decides whether to wipe the operator's booking terms, and an uncertain answer
// must never destroy data.
function isSameCp(a, b) {
  if (!a || !b) return true;
  if (a.code && b.code) return a.code === b.code;
  if (a.email && b.email) return a.email === b.email;
  return true;
}

// Wipe page 2 — the booking terms — leaving the CP block and recipients alone.
// Used when the CP changes, because a rebooking through a different partner is
// a different deal and the previous buyer's figures must not carry over.
function clearBookingDetailFields() {
  document.querySelectorAll('#bookingModal .booking-page[data-page="2"] [data-bf]')
    .forEach(el => {
      if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });
  bookingState.payMode = 'single';
  applyPayMode('single');
  applyPayStructure('');
  applyBrokerageTiming();
  refreshAllAmountHints();
}

// ── Draft autosave ──────────────────────────────────────────────────────────
// The booking used to reach the database only when the mail was sent, so a
// closed tab lost everything typed. It is now saved as a draft while the
// operator types and on every step change.
//
// The draft deliberately does NOT mark the unit Booked — only a sent booking
// does that — and it updates one row rather than inserting per keystroke.
let _draftTimer = null;
let _draftInFlight = false;
let _draftTicker = null;
let _draftDirty = false;

// Save on a fixed 10s cadence while the modal is open, but only when something
// actually changed — a ticker that writes an unchanged row every 10s is just
// load. Edits set the dirty flag; a successful save clears it.
function startBookingAutosave() {
  stopBookingAutosave();
  _draftTicker = setInterval(() => {
    if (_draftDirty && !_draftInFlight) saveBookingDraft({ quiet: true });
  }, 10000);
}

function stopBookingAutosave() {
  clearInterval(_draftTicker);
  _draftTicker = null;
  clearTimeout(_draftTimer);
  _draftTimer = null;
}

let _draftChain = Promise.resolve();

// Queue behind any save already running rather than skipping — dropping a save
// loses whatever was typed since the one in flight started.
function saveBookingDraft(opts = {}) {
  _draftChain = _draftChain.then(() => doSaveBookingDraft(opts)).catch(() => {});
  return _draftChain;
}

async function doSaveBookingDraft({ quiet = true } = {}) {
  if (!bookingState.uid) return false;
  _draftInFlight = true;
  try {
    const form = collectBookingForm();
    const r = await fetch('/api/booking-details/' + encodeURIComponent(bookingState.uid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: 'save',
        booking_id: bookingState.draftId,
        recipients: bookingState.recipients,
        broker_emails: bookingState.brokers,
        selling_cp_id: bookingState.cpId,
        selling_cp_email: bookingState.brokers[0] || null,
        ...form,
      }),
    });
    const data = await r.json();
    if (r.ok && data.success && data.id) {
      bookingState.draftId = data.id;       // subsequent saves update this row
      _draftDirty = false;
      markBookingSaved();
      if (!quiet) showToast('Draft saved', 'success');
      return true;
    }
    if (!quiet) showToast(data.error || 'Could not save draft', 'error');
    return false;
  } catch (e) {
    // Autosave is best-effort: a dropped save must never block data entry.
    if (!quiet) showToast('Could not save draft: ' + e.message, 'error');
    return false;
  } finally {
    _draftInFlight = false;
  }
}

// Timestamp in the footer so a save is visibly confirmed, whether it came from
// the button, a step change, or the ticker.
function markBookingSaved() {
  const hint = $('#bookingSaveHint');
  if (!hint) return;
  hint.textContent = 'Saved ' + new Date().toLocaleTimeString();
  hint.classList.add('is-saved');
}

// Called on every edit: flag the change and let the 10s ticker pick it up.
function scheduleBookingDraft() {
  _draftDirty = true;
}

// ── Selling channel partner lookup ──────────────────────────────────────────
// Resolve the CP from its code or registered phone instead of asking for an
// email up front. channel_partners lives in a separate database, so what we
// find is snapshotted onto the booking row (see api/_db.js).
//
// The email is the one field the lookup cannot fill — it is empty for every CP
// upstream — so it is typed here and written back after a successful send.
function cpStatus(msg, kind) {
  const el = $('#cpLookupStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'cp-lookup-status' + (kind ? ' is-' + kind : '');
}

// The CP detail fields stay locked until a partner is actually resolved — an
// email typed against no CP cannot be filed against anyone, and would be written
// back to nothing. Unlocked only by applyCpMatch().
function setCpFieldsLocked(locked) {
  document.querySelectorAll('#bookingModal [data-cp-field]').forEach(el => {
    el.readOnly = locked;
    el.classList.toggle('is-locked', locked);
  });
  // The CP's email is captured by the existing broker box — there is no second
  // field for it — so that box follows the same rule: no CP, no email.
  const broker = document.getElementById('bookingNewBroker');
  if (broker) {
    broker.readOnly = locked;
    broker.classList.toggle('is-locked', locked);
    broker.placeholder = locked ? 'Look up a CP first' : 'Add CP email…';
  }
  const addBtn = document.getElementById('bookingAddBroker');
  if (addBtn) addBtn.disabled = locked;
}

function resetCpLookup() {
  bookingState.cpId = null;
  ['cpLookupCode', 'cpLookupPhone', 'cpName', 'cpCompany']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const m = $('#cpLookupMatches'); if (m) { m.hidden = true; m.innerHTML = ''; }
  setCpFieldsLocked(true);
  cpStatus('');
}

// Fill the form from one resolved CP.
function applyCpMatch(cp) {
  bookingState.cpId = cp.id;
  const src = document.querySelector('#bookingModal [data-bf="source"]');
  if (src && src.value !== 'CP') { src.value = 'CP'; applySource('CP'); }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; };
  set('cpLookupCode', cp.cpCode);
  set('cpLookupPhone', cp.phone);
  set('cpName', cp.name);
  set('cpCompany', cp.company);

  setCpFieldsLocked(false);
  const m = $('#cpLookupMatches'); if (m) { m.hidden = true; m.innerHTML = ''; }

  // A stored email goes straight into the CP recipient chips; when the record
  // has none the operator adds it there, and it is written back on send.
  if (cp.email) {
    const e = String(cp.email).toLowerCase();
    if (!bookingState.brokers.includes(e)) {
      bookingState.brokers.push(e);
      renderBookingBrokers();
    }
  }

  cpStatus(`Matched ${cp.cpCode} — ${cp.name}${cp.company ? ' · ' + cp.company : ''}`, 'ok');
}

function renderCpMatches(matches) {
  const el = $('#cpLookupMatches');
  if (!el) return;
  el.innerHTML = matches.map((m, i) => `
    <button type="button" class="cp-match" data-cp-idx="${i}">
      <span class="code">${esc(m.cpCode)}</span>
      <span>${esc(m.name || '')}</span>
      <span class="meta">${esc([m.company, m.city, m.phone].filter(Boolean).join(' · '))}</span>
    </button>`).join('');
  el.hidden = false;
  bookingState.cpMatches = matches;
}

// Live search. Fires from a debounced input once the value looks complete —
// a full 10-digit phone, or a CP code of plausible length — so the operator
// never has to press anything. `seq` guards against an earlier, slower response
// overwriting a newer one when someone keeps typing.
let _cpSeq = 0;
let _cpTimer = null;

function cpLookupKeys() {
  const code = (($('#cpLookupCode') || {}).value || '').trim();
  const phoneRaw = (($('#cpLookupPhone') || {}).value || '').trim();
  const digits = phoneRaw.replace(/\D/g, '').slice(-10);
  return { code, phoneRaw, digits };
}

// Ready to search? Code is the unique key so it wins; 6965 of 6971 codes are
// exactly CP#####, and the handful of others are 4+ char admin rows.
function cpLookupReady() {
  const { code, digits } = cpLookupKeys();
  if (code) return /^cp\d{5}$/i.test(code) || code.length >= 4;
  return digits.length === 10;
}

function scheduleCpLookup() {
  clearTimeout(_cpTimer);
  if (!cpLookupReady()) { cpStatus(''); return; }
  _cpTimer = setTimeout(lookupChannelPartner, 300);
}

async function lookupChannelPartner() {
  const { code, phoneRaw } = cpLookupKeys();
  if (!code && !phoneRaw) { cpStatus(''); return; }

  const seq = ++_cpSeq;
  cpStatus('Searching…');
  try {
    const qs = new URLSearchParams();
    // Code is the unique key, so it wins when both are filled.
    if (code) qs.set('code', code); else qs.set('phone', phoneRaw);
    const r = await fetch('/api/cp-lookup?' + qs, { credentials: 'include' });
    const data = await r.json();
    if (seq !== _cpSeq) return;   // a newer keystroke already superseded this
    if (!r.ok || !data.success) { cpStatus(data.error || 'Lookup failed', 'error'); return; }

    if (!data.matches.length) {
      bookingState.cpId = null;
      setCpFieldsLocked(true);
      cpStatus('No channel partner found for that code or phone. Check it and try again.', 'error');
      return;
    }
    if (data.matches.length === 1) { applyCpMatch(data.matches[0]); return; }
    // One phone in the source data maps to two CP codes, so never guess.
    renderCpMatches(data.matches);
    cpStatus(`${data.matches.length} channel partners share that number — pick one.`, 'warn');
  } catch (e) {
    if (seq === _cpSeq) cpStatus('Network error: ' + e.message, 'error');
  }
}

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
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '📨 Send Buyer Mail'; }
  const cpSendBtn = $('#bookingSendCpBtn');
  if (cpSendBtn) { cpSendBtn.disabled = false; cpSendBtn.textContent = '📨 Send CP Mail'; }
  bookingState.recipients = [];
  bookingState.brokers = [];
  bookingState.cpId = null;
  bookingState.cpMatches = [];
  bookingState.draftId = null;
  bookingState.loadedCp = null;
  const srcEl = document.querySelector('#bookingModal [data-bf="source"]');
  if (srcEl) srcEl.value = '';
  applyDirectDeal(false);
  _draftDirty = false;
  startBookingAutosave();
  resetCpLookup();
  bookingState.fixedRecipients = [];
  bookingState.paymentMethods = [];
  bookingState.payMode = 'single';
  bookingState.previewMode = 'buyer';
  applyPayMode('single');
  setBF('source', 'CP');
  applySource('CP');
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

  // Prefill from the latest booking row, sent or not. A mailed booking stays
  // editable — corrections land on that row — while sending again still forks a
  // fresh row for the rebooking.
  if (data.latest) {
    const l = data.latest;
    bookingState.draftId = l.id != null ? l.id : null;
    bookingState.loadedCp = (l.selling_cp_email || l.selling_cp_code)
      ? cpIdentity(l.selling_cp_email, l.selling_cp_code) : null;
    // Source is stored on the row, so reopening restores whether this booking
    // involved a CP at all.
    if (l.source) { setBF('source', l.source); applySource(l.source); }
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
    setBF('source', l.source || 'CP');
    setBF('brokerage_amount', l.brokerage_amount);
    setBF('brokerage_timing', l.brokerage_timing);
    if (l.payment_structure) {
      applyPayStructure(l.payment_structure);
      setBF('payment_range_min_pct', l.payment_range_min_pct);
      setBF('payment_range_max_pct', l.payment_range_max_pct);
    }
    setBF('brokerage_ats_amount', l.brokerage_ats_amount);
    setBF('brokerage_registry_amount', l.brokerage_registry_amount);
    applySource(l.source || 'CP');
    applyBrokerageTiming();
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

  // A prior booking was already mailed. Re-submitting is the cancellation /
  // rebooking case — allowed for managers and admins — so warn rather than
  // block; the new submission is saved as a fresh row and the old one is kept.
  if (data.locked) {
    showToast('This unit already has a submitted booking. Submitting again records a rebooking.', 'warn');
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
  scheduleBookingDraft();
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
// Payment Structure mirrors Payment Mode's segmented control. The chosen value
// lives in a hidden [data-bf] input so it flows through collectBookingForm()
// like every other field; the tabs are just the control surface.
//
// Flexible means the payable share is a negotiated band rather than a fixed
// figure, so it reveals a Min/Max pair. Switching to Non-Flexible clears that
// pair — a stale range must not travel with a booking that no longer has one.
function applyPayStructure(value) {
  const hidden = document.querySelector('#bookingModal [data-bf="payment_structure"]');
  if (hidden) hidden.value = value || '';
  document.querySelectorAll('#bookingModal .pay-mode-tab[data-pay-structure]').forEach(t => {
    const active = t.dataset.payStructure === value;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const range = document.querySelector('#bookingModal [data-pay-structure-range]');
  const flexible = value === 'Flexible';
  if (range) range.style.display = flexible ? '' : 'none';
  if (!flexible) {
    clearBF('payment_range_min_pct');
    clearBF('payment_range_max_pct');
  }
}

function applyPayMode(mode) {
  bookingState.payMode = mode;
  document.querySelectorAll('#bookingModal .pay-mode-tab[data-pay-mode]').forEach(t => {
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

// When brokerage is payable at both ATS and Registry, the two legs must sum to
// the total — the server rejects a split that doesn't. So whichever leg the
// operator types, the other is derived, and editing the total re-derives from
// whichever leg is already filled.
//
// Assigning .value does not fire an `input` event, so the counterpart's own
// handler never runs and there is no feedback loop.
function recomputeBrokerageSplit(changedField) {
  const q = f => document.querySelector(`#bookingModal [data-bf="${f}"]`);
  const totalEl = q('brokerage_amount');
  const atsEl = q('brokerage_ats_amount');
  const regEl = q('brokerage_registry_amount');
  if (!totalEl || !atsEl || !regEl) return;

  const total = parseFloat(totalEl.value);
  if (isNaN(total)) return;

  // Clamp to [0, total]: a leg larger than the whole brokerage is never valid,
  // and a negative counterpart would be nonsense on screen.
  const derive = (fromEl, toEl) => {
    const v = parseFloat(fromEl.value);
    if (isNaN(v)) { toEl.value = ''; updateAmountHint(toEl); return; }
    const other = Math.min(Math.max(Math.round((total - v) * 100) / 100, 0), total);
    toEl.value = other;
    updateAmountHint(toEl);
  };

  if (changedField === 'brokerage_ats_amount') derive(atsEl, regEl);
  else if (changedField === 'brokerage_registry_amount') derive(regEl, atsEl);
  else if (changedField === 'brokerage_amount') {
    // The total moved: keep whichever leg was typed and re-derive the other.
    if (String(atsEl.value).trim() !== '') derive(atsEl, regEl);
    else if (String(regEl.value).trim() !== '') derive(regEl, atsEl);
  }
}

// Current Source select value ('CP' | 'Direct'), defaulting to 'CP'.
// The raw selection, empty until the operator picks one — Next requires it.
function currentSourceRaw() {
  const el = document.querySelector('#bookingModal [data-bf="source"]');
  return (el && el.value) || '';
}

function currentSource() {
  const el = document.querySelector('#bookingModal [data-bf="source"]');
  return (el && el.value) || 'CP';
}

// Clears a booking field's value and refreshes its lakhs/crores hint (if any).
function clearBF(field) {
  const el = document.querySelector(`#bookingModal [data-bf="${cssEscape(field)}"]`);
  if (el) { el.value = ''; updateAmountHint(el); }
}

// Toggles Source-dependent UI: the brokerage amount label ('paid' vs 'collected'),
// the CP-only payment-schedule block, and the footer's CP buttons. In Direct mode
// the CP-only fields are cleared so they aren't submitted.
function applySource(mode) {
  applyDirectDeal(mode === 'Direct');
  document.querySelectorAll('#bookingModal [data-source-show]').forEach(el => {
    el.style.display = el.dataset.sourceShow === mode ? '' : 'none';
  });
  document.querySelectorAll('#bookingModal [data-source-label]').forEach(el => {
    el.style.display = el.dataset.sourceLabel === mode ? '' : 'none';
  });
  if (mode === 'Direct') {
    clearBF('brokerage_timing');
    clearBF('brokerage_ats_amount');
    clearBF('brokerage_registry_amount');
  }
  applyBrokerageTiming();
  refreshBookingFooter();
}

// Reveals the ATS/Registry split inputs only when brokerage is payable at both;
// clears them otherwise so a stale split isn't submitted.
function applyBrokerageTiming() {
  const timing = document.querySelector('#bookingModal [data-bf="brokerage_timing"]')?.value || '';
  const split = document.querySelector('#bookingModal [data-brokerage-split]');
  const show = timing === 'ATS & Registry' && currentSource() === 'CP';
  if (split) split.style.display = show ? 'grid' : 'none';
  if (!show) {
    clearBF('brokerage_ats_amount');
    clearBF('brokerage_registry_amount');
  }
}

// Footer button visibility by step + previewMode + source. CP buttons only
// appear when Source = CP; the Step-3 Send button matches the previewed mail.
function refreshBookingFooter() {
  const step = bookingState.step;
  const isCp = currentSource() === 'CP';
  $('#bookingBackBtn').style.display = step === 1 ? 'none' : '';
  $('#bookingNextBtn').style.display = step === 1 ? '' : 'none';

  // Explicit save — the autosave still runs, but this gives a definite "it is
  // stored" moment before sending rather than trusting a timer.
  $('#bookingSaveBtn').style.display = step === 3 ? 'none' : '';

  const onDetails = step === 2;
  $('#bookingPreviewBtn').style.display = onDetails ? '' : 'none';
  $('#bookingPreviewCpBtn').style.display = (onDetails && isCp) ? '' : 'none';

  const onPreview = step === 3;
  $('#bookingSendBtn').style.display = (onPreview && bookingState.previewMode === 'buyer') ? '' : 'none';
  $('#bookingSendCpBtn').style.display = (onPreview && bookingState.previewMode === 'cp') ? '' : 'none';
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

  // Footer button visibility — delegated so the buyer/CP button pairs stay in
  // sync with the current step, previewed mail, and Source.
  refreshBookingFooter();
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
  // The two legs may use the same instrument (e.g. two separate UPI transfers),
  // so identical methods are allowed — only the split amounts are constrained.
  return missing;
}

// Validate the brokerage fields before previewing/sending the CP (broker) mail.
// Independent of the buyer-mail validation so the two flows never block each other.
function validateCpForm(form) {
  const missing = [];
  const has = k => form[k] || form[k] === 0;
  if (!has('brokerage_amount')) missing.push('Brokerage amount');
  if (!form.payment_structure) missing.push('Payment Structure');
  if (form.payment_structure === 'Flexible') {
    const lo = parseFloat(form.payment_range_min_pct);
    const hi = parseFloat(form.payment_range_max_pct);
    if (isNaN(lo)) missing.push('Payment Range Min (%)');
    if (isNaN(hi)) missing.push('Payment Range Max (%)');
    if (!isNaN(lo) && !isNaN(hi) && lo > hi) missing.push('Payment Range Min must not exceed Max');
  }
  if (!form.brokerage_timing) missing.push('Brokerage payable (timing)');
  if (form.brokerage_timing === 'ATS & Registry') {
    if (!has('brokerage_ats_amount')) missing.push('Brokerage at ATS');
    if (!has('brokerage_registry_amount')) missing.push('Brokerage at Registry');
    const a = parseFloat(form.brokerage_ats_amount);
    const r = parseFloat(form.brokerage_registry_amount);
    const total = parseFloat(form.brokerage_amount);
    if (!isNaN(a) && !isNaN(r) && !isNaN(total) && Math.abs((a + r) - total) > 0.01) {
      missing.push(`ATS + Registry split must total the brokerage amount (${total})`);
    }
  }
  return missing;
}

const EMAIL_RE_FE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fold any email still sitting in the "Add CP RM" / "Add CP" inputs (typed but
// not committed with the + Add button) into the recipient / broker lists. Guards
// the common miss where a user types an address, skips + Add, and sends without
// it — which is why a CP/CP-RM address can silently not receive the mail.
function flushPendingBookingInputs() {
  const recEl = $('#bookingNewRecipient');
  const rec = (recEl?.value || '').trim();
  if (rec && EMAIL_RE_FE.test(rec) &&
      !bookingState.recipients.some(e => e.toLowerCase() === rec.toLowerCase())) {
    bookingState.recipients.push(rec);
    if (recEl) recEl.value = '';
    renderBookingRecipients();
  }
  const brkEl = $('#bookingNewBroker');
  const brk = (brkEl?.value || '').trim().toLowerCase();
  if (brk && EMAIL_RE_FE.test(brk) &&
      !bookingState.brokers.some(b => b.toLowerCase() === brk)) {
    bookingState.brokers.push(brk);
    if (brkEl) brkEl.value = '';
    renderBookingBrokers();
  }
}

// Bind modal buttons (once)
(function bindBookingModal() {
  document.addEventListener('click', (e) => {
    // Add recipient
    if (e.target.matches('[data-cp-field], #bookingNewBroker') && e.target.readOnly) {
      cpStatus('Please enter a CP phone number or CP code first.', 'error');
      const code = $('#cpLookupCode'); if (code) code.focus();
      return;
    }
    const cpPick = e.target.closest('[data-cp-idx]');
    if (cpPick) {
      const m = (bookingState.cpMatches || [])[Number(cpPick.dataset.cpIdx)];
      if (m) applyCpMatch(m);
      return;
    }
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
    const structTab = e.target.closest('#bookingModal .pay-mode-tab[data-pay-structure]');
    if (structTab) {
      applyPayStructure(structTab.dataset.payStructure);
      scheduleBookingDraft();
      return;
    }
    const payTab = e.target.closest('#bookingModal .pay-mode-tab[data-pay-mode]');
    if (payTab) {
      applyPayMode(payTab.dataset.payMode);
    }
    // Next
    if (e.target.id === 'bookingSaveBtn') {
      const btn = e.target;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Saving…';
      saveBookingDraft({ quiet: false }).finally(() => {
        btn.disabled = false;
        btn.textContent = label;
      });
      return;
    }
    if (e.target.id === 'bookingNextBtn') {
      if (bookingState.step === 1) {
        // Commit any email typed but not yet + Added so it isn't dropped.
        flushPendingBookingInputs();
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
        if (!currentSourceRaw()) {
          showToast('Select a Source — CP or Direct', 'error');
          document.querySelector('#bookingModal [data-bf="source"]')?.focus();
          return;
        }
        if (!isDirectDeal() && !bookingState.cpId) {
          showToast('Look up the selling CP, or set Source to Direct', 'error');
          $('#cpLookupCode')?.focus();
          return;
        }

        // A different CP on an existing row means a rebooking through another
        // partner: the previous buyer's terms are not ours to carry forward, so
        // page 2 is wiped before it is shown. The same CP keeps its details,
        // prefilled and editable.
        const cpNow = isDirectDeal() ? null : currentCpIdentity();
        if (!isDirectDeal() && bookingState.loadedCp && !isSameCp(bookingState.loadedCp, cpNow)) {
          clearBookingDetailFields();
          showToast('Different CP — previous booking details cleared for a fresh booking', 'warn');
        }
        bookingState.loadedCp = cpNow;   // don't re-clear on the next Next

        // Persist the CP block, and the cleared terms, before leaving page 1.
        saveBookingDraft({ quiet: true }).then(ok => {
          if (!ok) showToast('Could not save the CP details — check your connection', 'error');
        });
        goToBookingStep(2);
      }
    }
    // Back
    if (e.target.id === 'bookingBackBtn') {
      if (bookingState.step > 1) {
        saveBookingDraft({ quiet: true });
        goToBookingStep(bookingState.step - 1);
      }
    }
    // Buyer Mail Preview (page 2 → server preview → page 3)
    if (e.target.id === 'bookingPreviewBtn') {
      saveBookingDraft({ quiet: true });
      const form = collectBookingForm();
      const missing = validateBookingForm(form);
      if (missing.length) {
        showToast('Missing required fields: ' + missing.join(', '), 'error');
        return;
      }
      generateBookingPreview('buyer');
    }
    // CP Mail Preview
    if (e.target.id === 'bookingPreviewCpBtn') {
      const form = collectBookingForm();
      const missing = validateCpForm(form);
      if (missing.length) {
        showToast('CP mail — missing/invalid: ' + missing.join(', '), 'error');
        return;
      }
      generateBookingPreview('cp');
    }
    // Send buyer / CP mail
    if (e.target.id === 'bookingSendBtn') {
      sendBookingMail('buyer');
    }
    if (e.target.id === 'bookingSendCpBtn') {
      sendBookingMail('cp');
    }
  });

  // Source / brokerage-timing selects (change, not input, for <select>)
  document.addEventListener('change', (e) => {
    const field = e.target?.dataset?.bf;
    if (field === 'source') applySource(e.target.value);
    if (field === 'brokerage_timing') applyBrokerageTiming();
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
    if (field === 'brokerage_amount' || field === 'brokerage_ats_amount'
        || field === 'brokerage_registry_amount') {
      recomputeBrokerageSplit(field);
    }
  });
})();

async function generateBookingPreview(mode) {
  mode = mode === 'cp' ? 'cp' : 'buyer';
  bookingState.previewMode = mode;
  flushPendingBookingInputs(); // catch any un-added CP RM / CP email before send
  const form = collectBookingForm();
  try {
    const r = await fetch('/api/booking-details/' + encodeURIComponent(bookingState.uid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: mode === 'cp' ? 'preview_cp' : 'preview',
        booking_id: bookingState.draftId,
        recipients: bookingState.recipients,
        broker_emails: bookingState.brokers,
        selling_cp_id: bookingState.cpId,
        selling_cp_email: bookingState.brokers[0] || null,
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

async function sendBookingMail(mode) {
  const isCp = mode === 'cp';
  const form = bookingState.form;
  const btn = isCp ? $('#bookingSendCpBtn') : $('#bookingSendBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Sending…';

  try {
    const r = await fetch('/api/booking-details/' + encodeURIComponent(bookingState.uid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        action: isCp ? 'send_cp' : 'send',
        booking_id: bookingState.draftId,
        recipients: bookingState.recipients,
        broker_emails: bookingState.brokers,
        selling_cp_id: bookingState.cpId,
        selling_cp_email: bookingState.brokers[0] || null,
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
    showToast(isCp ? 'CP (broker) mail sent' : 'Booking submitted and buyer email sent', 'success');
    // Mark this mail as sent but KEEP the modal open, so the other mail can be
    // sent in the same session against the row this send just created. The
    // disabled state prevents a double-send race.
    btn.textContent = '✓ Sent';

    // Either send marks the unit Booked.
    const row = state.rows.find(x => x.uid === bookingState.uid);
    if (row) row.availability_status = 'Booked';
    syncAvailabilityUI(bookingState.uid, 'Booked');
  } catch (e) {
    showToast('Network error: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── Update Home modal (external listing → Coming Soon) ──────────────────
// Flow: open → GET masters + societies + current home details (prefill) → user
// edits the full field set → Preview (summary of what will change) → Publish,
// which POSTs /api/core-home/update (forwarded upstream as PATCH, listing → CS).
const updateHomeState = {
  uid: null, coreHomeId: null, property: null,
  masters: null, societies: [], furnishing: [], step: 1,
};

const UH_FACING_LABELS = { N: 'North', E: 'East', W: 'West', S: 'South', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest' };
const UH_FURN_LABELS = { UF: 'Unfurnished', SF: 'Semi furnished', FF: 'Fully furnished' };
const UH_AGE_LABELS = { y: 'Years', m: 'Months' };

// get-home-details returns LABELS ("North", "Semi Furnished", "Years") but the
// update API wants CODES ("N", "SF", "y"). These map a label (or an already-valid
// code) back to the code used by the form's <option> values.
const UH_FACING_CODE = { north: 'N', east: 'E', west: 'W', south: 'S', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };
const UH_FURN_CODE = { unfurnished: 'UF', 'semi furnished': 'SF', 'fully furnished': 'FF' };
const UH_AGE_CODE = { years: 'y', year: 'y', months: 'm', month: 'm' };

function uhToCode(map, labels, v) {
  if (v == null || v === '') return '';
  if (labels[v]) return v; // already a code
  return map[String(v).trim().toLowerCase()] || '';
}

// Resolve a master-row id from a display label/reason (get-home-details gives
// names, not ids). Case-insensitive match against the loaded masters list.
function uhIdByLabel(mastersName, labelKeys, value) {
  if (value == null) return null;
  const norm = String(value).trim().toLowerCase();
  const item = uhMastersArr(mastersName).find(x =>
    labelKeys.some(k => x[k] && String(x[k]).trim().toLowerCase() === norm));
  return item ? item.id : null;
}

// Turn an array of ids OR {id} OR {name}/{reason} into a list of master ids.
function uhResolveIds(mastersName, labelKeys, arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const el of arr) {
    if (el == null) continue;
    if (typeof el === 'number') { out.push(el); continue; }
    if (typeof el === 'string') { const id = uhIdByLabel(mastersName, labelKeys, el); if (id != null) out.push(id); continue; }
    if (typeof el === 'object') {
      if (el.id != null) { out.push(el.id); continue; }
      const lbl = labelKeys.map(k => el[k]).find(Boolean);
      const id = uhIdByLabel(mastersName, labelKeys, lbl);
      if (id != null) out.push(id);
    }
  }
  return out;
}

// Master arrays tolerate camelCase (documented) or snake_case response keys.
function uhMastersArr(name) {
  const m = updateHomeState.masters || {};
  const variants = ({
    propertyTypes: ['propertyTypes', 'property_types'],
    overlooking: ['overlooking'],
    whyChooseThisHome: ['whyChooseThisHome', 'why_choose_this_home'],
    documentationAndLoan: ['documentationAndLoan', 'documentation_and_loan'],
  })[name] || [name];
  for (const k of variants) if (Array.isArray(m[k])) return m[k];
  return [];
}

function setUf(field, value) {
  if (value == null) return;
  const el = document.querySelector(`#updateHomeModal [data-uf="${cssEscape(field)}"]`);
  if (el) el.value = value;
}

function uhFieldValue(field) {
  const el = document.querySelector(`#updateHomeModal [data-uf="${cssEscape(field)}"]`);
  return el ? el.value : '';
}

// Defaults never overwrite a value that get-home-details already supplied —
// whatever the upstream listing holds wins, and defaults only fill the gaps.
function setUfIfEmpty(field, value) {
  if (value == null || value === '') return;
  if (String(uhFieldValue(field)).trim() !== '') return;
  setUf(field, value);
}

// For a few numeric fields upstream returns 0 as a placeholder on a home that
// was never listed — price total 0, parking 0/0 — and a literal 0 there is not a
// fact, it is "unset". Treating it as a real value would block the default and
// leave the operator staring at a 0 they have to clear by hand. A real price is
// never 0, so this only ever loosens fields where 0 is meaningless.
function uhIsBlankOrZero(field) {
  const raw = String(uhFieldValue(field)).trim();
  if (raw === '') return true;
  const n = Number(raw);
  return Number.isFinite(n) && n === 0;
}

function setUfIfBlankOrZero(field, value) {
  if (value == null || value === '') return;
  if (!uhIsBlankOrZero(field)) return;
  setUf(field, value);
}

function uhGroupHasChecked(containerId) {
  return !!document.querySelector(`#${containerId} input[type=checkbox]:checked`);
}

// Same rule for a checkbox group: if the listing already selected anything in
// this group, leave the whole group alone rather than adding to it.
function checkUhBoxesIfEmpty(containerId, ids) {
  if (uhGroupHasChecked(containerId)) return;
  checkUhBoxes(containerId, ids);
}

async function openUpdateHomeModal(uid) {
  const row = state.rows.find(r => r.uid === uid);
  if (!row) return;
  if (row.core_home_id == null) { showToast('This property is not linked to a core home', 'error'); return; }

  updateHomeState.uid = uid;
  updateHomeState.coreHomeId = row.core_home_id;
  updateHomeState.property = row;
  updateHomeState.step = 1;
  updateHomeState.furnishing = [];
  updateHomeState.masters = null;
  updateHomeState.societies = [];
  updateHomeState.layouts = [];
  updateHomeState.floorPlanUrl = null;      // newly uploaded, pending publish
  updateHomeState.floorPlanCurrent = null;  // what the home already has
  updateHomeState.floorPlanSource = null;   // 'sheet' | 'upload'
  updateHomeState.floorPlanNote = null;     // why there is (or isn't) a suggestion

  document.querySelectorAll('#updateHomeModal [data-uf]').forEach(el => { el.value = ''; });
  const laySelReset = document.querySelector('#updateHomeModal [data-uf="layoutId"]');
  if (laySelReset) laySelReset.innerHTML = '<option value="">Select…</option>';
  ['uhOverlooking', 'uhWhyChoose', 'uhDocs'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
  renderUhFurnishing();
  renderUhFloorPlan();
  const fpFile = $('#uhFloorPlanFile'); if (fpFile) fpFile.value = '';
  const nlPanel = $('#uhLayoutNew'); if (nlPanel) nlPanel.hidden = true;
  const nlToggle = $('#uhLayoutNewToggle'); if (nlToggle) nlToggle.textContent = '+ New layout';
  const nlStatus = $('#uhNlStatus'); if (nlStatus) nlStatus.textContent = '';
  ['uhNlName','uhNlBeds','uhNlBaths','uhNlBalc','uhNlSuper','uhNlCarpet']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const fpStatus = $('#uhFloorPlanStatus'); if (fpStatus) fpStatus.textContent = '';
  $('#updateHomeCurrent').innerHTML = '';
  $('#updateHomeSubtitle').textContent = `· ${row.society_name || ''} ${row.unit_no ? '· Unit ' + row.unit_no : ''}`;
  const pubBtn = $('#uhPublishBtn'); if (pubBtn) { pubBtn.disabled = false; pubBtn.textContent = '🚀 Publish (Coming Soon)'; }
  goToUhStep(1);
  $('#updateHomeModal').classList.add('open');

  $('#updateHomeLoading').style.display = '';
  $('#uhPreviewBtn').disabled = true;
  try {
    const [mastersR, publicR, detailsR, planR] = await Promise.all([
      fetch('/api/core-home/masters', { credentials: 'include' }).then(r => r.json()).catch(e => ({ success: false, error: e.message })),
      fetch('/api/core-home/public-masters?city=' + encodeURIComponent(row.city || ''), { credentials: 'include' }).then(r => r.json()).catch(e => ({ success: false, error: e.message })),
      fetch('/api/core-home/details?id=' + encodeURIComponent(row.core_home_id), { credentials: 'include' }).then(r => r.json()).catch(e => ({ success: false, error: e.message })),
      fetch('/api/core-home/floor-plan-lookup?' + new URLSearchParams({
        society: row.society_name || '',
        bhk: extractBedrooms(row.configuration) || '',
        area: row.super_area || row.area_sqft || '',
        city: row.city || '',
        fresh: '1',
      }), { credentials: 'include' }).then(r => r.json()).catch(e => ({ success: false, matches: [] })),
    ]);
    // Bail if the modal was closed or switched to another row during the fetch.
    if (!$('#updateHomeModal').classList.contains('open') || updateHomeState.uid !== uid) return;

    updateHomeState.masters = (mastersR && mastersR.success) ? mastersR.masters : {};
    updateHomeState.societies = (publicR && publicR.success && publicR.publicMasters && publicR.publicMasters.societies) || [];
    const home = (detailsR && detailsR.success) ? detailsR.home : null;
    updateHomeState.layouts = uhCollectLayouts(home);
    updateHomeState.floorPlanCurrent = uhFloorPlanFromHome(home);

    // The Floor Plans sheet is the curated source, so on an Archive home its
    // match is offered even when the home already carries a plan — an unlisted
    // home's existing photo is usually the stale one. Both are shown; publishing
    // sends the suggestion, and the operator can drop it or upload their own.
    const sheetHit = (planR && planR.matches && planR.matches[0]) || null;
    if (uhShouldApplyDefaults(home) && sheetHit && sheetHit.url) {
      updateHomeState.floorPlanUrl = sheetHit.url;
      updateHomeState.floorPlanSource = 'sheet';
      updateHomeState.floorPlanNote =
        `Sheet match: ${sheetHit.society || ''} ${sheetHit.bhk || '?'}BHK ${sheetHit.area || '?'} sqft`;
    } else if (!uhShouldApplyDefaults(home)) {
      updateHomeState.floorPlanNote = null;   // live listing: no suggestions at all
    } else if (planR && planR.success === false) {
      updateHomeState.floorPlanNote = 'Floor Plans sheet unavailable: ' + (planR.error || 'lookup failed');
    } else {
      updateHomeState.floorPlanNote =
        `No match in the Floor Plans sheet for "${row.society_name || ''}" `
        + `(${extractBedrooms(row.configuration) || '?'} BHK, ${row.super_area || row.area_sqft || '?'} sqft).`;
    }
    renderUhFloorPlan();

    populateUhSelects();
    populateUhChecks();
    prefillUhFromHome(home);
    applyUhDefaults(row, home);
    fillUhNewLayoutForm(row);

    const code = extractListingStatus(home);
    // floor is read-only context (update-home doesn't accept it); 0 = ground floor.
    const floor = home && home.floor != null && home.floor !== '' ? home.floor : null;
    $('#updateHomeCurrent').innerHTML =
      `<div style="margin-bottom:14px;font-size:13px;color:#374151;">Current listing status: ${renderHomeStatusBadge(code ? { code } : { error: 'unknown' })}${floor != null ? `<span style="margin-left:12px;color:#6b7280;">Floor: <strong>${esc(floor === 0 ? 'Ground' : floor)}</strong></span>` : ''}</div>`;
    if (home) { state.homeStatus[row.core_home_id] = { code, home }; updateHomeStatusBadge(row.core_home_id); }
    if (!mastersR.success) showToast('Could not load dropdown options: ' + (mastersR.error || ''), 'error');
  } catch (e) {
    showToast('Failed to load home data: ' + e.message, 'error');
  } finally {
    $('#updateHomeLoading').style.display = 'none';
    $('#uhPreviewBtn').disabled = false;
  }
}

function populateUhSelects() {
  const ptSel = document.querySelector('#updateHomeModal [data-uf="propertyTypeId"]');
  if (ptSel) ptSel.innerHTML = '<option value="">Select…</option>' +
    uhMastersArr('propertyTypes').map(t => `<option value="${esc(t.id)}">${esc(t.name || t.label || ('#' + t.id))}</option>`).join('');
  const socSel = document.querySelector('#updateHomeModal [data-uf="societyId"]');
  if (socSel) socSel.innerHTML = '<option value="">Select…</option>' +
    (updateHomeState.societies || []).map(s => `<option value="${esc(s.id)}">${esc(s.name || ('#' + s.id))}</option>`).join('');
  const laySel = document.querySelector('#updateHomeModal [data-uf="layoutId"]');
  if (laySel) laySel.innerHTML = '<option value="">Select…</option>' +
    (updateHomeState.layouts || []).map(l => `<option value="${esc(l.id)}">${esc(uhLayoutLabel(l))}</option>`).join('');
}

function populateUhChecks() {
  renderUhChecks('uhOverlooking', uhMastersArr('overlooking'), 'name');
  renderUhChecks('uhWhyChoose', uhMastersArr('whyChooseThisHome'), 'reason');
  renderUhChecks('uhDocs', uhMastersArr('documentationAndLoan'), 'reason');
}

function renderUhChecks(containerId, items, labelKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.length
    ? items.map(it => {
        const label = it[labelKey] || it.name || it.reason || ('#' + it.id);
        return `<label style="display:inline-flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
          <input type="checkbox" value="${esc(it.id)}"> ${esc(label)}
        </label>`;
      }).join('')
    : '<span class="field-val muted">None available</span>';
}

// Layout option label — name plus the areas we match on, so two same-named
// layouts ("3 BHK" twice) are still tellable apart in the dropdown.
function uhLayoutLabel(l) {
  if (!l) return '';
  const bits = [];
  const beds = Array.isArray(l.bedrooms) ? l.bedrooms.length : null;
  if (beds) bits.push(beds + ' bed');
  if (l.superBuiltUp) bits.push(l.superBuiltUp + ' sup');
  if (l.carpet) bits.push(l.carpet + ' carpet');
  const name = l.name || ('Layout #' + l.id);
  return bits.length ? `${name} · ${bits.join(' · ')}` : name;
}

// Candidate layouts for the dropdown: the society's master list UNION the home's
// own current layout. The union is deliberate — upstream `society.layouts` is
// still under-populated (societies with 2 BHK + 3 BHK in use commonly list only
// one), so without it the home's existing layout would be missing from its own
// dropdown and unpickable. update-home accepts either, so both are valid:
// "must be on home.society.layouts OR already be this home's current layout".
function uhCollectLayouts(home) {
  const out = [], seen = new Set();
  const add = (l) => {
    if (!l || l.id == null || seen.has(String(l.id))) return;
    seen.add(String(l.id));
    out.push(l);
  };
  add(home && home.layout);
  const socLayouts = (home && home.society && home.society.layouts) || [];
  if (Array.isArray(socLayouts)) socLayouts.forEach(add);
  return out;
}

// The floor plan is a HomePhoto identified by altText containing "floor plan"
// (case-insensitive — production carries both "Floor plan" and "Floor Plan").
// Deliberately NOT matched on tags: the tags on these rows are room names and
// are frequently wrong (one sampled floor plan is tagged "Balcony View").
function uhFloorPlanFromHome(home) {
  const photos = (home && home.homePhotos) || [];
  if (!Array.isArray(photos)) return null;
  const hit = photos.find(p => p && /floor\s*plan/i.test(String(p.altText || '')));
  return hit && hit.image ? hit.image : null;
}

// Shows the home's existing plan and any pending one (sheet suggestion or
// upload) side by side, so the operator can compare before publishing. When
// there is nothing to suggest, says why rather than rendering an empty box.
function renderUhFloorPlan() {
  const el = $('#uhFloorPlan');
  if (!el) return;

  const current = updateHomeState.floorPlanCurrent;
  const pending = updateHomeState.floorPlanUrl;
  const source = updateHomeState.floorPlanSource;
  const note = updateHomeState.floorPlanNote;

  const card = (url, title, tone) => `
    <figure class="uh-fp-card">
      <img src="${esc(url)}" alt="${esc(title)}" data-uh-floorplan="${esc(url)}" loading="lazy">
      <figcaption class="uh-fp-cap ${tone}">${esc(title)}</figcaption>
    </figure>`;

  const cards = [];
  if (current) {
    cards.push(card(current, pending ? 'Current — will be replaced' : 'Current floor plan',
                    pending ? 'is-stale' : ''));
  }
  if (pending) {
    cards.push(card(pending,
      source === 'sheet' ? 'From sheet — attaches on publish' : 'Uploaded — attaches on publish',
      'is-new'));
  }

  el.innerHTML = (cards.length ? `<div class="uh-fp-row">${cards.join('')}</div>` : '')
    + (!cards.length ? '<span class="field-val muted">No floor plan on this home yet.</span>' : '')
    + (note ? `<p class="uh-fp-note">${esc(note)}</p>` : '');

  const clearBtn = $('#uhFloorPlanClear');
  if (clearBtn) clearBtn.style.display = pending ? '' : 'none';
}

// Reads the picked file, ships it to our Cloudinary proxy, and keeps the
// returned URL until publish — nothing is written to the home until then.
async function uploadUhFloorPlan(file) {
  const statusEl = $('#uhFloorPlanStatus');
  const setStatus = (t, err) => { if (statusEl) { statusEl.textContent = t; statusEl.style.color = err ? '#b91c1c' : '#6b7280'; } };
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    setStatus(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max 3 MB — please compress it.`, true);
    return;
  }
  setStatus('Uploading…');
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Could not read that file'));
      fr.readAsDataURL(file);
    });
    const r = await fetch('/api/core-home/floor-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ dataUrl }),
    });
    const data = await r.json();
    if (!r.ok || !data.success) { setStatus(data.error || 'Upload failed', true); return; }
    updateHomeState.floorPlanUrl = data.url;
    updateHomeState.floorPlanSource = 'upload';
    setStatus('Uploaded — publish to attach it to this home.');
    renderUhFloorPlan();
  } catch (e) {
    setStatus(e.message, true);
  }
}


// ── Create / resolve a layout ───────────────────────────────────────────────
// Upstream matches ONLY against the society's Layout M2M, which is still
// under-populated — a layout can be live on this very home and invisible to the
// matcher. So before offering to create, we re-run the same match rule against
// the layouts we DO know about (society list plus the home's own). A local hit
// upstream can't see means creating would duplicate an existing layout, which
// is permanent and shows on the public listing — so we stop and say so.
function uhLocalLayoutMatch(spec) {
  const beds = Number(spec.bedrooms), sup = Number(spec.superBuiltUp), car = Number(spec.carpet);
  const near = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return false;
    return Math.abs(a - b) / b <= 0.02;   // same ~2% tolerance the backend uses
  };
  return (updateHomeState.layouts || []).find(l => {
    const lb = Array.isArray(l.bedrooms) ? l.bedrooms.length : null;
    if (lb == null || !Number.isFinite(beds) || lb !== beds) return false;
    const supOk = Number.isFinite(sup) ? near(sup, Number(l.superBuiltUp)) : true;
    const carOk = Number.isFinite(car) ? near(car, Number(l.carpet)) : true;
    return supOk && carOk;
  }) || null;
}

// Seed the panel from the unit's own supply data. Runs when the modal loads so
// the form is ready before it is ever opened, and again on each toggle — it only
// ever writes into blank inputs, so re-running never clobbers an edit.
function fillUhNewLayoutForm(row) {
  if (!row) return;
  const beds = Number(extractBedrooms(row.configuration));
  const sup  = Number(row.super_area || row.area_sqft);
  const carp = Number(row.carpet_area);

  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (String(el.value).trim() !== '') return;          // never overwrite an edit
    if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return;
    el.value = v;
  };

  set('uhNlBeds',   Number.isFinite(beds) ? beds : null);
  set('uhNlBaths',  row.bathrooms != null && row.bathrooms !== '' ? Number(row.bathrooms) : null);
  set('uhNlBalc',   row.balconies != null && row.balconies !== '' ? Number(row.balconies) : null);
  set('uhNlSuper',  Number.isFinite(sup) && sup > 0 ? Math.round(sup) : null);
  set('uhNlCarpet', Number.isFinite(carp) && carp > 0 ? Math.round(carp) : null);

  // Name it the way the layout dropdown labels things, so a created layout reads
  // consistently with the ones already there.
  set('uhNlName', [
    Number.isFinite(beds) ? beds + ' BHK' : '',
    Number.isFinite(sup) && sup > 0 ? Math.round(sup) + ' sqft' : '',
  ].filter(Boolean).join(' — ') || null);
}

function uhNewLayoutSpec() {
  const num = (id) => { const el = document.getElementById(id); const v = el ? el.value.trim() : ''; return v === '' ? null : Number(v); };
  return {
    name: (document.getElementById('uhNlName') || {}).value || '',
    bedrooms: num('uhNlBeds'),
    bath: num('uhNlBaths'),
    numberOfBalconies: num('uhNlBalc'),
    superBuiltUp: num('uhNlSuper'),
    carpet: num('uhNlCarpet'),
  };
}

// Add a layout to the dropdown and select it.
function uhAdoptLayout(layout) {
  if (!layout || layout.id == null) return;
  if (!(updateHomeState.layouts || []).some(l => String(l.id) === String(layout.id))) {
    updateHomeState.layouts.push(layout);
    populateUhSelects();
  }
  setUf('layoutId', layout.id);
}

async function resolveUhLayout() {
  const statusEl = $('#uhNlStatus');
  const say = (t, kind) => {
    if (!statusEl) return;
    statusEl.textContent = t;
    statusEl.style.color = kind === 'error' ? '#b91c1c' : kind === 'warn' ? '#b45309' : kind === 'ok' ? '#166534' : '#6b7280';
  };
  const btn = $('#uhNlResolve');
  const spec = uhNewLayoutSpec();

  const societyId = Number(uhFieldValue('societyId'));
  if (!Number.isFinite(societyId) || !societyId) { say('Pick a Society first — the layout is created on it.', 'error'); return; }
  if (!Number.isFinite(Number(spec.bedrooms)) || Number(spec.bedrooms) < 1) { say('Bedrooms is required.', 'error'); return; }
  if (!String(spec.name).trim()) { say('Give the layout a name.', 'error'); return; }

  // Guard against creating a duplicate of a layout the backend can't see.
  const local = uhLocalLayoutMatch(spec);
  if (local) {
    uhAdoptLayout(local);
    say(`Already exists on this home — selected "${uhLayoutLabel(local)}" instead of creating a duplicate.`, 'warn');
    return;
  }

  const payload = {
    societyId,
    name: String(spec.name).trim(),
    areaUnit: 'sqft',
    bath: spec.bath,
    numberOfBalconies: spec.numberOfBalconies,
    superBuiltUp: spec.superBuiltUp,
    carpet: spec.carpet,
    // Matching is on bedroom COUNT, so send that many entries. We have no room
    // dimensions here — the first is the master, the rest family.
    bedrooms: Array.from({ length: Number(spec.bedrooms) }, (_, i) => ({ type: i === 0 ? 'm' : 'b' })),
    bathrooms: [],
    balconies: [],
  };

  if (btn) btn.disabled = true;
  try {
    // Pass 1 — look for a match without writing anything.
    say('Checking this society for a match…');
    let r = await fetch('/api/core-home/layout-resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ ...payload, createIfMissing: false }),
    });
    let data = await r.json();
    if (!r.ok || !data.success) { say(data.error || 'Lookup failed', 'error'); return; }

    if (data.layoutId != null) {
      uhAdoptLayout({ id: data.layoutId, name: payload.name, superBuiltUp: payload.superBuiltUp,
                      carpet: payload.carpet, bedrooms: payload.bedrooms });
      say(`Matched existing layout #${data.layoutId} — selected it. Nothing was created.`, 'ok');
      return;
    }

    // Pass 2 — no match anywhere, so create it and attach it to the society.
    say('No match — creating…');
    r = await fetch('/api/core-home/layout-resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ ...payload, createIfMissing: true }),
    });
    data = await r.json();
    if (!r.ok || !data.success) { say(data.error || 'Create failed', 'error'); return; }
    if (data.layoutId == null) { say('Upstream returned no layout id.', 'error'); return; }

    uhAdoptLayout({ id: data.layoutId, name: payload.name, superBuiltUp: payload.superBuiltUp,
                    carpet: payload.carpet, bedrooms: payload.bedrooms });
    say(data.created
      ? `Created layout #${data.layoutId} and added it to this society.`
      : `Matched layout #${data.layoutId} — selected it.`, 'ok');
  } catch (e) {
    say('Network error: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Update Home defaults ────────────────────────────────────────────────────
// Publishing an Archive unit as Coming Soon repeats the same judgement calls
// every time, so the form is seeded from the supply-side row we already hold
// (state.rows) plus a few house rules. Everything stays editable before publish.
//
// These run AFTER prefillUhFromHome() and only ever FILL GAPS: any field
// get-home-details already populated is left exactly as it came back. They also
// only run at all for a home still in Archive,
// which by definition has no real listing data yet. A home already live
// (Coming Soon / Available / Sold / Booked) keeps exactly what
// get-home-details returns, so re-editing a published listing never silently
// overwrites real values with generated ones. See uhShouldApplyDefaults().

// Names the operator ticks on essentially every listing.
const UH_DEFAULT_WHY_CHOOSE = [
  'Bank Approved', 'Eco-Friendly Environment', 'Piped gas & 24/7 water',
  'RERA Approved', 'Value for money',
];
const UH_DEFAULT_DOCS = [
  'Allotment Letter', 'Builder Buyer Agreement', 'Conveyance/ Sale Deed',
  'Possession Letter',
];

// Master labels are hand-entered on both sides ("Conveyance/ Sale Deed" vs
// "Conveyance/Sale Deed", "Semi-Furnished" vs "Semi furnished"), so compare on
// alphanumerics only.
function uhNorm(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function uhIdByFuzzy(mastersName, labelKeys, value) {
  const want = uhNorm(value);
  if (!want) return null;
  const list = uhMastersArr(mastersName);
  const exact = list.find(x => labelKeys.some(k => x[k] && uhNorm(x[k]) === want));
  if (exact) return exact.id;
  const partial = list.find(x => labelKeys.some(k => {
    const got = uhNorm(x[k]);
    return got && (got.includes(want) || want.includes(got));
  }));
  return partial ? partial.id : null;
}

function uhFuzzyIds(mastersName, labelKeys, values) {
  const out = [];
  for (const v of values) {
    const id = uhIdByFuzzy(mastersName, labelKeys, v);
    if (id != null && !out.includes(id)) out.push(id);
  }
  return out;
}

// Parking free-text -> { covered, open }, or null when nothing is recognisable.
//
// The supply form writes "Closed" for a covered slot ("1 Closed"), not
// "Covered" — both spellings occur in the data, along with stilt/basement/
// garage for the same thing and uncovered as a synonym for open.
//
// Returns null rather than {0,0} for unparseable text ("Yes", "Available"),
// because writing zeros would assert "this unit has no parking" when we simply
// could not tell — the operator fills it in instead.
const UH_PARK_OPEN = /^(open|uncovered)$/;
const UH_PARK_WORD = /(\d+)\s*(covered|closed|uncovered|open|stilt|basement|garage)/g;

function uhParseParking(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s.trim()) return null;

  const out = { covered: 0, open: 0 };
  let m, matched = false;
  UH_PARK_WORD.lastIndex = 0;   // module-scope regex with /g keeps state
  while ((m = UH_PARK_WORD.exec(s)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    if (UH_PARK_OPEN.test(m[2])) out.open += n; else out.covered += n;
  }
  if (matched) return out;

  // A bare word with no leading count means one of that kind. Check the
  // "uncovered" branch first — it contains "covered" as a substring.
  if (/uncovered|open/.test(s)) return { covered: 0, open: 1 };
  if (/covered|closed|stilt|basement|garage/.test(s)) return { covered: 1, open: 0 };
  return null;
}

// Balcony Facing renders as "Room · Facing · View"; the View (last part) is what
// the unit overlooks — "Tower", "Other Building", "Park".
function uhBalconyViews(balconyDetails) {
  const arr = parseJsonish(balconyDetails);
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const o of arr) {
    let view = '';
    if (typeof o === 'string') view = o.split('·').pop().trim();
    else if (o) view = o.view || o.outlook || '';
    view = String(view || '').trim();
    if (view && !out.includes(view)) out.push(view);
  }
  return out;
}

// Closest layout: bedroom count first, then super-area proximity. Mirrors how
// layouts/resolve matches, so the pick here agrees with the backend's.
function uhClosestLayout(layouts, bedrooms, superArea) {
  const list = (layouts || []).filter(l => l && l.id != null);
  if (!list.length) return null;
  const wantBeds = Number(bedrooms), wantArea = Number(superArea);
  const scored = list.map(l => {
    const beds = Array.isArray(l.bedrooms) ? l.bedrooms.length : null;
    const area = Number(l.superBuiltUp || l.builtUp || l.carpet);
    return {
      l,
      bedDelta: (Number.isFinite(wantBeds) && beds != null) ? Math.abs(beds - wantBeds) : 99,
      areaDelta: (Number.isFinite(wantArea) && wantArea > 0 && Number.isFinite(area))
        ? Math.abs(area - wantArea) / wantArea : 99,
    };
  });
  scored.sort((a, b) => (a.bedDelta - b.bedDelta) || (a.areaDelta - b.areaDelta));
  return scored[0].l;
}

// Defaults apply only to Archive homes. Anything already listed shows its real
// values instead. An unknown/unreadable status is treated as "don't apply" —
// guessing wrong here would clobber a live listing, and a missing default is
// far cheaper to fix than an overwritten price.
function uhShouldApplyDefaults(home) {
  const raw = extractListingStatus(home);
  if (!raw) return false;
  return /^(arc|archive|archived)$/i.test(String(raw).trim());
}

function applyUhDefaults(row, home) {
  if (!row) return;
  if (!uhShouldApplyDefaults(home)) return;

  setUfIfEmpty('commission', '1');

  // Property type and furnishing status always come from us, overwriting
  // whatever the listing holds — upstream's values for these are unreliable and
  // the supply row is authoritative. (Still Archive-only, like every default.)
  const ptId = uhIdByFuzzy('propertyTypes', ['name'], 'Flat/Apartment')
            || uhIdByFuzzy('propertyTypes', ['name'], 'Apartment');
  if (ptId != null) setUf('propertyTypeId', ptId);

  // Layout — closest to this unit's config + super area.
  const beds = Number(extractBedrooms(row.configuration));
  const superArea = Number(row.super_area || row.area_sqft);
  const layout = uhClosestLayout(updateHomeState.layouts, beds, superArea);
  if (layout) setUfIfEmpty('layoutId', layout.id);

  // Exit Facing -> facing code. "South-East" normalises to "southeast".
  const facing = uhToCode(UH_FACING_CODE, UH_FACING_LABELS,
    String(row.exit_facing || '').replace(/[^a-zA-Z]/g, '').toLowerCase());
  if (facing) setUfIfEmpty('facing', facing);

  // "Semi-Furnished" -> "semi furnished" -> "SF".
  const furn = uhToCode(UH_FURN_CODE, UH_FURN_LABELS,
    String(row.furnishing || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());
  if (furn) setUf('furnishingStatus', furn);

  // Property age is the society's age, always expressed in years.
  if (row.society_age_years != null && row.society_age_years !== '') {
    const age = Math.round(Number(row.society_age_years));
    if (Number.isFinite(age)) setUfIfEmpty('propertyAge', Math.min(Math.max(age, 0), 40));
  }
  setUfIfEmpty('ageUnits', 'y');

  setUfIfEmpty('naturalLightScore', Math.random() < 0.5 ? 7 : 8);

  // Money on the dashboard is in LAKHS; the API wants rupees.
  // `default_price_lakhs` is derived server-side (listing price, else
  // acquisition + 8%) so this works for managers, who never receive the raw
  // acquisition column. Falls back to the local fields for older payloads.
  const lakhs = (row.default_price_lakhs != null && row.default_price_lakhs !== '')
    ? Number(row.default_price_lakhs)
    : ((row.listing_price != null && row.listing_price !== '')
        ? Number(row.listing_price)
        : (row.guaranteed_sale_price != null && row.guaranteed_sale_price !== ''
            ? Number(row.guaranteed_sale_price) * 1.08 : null));
  const ourTotal = (lakhs != null && Number.isFinite(lakhs) && lakhs > 0)
    ? Math.round(lakhs * 100000) : null;
  if (ourTotal != null) setUfIfBlankOrZero('priceTotal', ourTotal);

  // Per sq ft divides by the SALEABLE area. For affordable societies in Gurgaon
  // the quoted rate is against super area inflated by 1.3; everywhere else it is
  // the plain super area.
  //
  // Prefer the price actually in the form (upstream's, or ours from just above)
  // so the two figures agree, but fall back to our own computed total. Reading
  // only the field meant that whenever the price default didn't land — a manager
  // with no listing price, say — the rate silently never computed either.
  //
  // The rate is ALWAYS recomputed, never gap-filled. It is derived from the
  // total, so leaving upstream's value beside a total we just wrote would put
  // two numbers on screen that contradict each other. It also sidesteps the
  // placeholders Django seeds an unlisted home with: `total` 0 and `per_sq_ft`
  // 10000 (the model default — confirmed on live Archive homes), neither of
  // which is a real figure.
  const fieldTotal = Number(uhFieldValue('priceTotal'));
  const totalNow = (Number.isFinite(fieldTotal) && fieldTotal > 0) ? fieldTotal : ourTotal;
  if (totalNow != null && Number.isFinite(totalNow) && totalNow > 0
      && Number.isFinite(superArea) && superArea > 0) {
    const affordableGurgaon = /gurgaon|gurugram/i.test(String(row.city || ''))
      && (row.affordable === true || String(row.affordable).toLowerCase() === 'true');
    const denominator = affordableGurgaon ? superArea * 1.3 : superArea;
    setUf('pricePerSqFt', Math.round(totalNow / denominator));
  }

  const parking = uhParseParking(row.parking);
  if (parking && uhIsBlankOrZero('parkingCovered') && uhIsBlankOrZero('parkingOpen')) {
    setUf('parkingCovered', Math.min(parking.covered, 9));
    setUf('parkingOpen', Math.min(parking.open, 9));
  }

  checkUhBoxesIfEmpty('uhOverlooking', uhFuzzyIds('overlooking', ['name'], uhBalconyViews(row.balcony_details)));
  checkUhBoxesIfEmpty('uhWhyChoose', uhFuzzyIds('whyChooseThisHome', ['reason', 'name'], UH_DEFAULT_WHY_CHOOSE));
  checkUhBoxesIfEmpty('uhDocs', uhFuzzyIds('documentationAndLoan', ['reason', 'name'], UH_DEFAULT_DOCS));

  // Furnishing items come from supply as a plain name list; count defaults to 1.
  const items = parseJsonish(row.furnishing_details);
  if (Array.isArray(items) && items.length && !updateHomeState.furnishing.length) {
    updateHomeState.furnishing = items
      .map(x => (typeof x === 'string' ? x : (x && (x.name || x.item)) || ''))
      .map(n => String(n).trim())
      .filter(Boolean)
      .map(name => ({ name, count: 1 }));
    renderUhFurnishing();
  }
}

// Prefill the form from get-home-details. That payload speaks LABELS and NAMES
// (e.g. facing "North", propertyType {name}, overlooking [{name}]) whereas the
// update API and this form speak CODES and IDS — so every field is normalised
// back to its code/id here.
function prefillUhFromHome(home) {
  if (!home || typeof home !== 'object') return;
  const g = (...keys) => { for (const k of keys) { if (home[k] != null && home[k] !== '') return home[k]; } return null; };

  setUf('commission', g('commission'));

  // Property type — response gives { name } (no id); match name → masters id.
  const pt = g('propertyType', 'property_type', 'propertyTypeId', 'property_type_id');
  let ptId = null;
  if (pt != null) ptId = (typeof pt === 'object')
    ? (pt.id != null ? pt.id : uhIdByLabel('propertyTypes', ['name'], pt.name))
    : (typeof pt === 'number' ? pt : uhIdByLabel('propertyTypes', ['name'], pt));
  setUf('propertyTypeId', ptId);

  // Society — the payload now carries a numeric society.id, so that wins. The
  // name match is kept only as a fallback for older/partial payloads.
  const soc = g('society', 'societyId', 'society_id');
  let socId = null;
  if (soc != null) {
    if (typeof soc === 'object') {
      socId = soc.id != null ? soc.id : null;
      if (socId == null && soc.name) {
        const m = (updateHomeState.societies || []).find(s => String(s.name || '').trim().toLowerCase() === String(soc.name).trim().toLowerCase());
        if (m) socId = m.id;
      }
    } else if (typeof soc === 'number') socId = soc;
  }
  setUf('societyId', socId);

  // Layout — the payload now carries layout.id, so the current layout can be
  // preselected in the dropdown built by uhCollectLayouts().
  const layout = g('layout', 'layoutId', 'layout_id');
  const layoutId = (layout && typeof layout === 'object') ? layout.id : layout;
  if (layoutId != null) setUf('layoutId', layoutId);

  setUf('facing', uhToCode(UH_FACING_CODE, UH_FACING_LABELS, g('facing')));
  setUf('furnishingStatus', uhToCode(UH_FURN_CODE, UH_FURN_LABELS, g('furnishingStatus', 'furnishing_status')));
  setUf('ageUnits', uhToCode(UH_AGE_CODE, UH_AGE_LABELS, g('ageUnits', 'age_units')));
  setUf('propertyAge', g('propertyAge', 'property_age'));
  setUf('naturalLightScore', g('naturalLightScore', 'natural_light_score'));

  const price = g('price', 'priceData', 'price_data');
  if (price && typeof price === 'object') {
    setUf('priceTotal', price.total);
    setUf('pricePerSqFt', price.perSqFt != null ? price.perSqFt : price.per_sq_ft);
  }
  const parking = g('parking', 'parkingData', 'parking_data');
  if (parking && typeof parking === 'object') {
    setUf('parkingCovered', parking.covered);
    setUf('parkingOpen', parking.open);
  }

  checkUhBoxes('uhOverlooking', uhResolveIds('overlooking', ['name'], g('overlooking', 'overlookingIds', 'overlooking_ids')));
  checkUhBoxes('uhWhyChoose', uhResolveIds('whyChooseThisHome', ['reason', 'name'], g('whyChooseThisHome', 'whyChooseThisHomeIds', 'why_choose_this_home')));
  checkUhBoxes('uhDocs', uhResolveIds('documentationAndLoan', ['reason', 'name'], g('documentationAndLoan', 'documentationAndLoanIds', 'documentation_and_loan')));

  // Furnishing items — GET now returns [{name, count}], the same shape update
  // takes, so these round-trip. Items still missing a count are skipped rather
  // than defaulted: furnishing_data upserts by name, so a guessed count would
  // overwrite the real one on save.
  const furn = g('furnishings', 'furnishingData', 'furnishing_data');
  if (Array.isArray(furn)) {
    updateHomeState.furnishing = furn
      .filter(f => f && f.name && Number.isFinite(Number(f.count)) && Number(f.count) > 0)
      .map(f => ({ name: String(f.name), count: Number(f.count) }));
    renderUhFurnishing();
  }
}

function checkUhBoxes(containerId, ids) {
  if (!Array.isArray(ids)) return;
  const set = new Set(ids.map(String));
  document.querySelectorAll(`#${containerId} input[type=checkbox]`).forEach(c => { if (set.has(String(c.value))) c.checked = true; });
}

function renderUhFurnishing() {
  const el = $('#uhFurnishingList');
  if (!el) return;
  el.innerHTML = updateHomeState.furnishing.map((f, i) => `
    <div class="recipient-chip" style="margin:2px 4px 2px 0;">
      <span class="recipient-email">${esc(f.name)} × ${esc(f.count)}</span>
      <button type="button" class="recipient-remove" data-uh-furnish-idx="${i}" title="Remove">×</button>
    </div>`).join('');
}

function addUhFurnishing() {
  const nameEl = $('#uhFurnishName'), countEl = $('#uhFurnishCount');
  const name = (nameEl?.value || '').trim();
  const count = parseInt(countEl?.value, 10);
  if (!name) { showToast('Furnishing item name is required', 'error'); return; }
  if (isNaN(count) || count < 1) { showToast('Count must be a whole number ≥ 1', 'error'); return; }
  updateHomeState.furnishing.push({ name, count });
  if (nameEl) nameEl.value = '';
  if (countEl) countEl.value = '';
  renderUhFurnishing();
}

// Build the camelCase update body — only fields the user actually filled in.
function collectUhForm() {
  const body = { homeId: Number(updateHomeState.coreHomeId), listingStatus: 'CS' };
  const val = f => { const el = document.querySelector(`#updateHomeModal [data-uf="${cssEscape(f)}"]`); return el ? el.value.trim() : ''; };
  const setStr = (k, f) => { const v = val(f); if (v !== '') body[k] = v; };
  const setNum = (k, f) => { const v = val(f); if (v !== '') body[k] = Number(v); };

  setStr('commission', 'commission');
  setNum('propertyTypeId', 'propertyTypeId');
  setNum('societyId', 'societyId');
  setNum('layoutId', 'layoutId');
  setStr('facing', 'facing');
  setStr('furnishingStatus', 'furnishingStatus');
  setNum('propertyAge', 'propertyAge');
  setStr('ageUnits', 'ageUnits');
  setNum('naturalLightScore', 'naturalLightScore');

  const pt = val('priceTotal'), pp = val('pricePerSqFt');
  if (pt !== '' || pp !== '') {
    body.priceData = {};
    if (pt !== '') body.priceData.total = Number(pt);
    if (pp !== '') body.priceData.perSqFt = Number(pp);
  }
  const pc = val('parkingCovered'), po = val('parkingOpen');
  if (pc !== '' || po !== '') {
    body.parkingData = { covered: pc !== '' ? Number(pc) : 0, open: po !== '' ? Number(po) : 0 };
  }

  const checks = (containerId, key) => {
    const ids = Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)).map(c => Number(c.value));
    if (ids.length) body[key] = ids;
  };
  checks('uhOverlooking', 'overlookingIds');
  checks('uhWhyChoose', 'whyChooseThisHomeIds');
  checks('uhDocs', 'documentationAndLoanIds');

  if (updateHomeState.floorPlanUrl) body.floorPlanUrl = updateHomeState.floorPlanUrl;

  if (updateHomeState.furnishing.length) {
    body.furnishingData = updateHomeState.furnishing.map(f => ({ name: f.name, count: f.count }));
  }
  return body;
}

function uhLabelForId(mastersName, id, labelKeys) {
  const item = uhMastersArr(mastersName).find(x => String(x.id) === String(id));
  if (!item) return '#' + id;
  for (const k of labelKeys) if (item[k]) return item[k];
  return '#' + id;
}
function uhSocietyLabel(id) {
  const s = (updateHomeState.societies || []).find(x => String(x.id) === String(id));
  return s ? (s.name || ('#' + id)) : ('#' + id);
}
function uhIdsLabels(mastersName, labelKey, ids) {
  return ids.map(id => uhLabelForId(mastersName, id, [labelKey, 'name', 'reason'])).join(', ');
}

function buildUhPreview(body) {
  const rows = [];
  const push = (label, valHtml) => rows.push(
    `<div style="display:flex;justify-content:space-between;gap:16px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
       <span style="color:#6b7280;">${esc(label)}</span>
       <span style="font-weight:600;text-align:right;">${valHtml}</span>
     </div>`);

  push('Listing status', renderHomeStatusBadge({ code: 'CS' }));
  if ('commission' in body) push('Commission', esc(body.commission));
  if ('propertyTypeId' in body) push('Property type', esc(uhLabelForId('propertyTypes', body.propertyTypeId, ['name'])));
  if ('societyId' in body) push('Society', esc(uhSocietyLabel(body.societyId)));
  if ('floorPlanUrl' in body) push('Floor plan', updateHomeState.floorPlanCurrent ? 'Replaces the existing plan' : 'New plan attached');
  if ('layoutId' in body) push('Layout', esc(uhLayoutLabel(
    (updateHomeState.layouts || []).find(l => String(l.id) === String(body.layoutId))
  ) || ('#' + body.layoutId)));
  if ('facing' in body) push('Facing', esc(UH_FACING_LABELS[body.facing] || body.facing));
  if ('furnishingStatus' in body) push('Furnishing status', esc(UH_FURN_LABELS[body.furnishingStatus] || body.furnishingStatus));
  if ('propertyAge' in body || 'ageUnits' in body) {
    push('Property age', esc(`${body.propertyAge != null ? body.propertyAge : ''} ${UH_AGE_LABELS[body.ageUnits] || body.ageUnits || ''}`.trim()));
  }
  if ('naturalLightScore' in body) push('Natural light score', esc(body.naturalLightScore));
  if (body.priceData) push('Price', esc(`Total ₹${body.priceData.total != null ? body.priceData.total : '—'}${body.priceData.perSqFt != null ? ` · ₹${body.priceData.perSqFt}/sqft` : ''}`));
  if (body.parkingData) push('Parking', esc(`Covered ${body.parkingData.covered} · Open ${body.parkingData.open}`));
  if (body.overlookingIds) push('Overlooking', esc(uhIdsLabels('overlooking', 'name', body.overlookingIds)));
  if (body.whyChooseThisHomeIds) push('Why choose', esc(uhIdsLabels('whyChooseThisHome', 'reason', body.whyChooseThisHomeIds)));
  if (body.documentationAndLoanIds) push('Documentation & loan', esc(uhIdsLabels('documentationAndLoan', 'reason', body.documentationAndLoanIds)));
  if (body.furnishingData) push('Furnishing items', esc(body.furnishingData.map(f => `${f.name} ×${f.count}`).join(', ')));

  if (rows.length === 1) {
    rows.push('<div style="color:#6b7280;padding:8px 0;">No other fields changed — this will only publish the home as Coming Soon.</div>');
  }
  return rows.join('');
}

function goToUhStep(step) {
  updateHomeState.step = step;
  document.querySelectorAll('#updateHomeModal .uh-page').forEach(p => {
    p.style.display = (parseInt(p.dataset.uhPage, 10) === step) ? '' : 'none';
  });
  $('#uhBackBtn').style.display = step === 1 ? 'none' : '';
  $('#uhPreviewBtn').style.display = step === 1 ? '' : 'none';
  $('#uhPublishBtn').style.display = step === 2 ? '' : 'none';
}

async function publishUpdateHome() {
  const body = collectUhForm();
  const btn = $('#uhPublishBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Publishing…';
  try {
    const r = await fetch('/api/core-home/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok || !data.success) {
      showToast(data.error || 'Update failed', 'error');
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    // The proxy retries without furnishings when upstream rejects a name, so a
    // publish can succeed with items dropped — say so rather than reporting a
    // clean success the operator would never think to check.
    if (Array.isArray(data.skippedFurnishing) && data.skippedFurnishing.length) {
      showToast('Published as Coming Soon, but furnishing items were not saved ('
        + data.skippedFurnishing.join(', ') + '). Add them in Django admin.', 'error');
    } else {
      showToast('Home published as Coming Soon', 'success');
    }
    state.homeStatus[updateHomeState.coreHomeId] = { code: 'CS', home: data.home };
    updateHomeStatusBadge(updateHomeState.coreHomeId);
    $('#updateHomeModal').classList.remove('open');
  } catch (e) {
    showToast('Network error: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

// Bind Update Home controls once (delegated).
(function bindUpdateHomeModal() {
  document.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-update-home-uid]');
    if (openBtn) { openUpdateHomeModal(openBtn.dataset.updateHomeUid); return; }
    if (e.target.id === 'uhFurnishAdd') { addUhFurnishing(); return; }
    if (e.target.id === 'uhLayoutNewToggle') {
      const panel = $('#uhLayoutNew');
      if (panel) {
        panel.hidden = !panel.hidden;
        e.target.textContent = panel.hidden ? '+ New layout' : 'Cancel';
        if (!panel.hidden) {
          fillUhNewLayoutForm(updateHomeState.property);
          const first = document.getElementById('uhNlName');
          if (first) first.focus();
        }
      }
      return;
    }
    if (e.target.id === 'uhNlResolve') { resolveUhLayout(); return; }
    // Zoom the floor plan in the existing lightbox.
    const fpImg = e.target.closest('[data-uh-floorplan]');
    if (fpImg) { openLightbox([fpImg.dataset.uhFloorplan], 0); return; }
    // Drop a pending upload — the home's existing plan is untouched.
    if (e.target.id === 'uhFloorPlanClear') {
      updateHomeState.floorPlanUrl = null;
      updateHomeState.floorPlanSource = null;
      updateHomeState.floorPlanNote = null;
      const f = $('#uhFloorPlanFile'); if (f) f.value = '';
      const st = $('#uhFloorPlanStatus'); if (st) st.textContent = '';
      renderUhFloorPlan();
      return;
    }
    const rmF = e.target.closest('[data-uh-furnish-idx]');
    if (rmF) { updateHomeState.furnishing.splice(parseInt(rmF.dataset.uhFurnishIdx, 10), 1); renderUhFurnishing(); return; }
    if (e.target.id === 'uhPreviewBtn') {
      $('#updateHomePreview').innerHTML = buildUhPreview(collectUhForm());
      goToUhStep(2);
      return;
    }
    if (e.target.id === 'uhBackBtn') { goToUhStep(1); return; }
    if (e.target.id === 'uhPublishBtn') { publishUpdateHome(); return; }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'uhFloorPlanFile') uploadUhFloorPlan(e.target.files && e.target.files[0]);
  });
  // Changing the code or phone after a match invalidates the resolved CP — the
  // snapshot must never be filed under a partner the operator has moved off.
  document.addEventListener('focusin', (e) => {
    if (e.target.matches && e.target.matches('[data-cp-field], #bookingNewBroker') && e.target.readOnly) {
      cpStatus('Please enter a CP phone number or CP code first.', 'error');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches && e.target.matches('[data-cp-field], #bookingNewBroker') && e.target.readOnly
        && e.key.length === 1) {
      cpStatus('Please enter a CP phone number or CP code first.', 'error');
    }
  }, true);
  document.addEventListener('input', (e) => {
    // Any booking field edit schedules a debounced draft save.
    if (e.target.closest && e.target.closest('#bookingModal') && e.target.matches('[data-bf]')) {
      scheduleBookingDraft();
    }
    if (e.target.id === 'cpLookupCode' || e.target.id === 'cpLookupPhone') {
      if (bookingState.cpId != null) {
        bookingState.cpId = null;
        setCpFieldsLocked(true);
      }
      scheduleCpLookup();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.id === 'cpLookupCode' || e.target.id === 'cpLookupPhone')) {
      e.preventDefault();
      clearTimeout(_cpTimer);
      lookupChannelPartner();
      return;
    }
    if (e.key === 'Enter' && (e.target.id === 'uhFurnishName' || e.target.id === 'uhFurnishCount')) {
      e.preventDefault();
      addUhFurnishing();
    }
  });
})();
