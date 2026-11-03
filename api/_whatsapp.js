// "booking_alert" WhatsApp (Interakt) — announces a booking to the team:
//
//   💰💰Booking Alert💰💰
//   📅 Date - {{1}}            booking date, e.g. 03-Nov-2026
//   🪙 Booking Type - {{2}}    Normal / Conditional
//   🏠  {{3}}                  H - 31, M3M Soulitude
//   🛏️ Config - {{4}}          2BHK, 1082.0 sqft
//   🏙️ MM - {{5}}              New Gurgaon 88-92
//
// Fired once per booking row (booking_details.booking_alert_sent_at is the guard):
// a normal booking when its buyer booking mail is sent, a conditional booking —
// which sends no mail — when it is first saved complete (buyer, amount, booking
// date and payment screenshot: what its Save on page 2 requires).
//
// Same Interakt call and the same micro-market rule as the CRM's WhatsApp alerts
// (Transaction-Management-Dashboard backend/app/whatsapp.py).
//
// Env: INTERAKT_API_KEY (same key as the CRM); BOOKING_ALERT_TO, comma-separated
// emails (phone looked up in users) or 10-digit phones. Test units (TEST_SOCIETIES)
// go only to TEST_UNIT_VIEWERS. Best-effort: never throws into the booking request.
const { pool, logActivity, TEST_SOCIETIES } = require('./_db');

const INTERAKT_URL = 'https://api.interakt.ai/v1/public/message/';
const TEMPLATE = 'booking_alert';
const TESTERS = ['saransh.khera@openhouse.in', 'sahaj.durej@openhouse.in'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function configured() { return !!(process.env.INTERAKT_API_KEY || '').trim(); }

// '2026-11-03' (or a Date) → '03-Nov-2026', the format the approved templates use.
function fmtDate(v) {
  let y, m, d;
  const s = v instanceof Date ? v.toISOString() : String(v || '');
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { [y, m, d] = [iso[1], +iso[2], iso[3]]; }
  else {
    const t = new Date(Date.now() + 5.5 * 3600 * 1000);   // today in IST
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, String(t.getUTCDate()).padStart(2, '0')];
  }
  return `${d}-${MONTHS[m - 1]}-${y}`;
}

// Spaces / dashes / plus / leading 0 out; a leading 91 dropped only when that leaves 10 digits.
function cleanPhone(ph) {
  let c = String(ph || '').replace(/[\s\-+]/g, '').replace(/^0+/, '');
  if (c.startsWith('91') && c.length === 12) c = c.slice(2);
  return /^\d{10}$/.test(c) ? c : '';
}

// The society's micro market from master_societies: locality + society, else
// society + city when that pair has exactly one micro market.
async function microMarket(p) {
  if (!p.society_name) return '—';
  try {
    if (p.locality) {
      const r = await pool.query(
        `SELECT micro_market FROM master_societies
          WHERE LOWER(TRIM(locality)) = LOWER(TRIM($1)) AND LOWER(TRIM(society_name)) = LOWER(TRIM($2))
            AND COALESCE(micro_market, '') <> '' LIMIT 1`, [p.locality, p.society_name]);
      if (r.rows[0]) return r.rows[0].micro_market;
    }
    if (p.city) {
      const r = await pool.query(
        `SELECT CASE WHEN count(DISTINCT micro_market) = 1 THEN max(micro_market) END AS mm
           FROM master_societies
          WHERE LOWER(TRIM(society_name)) = LOWER(TRIM($1)) AND LOWER(TRIM(city)) = LOWER(TRIM($2))
            AND COALESCE(micro_market, '') <> ''`, [p.society_name, p.city]);
      if (r.rows[0] && r.rows[0].mm) return r.rows[0].mm;
    }
  } catch (e) { console.error('[booking_alert] micro market:', e.message); }
  return '—';
}

function bodyValues(p, booking, mm) {
  const unit = [p.tower_no, p.unit_no].map(x => String(x || '').trim()).filter(Boolean).join(' - ');
  const home = [unit, String(p.society_name || '').trim()].filter(Boolean).join(', ');
  const area = p.area_sqft != null && String(p.area_sqft).trim() !== '' ? `${p.area_sqft} sqft` : '';
  const cfg = [String(p.configuration || '').trim(), area].filter(Boolean).join(', ');
  const type = String(booking.token_type || 'normal').toLowerCase() === 'conditional' ? 'Conditional' : 'Normal';
  return [fmtDate(booking.booking_date), type, home || '—', cfg || '—', mm || '—'];
}

// [{name, phone}] — testers for a test unit, else BOOKING_ALERT_TO.
async function recipients(p) {
  const isTest = TEST_SOCIETIES.map(s => s.toLowerCase())
    .includes(String(p.society_name || '').trim().toLowerCase());
  const wanted = isTest ? TESTERS
    : String(process.env.BOOKING_ALERT_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  const emails = wanted.filter(w => w.includes('@')).map(w => w.toLowerCase());
  const byEmail = {};
  if (emails.length) {
    const { rows } = await pool.query(
      `SELECT LOWER(TRIM(email)) AS email, name, phone FROM users WHERE LOWER(TRIM(email)) = ANY($1::text[])`,
      [emails]);
    rows.forEach(r => { byEmail[r.email] = r; });
  }
  const seen = new Set(), out = [];
  for (const w of wanted) {
    const u = w.includes('@') ? byEmail[w.toLowerCase()] : null;
    const phone = cleanPhone(u ? u.phone : w);
    if (phone && !seen.has(phone)) { seen.add(phone); out.push({ name: u ? u.name : w, phone }); }
  }
  return out;
}

async function sendTemplate(phone, values) {
  try {
    const r = await fetch(INTERAKT_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${process.env.INTERAKT_API_KEY.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode: '+91', phoneNumber: phone, type: 'Template',
        template: { name: TEMPLATE, languageCode: 'en', bodyValues: values } }),
      signal: AbortSignal.timeout(15000),
    });
    // Interakt answers a successful send with 201.
    return r.ok ? { ok: true } : { ok: false, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Announce booking row `bookingId` of `property`, once. Returns a summary or null.
async function bookingAlert(bookingId, property, user) {
  try {
    if (!configured()) { console.warn('[booking_alert] INTERAKT_API_KEY not set — not sent'); return null; }
    const to = await recipients(property);
    if (!to.length) { console.warn('[booking_alert] no recipients (BOOKING_ALERT_TO) — not sent'); return null; }
    // Claim first, so two requests can never both announce the same booking.
    const { rows } = await pool.query(
      `UPDATE booking_details SET booking_alert_sent_at = NOW()
        WHERE id = $1 AND booking_alert_sent_at IS NULL
        RETURNING booking_date, token_type`, [bookingId]);
    if (!rows.length) return null;
    const values = bodyValues(property, rows[0], await microMarket(property));
    const results = await Promise.all(to.map(async r => ({ ...r, ...(await sendTemplate(r.phone, values)) })));
    const sent = results.filter(r => r.ok).length;
    logActivity(property.uid, 'booking_alert_whatsapp', 'booking', user, {
      booking_id: bookingId, template: TEMPLATE, values, sent, total: results.length,
      failed: results.filter(r => !r.ok).map(r => ({ name: r.name, error: r.error })),
    });
    return { sent, total: results.length };
  } catch (e) {
    console.error('[booking_alert]', e.message);
    return null;
  }
}

module.exports = { bookingAlert, bodyValues, fmtDate, microMarket, recipients };
