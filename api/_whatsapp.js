// "booking_alert" WhatsApp (Interakt) — announces a booking to the team:
//
//   💰💰Booking Alert💰💰
//   📅 Date - {{1}}            booking date, e.g. 03-Nov-2026
//   🪙 Booking Type - {{2}}    Normal / Conditional
//   🏠  {{3}}                  H - 31, M3M Soulitude
//   🛏️ Config - {{4}}          2BHK, 1082.0 sqft
//   🏙️ MM - {{5}}              New Gurgaon 88-92
//
// Sent once per booking row (booking_details.booking_alert_sent_at is the guard):
//   normal token       automatically, when its buyer booking mail is sent (Send
//                      Buyer Mail, after the preview);
//   conditional token  no mail goes out, so the team sends it with the "Send
//                      Booking Alert" button once the booking is saved complete
//                      (buyer, amount, booking date, payment screenshot).
//
// To: Manish Pal, Ankit, Saurabh, Ashish (TEAM), the unit's demand POC and that
// POC's manager from the Demand CRM (_demandcrm.js), plus anyone in the optional
// BOOKING_ALERT_TO env (comma-separated emails or 10-digit phones). Phones come from
// this dashboard's users table, else the Demand CRM's. Test units (TEST_SOCIETIES)
// go only to TESTERS.
//
// Same Interakt call and the same micro-market rule as the CRM's WhatsApp alerts
// (Transaction-Management-Dashboard backend/app/whatsapp.py). Env: INTERAKT_API_KEY
// (same key as the CRM). Best-effort: never throws into the booking request.
const { pool, logActivity, TEST_SOCIETIES } = require('./_db');
const demandcrm = require('./_demandcrm');

const INTERAKT_URL = 'https://api.interakt.ai/v1/public/message/';
const TEMPLATE = 'booking_alert';
const TESTERS = ['saransh.khera@openhouse.in', 'sahaj.dureja@openhouse.in'];
const TEAM = ['manish.pal@openhouse.in', 'ankit@openhouse.in', 'saurabh@openhouse.in', 'ashish@openhouse.in'];
// Numbers for team members no users table has a phone for (used only as a fallback).
const TEAM_PHONES = { 'manish.pal@openhouse.in': '9810967731' };
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

// Everyone the alert is for: [{name, email, role, phone}] — phone '' when none is on
// file anywhere (reported back as skipped). Testers only for a test unit.
async function recipients(p, bookingDate) {
  const isTest = TEST_SOCIETIES.map(s => s.toLowerCase())
    .includes(String(p.society_name || '').trim().toLowerCase());
  const want = [];
  const add = (who, role) => {
    const w = String(who || '').trim();
    if (w) want.push({ key: w.includes('@') ? w.toLowerCase() : w, role });
  };
  if (isTest) {
    TESTERS.forEach(e => add(e, 'tester'));
  } else {
    TEAM.forEach(e => add(e, 'team'));
    const crm = await demandcrm.pocAndManager(p.uid, p.core_home_id, bookingDate);
    if (crm && crm.poc) want.push({ key: crm.poc.email, role: 'demand POC', crm: crm.poc });
    if (crm && crm.manager) want.push({ key: crm.manager.email, role: 'POC manager', crm: crm.manager });
    String(process.env.BOOKING_ALERT_TO || '').split(',').forEach(e => add(e, 'extra'));
  }

  const emails = [...new Set(want.map(w => w.key).filter(k => k && k.includes('@')))];
  const local = {};
  if (emails.length) {
    const { rows } = await pool.query(
      `SELECT LOWER(TRIM(email)) AS email, name, phone FROM users WHERE LOWER(TRIM(email)) = ANY($1::text[])`,
      [emails]);
    rows.forEach(r => { local[r.email] = r; });
  }
  const missing = emails.filter(e => !cleanPhone((local[e] || {}).phone));
  const crmUsers = await demandcrm.usersByEmail(missing);

  const seen = new Set(), out = [];
  for (const w of want) {
    const isEmail = w.key && w.key.includes('@');
    const u = isEmail ? local[w.key] : null;
    const cu = isEmail ? crmUsers[w.key] : null;
    const name = (w.crm && w.crm.name) || (u && u.name) || (cu && cu.name) || w.key;
    const phone = isEmail
      ? cleanPhone(u && u.phone) || cleanPhone(cu && cu.phone) || cleanPhone(w.crm && w.crm.phone)
        || cleanPhone(TEAM_PHONES[w.key])
      : cleanPhone(w.key);
    const id = phone || w.key;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name, email: isEmail ? w.key : null, role: w.role, phone });
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

// Announce booking row `bookingId` of `property`, once.
// → { ok: true, sent, total, skipped: [names without a phone], failed: [...] }
//   { ok: false, reason: 'not_configured' | 'already_sent' | 'not_found' | 'no_recipients' | 'error', ... }
async function bookingAlert(bookingId, property, user) {
  try {
    if (!configured()) {
      console.warn('[booking_alert] INTERAKT_API_KEY not set — not sent');
      return { ok: false, reason: 'not_configured' };
    }
    const cur = (await pool.query(
      `SELECT booking_date, token_type, booking_alert_sent_at FROM booking_details WHERE id = $1`,
      [bookingId])).rows[0];
    if (!cur) return { ok: false, reason: 'not_found' };
    if (cur.booking_alert_sent_at) return { ok: false, reason: 'already_sent', at: cur.booking_alert_sent_at };
    const people = await recipients(property, cur.booking_date);
    const to = people.filter(r => r.phone);
    const skipped = people.filter(r => !r.phone).map(r => r.name);
    if (!to.length) return { ok: false, reason: 'no_recipients', skipped };
    // Claim first, so two requests can never both announce the same booking.
    const { rows } = await pool.query(
      `UPDATE booking_details SET booking_alert_sent_at = NOW()
        WHERE id = $1 AND booking_alert_sent_at IS NULL
        RETURNING booking_date, token_type, booking_alert_sent_at`, [bookingId]);
    if (!rows.length) return { ok: false, reason: 'already_sent' };
    const values = bodyValues(property, rows[0], await microMarket(property));
    const results = await Promise.all(to.map(async r => ({ ...r, ...(await sendTemplate(r.phone, values)) })));
    const sent = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).map(r => ({ name: r.name, error: r.error }));
    // Nothing went out: release the claim so the button can be pressed again.
    if (!sent) {
      await pool.query(`UPDATE booking_details SET booking_alert_sent_at = NULL WHERE id = $1`, [bookingId]);
    }
    logActivity(property.uid, 'booking_alert_whatsapp', 'booking', user, {
      booking_id: bookingId, template: TEMPLATE, values, sent, total: results.length,
      to: results.map(r => `${r.name} (${r.role})`), skipped, failed,
    });
    return { ok: sent > 0, sent, total: results.length, skipped, failed,
             at: sent ? rows[0].booking_alert_sent_at : null, reason: sent ? undefined : 'send_failed' };
  } catch (e) {
    console.error('[booking_alert]', e.message);
    return { ok: false, reason: 'error', error: e.message };
  }
}

module.exports = { bookingAlert, bodyValues, fmtDate, microMarket, recipients };
