#!/usr/bin/env node
//
// scripts/rollback-legacy.js
//
// Undoes legacy CSV imports by deleting every row whose uid matches LEG-* from
// legacy_properties + properties (in case any orphans remain from the old
// Option A script) + ap_details + demand_details. Covers every city
// (G/N/GH/...) with one invocation.
//
// Defaults to ALL cities. Pass --city=<Gurgaon|Noida|Ghaziabad> to scope to
// one city's prefix only — useful for rolling back a single failed import.
//
// Adds a 'legacy_rollback' entry to activity_logs for each removed uid so the
// original 'legacy_import' entries (preserved) and the rollback events form a
// complete audit trail.
//
// Usage:
//   node scripts/rollback-legacy.js                       # DRY-RUN, all cities
//   node scripts/rollback-legacy.js --city=Noida          # DRY-RUN, Noida only (LEG-N-*)
//   node scripts/rollback-legacy.js --commit              # actually DELETE all
//   node scripts/rollback-legacy.js --city=Noida --commit # actually DELETE Noida only
//
// Reads DATABASE_URL from .env (or environment).

const fs = require('fs');
const path = require('path');

// Lazy .env loader (matches the importer).
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (/^['"].*['"]$/.test(val)) val = val.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  }
} catch {}

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}

const dryRun = !process.argv.includes('--commit');

// City scoping. Defaults to all cities (LEG-%); --city=Noida narrows to LEG-N-%.
const CITY_TO_UID_PREFIX = { Gurgaon: 'G', Noida: 'N', Ghaziabad: 'GH' };
const cityArg = process.argv.find(a => a.startsWith('--city='))?.split('=')[1];
let UID_PATTERN = 'LEG-%';
let scopeLabel = 'ALL CITIES';
if (cityArg) {
  const cityKey = cityArg.charAt(0).toUpperCase() + cityArg.slice(1).toLowerCase();
  if (!CITY_TO_UID_PREFIX[cityKey]) {
    console.error(`Unknown city "${cityArg}". Allowed: ${Object.keys(CITY_TO_UID_PREFIX).join(', ')}`);
    process.exit(1);
  }
  UID_PATTERN = `LEG-${CITY_TO_UID_PREFIX[cityKey]}-%`;
  scopeLabel = cityKey;
}

(async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  console.log(`Mode:   ${dryRun ? 'DRY-RUN (no DB writes)' : 'COMMIT (will delete)'}`);
  console.log(`Scope:  ${scopeLabel}  (uid pattern: ${UID_PATTERN})\n`);

  // Find affected rows. With Option B isolation, legacy imports live in
  // `legacy_properties` (not `properties`). We still cross-check `properties`
  // to catch any orphans from the old Option A import script.
  const { rows: legacyRows } = await pool.query(
    `SELECT uid, society_name, unit_no
       FROM legacy_properties
      WHERE uid LIKE $1
      ORDER BY uid`,
    [UID_PATTERN]
  );
  const { rows: orphanRealRows } = await pool.query(
    `SELECT uid, society_name, unit_no
       FROM properties
      WHERE uid LIKE $1
      ORDER BY uid`,
    [UID_PATTERN]
  );
  const { rows: apdRows } = await pool.query(
    `SELECT uid FROM ap_details WHERE uid LIKE $1`, [UID_PATTERN]
  );
  const { rows: ddRows } = await pool.query(
    `SELECT uid FROM demand_details WHERE uid LIKE $1`, [UID_PATTERN]
  );

  // Union of uids found anywhere. We'll DELETE from each table that has them.
  const allUids = new Set([
    ...legacyRows.map(r => r.uid),
    ...orphanRealRows.map(r => r.uid),
  ]);
  if (!allUids.size) {
    console.log('No matching legacy properties found. Nothing to do.');
    await pool.end();
    return;
  }

  // Build a display list (prefer legacy_properties row info if present).
  const display = [];
  for (const uid of [...allUids].sort()) {
    const lr = legacyRows.find(r => r.uid === uid);
    const or = orphanRealRows.find(r => r.uid === uid);
    const info = lr || or;
    const tables = [];
    if (lr) tables.push('legacy_properties');
    if (or) tables.push('properties (Option A orphan!)');
    display.push({ uid, society_name: info.society_name, unit_no: info.unit_no, tables });
  }

  console.log(`Found in live DB:`);
  console.log(`  legacy_properties:  ${legacyRows.length} rows`);
  console.log(`  properties:         ${orphanRealRows.length} rows ${orphanRealRows.length ? '⚠️ Option A orphan' : ''}`);
  console.log(`  ap_details:         ${apdRows.length} rows`);
  console.log(`  demand_details:     ${ddRows.length} rows`);
  console.log('');
  console.log('Properties to remove:');
  for (const d of display) {
    console.log(`  ${d.uid}  ${d.society_name} · ${d.unit_no}  [${d.tables.join(', ')}]`);
  }
  console.log('');

  if (dryRun) {
    console.log('DRY-RUN complete. Re-run with --commit to actually delete.');
    await pool.end();
    return;
  }

  // Real delete — single transaction. Aborts cleanly on any error.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let removed = 0;
    for (const d of display) {
      // Children first (no FKs today but order-safe). Each DELETE is a no-op
      // if the row doesn't exist in that table — fine for partial cleanups.
      await client.query(`DELETE FROM demand_details   WHERE uid = $1`, [d.uid]);
      await client.query(`DELETE FROM ap_details       WHERE uid = $1`, [d.uid]);
      await client.query(`DELETE FROM legacy_properties WHERE uid = $1`, [d.uid]);
      await client.query(`DELETE FROM properties        WHERE uid = $1`, [d.uid]);

      // Preserves audit trail — the original 'legacy_import' rows stay
      // untouched in activity_logs; this adds a paired 'legacy_rollback' entry.
      await client.query(
        `INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, details, dashboard)
         VALUES ($1, 'legacy_rollback', 'csv_rollback', 'legacy_import@system', 'Legacy Importer', $2, 'Demand Dashboard')`,
        [d.uid, JSON.stringify({
          society: d.society_name,
          unit: d.unit_no,
          tables_cleared: d.tables,
          rolled_back_at: new Date().toISOString(),
        })]
      );

      removed++;
      console.log(`  ✓ removed ${d.uid}`);
    }

    await client.query('COMMIT');
    console.log(`\n✓ Removal complete. ${removed} legacy properties deleted from legacy_properties / properties / ap_details / demand_details.`);
    console.log(`  Original 'legacy_import' audit entries preserved in activity_logs.`);
    console.log(`  Paired 'legacy_rollback' entries inserted for each removal.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Transaction reverted due to error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
