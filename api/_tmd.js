// Documents and deviation from TMD's "Docs Verified & AMA Draft" stage, shaped for
// the property panel. Pure functions only — the route (api/tmd-docs/[uid].js) does
// the reads. Three sources, in the order the panel lists them:
//
//   1. Ownership checklist — properties.ama_prop_docs, {key: {status, url}}. Same
//      keys and labels as TMD's _PROP_DOC_FIELDS (backend/app/properties.py).
//   2. Seller App documents — TMD's seller_app_docs_seen ledger, which TMD's sweep
//      fills from the Seller App's stage 1b while a deal is in Docs Verified. It
//      keeps every URL ever seen, so a replaced document has several rows under one
//      name; only the newest is shown.
//   3. Additional Documents uploaded in TMD — its `documents` table.
//
// A file TMD pushed to the Seller App sits in both 2 and 3 under the same URL, so
// the list is de-duplicated on URL.

// [key, label, the Seller App document that is the same paper]. A checklist entry
// with no file of its own is dropped when that Seller App document is present —
// otherwise "Allotment Letter" (no link) sits beside "Allotment Letter issued by
// the Builder" (link) and reads as two documents.
const CHECKLIST = [
  ['allotment_letter', 'Allotment Letter', /allotment letter/i],
  ['possession_letter', 'Possession Letter', /possession letter/i],
  ['bba', 'Builder Buyer Agreement', /builder buyer/i],
  ['conveyance_deed', 'Conveyance/Sub Lease/Sale Deed', /conveyance|sale deed|sub.?lease|registry/i],
  ['parking_allotment', 'Car Parking Letter', null],
  ['noc', 'NOC', null],
  ['gpa', 'GPA', null],
  ['mutation', 'Mutation', null],
];

// The Seller App's named stage-1b slots, in TMD's order (NAMED_DOCS in
// backend/app/sellerapp.py). Any other named document follows them.
const SELLER_APP_NAMED = [
  'Allotment Letter issued by the Builder',
  'Builder Buyer Agreement',
  'Possession Letter/Certificate by the Builder',
  'Conveyance Deed/Sale Deed/Registry',
];

const str = v => (typeof v === 'string' ? v.trim() : '');
const time = v => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; };
const isAdditional = name => /^additional document/i.test(name);

function parseChecklist(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

// A checklist entry counts when the seller has it ('Yes') or a file is attached.
function checklistDocs(raw, sellerAppNames = []) {
  const docs = parseChecklist(raw);
  const out = [];
  for (const [key, name, sameAs] of CHECKLIST) {
    const d = docs[key] && typeof docs[key] === 'object' ? docs[key] : {};
    const url = str(d.url);
    if (!url && sameAs && sellerAppNames.some(n => sameAs.test(n))) continue;
    if (str(d.status).toLowerCase() === 'yes' || url) {
      out.push({ name, url: url || null, source: 'checklist' });
    }
  }
  return out;
}

function sellerAppDocs(rows) {
  const newest = new Map();
  for (const r of rows || []) {
    const name = str(r.document_name) || 'Document';
    const url = str(r.url);
    if (!url) continue;
    const prev = newest.get(name);
    if (!prev || time(r.first_seen_at) > prev.at) newest.set(name, { url, at: time(r.first_seen_at) });
  }
  const docs = [...newest].map(([name, { url }]) => ({ name, url, source: 'seller_app' }));
  // Named slots first (TMD's order), then "Additional Document N" in number order.
  const num = n => parseInt((n.match(/(\d+)\s*$/) || [])[1], 10) || 0;
  const rank = n => { const i = SELLER_APP_NAMED.indexOf(n); return i < 0 ? SELLER_APP_NAMED.length : i; };
  return [
    ...docs.filter(d => !isAdditional(d.name)).sort((a, b) => rank(a.name) - rank(b.name)),
    ...docs.filter(d => isAdditional(d.name)).sort((a, b) => num(a.name) - num(b.name)),
  ];
}

function crmDocs(rows) {
  return (rows || [])
    .filter(r => str(r.url))
    .map(r => ({ name: str(r.filename) || 'Document', url: str(r.url), source: 'crm' }));
}

function buildDocuments({ propDocs, sellerApp, crm } = {}) {
  const seen = new Set();
  const out = [];
  const fromApp = sellerAppDocs(sellerApp);
  const named = fromApp.filter(d => !isAdditional(d.name)).map(d => d.name);
  for (const d of [...checklistDocs(propDocs, named), ...fromApp, ...crmDocs(crm)]) {
    if (d.url) {
      if (seen.has(d.url)) continue;
      seen.add(d.url);
    }
    out.push(d);
  }
  return out;
}

// Links are for admins and managers. Everyone else gets names only — the URL is
// removed here, on the server, so it never reaches a viewer's browser.
function forRole(docs, role) {
  if (role === 'admin' || role === 'manager') return docs;
  return docs.map(({ url, ...rest }) => rest);
}

function shapeDeviation(row) {
  if (!row || !row.has_deviation) return null;
  const text = str(row.text);
  if (!text) return null;
  return { text, resolved_at: row.resolved_at || null };
}

module.exports = { buildDocuments, forRole, shapeDeviation, CHECKLIST };
