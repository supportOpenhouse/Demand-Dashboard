// Read-only Google Sheets client for the Floor Plans sheet.
//
// The sheet is private; access is via the service account already configured for
// this app (GOOGLE_SERVICE_ACCOUNT_JSON). Share the sheet with that service
// account's client_email or every lookup 403s.
//
// Sheet: "Floor plans" tab, columns
//   society | city | locality | bhk | area_sqft | tower | unit_label | source | image_url
const { JWT } = require('google-auth-library');

const SHEET_ID = process.env.FLOOR_PLAN_SHEET_ID || '15oPgy0Gexkxf5j72VKQJ3ed_tP--TwGDfKnt8lofSdM';
const TAB = process.env.FLOOR_PLAN_SHEET_TAB || 'Floor plans';

// ~11.5k rows is a couple of MB of JSON and takes a second or two to pull, so
// hold it for the life of a warm lambda rather than re-fetching per request.
const TTL_MS = 10 * 60 * 1000;
let _cache = null;      // { at: <ms>, rows: [...] }
let _inflight = null;   // de-dupes concurrent cold-start fetches

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const trimmed = raw.trim();
  // Accept raw JSON or base64-encoded JSON — both are common in host env UIs.
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
  }
}

async function fetchRows() {
  const creds = serviceAccount();
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const { token } = await client.getAccessToken();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`
            + `/values/${encodeURIComponent(TAB)}!A:I`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && data.error.message) || `Sheets responded ${r.status}`;
    throw new Error(msg);
  }
  const values = data.values || [];
  const header = (values[0] || []).map(h => String(h).trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iSoc = idx('society'), iCity = idx('city'), iBhk = idx('bhk'),
        iArea = idx('area_sqft'), iTower = idx('tower'),
        iUnit = idx('unit_label'), iUrl = idx('image_url');

  return values.slice(1).map(row => ({
    society: String(row[iSoc] || '').trim(),
    city:    String(row[iCity] || '').trim(),
    // "3.0" and "3" both appear in the sheet; Number() normalises both.
    bhk:     Number(row[iBhk]),
    area:    Number(row[iArea]),
    tower:   String(row[iTower] || '').trim(),
    unit:    String(row[iUnit] || '').trim(),
    url:     String(row[iUrl] || '').trim(),
  })).filter(x => x.society && x.url);
}

async function getFloorPlanRows() {
  if (_cache && (Date.now() - _cache.at) < TTL_MS) return _cache.rows;
  if (_inflight) return _inflight;
  _inflight = fetchRows()
    .then(rows => { _cache = { at: Date.now(), rows }; return rows; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

// Society names are entered by hand on both sides, so compare on a squashed key
// (lowercase, alphanumerics only) rather than requiring an exact string match.
function socKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Rank candidates for one unit: same society, then closest BHK, then closest
// area. Returns [{url, bhk, area, tower, unit, areaDelta}] best-first.
function matchFloorPlans(rows, { society, bhk, area }) {
  const key = socKey(society);
  if (!key) return [];
  let pool = rows.filter(r => socKey(r.society) === key);
  // Fall back to a containment match ("Gaur City 2" vs "16th Avenue, Gaur City 2").
  if (!pool.length) {
    pool = rows.filter(r => {
      const k = socKey(r.society);
      return k && (k.includes(key) || key.includes(k));
    });
  }
  if (!pool.length) return [];

  const wantBhk = Number(bhk), wantArea = Number(area);
  return pool
    .map(r => ({
      ...r,
      bhkDelta:  Number.isFinite(wantBhk) && Number.isFinite(r.bhk) ? Math.abs(r.bhk - wantBhk) : 99,
      areaDelta: Number.isFinite(wantArea) && Number.isFinite(r.area) && wantArea > 0
        ? Math.abs(r.area - wantArea) / wantArea : 99,
    }))
    .sort((a, b) => (a.bhkDelta - b.bhkDelta) || (a.areaDelta - b.areaDelta))
    .slice(0, 8);
}

module.exports = { getFloorPlanRows, matchFloorPlans, socKey };
