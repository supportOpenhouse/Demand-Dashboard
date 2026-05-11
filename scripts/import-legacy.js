#!/usr/bin/env node
//
// scripts/import-legacy.js
//
// City-agnostic legacy CSV importer. Writes to legacy_properties + demand_details.
// Does NOT touch `properties` or `ap_details` (Option B isolation).
//
// Auto-detects the city from the CSV filename ("Listing Database - <City>.csv")
// and constructs a per-city UID prefix from backend-form's cityMap:
//   Gurgaon → LEG-G-<Sno>
//   Noida   → LEG-N-<Sno>
//   Ghaziabad → LEG-GH-<Sno>
//
// Override city via --city=Noida if the filename doesn't match the convention.
//
// Usage:
//   node scripts/import-legacy.js "/path/Listing Database - Noida.csv"
//   node scripts/import-legacy.js "/path/Listing Database - Noida.csv" --commit
//   node scripts/import-legacy.js "/path/SomeOther.csv" --city=Gurgaon

const fs = require('fs');
const path = require('path');

// .env loader
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
  console.error('FATAL: DATABASE_URL is not set. Add it to demand-dashboard/.env or export it.');
  process.exit(1);
}

// ── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const dryRun = !args.includes('--commit');
const cityArg = args.find(a => a.startsWith('--city='))?.split('=')[1];

if (!csvPath) {
  console.error('Usage: node scripts/import-legacy.js "/path/to/csv" [--city=Noida] [--commit]');
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error('CSV not found:', csvPath);
  process.exit(1);
}

// City prefix mirrors backend-form/openhouse-forms/routes/config.js cityMap.
const CITY_TO_UID_PREFIX = { Gurgaon: 'G', Noida: 'N', Ghaziabad: 'GH' };

function detectCity(p) {
  const m = path.basename(p).match(/Listing Database - ([A-Za-z]+)\.csv$/i);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

let city = cityArg
  ? cityArg.charAt(0).toUpperCase() + cityArg.slice(1).toLowerCase()
  : detectCity(csvPath);
if (!city) {
  console.error('Could not detect city from filename. Pass --city=<Gurgaon|Noida|Ghaziabad>.');
  process.exit(1);
}
if (!CITY_TO_UID_PREFIX[city]) {
  console.error(`Unknown city "${city}". Add a UID prefix in CITY_TO_UID_PREFIX first.`);
  process.exit(1);
}
const uidPrefix = CITY_TO_UID_PREFIX[city];

// ── Audit-approved correction maps ─────────────────────────────────────

const EXTRA_AREA_MAP = {
  'No extra room':  'No Extra Room',
  'Servant Quarter':'Servant Room',
  'Puja Room':      'Pooja Room',
  'Study Room':     'Study Room',
  'Store Room':     'Store Room',  // canonical (added during Noida audit)
};

const PARKING_MAP = {
  '1 - Closed':         '1 Closed',
  '1 - Open':           '1 Open',
  '2- Closed':          '2 Closed',
  '2 - Closed':         '2 Closed',
  '2 - Open':           '2 Open',
  '1 - Open, 1 - Closed':'1 Open + 1 Closed',
};

const FURNISHING_MAP = {
  'Semi Furnished':  'Semi-Furnished',
  'Semi-Furnished':  'Semi-Furnished',
  'Fully Furnished': 'Fully Furnished',
  'Unfurnished':     'Unfurnished',
};

const FURNISHING_ITEM_MAP = {
  'Geyser':           'Geysers',
  'Lights': 'Lights', 'Fans': 'Fans', 'Modular Kitchen': 'Modular Kitchen',
  'Chimney': 'Chimney', 'Almirahs': 'Almirahs', 'ACs': 'ACs', 'Geysers': 'Geysers',
};

const EXIT_FACING_MAP = {
  'North East':  'North-East',
  'North East ': 'North-East ',
  'South East':  'South-East',
  'South East ': 'South-East ',
  'North West':  'North-West',
  'North West ': 'North-West ',
  'South West':  'South-West',
  'South West ': 'South-West ',
};

const BALCONY_VIEW_MAP = {
  'Open':            'Open Area',
  'Road': 'Road', 'Club': 'Club', 'Garden': 'Garden',
  'Park/Playground': 'Park/Playground',
  'Swimming Pool':   'Swimming Pool',
  'Open Area':       'Open Area',
  'Other Building':  'Other Building',
  'Tower':           'Tower',
  'N/A':             'N/A',
};

const DOC_MAP = {
  'BBA':                                'Builder Buyer Agreement',
  'Allotment Letter':                   'Allotment Letter issued by the Builder',
  'Possession Letter':                  'Possession Letter/Certificate by the Builder',
  'Sale Deed':                          'Conveyance Deed/Sub Lease Deed/Sale Deed',
  'Conveyance':                         'Conveyance Deed/Sub Lease Deed/Sale Deed',
  'Conveyance/ Sale Deed':              'Conveyance Deed/Sub Lease Deed/Sale Deed',
  'Loan Related Document':              'Other Documents',
  'Endorsement Letter':                 'Other Documents',
  'Parking Allotment Letter':           'Other Documents',
  'No Dues Letter - Maintenance/ RWA':  'Other Documents',
  'No Dues Letter - Property Tax':      'Other Documents',  // Noida audit addition
};

// First-name → full-name mapping for POC (CSV uses short names).
// Anything not in this map AND not in canonical assignedByList → kept as-is
// (they'll show up in the dashboard's POC dropdown as "(legacy)" entries).
// 'Apurv' → null (per user direction; not in canonical list).
const POC_MAP = {
  'Abhishek': 'Abhishek Rathore',
  'Shashank': 'Shashank Kumar',
  'Rupali':   'Rupali Prasad',
  'Animesh':  'Animesh Singh',  // Ghaziabad audit addition
  'Apurv':    null,
};

// AMA date overrides per (city, sno). Used when the CSV value is missing,
// obviously wrong, or the user has provided an explicit correction.
const AMA_DATE_OVERRIDES = {
  Gurgaon: {
    '62':  '2026-01-21',
    '143': '2026-03-28',
  },
  Noida: {
    '113': '2026-03-11',  // CSV says 11-Mar-2023; user clarified year is 2026
  },
  Ghaziabad: {},
};

// ── CSV parsing (handles multi-line quoted cells) ──────────────────────

function parseCsv(s) {
  const out = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') { q = false; }
      else cell += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
      else if (c === '\r') {}
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out;
}

// ── Field transforms ────────────────────────────────────────────────────

function parseAmaDate(raw, sno, cityName) {
  const overrides = AMA_DATE_OVERRIDES[cityName] || {};
  if (overrides[sno]) return overrides[sno];
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
                   Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
  const mm = months[m[2].slice(0,1).toUpperCase() + m[2].slice(1,3).toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2,'0')}`;
}

function parseInt0(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseFloat0(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseCarpetArea(raw) {
  const s = String(raw || '').trim();
  if (!s) return { value: null, raw: null };
  const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return { value: parseFloat(range[1]), raw: s };
  const n = parseFloat(s);
  return { value: isNaN(n) ? null : n, raw: null };
}

function parseListCanonical(raw, map) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const seen = new Set();
  const out = [];
  for (const part of s.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const canonical = map[trimmed] !== undefined ? map[trimmed] : trimmed;
    if (!seen.has(canonical)) { seen.add(canonical); out.push(canonical); }
  }
  return out;
}

function parseExtraArea(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const mapped = EXTRA_AREA_MAP[s] !== undefined ? EXTRA_AREA_MAP[s] : s;
  return mapped === 'No Extra Room' ? [] : [mapped];
}

function parseBalconyDetails(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const seen = new Set();
  const out = [];
  for (const part of s.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const canonical = BALCONY_VIEW_MAP[trimmed] !== undefined ? BALCONY_VIEW_MAP[trimmed] : trimmed;
    if (!seen.has(canonical)) { seen.add(canonical); out.push({ view: canonical }); }
  }
  return out;
}

function parseFurnishingItems(raw) {
  // "No Items" (Noida audit) → empty list. Otherwise canonicalize each comma-separated item.
  const s = String(raw || '').trim();
  if (!s || /^no\s*items$/i.test(s)) return [];
  return parseListCanonical(raw, FURNISHING_ITEM_MAP);
}

function parseDocs(raw) { return parseListCanonical(raw, DOC_MAP); }

function parseExitFacing(raw) {
  const s = String(raw || '');  // do NOT trim — preserve trailing whitespace per user direction
  if (!s) return null;
  return EXIT_FACING_MAP[s] !== undefined ? EXIT_FACING_MAP[s] : s;
}

function parsePoc(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return POC_MAP[s] !== undefined ? POC_MAP[s] : s;
}

function parseOwnerName(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.split(/\r?\n/).map(x => x.trim()).filter(Boolean).join(', ');
}

function parseLoanStatus(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^(no\s*loan|na|no)$/i.test(s)) return 'No Loan';
  return s;
}

function parseAlphaBeta(alphaRaw, betaRaw) {
  const a = String(alphaRaw || '').trim();
  const b = String(betaRaw || '').trim();
  if (!a && !b) return null;
  return `Alpha ${a || '—'} / Beta ${b || '—'}`;
}

function parseListingPrice(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── Main ────────────────────────────────────────────────────────────────

(async function main() {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) { console.error('CSV has no data rows'); process.exit(1); }
  const dataRows = rows.slice(1).filter(r => /^\d+$/.test(String(r[0] || '').trim()));

  console.log(`Mode:       ${dryRun ? 'DRY-RUN (no DB writes)' : 'COMMIT (will write)'}`);
  console.log(`City:       ${city}  (UID prefix: LEG-${uidPrefix}-*)`);
  console.log(`Target:     legacy_properties + demand_details (Supply tracker won't see these)`);
  console.log(`CSV:        ${csvPath}`);
  console.log(`Data rows:  ${dataRows.length}\n`);

  // Build records. Intra-CSV dedupe by Sno — if the same Sno appears twice
  // (e.g. Sno 115 in Ghaziabad), we keep the first and warn about extras.
  const seenSnos = new Set();
  const intraDupes = [];
  const records = [];
  for (const r of dataRows) {
    const sno = String(r[0]).trim();
    if (seenSnos.has(sno)) { intraDupes.push(sno); continue; }
    seenSnos.add(sno);

    const carpet = parseCarpetArea(r[14]);
    const legacy_raw_values = {};
    if (carpet.raw) legacy_raw_values.carpet_area = carpet.raw;
    const parkingNumber = (function () {
      const s = String(r[22] || '').trim();
      return s && s.toUpperCase() !== 'NA' ? s : null;
    })();

    records.push({
      sno,
      uid: `LEG-${uidPrefix}-${sno}`,
      legacy_properties: {
        city:                   String(r[5] || '').trim() || null,
        locality:               String(r[7] || '').trim() || null,
        society_name:           String(r[6] || '').trim() || null,
        unit_no:                String(r[8] || '').trim() || null,
        floor:                  parseInt0(r[9]),
        source:                 null,                   // user assigns via dashboard
        assigned_by:            parsePoc(r[3]),
        configuration:          String(r[10] || '').trim() || null,
        area_sqft:              parseFloat0(r[13]),
        super_area:             parseFloat0(r[13]),
        carpet_area:            carpet.value,
        extra_area:             JSON.stringify(parseExtraArea(r[11])),
        bathrooms:              parseInt0(r[16]),
        balconies:              parseInt0(r[17]),
        balcony_details:        JSON.stringify(parseBalconyDetails(r[28])),
        total_floors_tower:     parseInt0(r[25]),
        total_flats_floor:      parseInt0(r[26]),
        society_age_years:      parseFloat0(r[29]),
        total_units:            parseInt0(r[31]),
        exit_facing:            parseExitFacing(r[27]),
        possession_status:      String(r[19] || '').trim() || null,
        current_occupancy_pct:  parseFloat0(r[43]),
        key_handover_date:      null,                   // user assigns via dashboard
        maintenance_charges:    parseFloat0(r[32]),
        society_move_in_charges: parseFloat0(r[33]),
        electricity_charges:    parseFloat0(r[34]),
        dg_charges:             parseFloat0(r[36]),
        circle_rate:            parseFloat0(r[44]),
        alpha_beta:             parseAlphaBeta(r[39], r[40]),
        gas_pipeline:           String(r[18] || '').trim() || null,
        club_facility:          String(r[20] || '').trim() || null,
        parking:                (PARKING_MAP[String(r[21] || '').trim()] || String(r[21] || '').trim() || null),
        parking_number:         parkingNumber,
        furnishing:             FURNISHING_MAP[String(r[23] || '').trim()] || (String(r[23] || '').trim() || null),
        furnishing_details:     JSON.stringify(parseFurnishingItems(r[24])),
        owner_broker_name:      parseOwnerName(r[38]),
        seller_location:        String(r[42] || '').trim() || null,
        loan_status:            parseLoanStatus(r[41]),
        documents_available:    JSON.stringify(parseDocs(r[37])),
        ama_date:               parseAmaDate(r[1], sno, city),
        legacy_status:          'AMA Signed',
      },
      demand_details: {
        listing_price: parseListingPrice(r[12]),
        legacy_raw_values: Object.keys(legacy_raw_values).length ? JSON.stringify(legacy_raw_values) : null,
      },
    });
  }

  if (intraDupes.length) {
    console.log(`⚠️  Intra-CSV duplicates (kept first occurrence, dropped rest): Sno ${intraDupes.join(', ')}\n`);
  }

  console.log('Planned inserts:');
  for (const rec of records) {
    const p = rec.legacy_properties;
    console.log(`  ${rec.uid}  ${p.society_name} · ${p.unit_no}  AMA=${p.ama_date}  POC=${p.assigned_by || '(unassigned)'}  ListPrice=${rec.demand_details.listing_price}`);
  }
  console.log('');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  // Schema check
  const liveCols = new Set(
    (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'legacy_properties'`
    )).rows.map(r => r.column_name)
  );
  if (liveCols.size === 0) {
    console.error('✗ Table `legacy_properties` does not exist yet. Hit any /api/* endpoint after deploy to trigger INIT_SQL, then re-run.');
    await pool.end();
    process.exit(1);
  }
  const sample = records[0]?.legacy_properties || {};
  const skipCols = Object.keys(sample).filter(c => !liveCols.has(c));
  if (skipCols.length) {
    console.log('⚠️  Skipping columns missing from live legacy_properties:');
    console.log(`     ${skipCols.join(', ')}\n`);
  }
  const writeCols = Object.keys(sample).filter(c => liveCols.has(c));

  // Cross-table duplicate check (society + unit) against BOTH `properties` and `legacy_properties`.
  const dupes = [];
  for (const rec of records) {
    const p = rec.legacy_properties;
    if (!p.society_name || !p.unit_no) continue;
    const realDup = await pool.query(
      `SELECT uid FROM properties WHERE LOWER(society_name) = LOWER($1) AND LOWER(unit_no) = LOWER($2) LIMIT 1`,
      [p.society_name, p.unit_no]
    );
    const legacyDup = await pool.query(
      `SELECT uid FROM legacy_properties WHERE LOWER(society_name) = LOWER($1) AND LOWER(unit_no) = LOWER($2) LIMIT 1`,
      [p.society_name, p.unit_no]
    );
    if (realDup.rows.length || legacyDup.rows.length) {
      dupes.push({
        rec,
        existingRealUid: realDup.rows[0]?.uid || null,
        existingLegacyUid: legacyDup.rows[0]?.uid || null,
      });
    }
  }
  if (dupes.length) {
    console.log('⚠️  These rows already exist in the demand pool (will be SKIPPED):');
    for (const d of dupes) {
      const where = [d.existingRealUid && `properties.uid=${d.existingRealUid}`,
                     d.existingLegacyUid && `legacy_properties.uid=${d.existingLegacyUid}`]
        .filter(Boolean).join(', ');
      console.log(`     ${d.rec.uid}  ${d.rec.legacy_properties.society_name} · ${d.rec.legacy_properties.unit_no}  (${where})`);
    }
    console.log('');
  }
  const toInsert = records.filter(r => !dupes.find(d => d.rec === r));
  console.log(`Will insert: ${toInsert.length}     Will skip (duplicates): ${dupes.length}     Intra-CSV dupes dropped: ${intraDupes.length}\n`);

  if (dryRun) {
    console.log('DRY-RUN complete. Re-run with --commit to actually write.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    for (const rec of toInsert) {
      const p = rec.legacy_properties;
      const vals = writeCols.map(c => p[c]);
      const placeholders = writeCols.map((_, i) => `$${i + 2}`).join(', ');
      await client.query(
        `INSERT INTO legacy_properties (uid, ${writeCols.map(c => `"${c}"`).join(', ')})
         VALUES ($1, ${placeholders})
         ON CONFLICT (uid) DO NOTHING`,
        [rec.uid, ...vals]
      );

      const dd = rec.demand_details;
      await client.query(
        `INSERT INTO demand_details (uid, listing_price, legacy_raw_values, updated_by)
         VALUES ($1, $2, $3, 'legacy_import')
         ON CONFLICT (uid) DO NOTHING`,
        [rec.uid, dd.listing_price, dd.legacy_raw_values]
      );

      await client.query(
        `INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, details, dashboard)
         VALUES ($1, 'legacy_import', 'csv_import', 'legacy_import@system', 'Legacy Importer', $2, 'Demand Dashboard')`,
        [rec.uid, JSON.stringify({
          sno: rec.sno,
          city,
          source_file: path.basename(csvPath),
          target_table: 'legacy_properties',
          import_date: new Date().toISOString(),
        })]
      );

      inserted++;
      console.log(`  ✓ ${rec.uid}  ${p.society_name} · ${p.unit_no}`);
    }

    await client.query('COMMIT');
    console.log(`\n✓ COMMIT complete. Inserted: ${inserted}, skipped (dupes): ${dupes.length}`);
    console.log(`  Wrote to: legacy_properties (${inserted}) + demand_details (${inserted})`);
    console.log(`  Did NOT write to: properties or ap_details (Option B isolation).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ Transaction reverted due to error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
