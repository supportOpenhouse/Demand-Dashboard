const { pool, getPropertiesColumns, hasCol, masterSocietiesHasAffordable,
        masterSocietiesHasMicroMarket, SUPPLY_READY_STATUSES,
        KEY_HANDOVER_DONE_STATUS } = require('./_db');
const { requireAuth, setCors } = require('./_auth');

// Typed projection list shared by both sides of the UNION ALL. Each tuple is:
//   [source column on properties, source column on legacy_properties, output alias, postgres type]
// `type` is required because UNION ALL needs matching types on both sides;
// missing columns on either side are projected as NULL::<type>.
//
// Most columns are identical on both tables; the few that diverge get distinct
// source-column names (e.g. supply uses owner_broker_name → output alias 'owner_name';
// legacy_properties has owner_broker_name too, same alias).
const UNIFIED_COLS = [
  // [propsCol, legacyCol, alias, type]
  ['uid',                       'uid',                       'uid',                       'TEXT'],
  ['society_name',              'society_name',              'society_name',              'TEXT'],
  ['unit_no',                   'unit_no',                   'unit_no',                   'TEXT'],
  ['tower_no',                  'tower_no',                  'tower_no',                  'TEXT'],
  ['floor',                     'floor',                     'floor',                     'TEXT'],  // properties.floor is TEXT and holds 'Top'/'Ground' — never cast it to INTEGER
  ['city',                      'city',                      'city',                      'TEXT'],
  ['locality',                  'locality',                  'locality',                  'TEXT'],
  ['source',                    'source',                    'source',                    'TEXT'],
  ['assigned_by',               'assigned_by',               'poc',                       'TEXT'],

  ['configuration',             'configuration',             'configuration',             'TEXT'],
  ['area_sqft',                 'area_sqft',                 'area_sqft',                 'REAL'],
  ['super_area',                'super_area',                'super_area',                'REAL'],
  ['carpet_area',               'carpet_area',               'carpet_area',               'REAL'],
  ['extra_area',                'extra_area',                'extra_area',                'JSONB'],
  ['bathrooms',                 'bathrooms',                 'bathrooms',                 'INTEGER'],
  ['balconies',                 'balconies',                 'balconies',                 'INTEGER'],
  ['balcony_details',           'balcony_details',           'balcony_details',           'JSONB'],

  ['total_lifts',               null,                        'total_lifts',               'INTEGER'],
  ['total_floors_tower',        'total_floors_tower',        'total_floors_tower',        'INTEGER'],
  ['total_flats_floor',         'total_flats_floor',         'total_flats_floor',         'INTEGER'],
  ['society_age_years',         'society_age_years',         'society_age_years',         'REAL'],
  ['total_units',               'total_units',               'total_units',               'INTEGER'],
  ['exit_facing',               'exit_facing',               'exit_facing',               'TEXT'],
  ['exit_compass_image',        'exit_compass_image',        'exit_compass_image',        'TEXT'],

  ['possession_status',         'possession_status',         'possession_status',         'TEXT'],
  ['occupancy_status',          'occupancy_status',          'occupancy_status',          'TEXT'],
  ['current_occupancy_pct',     'current_occupancy_pct',     'current_occupancy_pct',     'REAL'],
  ['key_handover_date',         'key_handover_date',         'key_handover_date',         'DATE'],
  ['tentative_handover_date',   'tentative_handover_date',   'tentative_handover_date',   'DATE'],

  ['maintenance_charges',       'maintenance_charges',       'maintenance_charges',       'REAL'],
  ['society_move_in_charges',   'society_move_in_charges',   'society_move_in_charges',   'REAL'],
  ['electricity_charges',       'electricity_charges',       'electricity_charges',       'REAL'],
  ['dg_charges',                'dg_charges',                'dg_charges',                'REAL'],
  ['circle_rate',               'circle_rate',               'circle_rate',               'REAL'],
  ['alpha_beta',                'alpha_beta',                'alpha_beta',                'TEXT'],
  ['beta_pct',                  'beta_pct',                  'beta_pct',                  'REAL'],
  // Backend-form's canonical Payment Structure trio. `ama_payment_structure` is
  // still real-only — legacy carries its Flexible/Non-Flexible flag in
  // alpha_beta (TEXT). The min/max pair is now mirrored on legacy_properties
  // (added via INIT_SQL ALTERs) so the dashboard can surface the same Min %/
  // Max % range when alpha_beta = 'Flexible' on legacy rows.
  ['ama_payment_structure',     null,                        'ama_payment_structure',     'TEXT'],
  ['ama_beta_min_pct',          'ama_beta_min_pct',          'ama_beta_min_pct',          'REAL'],
  ['ama_beta_max_pct',          'ama_beta_max_pct',          'ama_beta_max_pct',          'REAL'],
  ['guaranteed_sale_price',     'guaranteed_sale_price',     'guaranteed_sale_price',     'REAL'],
  ['listing_asking_price',      'listing_asking_price',      'listing_asking_price',      'REAL'],
  ['demand_price',              'demand_price',              'demand_price',              'REAL'],

  ['gas_pipeline',              'gas_pipeline',              'gas_pipeline',              'TEXT'],
  ['club_facility',             'club_facility',             'club_facility',             'TEXT'],
  ['parking',                   'parking',                   'parking',                   'TEXT'],
  ['furnishing',                'furnishing',                'furnishing',                'TEXT'],
  ['furnishing_details',        'furnishing_details',        'furnishing_details',        'JSONB'],

  ['owner_broker_name',         'owner_broker_name',         'owner_name',                'TEXT'],
  ['contact_no',                'contact_no',                'contact_no',                'TEXT'],
  ['co_owner',                  'co_owner',                  'co_owner',                  'TEXT'],
  ['co_owner_number',           'co_owner_number',           'co_owner_number',           'TEXT'],
  ['seller_residential_status', 'seller_residential_status', 'seller_residential_status', 'TEXT'],
  ['seller_location',           'seller_location',           'seller_location',           'TEXT'],

  ['loan_status',               'loan_status',               'loan_status',               'TEXT'],
  ['outstanding_loan',          'outstanding_loan',          'outstanding_loan',          'REAL'],
  ['bank_name_loan',            'bank_name_loan',            'bank_name_loan',            'TEXT'],

  ['documents_available',       'documents_available',       'documents_available',       'JSONB'],
  ['ama_date',                  'ama_date',                  'ama_date',                  'DATE'],
  // Form 9 (Key Handover Acknowledgement) submission stamp, written by the supply
  // forms app. This — not the presence of a date — is what makes key handover
  // genuinely "Done": key_handover_date alone can be a tentative Form 3 value or a
  // manual entry. Real-side only; legacy rows never pass through the supply forms.
  ['final_submitted_at',        null,                        'final_submitted_at',        'TIMESTAMPTZ'],

  ['additional_images',         'additional_images',         'additional_images',         'JSONB'],
  ['video_link',                'video_link',                'video_link',                'TEXT'],
  ['core_home_id',              null,                        'core_home_id',              'INTEGER'],
];

// Build the SELECT projection for the real-properties side of the UNION.
// Columns that don't exist in the live `properties` table (schema drift) get
// projected as NULL::<type> — same approach used since launch.
function buildPropertiesProjection(allCols) {
  const cols = UNIFIED_COLS.map(([propsCol, _legacyCol, alias, type]) => {
    if (propsCol && hasCol(allCols, propsCol)) {
      return `p."${propsCol}"::${type} AS "${alias}"`;
    }
    return `NULL::${type} AS "${alias}"`;
  });
  // Trailing virtual columns: status + ancillary fields from ap_details, origin tag.
  cols.push(
    `apd.status::TEXT AS supply_status`,
    `apd.parking_number::TEXT AS parking_number`,
    `apd.property_tax_status::TEXT AS property_tax_status`,
    `apd.internal_remarks::TEXT AS supply_internal_remarks`,
    `'real'::TEXT AS origin`,
  );
  return cols.join(',\n        ');
}

// Build the SELECT projection for the legacy-properties side.
// All columns we declared in legacy_properties exist (we own the schema) so no
// existence check is needed.
function buildLegacyProjection() {
  const cols = UNIFIED_COLS.map(([_propsCol, legacyCol, alias, type]) => {
    if (legacyCol) {
      return `lp."${legacyCol}"::${type} AS "${alias}"`;
    }
    return `NULL::${type} AS "${alias}"`;
  });
  cols.push(
    `lp.legacy_status::TEXT AS supply_status`,
    `lp.parking_number::TEXT AS parking_number`,
    `NULL::TEXT AS property_tax_status`,
    `NULL::TEXT AS supply_internal_remarks`,
    `'legacy'::TEXT AS origin`,
  );
  return cols.join(',\n        ');
}

// Key handover → occupancy sync.
//
// Once the keys are in Openhouse custody, any Tenant / Owner Staying label is
// stale and flips to 'Vacant'. Handover counts as real on either signal — a Form 9
// (Key Handover Acknowledgement) submission, or the supply pipeline reaching
// 'Key Handover Done' — matching keyHandoverDone() in the frontend. Form 9 alone
// would miss the ~64 fully-progressed units that predate / bypassed the form and
// leave them reading "Done" while still labelled Tenant.
//
// The two labels are NOT treated alike, because the confidence differs:
//   Tenant       → always flips. A tenanted unit whose keys reached Openhouse
//                  means the tenant left; there is no ambiguous case.
//   Owner Staying → flips only when owner_will_vacate holds an explicit answer
//                  other than 'No'. 'No' is Form 9's own carve-out (it sets the
//                  handover date to the AMA date precisely because no handover
//                  happens). NULL/'' is the important one: owner_will_vacate was
//                  added to `properties` by a later ALTER, so older rows never
//                  answered it — and guessing 'Vacant' for an owner who may still
//                  be living there sends the demand team to visit an occupied
//                  home. Those units keep their label for a human to resolve.
//
// Runs on every list load rather than through a hook, following the same
// self-healing pattern as the demand_details materialization above — this app
// has no callback from the supply forms. It is cheap and idempotent: the WHERE
// clause only matches rows still needing a flip, so after the first pass it
// matches nothing. Each flip is audit-logged with an `auto` tag so it is
// distinguishable from a human edit.
//
// Legacy rows are untouched — legacy_properties has no Form 9 stamp.
async function syncKeyHandoverVacancy(allCols) {
  const required = ['final_submitted_at', 'key_handover_date', 'owner_will_vacate',
                    'possession_status', 'occupancy_status', 'updated_at'];
  if (!required.every(c => hasCol(allCols, c))) return;

  try {
    await pool.query(`
      WITH cand AS MATERIALIZED (
        SELECT p.uid,
               TRIM(COALESCE(p.possession_status, '')) AS old_poss,
               TRIM(COALESCE(p.occupancy_status,  '')) AS old_occ,
               (TRIM(COALESCE(p.owner_will_vacate, '')) NOT IN ('', 'No')) AS owner_vacating
        FROM properties p
        LEFT JOIN ap_details apd ON apd.uid = p.uid
        WHERE (p.final_submitted_at IS NOT NULL OR apd.status = $1)
          AND p.key_handover_date IS NOT NULL
          AND (
            TRIM(COALESCE(p.possession_status, '')) = 'Tenant'
            OR TRIM(COALESCE(p.occupancy_status, '')) = 'Tenant'
            OR (TRIM(COALESCE(p.owner_will_vacate, '')) NOT IN ('', 'No')
                AND (TRIM(COALESCE(p.possession_status, '')) = 'Owner Staying'
                  OR TRIM(COALESCE(p.occupancy_status,  '')) = 'Owner Staying'))
          )
      ), upd AS (
        UPDATE properties p SET
          possession_status = CASE
            WHEN c.old_poss = 'Tenant' THEN 'Vacant'
            WHEN c.old_poss = 'Owner Staying' AND c.owner_vacating THEN 'Vacant'
            ELSE p.possession_status END,
          occupancy_status = CASE
            WHEN c.old_occ = 'Tenant' THEN 'Vacant'
            WHEN c.old_occ = 'Owner Staying' AND c.owner_vacating THEN 'Vacant'
            ELSE p.occupancy_status END,
          updated_at = NOW()
        FROM cand c WHERE p.uid = c.uid
        RETURNING p.uid
      )
      INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, details, dashboard)
      SELECT c.uid, 'property_edit', 'supply_field', '', 'System (key handover sync)',
             jsonb_build_object(
               'auto', 'key_handover_vacant_sync',
               'table', 'properties',
               'possession_status_from', c.old_poss,
               'occupancy_status_from',  c.old_occ,
               'to', 'Vacant'
             ),
             'Demand Dashboard'
      FROM cand c
    `, [KEY_HANDOVER_DONE_STATUS]);
  } catch (err) {
    // Never let the sync break the listing — the dashboard still renders the
    // pre-flip values and the next load retries.
    console.warn('[syncKeyHandoverVacancy]', err.message);
  }
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const allCols = await getPropertiesColumns();
    const hasAffordable = await masterSocietiesHasAffordable();
    const hasMicroMarket = await masterSocietiesHasMicroMarket();

    const { search, city, source, poc, affordable, availability, occupancy,
            dateField, from, to, page, limit: rawLimit } = req.query;

    // Micromarket is multi-select, sent as a repeated param
    // (?micromarket=A&micromarket=B). A comma-delimited single value is also
    // accepted so a hand-written URL still works. Normalized to lowercase here
    // because the master table's casing is inconsistent.
    const micromarketFilter = [].concat(req.query.micromarket || [])
      .flatMap(v => String(v).split(','))
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);

    // Status filters — independent dropdowns, applied as an AND so users can
    // narrow by both the availability pill (Available/Booked/Sold/Dead) and
    // the occupancy subtitle (Vacant/Tenant/Owner Staying) at the same time.
    // 'Dead' is a soft-delete: rows carrying it are hidden from viewers +
    // managers by the visibility gate below (`hideDead`) so only admins can
    // actually see Dead rows or filter by them.
    const VALID_AVAIL = ['Available', 'Booked', 'Sold', 'Dead'];
    const VALID_OCC   = ['Vacant', 'Tenant', 'Owner Staying'];
    const hideDead    = user.role !== 'admin';
    const notDeadSql  = `COALESCE(dd.availability_status, 'Available') <> 'Dead'`;

    // Real-side gate: only properties whose ap_details.status is supply-ready.
    // These params occupy the first N placeholders; outer-WHERE filters follow.
    const supplyReadyParams = SUPPLY_READY_STATUSES.map((_, i) => `$${i + 1}`).join(',');
    const baseParams = [...SUPPLY_READY_STATUSES];

    // Filters apply to BOTH sides of the UNION via the outer WHERE on the CTE.
    const outerConditions = [];
    const outerParams = [];

    if (city) {
      outerParams.push(city);
      outerConditions.push(`u.city = $${baseParams.length + outerParams.length}`);
    }
    if (source) {
      outerParams.push(source);
      outerConditions.push(`u.source = $${baseParams.length + outerParams.length}`);
    }
    if (poc) {
      outerParams.push(poc);
      outerConditions.push(`u.poc = $${baseParams.length + outerParams.length}`);
    }
    // Affordable filter ('yes' / 'no') resolves against the master_societies
    // LEFT JOIN added below, so it only applies where that table is available.
    // 'yes' → affordable = true; 'no' → affordable = false (societies with no
    // master row are NULL and fall out of both filtered views, as expected).
    if (hasAffordable && (affordable === 'yes' || affordable === 'no')) {
      outerParams.push(affordable === 'yes');
      outerConditions.push(`ms.affordable = $${baseParams.length + outerParams.length}`);
    }
    // Micro-market — the sub-city area, resolved through the same master_societies
    // LATERAL join as `affordable`. Several may be selected at once, so this is an
    // ANY() over the normalized names rather than an equality test.
    if (hasMicroMarket && micromarketFilter.length) {
      outerParams.push(micromarketFilter);
      outerConditions.push(`LOWER(TRIM(ms.micro_market)) = ANY($${baseParams.length + outerParams.length}::text[])`);
    }
    // Availability → demand_details.availability_status. demand_details is
    // LEFT JOINed and may be NULL — rows without a demand_details row are
    // treated as 'Available' downstream via COALESCE, so we match the same way.
    // For non-admins, filtering on 'Dead' would return zero rows anyway thanks
    // to the visibility gate; the dropdown option is stripped in the UI too.
    if (availability && VALID_AVAIL.includes(availability)) {
      outerParams.push(availability);
      outerConditions.push(`COALESCE(dd.availability_status, 'Available') = $${baseParams.length + outerParams.length}`);
    }
    // Visibility gate: non-admins never see Dead units in any query below.
    if (hideDead) outerConditions.push(notDeadSql);
    // Occupancy → unit-level. The dashboard renders the Status subtitle as
    // possession_status with occupancy_status as fallback, so the filter
    // matches the same way.
    if (occupancy && VALID_OCC.includes(occupancy)) {
      outerParams.push(occupancy);
      outerConditions.push(`COALESCE(u.possession_status, u.occupancy_status) = $${baseParams.length + outerParams.length}`);
    }

    // Date range filter — `dateField` lets the caller pick which timestamp to filter on.
    const VALID_DATE_FIELDS = ['ama_date', 'key_handover_date', 'updated_at'];
    const df = VALID_DATE_FIELDS.includes(dateField) ? dateField : 'ama_date';
    const dfTable = df === 'updated_at' ? 'dd' : 'u';
    if (from) {
      outerParams.push(from);
      outerConditions.push(`${dfTable}."${df}" >= $${baseParams.length + outerParams.length}`);
    }
    if (to) {
      outerParams.push(to);
      outerConditions.push(`${dfTable}."${df}" <= $${baseParams.length + outerParams.length}`);
    }

    if (search) {
      outerParams.push(`%${search.toLowerCase()}%`);
      const idx = baseParams.length + outerParams.length;
      const searchCols = ['uid', 'society_name', 'owner_name', 'unit_no', 'contact_no', 'locality'];
      const clause = searchCols
        .map(c => `LOWER(COALESCE(u."${c}"::text, '')) LIKE $${idx}`)
        .join(' OR ');
      outerConditions.push(`(${clause})`);
    }

    const outerWhere = outerConditions.length ? `WHERE ${outerConditions.join(' AND ')}` : '';

    const pageSize = Math.min(Math.max(parseInt(rawLimit) || 100, 1), 500);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const offset = (pageNum - 1) * pageSize;

    const propsProjection = buildPropertiesProjection(allCols);
    const legacyProjection = buildLegacyProjection();

    // Per-society attributes from master_societies (affordable flag, micro-market)
    // folded in by matching society_name (case-insensitive, trimmed). LATERAL +
    // LIMIT 1 keeps it a 1:1 lookup so a duplicate society_name in the master table
    // can't multiply demand rows. Each column is projected only where it exists —
    // the table is owned externally and may be absent or lag a column on some
    // deployments — with NULL standing in otherwise, which also disables the
    // corresponding filter above. Shared by the count, rows and distinct queries so
    // both filters narrow the badge count and the dropdowns alike.
    const msCols = [
      hasAffordable  ? 'affordable'   : null,
      hasMicroMarket ? 'micro_market' : null,
    ].filter(Boolean);
    const msSelect =
      (hasAffordable  ? 'ms.affordable AS affordable,'      : 'NULL::boolean AS affordable,') +
      (hasMicroMarket ? ' ms.micro_market AS micro_market,' : ' NULL::text AS micro_market,');
    const msJoin = msCols.length
      ? `LEFT JOIN LATERAL (
             SELECT ${msCols.join(', ')} FROM master_societies ms
             WHERE LOWER(TRIM(ms.society_name)) = LOWER(TRIM(u.society_name))
             LIMIT 1
           ) ms ON TRUE`
      : '';

    // CTE encapsulates the UNION ALL of real + legacy, then outer SELECT applies
    // demand_details join, filters, ordering and pagination uniformly across both.
    // Real side: INNER JOIN ap_details + status filter — properties without an
    // ap_details row, or whose status isn't AMA Signed / Key Handover Done, are
    // excluded. Legacy side: every row in legacy_properties is shown.
    const baseCte = `
      WITH unified AS (
        SELECT
        ${propsProjection}
        FROM properties p
        INNER JOIN ap_details apd ON apd.uid = p.uid
        WHERE apd.status IN (${supplyReadyParams})

        UNION ALL

        SELECT
        ${legacyProjection}
        FROM legacy_properties lp
      )`;

    // Materialize a demand_details row for every property in the pool, so the
    // table mirrors exactly what the dashboard shows — a unit rendered as
    // "Available" has a real row saying 'Available', not a COALESCE default.
    // Column defaults supply the values ('Available' / 'Buyer Visit' / '');
    // updated_by stays NULL, which is what marks a row as never user-edited.
    // ON CONFLICT makes it idempotent and self-healing: properties that enter
    // the pool later (Supply flips ap_details.status) get their row on the
    // next list load, with no cron or hook into the Supply app.
    await pool.query(`${baseCte}
      INSERT INTO demand_details (uid)
      SELECT u.uid FROM unified u
      ON CONFLICT (uid) DO NOTHING`, baseParams);

    await syncKeyHandoverVacancy(allCols);

    // Total count across both halves, with filters applied.
    const countSql = `${baseCte}
      SELECT COUNT(*) FROM unified u
      LEFT JOIN demand_details dd ON dd.uid = u.uid
      ${msJoin}
      ${outerWhere}`;
    const countResult = await pool.query(countSql, [...baseParams, ...outerParams]);
    const totalCount = parseInt(countResult.rows[0].count);

    // Scope total — count of the unified pool restricted to the city scope
    // ONLY (no source/poc/affordable/status/date/search filters applied).
    // Drives the header subtitle's first number when a city is picked
    // ("Noida · 35 of 182 Properties"). Skipped when no city is set since
    // it would equal grandTotal. Dead-unit visibility gate applied for
    // non-admins so the denominator matches what they can actually see.
    const totalsExtraWhere = hideDead ? `WHERE ${notDeadSql}` : '';
    const grandTotalSql = `${baseCte}
      SELECT COUNT(*) FROM unified u
      LEFT JOIN demand_details dd ON dd.uid = u.uid
      ${totalsExtraWhere}`;
    const grandTotalResult = await pool.query(grandTotalSql, baseParams);
    const grandTotal = parseInt(grandTotalResult.rows[0].count);

    let scopeTotal = grandTotal;
    if (city) {
      const scopeWhereParts = [`u.city = $${baseParams.length + 1}`];
      if (hideDead) scopeWhereParts.push(notDeadSql);
      const scopeSql = `${baseCte}
        SELECT COUNT(*) FROM unified u
        LEFT JOIN demand_details dd ON dd.uid = u.uid
        WHERE ${scopeWhereParts.join(' AND ')}`;
      const scopeResult = await pool.query(scopeSql, [...baseParams, city]);
      scopeTotal = parseInt(scopeResult.rows[0].count);
    }

    const limitParamIdx = baseParams.length + outerParams.length + 1;
    const offsetParamIdx = baseParams.length + outerParams.length + 2;

    const rowsSql = `${baseCte}
      SELECT u.*,
             ${msSelect}
             dd.listing_price          AS listing_price,
             COALESCE(dd.demand_status, 'Buyer Visit') AS demand_status,
             COALESCE(dd.availability_status, 'Available') AS availability_status,
             dd.buyer_visit_date,
             dd.buyer_interested_date,
             dd.buyer_revisit_date,
             dd.negotiation_meeting_date,
             dd.booking_done_date,
             dd.ats_signed_date,
             dd.registry_done_date,
             dd.sold_date,
             dd.internal_remarks,
             dd.legacy_raw_values,
             dd.updated_by,
             dd.updated_at
      FROM unified u
      LEFT JOIN demand_details dd ON dd.uid = u.uid
      ${msJoin}
      ${outerWhere}
      ORDER BY COALESCE(u.ama_date, u.key_handover_date) DESC NULLS LAST
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`;

    const { rows } = await pool.query(rowsSql, [...baseParams, ...outerParams, pageSize, offset]);

    // Default listing price for the Update Home form: the listing price when
    // set, otherwise acquisition + 8%. Derived server-side and exposed to every
    // role so managers can publish a home without a listing price — the raw
    // acquisition column itself stays admin-only below.
    //
    // Note this is reversible (÷1.08 recovers the acquisition price), so it does
    // disclose the cost basis to managers. That is a deliberate, accepted
    // trade-off for the publishing flow, not an oversight.
    for (const r of rows) {
      r.default_price_lakhs =
        (r.listing_price != null && r.listing_price !== '')
          ? Number(r.listing_price)
          : (r.guaranteed_sale_price != null && r.guaranteed_sale_price !== ''
              ? Number(r.guaranteed_sale_price) * 1.08
              : null);
      if (!Number.isFinite(r.default_price_lakhs)) r.default_price_lakhs = null;
    }

    // Acquisition price (properties.guaranteed_sale_price) is admin-only — our
    // cost basis, not something manager/viewer should see. Hiding it in the UI
    // isn't enough since the raw row lands in the browser, so drop the column
    // from the payload for everyone but admin.
    if (user.role !== 'admin') {
      for (const r of rows) delete r.guaranteed_sale_price;
    }

    // Distinct values for filter dropdowns — pulled from the full unified pool
    // (no outer filter conditions applied here) so picking one filter never
    // strips options from another. The CTE still applies the supply-ready gate.
    const distinctSql = `${baseCte}
      SELECT DISTINCT u.city, u.source, u.poc, ${hasMicroMarket ? 'ms.micro_market' : 'NULL::text AS micro_market'}
      FROM unified u
      ${msJoin}`;
    const distinctRows = await pool.query(distinctSql, baseParams);
    const cities = new Set(), sources = new Set(), pocs = new Set();
    // Micro-markets are deduped case-insensitively (Map keyed on the lowercased
    // name, first-seen casing wins) because master_societies is hand-maintained
    // and the same area can appear as "Sector 150" and "sector 150" — which would
    // otherwise show as two identical-looking dropdown entries. The filter matches
    // case-insensitively too, so either casing selects the same rows.
    // They're also bucketed by city: a micro-market belongs to exactly one city,
    // so the frontend narrows its dropdown once a city is picked rather than
    // listing every area across the country.
    const micromarkets = new Map();
    const micromarketsByCity = {};
    for (const r of distinctRows.rows) {
      if (r.city) cities.add(r.city);
      if (r.source) sources.add(r.source);
      if (r.poc) pocs.add(r.poc);
      const mm = (r.micro_market || '').trim();
      if (mm) {
        const key = mm.toLowerCase();
        if (!micromarkets.has(key)) micromarkets.set(key, mm);
        if (r.city) (micromarketsByCity[r.city] ||= new Map()).set(key, micromarkets.get(key));
      }
    }
    const sortedNames = (map) => [...map.values()].sort((a, b) => a.localeCompare(b));
    const distinct = {
      cities:  [...cities].sort(),
      sources: [...sources].sort(),
      pocs:    [...pocs].sort(),
      micromarkets: sortedNames(micromarkets),
      micromarketsByCity: Object.fromEntries(
        Object.entries(micromarketsByCity).map(([c, map]) => [c, sortedNames(map)])
      ),
    };

    res.status(200).json({
      success: true,
      count: rows.length,
      total: totalCount,
      scopeTotal,
      grandTotal,
      page: pageNum,
      pageSize,
      totalPages: Math.ceil(totalCount / pageSize),
      distinct,
      role: user.role,
      data: rows,
    });
  } catch (err) {
    console.error('[/api/list]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
