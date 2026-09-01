// Read/write client for the CP inventory database (channel_partners, rms).
//
// This is a DIFFERENT Postgres instance from the dashboard's own (`_db.js`) —
// no foreign keys or joins are possible across the two, which is why a booking
// snapshots the CP's details into booking_details rather than referencing them.
//
// We connect with an owner-level role, so every query here is deliberately
// narrow: look up a CP, and write back a single email column. Nothing else in
// that database is ours to touch.
const { Pool } = require('pg');

let _pool = null;
function cpPool() {
  if (_pool) return _pool;
  if (!process.env.CP_INVENTORY_DB) throw new Error('CP_INVENTORY_DB is not set');
  _pool = new Pool({
    connectionString: process.env.CP_INVENTORY_DB,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return _pool;
}

// Phones are stored as bare 10 digits. Operators paste "+91 98765 43210",
// "098765-43210" etc., so reduce to the last 10 digits before matching.
function normalisePhone(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normaliseCode(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

const SELECT_CP = `
  SELECT cp.id, cp.cp_code, cp.name, cp.phone, cp.email, cp.company, cp.city, cp.is_active
  FROM channel_partners cp`;

// Look a CP up by code or phone. cp_code is unique; phone is very nearly unique
// (one known collision), so this always returns a list and lets the caller
// disambiguate rather than silently picking one.
async function findChannelPartners({ code, phone }) {
  const c = normaliseCode(code);
  const p = normalisePhone(phone);
  if (!c && p.length !== 10) return [];

  const { rows } = c
    ? await cpPool().query(`${SELECT_CP} WHERE UPPER(cp.cp_code) = $1 LIMIT 5`, [c])
    : await cpPool().query(`${SELECT_CP} WHERE regexp_replace(cp.phone, '\\D', '', 'g') = $1 LIMIT 5`, [p]);
  return rows;
}

// Write an operator-supplied email back onto the CP, so the next lookup has it.
// channel_partners.email is empty for every row today; this is how it fills up.
// Scoped to the single row and the single column, and skipped when the stored
// value already matches.
async function saveChannelPartnerEmail(id, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!id || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return { updated: false, reason: 'invalid email' };
  const { rows } = await cpPool().query(
    `UPDATE channel_partners
        SET email = $1
      WHERE id = $2
        AND (email IS DISTINCT FROM $1)
      RETURNING id, cp_code, email`,
    [clean, id]
  );
  return { updated: rows.length > 0, row: rows[0] || null };
}

module.exports = { cpPool, findChannelPartners, saveChannelPartnerEmail, normalisePhone, normaliseCode };
