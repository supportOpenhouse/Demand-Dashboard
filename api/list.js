const { pool, getPropertiesColumns, hasCol, masterSocietiesHasAffordable, SUPPLY_READY_STATUSES } = require('./_db');
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
  ['floor',                     'floor',                     'floor',                     'INTEGER'],
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

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const allCols = await getPropertiesColumns();
    const hasAffordable = await masterSocietiesHasAffordable();

    const { search, city, source, poc, affordable, availability, occupancy,
            dateField, from, to, page, limit: rawLimit } = req.query;

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

    // master_societies.affordable (BOOLEAN) folded in by matching society_name
    // (case-insensitive, trimmed). LATERAL + LIMIT 1 keeps it a 1:1 lookup so a
    // duplicate society_name in the master table can't multiply demand rows.
    // Skipped entirely (projected NULL) where the externally-owned table is absent.
    // Shared by the count and rows queries so the affordable filter applies to both.
    const affordableSelect = hasAffordable
      ? 'ms.affordable AS affordable,'
      : 'NULL::boolean AS affordable,';
    const affordableJoin = hasAffordable
      ? `LEFT JOIN LATERAL (
             SELECT affordable FROM master_societies ms
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

    // Total count across both halves, with filters applied.
    const countSql = `${baseCte}
      SELECT COUNT(*) FROM unified u
      LEFT JOIN demand_details dd ON dd.uid = u.uid
      ${affordableJoin}
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
             ${affordableSelect}
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
      ${affordableJoin}
      ${outerWhere}
      ORDER BY COALESCE(u.ama_date, u.key_handover_date) DESC NULLS LAST
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`;

    const { rows } = await pool.query(rowsSql, [...baseParams, ...outerParams, pageSize, offset]);

    // Distinct values for filter dropdowns — pulled from the full unified pool
    // (no outer filter conditions applied here) so picking one filter never
    // strips options from another. The CTE still applies the supply-ready gate.
    const distinctSql = `${baseCte}
      SELECT DISTINCT u.city, u.source, u.poc FROM unified u`;
    const distinctRows = await pool.query(distinctSql, baseParams);
    const cities = new Set(), sources = new Set(), pocs = new Set();
    for (const r of distinctRows.rows) {
      if (r.city) cities.add(r.city);
      if (r.source) sources.add(r.source);
      if (r.poc) pocs.add(r.poc);
    }
    const distinct = {
      cities:  [...cities].sort(),
      sources: [...sources].sort(),
      pocs:    [...pocs].sort(),
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
