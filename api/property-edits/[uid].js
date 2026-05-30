// POST /api/property-edits/:uid
//
// Lets Admin/Manager edit a small allow-list of supply-side fields. The target
// table is determined at runtime based on which table contains the uid:
//   - properties        → real, supply-pipeline properties
//   - legacy_properties → demand-only legacy imports
//
// Same allow-list applies to both. Same audit-log behavior (action='property_edit',
// details: {field, from, to, table} so legacy edits are distinguishable in logs).
//
// EVERY successful change is logged to activity_logs. UPDATE + INSERT happen
// inside a single transaction — rollback on error means no orphan writes
// without an audit trail.
//
// Hard-restricted to a fixed allow-list (ALLOWED_FIELDS_*). No dynamic field
// names from the request body — even a compromised client can only modify
// these specific columns.

const { pool, getPropertiesColumns, SUPPLY_READY_STATUSES } = require('../_db');
const { requireAuth, canEdit, setCors } = require('../_auth');

const ALLOWED_FIELDS_INT = [
  'total_units',
  'total_floors_tower',
  'total_flats_floor',
];

const ALLOWED_FIELDS_REAL = [
  'maintenance_charges',
  'society_move_in_charges',
  'electricity_charges',
  'dg_charges',
  'circle_rate',
  'society_age_years',
  'outstanding_loan',
  'current_occupancy_pct',
  // Backend-form's Beta range. Now present on both `properties` and
  // `legacy_properties` (legacy columns added via INIT_SQL ALTERs) so the
  // Demand Dashboard can surface the same Min %/Max % range on legacy rows
  // when alpha_beta = 'Flexible'.
  'ama_beta_min_pct',
  'ama_beta_max_pct',
];

const ALLOWED_FIELDS_DATE = [
  'key_handover_date',
];

const ALLOWED_FIELDS_TEXT = [
  'alpha_beta',              // Legacy free-text Payment Structure (kept for legacy_properties)
  'ama_payment_structure',   // Canonical Payment Structure for real properties (Alpha/Beta/etc.)
  'loan_status',
  'bank_name_loan',
  'assigned_by',             // POC — dropdown UI but stored as text
];

// Strict-enum fields: only the listed values (or NULL) accepted.
const ALLOWED_FIELDS_ENUM = {
  source: ['CP', 'Direct'],
};

const ALLOWED_FIELDS = [
  ...ALLOWED_FIELDS_INT,
  ...ALLOWED_FIELDS_REAL,
  ...ALLOWED_FIELDS_DATE,
  ...ALLOWED_FIELDS_TEXT,
  ...Object.keys(ALLOWED_FIELDS_ENUM),
];

const MAX_TEXT_LEN = 500;

// Auto-derivation for the per-unit "Current Occupancy" labels.
// Trigger: an actual change to key_handover_date — once the unit's keys are
// in Openhouse custody, any prior Tenant/Owner Staying label is no longer
// accurate, so we flip the affected fields to 'Vacant'. We only re-label
// values already in the canonical {Vacant, Tenant, Owner Staying} set —
// other values (society-level "Ready to Move" etc.) are left untouched.
const AUTO_VACANT_FIELDS  = ['possession_status', 'occupancy_status'];
const AUTO_VACANT_FROM    = ['Vacant', 'Tenant', 'Owner Staying'];

// Cache: which columns exist on legacy_properties. We own this schema, so the
// list is stable per cold start. Mirrors the getPropertiesColumns pattern.
let _legacyColumnCache = null;
async function getLegacyPropertiesColumns() {
  if (_legacyColumnCache) return _legacyColumnCache;
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'legacy_properties' ORDER BY ordinal_position
  `);
  _legacyColumnCache = rows.map(r => r.column_name);
  return _legacyColumnCache;
}

// Returns 'properties' if uid is in the real supply pool (gated by ap_details.status),
// 'legacy_properties' if in the demand-only legacy pool, null otherwise. The gate
// stops URL-hacking from reaching unqualified properties.
async function findUidTable(uid) {
  const supplyReadyParams = SUPPLY_READY_STATUSES.map((_, i) => `$${i + 2}`).join(',');

  const realRes = await pool.query(
    `SELECT 1 FROM properties p
     INNER JOIN ap_details apd ON apd.uid = p.uid
     WHERE p.uid = $1 AND apd.status IN (${supplyReadyParams})`,
    [uid, ...SUPPLY_READY_STATUSES]
  );
  if (realRes.rowCount) return 'properties';

  const legacyRes = await pool.query(
    `SELECT 1 FROM legacy_properties WHERE uid = $1`,
    [uid]
  );
  if (legacyRes.rowCount) return 'legacy_properties';

  return null;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!canEdit(user)) {
    return res.status(403).json({ success: false, error: 'Viewer access is read-only' });
  }

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ success: false, error: 'uid is required' });

  // Parse + validate each submitted field. Reject the whole request on any
  // invalid input — no partial saves.
  const updates = {};
  for (const field of ALLOWED_FIELDS) {
    if (req.body[field] === undefined) continue;
    const raw = req.body[field];

    if (raw === null || raw === '' || raw === undefined) {
      updates[field] = null;
      continue;
    }

    if (ALLOWED_FIELDS_INT.includes(field) || ALLOWED_FIELDS_REAL.includes(field)) {
      const num = ALLOWED_FIELDS_INT.includes(field) ? parseInt(raw, 10) : parseFloat(raw);
      if (isNaN(num) || num < 0) {
        return res.status(400).json({ success: false, error: `${field} must be a non-negative number` });
      }
      updates[field] = num;
    } else if (ALLOWED_FIELDS_DATE.includes(field)) {
      const val = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || isNaN(Date.parse(val))) {
        return res.status(400).json({ success: false, error: `${field} must be YYYY-MM-DD` });
      }
      updates[field] = val;
    } else if (ALLOWED_FIELDS_TEXT.includes(field)) {
      const val = String(raw).trim();
      if (val.length > MAX_TEXT_LEN) {
        return res.status(400).json({ success: false, error: `${field} exceeds ${MAX_TEXT_LEN} characters` });
      }
      updates[field] = val;
    } else if (ALLOWED_FIELDS_ENUM[field]) {
      const val = String(raw).trim();
      if (!ALLOWED_FIELDS_ENUM[field].includes(val)) {
        return res.status(400).json({
          success: false,
          error: `${field} must be one of: ${ALLOWED_FIELDS_ENUM[field].join(', ')}`,
        });
      }
      updates[field] = val;
    }
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ success: false, error: 'No valid fields to update' });
  }

  // Determine which table owns this uid.
  const targetTable = await findUidTable(uid);
  if (!targetTable) {
    return res.status(404).json({ success: false, error: 'Property not found in demand pool' });
  }

  // Defensive: confirm each updated column exists in the target table's schema.
  // properties may drift (owned by backend-form); legacy_properties is stable
  // (we own it) but we still check for symmetry / future schema changes.
  const tableCols = targetTable === 'properties'
    ? await getPropertiesColumns()
    : await getLegacyPropertiesColumns();

  for (const field of Object.keys(updates)) {
    if (!tableCols.includes(field)) {
      return res.status(500).json({
        success: false,
        error: `Column "${field}" doesn't exist in ${targetTable} table`,
      });
    }
  }

  // Transaction: read old → diff → UPDATE → INSERT logs → COMMIT.
  // Any failure ROLLBACKs everything — no orphan writes, no orphan logs.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cols = Object.keys(updates).map(f => `"${f}"`).join(', ');
    const oldRes = await client.query(
      `SELECT ${cols} FROM ${targetTable} WHERE uid = $1 FOR UPDATE`,
      [uid]
    );
    const oldRow = oldRes.rows[0] || {};

    // Per-type compare so legitimate no-ops don't pollute the audit log.
    const diff = {};
    for (const [field, newVal] of Object.entries(updates)) {
      const oldVal = oldRow[field];
      let same;
      if (oldVal == null && newVal == null) {
        same = true;
      } else if (oldVal == null || newVal == null) {
        same = false;
      } else if (ALLOWED_FIELDS_INT.includes(field) || ALLOWED_FIELDS_REAL.includes(field)) {
        same = Number(oldVal) === Number(newVal);
      } else if (ALLOWED_FIELDS_DATE.includes(field)) {
        const oldStr = oldVal instanceof Date ? oldVal.toISOString().slice(0, 10) : String(oldVal).slice(0, 10);
        same = oldStr === String(newVal);
      } else {
        same = String(oldVal).trim() === String(newVal).trim();
      }
      if (!same) diff[field] = { from: oldVal, to: newVal };
    }

    if (!Object.keys(diff).length) {
      await client.query('ROLLBACK');
      return res.status(200).json({ success: true, updated: {}, message: 'No changes' });
    }

    // Auto-vacant rule: if key_handover_date actually changed in this request,
    // also flip possession_status / occupancy_status to 'Vacant' — but ONLY
    // when the current value is one of {Vacant, Tenant, Owner Staying}. Other
    // values are left alone. Runs inside the same transaction (and inside the
    // row-level lock from the earlier FOR UPDATE) so the date change and the
    // status flip can never disagree under concurrency.
    const autoDerived = new Set();
    // Only fire when key_handover_date is being SET to a non-null date — if
    // the user clears the date (cancelling the handover), the prior tenant /
    // owner may still be staying, so we should not force-flip to Vacant.
    if (diff.key_handover_date && diff.key_handover_date.to) {
      const autoCols = AUTO_VACANT_FIELDS.filter(c => tableCols.includes(c));
      if (autoCols.length) {
        const sel = autoCols.map(c => `"${c}"`).join(', ');
        const curRes = await client.query(
          `SELECT ${sel} FROM ${targetTable} WHERE uid = $1`,
          [uid]
        );
        const cur = curRes.rows[0] || {};
        for (const c of autoCols) {
          const cv = (cur[c] == null) ? '' : String(cur[c]).trim();
          // Skip if not in the trigger set, OR already Vacant (no-op per spec).
          if (!AUTO_VACANT_FROM.includes(cv) || cv === 'Vacant') continue;
          diff[c] = { from: cur[c], to: 'Vacant' };
          autoDerived.add(c);
        }
      }
    }

    const setClauses = Object.keys(diff).map((f, i) => `"${f}" = $${i + 2}`).join(', ');
    const updateParams = [uid, ...Object.values(diff).map(d => d.to)];
    await client.query(
      `UPDATE ${targetTable} SET ${setClauses} WHERE uid = $1`,
      updateParams
    );

    // Audit log — `table` field on details lets us distinguish legacy edits
    // from real-properties edits when querying activity_logs later. Auto-
    // derived rows carry an explicit `auto` tag so they can be filtered out
    // (or counted) in later analytics.
    for (const [field, { from, to }] of Object.entries(diff)) {
      const details = { field, from, to, table: targetTable };
      if (autoDerived.has(field)) details.auto = 'key_handover_vacant';
      await client.query(
        `INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, details, dashboard)
         VALUES ($1, 'property_edit', 'supply_field', $2, $3, $4, 'Demand Dashboard')`,
        [uid, user.email || '', user.name || '', JSON.stringify(details)]
      );
    }

    await client.query('COMMIT');

    const updated = {};
    for (const [field, { to }] of Object.entries(diff)) updated[field] = to;
    res.status(200).json({ success: true, updated, table: targetTable });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[/api/property-edits]', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
};
