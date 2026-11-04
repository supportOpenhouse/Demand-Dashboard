// Read-only access to the Demand CRM (Openhouse_Demand_CRM) database: who on the
// demand side is responsible for a unit (its PM, the "demand POC") and that PM's
// manager. Same rules the CRM's own Daily Sales Report uses (backend/api/dsr.py):
//
//   POC      the PM who held the home on the booking date (property_assignments),
//            else its current PM (v_property_current_pm). The CRM's property is
//            matched on supply_form_uid = our uid, else home_id = core_home_id.
//   manager  dsr_pm_managers for that PM, else the manager of the PM's main area
//            (dsr_area_managers) — the area holding most of the PM's current homes,
//            the property's own area when the PM has none.
//
// Env: DEMAND_CRM_DATABASE_URL. Unset or unreachable → null, never an error.
const { Pool } = require('pg');

// dsr.py AREA_ALIASES — micro markets the CRM stores under another area's name.
const AREA_ALIASES = {
  'greater noida west': 'Noida Extension',
  'sector 10 greater noida west': 'Noida Extension',
  'nh24, ghaziabad': 'NH24',
};
const normArea = s => {
  const t = String(s || '').trim();
  return t ? (AREA_ALIASES[t.toLowerCase()] || t) : null;
};

let _pool;
function pool() {
  if (_pool !== undefined) return _pool;
  // Neon adds channel_binding; drop it, as the CRM's own dsr.py does.
  let url = String(process.env.DEMAND_CRM_DATABASE_URL || '').trim();
  try {
    const u = new URL(url);
    u.searchParams.delete('channel_binding');
    u.searchParams.delete('sslmode');      // ssl is set below
    url = u.toString();
  } catch (_) { /* leave as given */ }
  _pool = url ? new Pool({ connectionString: url, ssl: { rejectUnauthorized: false },
                           max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 }) : null;
  return _pool;
}

const USER_COLS = 'u.id, u.name, lower(u.email) AS email, u.phone';

// { poc: {name, email, phone} | null, manager: {...} | null } for one unit.
async function pocAndManager(uid, coreHomeId, onDate) {
  const db = pool();
  if (!db) return null;
  const c = await db.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const prop = (await c.query(
      `SELECT id, micro_market FROM properties
        WHERE deleted_at IS NULL
          AND (supply_form_uid = $1 OR ($2::text IS NOT NULL AND home_id::text = $2::text))
        ORDER BY (supply_form_uid = $1) DESC, updated_at DESC LIMIT 1`,
      [uid, coreHomeId != null && coreHomeId !== '' ? String(coreHomeId) : null])).rows[0];
    if (!prop) return { poc: null, manager: null };

    const day = onDate ? String(onDate).slice(0, 10) : null;
    let poc = day ? (await c.query(
      `SELECT ${USER_COLS} FROM property_assignments a JOIN users u ON u.id = a.pm_user_id
        WHERE a.property_id = $1
          AND (a.effective_from AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
          AND (a.effective_to IS NULL OR (a.effective_to AT TIME ZONE 'Asia/Kolkata')::date >= $2::date)
        ORDER BY a.effective_from DESC LIMIT 1`, [prop.id, day])).rows[0] : null;
    if (!poc) {
      poc = (await c.query(
        `SELECT ${USER_COLS} FROM v_property_current_pm v JOIN users u ON u.id = v.pm_user_id
          WHERE v.property_id = $1`, [prop.id])).rows[0] || null;
    }
    if (!poc) return { poc: null, manager: null };

    let manager = (await c.query(
      `SELECT ${USER_COLS} FROM dsr_pm_managers d JOIN users u ON u.id = d.manager_user_id
        WHERE d.pm_user_id = $1`, [poc.id])).rows[0] || null;
    if (!manager) {
      const counts = {};
      for (const r of (await c.query(
        `SELECT p.micro_market, count(*)::int AS n FROM v_property_current_pm v
           JOIN properties p ON p.id = v.property_id
          WHERE v.pm_user_id = $1 GROUP BY 1`, [poc.id])).rows) {
        const a = normArea(r.micro_market);
        if (a) counts[a] = (counts[a] || 0) + r.n;
      }
      // dsr.py: max by (count, name)
      const main = Object.entries(counts).sort((x, y) => y[1] - x[1] || (y[0] > x[0] ? 1 : -1))[0];
      const area = main ? main[0] : normArea(prop.micro_market);
      if (area) {
        manager = (await c.query(
          `SELECT ${USER_COLS} FROM dsr_area_managers d JOIN users u ON u.id = d.manager_user_id
            WHERE d.area = $1`, [area])).rows[0] || null;
      }
    }
    const shape = u => u && { name: u.name, email: u.email, phone: u.phone };
    return { poc: shape(poc), manager: shape(manager) };
  } catch (e) {
    console.error('[demandcrm] poc lookup:', e.message);
    return null;
  } finally {
    try { await c.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    c.release();
  }
}

// {email: {name, phone}} of CRM users by email (lower-cased), for people the Demand
// Dashboard's own users table has no row or number for.
async function usersByEmail(emails) {
  const db = pool();
  if (!db || !emails.length) return {};
  try {
    const { rows } = await db.query(
      `SELECT lower(email) AS email, name, phone FROM users WHERE lower(email) = ANY($1::text[])`, [emails]);
    return Object.fromEntries(rows.map(r => [r.email, { name: r.name, phone: r.phone }]));
  } catch (e) {
    console.error('[demandcrm] users:', e.message);
    return {};
  }
}

module.exports = { pocAndManager, usersByEmail, normArea };
