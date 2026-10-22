// POST /api/loan/submit   — PUBLIC, no authentication.
//
// The Openhouse loan form's intake. Writes a referral ticket into loan_applications
// — the table the Transaction CRM serves the Partner App's loan APIs from (backend
// app/loans.py), using the same field rules as that API's create. Differences, all
// because no broker is behind this form:
//   broker_id NULL, source 'other', commission_pct NULL (no partner to pay).
// The desk works the ticket in the CRM's Loans tab.
//
// The row is committed BEFORE the notification is sent: a failed mail must never
// lose a referral the client believes they submitted.
const { pool, ensureLoanTables } = require('../_db');
const { setCors } = require('../_auth');
const { buildLoanReferralEmail, sendMail } = require('../_email');
const { checkLoanRateLimit, clientIp } = require('./_rate-limit');

const NOTIFY = ['ankit@openhouse.in', 'rajnish@openhouse.in'];

const CITIES = { 1: 'Gurgaon', 2: 'Noida', 4: 'Ghaziabad' };
const EMPLOYMENT = ['salaried', 'self_employed'];
const OPEN_STATUSES = ['with_loan_desk', 'pre_login', 'logged_in', 'sanctioned'];
const LOAN_MIN = 100000, LOAN_MAX = 500000000;
const CONSENT_TEXT_VERSION = 'v1';

const NAME_RE = /^[\p{L} .'-]{1,50}$/u;
const MOBILE_RE = /^[6-9]\d{9}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// The same Openhouse-listing title the CRM stores: "Society · Tower: A · Unit: 1203".
async function resolveHome(homeId) {
  const { rows } = await pool.query(
    `SELECT society_name, tower_no, unit_no, city FROM properties
      WHERE core_home_id = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [homeId]);
  if (!rows.length) return null;
  const r = rows[0];
  const parts = [String(r.society_name || '').trim() || 'Openhouse home'];
  if (String(r.tower_no || '').trim()) parts.push(`Tower: ${String(r.tower_no).trim()}`);
  if (String(r.unit_no || '').trim()) parts.push(`Unit: ${String(r.unit_no).trim()}`);
  return { address: parts.join(' · '), city: r.city ? String(r.city).trim() : null };
}

async function validate(b) {
  const f = {}, c = {};
  for (const [key, col] of [['firstName', 'first_name'], ['lastName', 'last_name']]) {
    const v = String(b[key] || '').trim();
    if (!NAME_RE.test(v)) f[key] = 'Required: 1–50 letters, spaces or . \' -';
    c[col] = v;
  }
  c.client_mobile = String(b.clientMobile || '').trim();
  if (!MOBILE_RE.test(c.client_mobile)) f.clientMobile = 'Required: 10 digits starting 6–9';

  const pan = String(b.clientPan || '').trim().toUpperCase();
  if (pan && !PAN_RE.test(pan)) f.clientPan = 'Invalid PAN (ABCDE1234F)';
  c.client_pan = pan || null;

  const emp = b.employmentType || null;
  if (emp && !EMPLOYMENT.includes(emp)) f.employmentType = 'salaried or self_employed';
  c.employment_type = emp;

  const amt = b.loanAmountRequested;
  if (amt == null || amt === '') c.loan_amount_requested = null;
  else if (!Number.isInteger(amt) || amt < LOAN_MIN || amt > LOAN_MAX) f.loanAmountRequested = `Whole rupees, ${LOAN_MIN}–${LOAN_MAX}`;
  else c.loan_amount_requested = amt;

  const p = b.property && typeof b.property === 'object' ? b.property : null;
  Object.assign(c, { home_id: null, property_address: null, city_id: null, city_name: null });
  if (!p || !['openhouse', 'other'].includes(p.kind)) {
    f.property = 'Choose an Openhouse property or enter another address';
  } else if (p.kind === 'openhouse') {
    c.property_kind = 'openhouse';
    if (!Number.isInteger(p.homeId) || p.homeId <= 0) f.property = 'Choose the Openhouse property';
    else {
      const home = await resolveHome(p.homeId);
      if (!home) f.property = 'That Openhouse property was not found';
      else {
        const cid = Object.keys(CITIES).find((k) => CITIES[k].toLowerCase() === String(home.city || '').toLowerCase());
        Object.assign(c, { home_id: p.homeId, property_address: home.address, city_name: home.city,
                           city_id: cid ? Number(cid) : null });
      }
    }
  } else {
    c.property_kind = 'other';
    const addr = String(p.address || '').trim();
    if (addr.length < 8 || addr.length > 250) f.property = 'Address is required (8–250 characters)';
    let cname = String(p.cityName || '').trim();
    if (p.cityId != null) {
      if (!CITIES[p.cityId]) f.property = f.property || 'Choose a city, or type the city name';
      else cname = CITIES[p.cityId];
    } else if (!cname || cname.length > 80) f.property = f.property || 'The city is required';
    Object.assign(c, { property_address: addr, city_id: CITIES[p.cityId] ? p.cityId : null, city_name: cname || null });
  }

  const note = String(b.note || '').trim();
  if (note.length > 500) f.note = 'At most 500 characters';
  c.note = note || null;

  if (b.consent !== true) f.consent = 'The client must agree to be contacted';
  return { f, c };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ detail: 'Method not allowed', code: 'method_not_allowed' });

  try {
    const gate = await checkLoanRateLimit(clientIp(req), { limit: 10, windowMinutes: 60 });
    if (!gate.allowed) return res.status(429).json({ detail: gate.message, code: 'throttled' });
    if (!(await ensureLoanTables())) {
      return res.status(503).json({ detail: 'The loan form is temporarily unavailable. Please try again shortly.', code: 'unavailable' });
    }

    const { f, c } = await validate(req.body || {});
    if (Object.keys(f).length) {
      return res.status(400).json({ detail: 'Please correct the highlighted fields', code: 'validation_error', fields: f });
    }

    // One open ticket per client, whoever raised it — the same "already_referred"
    // rule the Partner App gets.
    const dup = await pool.query(
      `SELECT id FROM loan_applications
        WHERE (client_mobile = $1 OR ($2::text IS NOT NULL AND client_pan = $2))
          AND status = ANY($3) LIMIT 1`, [c.client_mobile, c.client_pan, OPEN_STATUSES]);
    if (dup.rows.length) {
      return res.status(409).json({ detail: 'We already have an open loan request for this client — our loan desk will be in touch.', code: 'already_referred' });
    }

    const cols = ['broker_id', 'first_name', 'last_name', 'client_mobile', 'client_pan', 'employment_type',
                  'loan_amount_requested', 'property_kind', 'home_id', 'property_address', 'city_id', 'city_name',
                  'note', 'consent', 'consent_text_version', 'source', 'commission_pct'];
    const vals = { ...c, broker_id: null, consent: true, consent_text_version: CONSENT_TEXT_VERSION,
                   source: 'other', commission_pct: null };
    const { rows } = await pool.query(
      `INSERT INTO loan_applications (${cols.join(', ')})
       VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, cols.map((k) => vals[k]));
    const referral = rows[0];

    try {
      const { subject, html } = buildLoanReferralEmail({ referral });
      await sendMail({ to: NOTIFY, subject, html });
    } catch (err) {
      console.error('[/api/loan/submit] notification failed:', err.message);
    }
    return res.status(201).json({ success: true, id: Number(referral.id) });
  } catch (err) {
    console.error('[/api/loan/submit]', err && err.stack || err);
    return res.status(500).json({ detail: 'Something went wrong. Please try again.', code: 'server_error' });
  }
};
