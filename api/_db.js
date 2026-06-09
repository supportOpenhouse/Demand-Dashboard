const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// Demand-side pipeline. Order is meaningful — index doubles as progression rank.
const DEMAND_STATUSES = [
  'Buyer Visit',
  'Buyer Interested',
  'Buyer Revisit',
  'Negotiation Meeting',
  'Booking Done',
  'ATS Signed',
  'Registry Done',
  'Sold',
];

// Properties enter the demand pool only after the supply side has reached one of these.
// Sourced from ap_details.status (replaces the deleted v_property_status view).
const SUPPLY_READY_STATUSES = ['AMA Signed', 'Key Handover Done'];

// Idempotent — runs on every cold start. Owns demand_users and demand_details only.
// Reads activity_logs (created by the Acquired dashboard) but does not own its schema.
const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS demand_users (
    id           SERIAL PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    name         TEXT,
    picture      TEXT,
    role         TEXT NOT NULL DEFAULT 'viewer',
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_demand_users_email ON demand_users(email);

  -- One-shot rename: 'editor' role was renamed to 'manager'. Idempotent — affects
  -- 0 rows after first run. Safe to keep in INIT_SQL indefinitely.
  UPDATE demand_users SET role = 'manager' WHERE role = 'editor';

  -- force_logout_at: when set, any JWT issued before this timestamp is rejected
  -- by requireAuth. Lets admins forcibly invalidate a user's active sessions
  -- without deleting their account.
  ALTER TABLE demand_users ADD COLUMN IF NOT EXISTS force_logout_at TIMESTAMPTZ;

  -- legacy_raw_values: stores original CSV cell text for any field whose value
  -- had to be transformed during legacy bulk imports (e.g. carpet_area "1230-1300"
  -- gets stored as the lower bound 1230, with the original range preserved here
  -- so the dashboard can render an info tooltip).
  -- Shape: { "<column_name>": "<original raw text>", ... }
  ALTER TABLE demand_details ADD COLUMN IF NOT EXISTS legacy_raw_values JSONB;

  -- availability_status: demand-side flag distinct from the supply pipeline
  -- (which lives in ap_details.status). Drives the colored pill in the main
  -- row's "Status" column. Valid values: 'Available' / 'Booked' / 'Sold'.
  ALTER TABLE demand_details ADD COLUMN IF NOT EXISTS availability_status TEXT DEFAULT 'Available';

  -- booking_details: captures the per-property booking submission (the "Submit
  -- Details" modal) and remembers who the email was sent to. Owned by the
  -- demand dashboard. One row per submission — if a booking falls through and
  -- a new buyer appears, a fresh row gets inserted. Latest by mail_sent_at /
  -- created_at is what the UI shows.
  CREATE TABLE IF NOT EXISTS booking_details (
    id                          SERIAL PRIMARY KEY,
    uid                         TEXT NOT NULL,
    buyer_name                  TEXT,
    co_buyer_name               TEXT,
    consideration_amount        REAL,             -- in Rupees
    booking_amount_received     REAL,             -- in Rupees
    booking_amount_method       TEXT,             -- UPI / NEFT / Cash / Cheque / Other
    ats_timeline                TEXT,             -- free text or date
    registry_timeline           TEXT,
    booking_amount_forfeitable  BOOLEAN,
    amount_on_ats_pct           REAL,
    other_conditions            TEXT,
    recipients                  JSONB DEFAULT '[]',  -- array of emails
    mail_sent_at                TIMESTAMPTZ,         -- null until Send Mail succeeds
    submitted_by                TEXT,                -- email of demand-team user
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_booking_details_uid       ON booking_details(uid);
  CREATE INDEX IF NOT EXISTS idx_booking_details_sent      ON booking_details(mail_sent_at DESC);
  CREATE INDEX IF NOT EXISTS idx_booking_details_created   ON booking_details(created_at DESC);

  -- buyer_email / co_buyer_email: captured on the Recipients page of the
  -- booking modal. Stored separately from the curated CP-RM recipients array
  -- (column "recipients"); combined into the effective mailing list at send time.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS buyer_email      TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS co_buyer_email   TEXT;
  -- buyer_salutation: addressee prefix used in the buyer-facing letter
  -- ("Dear Ms. Poonam"). One of Mr./Mrs./Ms./Dr. ats_timeline now stores
  -- an ISO date string (YYYY-MM-DD); registry_timeline stores days-as-integer.
  -- Both kept as TEXT so historical free-text rows still load.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS buyer_salutation TEXT;

  -- broker_emails: separate chip-list on Page 1 of the booking modal, parallel
  -- to the curated CP-RM recipients array. Stored as JSONB array of lowercased
  -- emails. Combined into the effective mailing list at send time.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS broker_emails JSONB DEFAULT '[]';

  -- Split payment support. When the booking amount is paid via two instruments,
  -- booking_amount_method holds the first method + booking_amount_split_1 the
  -- amount paid via it; booking_amount_method_2 / booking_amount_split_2 hold
  -- the second leg. For single-instrument payments, the _2 / split columns
  -- stay NULL and booking_amount_received is the total. The total of the two
  -- legs (when split) equals booking_amount_received.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS booking_amount_method_2 TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS booking_amount_split_1  REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS booking_amount_split_2  REAL;

  -- legacy_properties: parallel to the properties table but OWNED by the
  -- demand dashboard. Holds property records that came in via legacy bulk
  -- import (CSV) and do not belong in the supply pipeline. The Supply Closure
  -- Tracker never reads this table, so legacy records cannot pollute it. The
  -- Demand Dashboard reads both via UNION ALL in /api/list and /api/detail.
  CREATE TABLE IF NOT EXISTS legacy_properties (
    uid                       TEXT PRIMARY KEY,
    -- Identifiers
    city                      TEXT,
    locality                  TEXT,
    society_name              TEXT,
    unit_no                   TEXT,
    tower_no                  TEXT,
    floor                     INTEGER,
    source                    TEXT,
    assigned_by               TEXT,
    -- Configuration
    configuration             TEXT,
    area_sqft                 REAL,
    super_area                REAL,
    carpet_area               REAL,
    extra_area                JSONB DEFAULT '[]',
    bathrooms                 INTEGER,
    balconies                 INTEGER,
    balcony_details           JSONB DEFAULT '[]',
    -- Society / tower
    total_floors_tower        INTEGER,
    total_flats_floor         INTEGER,
    society_age_years         REAL,
    total_units               INTEGER,
    exit_facing               TEXT,
    exit_compass_image        TEXT,
    -- Possession / occupancy
    possession_status         TEXT,
    occupancy_status          TEXT,
    current_occupancy_pct     REAL,
    key_handover_date         DATE,
    tentative_handover_date   DATE,
    -- Charges / financial
    maintenance_charges       REAL,
    society_move_in_charges   REAL,
    electricity_charges       REAL,
    dg_charges                REAL,
    circle_rate               REAL,
    alpha_beta                TEXT,
    beta_pct                  REAL,
    guaranteed_sale_price     REAL,
    listing_asking_price      REAL,
    demand_price              REAL,
    -- Amenities
    gas_pipeline              TEXT,
    club_facility             TEXT,
    parking                   TEXT,
    parking_number            TEXT,
    furnishing                TEXT,
    furnishing_details        JSONB DEFAULT '[]',
    -- Owner / seller
    owner_broker_name         TEXT,
    contact_no                TEXT,
    co_owner                  TEXT,
    co_owner_number           TEXT,
    seller_residential_status TEXT,
    seller_location           TEXT,
    -- Loan
    loan_status               TEXT,
    outstanding_loan          REAL,
    bank_name_loan            TEXT,
    -- Documents / dates / media
    documents_available       JSONB DEFAULT '[]',
    ama_date                  DATE,
    additional_images         JSONB DEFAULT '[]',
    video_link                TEXT,
    -- Retained for historical data; no longer used to gate visibility.
    legacy_status             TEXT NOT NULL DEFAULT 'AMA Signed',
    created_at                TIMESTAMPTZ DEFAULT NOW(),
    updated_at                TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_legacy_props_status   ON legacy_properties(legacy_status);
  CREATE INDEX IF NOT EXISTS idx_legacy_props_society  ON legacy_properties(society_name);
  CREATE INDEX IF NOT EXISTS idx_legacy_props_city     ON legacy_properties(city);

  -- Beta range for legacy units. Mirrors the ama_beta_min_pct / ama_beta_max_pct
  -- columns on the properties table so the Demand Dashboard can surface a
  -- Min %/Max % pair when alpha_beta = 'Flexible' on legacy rows too. Legacy
  -- imports leave these NULL; users fill them in from the expand panel.
  ALTER TABLE legacy_properties ADD COLUMN IF NOT EXISTS ama_beta_min_pct REAL;
  ALTER TABLE legacy_properties ADD COLUMN IF NOT EXISTS ama_beta_max_pct REAL;

  CREATE TABLE IF NOT EXISTS demand_details (
    id                       SERIAL PRIMARY KEY,
    uid                      TEXT NOT NULL UNIQUE,
    listing_price            REAL,
    demand_status            TEXT DEFAULT 'Buyer Visit',
    buyer_visit_date         DATE,
    buyer_interested_date    DATE,
    buyer_revisit_date       DATE,
    negotiation_meeting_date DATE,
    booking_done_date        DATE,
    ats_signed_date          DATE,
    registry_done_date       DATE,
    sold_date                DATE,
    internal_remarks         TEXT DEFAULT '',
    updated_by               TEXT,
    updated_at               TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_demand_details_uid    ON demand_details(uid);
  CREATE INDEX IF NOT EXISTS idx_demand_details_status ON demand_details(demand_status);

  -- activity_logs is shared across dashboards; created by Acquired-dashboard. Create
  -- it here too so this app works standalone if deployed before the others.
  CREATE TABLE IF NOT EXISTS activity_logs (
    id          SERIAL PRIMARY KEY,
    uid         TEXT,
    action      TEXT NOT NULL,
    category    TEXT,
    actor_email TEXT,
    actor_name  TEXT,
    details     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMP DEFAULT (now() AT TIME ZONE 'Asia/Kolkata'),
    dashboard   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_uid     ON activity_logs(uid);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON activity_logs(created_at DESC);
`;

async function ensureTable() {
  try {
    await pool.query(INIT_SQL);
  } catch (err) {
    console.error('[ensureTable] INIT_SQL error:', err.message);
  }
}

async function logActivity(uid, action, category, user, details = {}) {
  try {
    await pool.query(
      `INSERT INTO activity_logs (uid, action, category, actor_email, actor_name, details, dashboard)
       VALUES ($1, $2, $3, $4, $5, $6, 'Demand Dashboard')`,
      [uid, action, category, user.email || '', user.name || '', JSON.stringify(details)]
    );
  } catch (err) {
    console.warn('[logActivity]', err.message);
  }
}

// Cached column list of the `properties` table (it's owned by backend-form, schema
// can drift). One lookup per cold start, then served from memory.
let _columnCache = null;

async function getPropertiesColumns() {
  if (_columnCache) return _columnCache;
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'properties' ORDER BY ordinal_position
  `);
  _columnCache = rows.map(r => r.column_name);
  return _columnCache;
}

function hasCol(allCols, name) {
  return allCols.includes(name);
}

// `master_societies` is owned externally (not created by INIT_SQL), so it may be
// absent on some deployments. Cache — once per cold start — whether the table and
// the two columns we LEFT JOIN on (society_name, affordable) exist, so /api/list
// can fold in the affordable flag without risking a crash where the table is missing.
let _masterSocietiesCache = null;

async function masterSocietiesHasAffordable() {
  if (_masterSocietiesCache !== null) return _masterSocietiesCache;
  try {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'master_societies'
    `);
    const cols = rows.map(r => r.column_name);
    _masterSocietiesCache = cols.includes('society_name') && cols.includes('affordable');
  } catch (err) {
    console.warn('[masterSocietiesHasAffordable]', err.message);
    _masterSocietiesCache = false;
  }
  return _masterSocietiesCache;
}

// Quote and project a property column only if it exists, with an alias. Used to
// build SELECT lists tolerantly so the dashboard doesn't crash if backend-form
// hasn't shipped a particular ALTER yet.
function projectIfExists(allCols, col, alias) {
  return hasCol(allCols, col) ? `p."${col}" AS "${alias || col}"` : `NULL::text AS "${alias || col}"`;
}

module.exports = {
  pool,
  ensureTable,
  logActivity,
  getPropertiesColumns,
  hasCol,
  masterSocietiesHasAffordable,
  projectIfExists,
  DEMAND_STATUSES,
  SUPPLY_READY_STATUSES,
};
