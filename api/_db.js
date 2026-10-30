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

// TEST PROPERTIES. Every unit in these societies is a test listing (owners "Test",
// towers "test" — OHGC1001, OHGC1785, OHGD1300 and five more), used to exercise the
// booking and CRM flows end to end. They have to stay on the Demand Dashboard for
// that, but the demand team kept seeing them and acting on them. So they are visible
// ONLY to the people who test, and invisible to everyone else: left out of the list
// and its counts, and "not found" on every per-unit endpoint, so a direct link does
// not reveal them either.
const TEST_SOCIETIES = ['DLF The Camellias'];
const TEST_UNIT_VIEWERS = ['saransh.khera@openhouse.in', 'sahaj.durej@openhouse.in'];

function canSeeTestUnits(user) {
  return TEST_UNIT_VIEWERS.includes(String((user && user.email) || '').trim().toLowerCase());
}

// SQL predicate that drops test units. The society names are constants above, never
// user input, so they are inlined (quote-escaped) rather than bound — which keeps it
// usable inside queries whose placeholder numbering is already fixed.
function notTestUnitSql(alias = 'u') {
  const names = TEST_SOCIETIES.map(s => `'${s.toLowerCase().replace(/'/g, "''")}'`).join(', ');
  return `LOWER(TRIM(COALESCE(${alias}.society_name, ''))) NOT IN (${names})`;
}

// True when this uid is a test unit the user may not see. Looks in both tables a
// Demand unit can come from (properties, legacy_properties).
async function isHiddenTestUnit(uid, user) {
  if (canSeeTestUnits(user) || !uid) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM (
       SELECT society_name FROM properties WHERE uid = $1
       UNION ALL
       SELECT society_name FROM legacy_properties WHERE uid = $1
     ) s WHERE LOWER(TRIM(COALESCE(s.society_name, ''))) = ANY($2::text[]) LIMIT 1`,
    [uid, TEST_SOCIETIES.map(s => s.toLowerCase())]);
  return rows.length > 0;
}

// The supply pipeline's terminal handover state. Treated as equivalent to a Form 9
// submission when deciding whether key handover is genuinely "Done": ~26% of units
// that reached this status predate / bypassed Form 9, but the status itself is a
// demanding gate (deal transfer, docs reviewed, draft AMA, seller approval, AMA
// date passed AND handover date passed), so it is a credible second signal.
const KEY_HANDOVER_DONE_STATUS = 'Key Handover Done';

// Columns stripped from API responses for anyone who isn't an admin. Hiding a
// field in the UI is not a restriction on its own — the raw row still lands in
// the browser and is readable from devtools — so every admin-only field is
// dropped from the payload here as well.
//   guaranteed_sale_price → acquisition price, our cost basis.
//   contact_no / co_owner_number → owner + co-owner phone numbers. Both, because
//     hiding only the owner's leaves the co-owner's as a trivial way around it.
const ADMIN_ONLY_COLUMNS = ['guaranteed_sale_price', 'contact_no', 'co_owner_number'];

// Drop admin-only columns from a row in place. Safe to call on any row shape.
function stripAdminOnlyColumns(row, user) {
  if (!row || (user && user.role === 'admin')) return row;
  for (const col of ADMIN_ONLY_COLUMNS) delete row[col];
  return row;
}

// Idempotent — runs on every cold start. Owns demand_users and demand_details only.
// Reads activity_logs (created by the Acquired dashboard) but does not own its schema.
const LOAN_DDL = `
-- Openhouse Loans — referral tickets. The Transaction CRM (app/loans.py) is the
-- source of truth and serves the Partner App's loan APIs; this dashboard's public
-- loan form writes the same table with no broker (broker_id NULL, source 'other').
-- Exactly the columns of the loans spec's panel table — keep both copies identical
-- (CRM: backend/app/loans.py DDL).
CREATE TABLE IF NOT EXISTS loan_applications (
  id                    BIGSERIAL PRIMARY KEY,
  broker_id             INTEGER,
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  client_mobile         TEXT NOT NULL,
  client_pan            TEXT,
  employment_type       TEXT,
  loan_amount_requested BIGINT,
  property_kind         TEXT NOT NULL,
  home_id               INTEGER,
  property_address      TEXT,
  city_id               INTEGER,
  city_name             TEXT,
  note                  TEXT,
  consent               BOOLEAN NOT NULL,
  consent_text_version  TEXT,
  source                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'with_loan_desk',
  closed_reason         TEXT,
  remarks               TEXT,
  status_set_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  commission_pct        NUMERIC(5,2),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loan_applications_broker  ON loan_applications (broker_id);
CREATE INDEX IF NOT EXISTS idx_loan_applications_mobile  ON loan_applications (client_mobile);
CREATE INDEX IF NOT EXISTS idx_loan_applications_created ON loan_applications (created_at DESC);

-- Per-IP rate limiting for the public route. Kept in Postgres, not memory:
-- serverless instances do not share memory, so an in-process counter resets
-- on every cold start and limits nothing in practice.
CREATE TABLE IF NOT EXISTS loan_form_rate_limit (
  ip              TEXT PRIMARY KEY,
  window_started  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hits            INTEGER     NOT NULL DEFAULT 0,
  last_hit        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_loan_rl_window ON loan_form_rate_limit(window_started);
`;

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
  -- project_status: written by Projects-Epicenter (services/project_status.py), never
  -- here — Phase 1 pending / Phase 1 / Phase 2 / Photoshoot, NULL with no work plan.
  -- Declared so the list query never fails on a database Epicenter has not touched.
  ALTER TABLE demand_details ADD COLUMN IF NOT EXISTS project_status TEXT;

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

  -- Source + brokerage. "source" is the deal channel: 'CP' (channel partner /
  -- broker involved) or 'Direct' (no CP). Drives a second, broker-only email:
  --   • CP     → brokerage_amount is the amount to be PAID to the CP, payable
  --              either 'Registry Only' or 'ATS & Registry'. For the latter the
  --              amount is split into brokerage_ats_amount + brokerage_registry_amount.
  --   • Direct → brokerage_amount is the amount to be COLLECTED; no timing/split,
  --              and no broker email is sent.
  -- cp_mail_sent_at is the send timestamp for the broker email (parallel to
  -- mail_sent_at for the buyer email); NULL until the CP mail is sent.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS source                    TEXT DEFAULT 'CP';
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS brokerage_amount          REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS brokerage_timing          TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS brokerage_ats_amount      REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS brokerage_registry_amount REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS cp_mail_sent_at           TIMESTAMPTZ;

  -- work_committed: free text shown in both mails immediately above
  -- other_conditions, as "Work Committed: <text>".
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS work_committed TEXT;

  -- Payment structure for the buyer's schedule: 'Flexible' means the payable
  -- share is a negotiated band rather than a fixed figure, so a min/max pair
  -- accompanies it. The pair stays NULL for 'Non-Flexible'.
  --
  -- The band is entered as an AMOUNT in lakhs (*_lakhs); the percentages are
  -- derived from it against consideration_amount and kept in step on every write
  -- so anything still reading the older columns keeps working. Rows predating the
  -- amount columns carry only the percentages, and the UI converts back from them
  -- using the booking's own consideration.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS payment_structure       TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS payment_range_min_pct   REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS payment_range_max_pct   REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS payment_range_min_lakhs REAL;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS payment_range_max_lakhs REAL;

  -- Gift promised to the buyer alongside the booking (a white good, furnishing,
  -- waived charge...). gift_details carries the description and gift_timing when
  -- it is handed over — 'ATS' or 'Registry'. Both NULL when no gift applies;
  -- there is no separate boolean, the description IS the flag, matching how
  -- work_committed already works.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS gift_details TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS gift_timing  TEXT;
  -- The window the gift offer stands for. A date pair rather than free text so
  -- the offer can be compared against a booking date later. gift_offer_period
  -- (TEXT) was an earlier shape of this field and is no longer written; it, and
  -- gift_offer_creative_url, can be dropped once no row relies on them.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS gift_offer_from DATE;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS gift_offer_to   DATE;

  -- Whether the buyer intends to fund the purchase with a home loan. NULL until
  -- answered, so "not asked" stays distinguishable from an explicit No.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS buyer_avails_loan BOOLEAN;

  -- listing_price_is_auto: TRUE when the listing price was derived from the
  -- acquisition price rather than typed by a person. Drives the small "A" marker
  -- in the UI, and — more importantly — is what lets the auto-pricer tell its own
  -- earlier output apart from a real human figure. Any manual edit clears it, and
  -- the pricer only ever fills a NULL price, so a typed value is never overwritten.
  ALTER TABLE demand_details ADD COLUMN IF NOT EXISTS listing_price_is_auto BOOLEAN DEFAULT FALSE;

  -- Selling channel partner, resolved from the CP inventory database by cp_code
  -- or registered phone at booking time. That database is a SEPARATE Postgres
  -- instance, so no foreign key is possible and no join can be done at query
  -- time — the CP's details are snapshotted here instead, which also preserves
  -- them as they were on the date of sale.
  --
  -- This is what makes "which CP sold this property" answerable:
  --   SELECT uid, selling_cp_code, selling_cp_name FROM booking_details
  --    WHERE mail_sent_at IS NOT NULL;
  --
  -- selling_cp_email is operator-entered: channel_partners.email is empty for
  -- every row upstream, so we capture it here AND write it back to the CP
  -- record so later lookups can prefill it.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS selling_cp_id      INTEGER;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS selling_cp_code    TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS selling_cp_phone   TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS selling_cp_name    TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS selling_cp_company TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS selling_cp_email   TEXT;

  -- token_type: 'normal' (the existing flow) or 'conditional'. A conditional
  -- token is money taken before terms are settled, so NO buyer/CP mail goes out
  -- for it — that is the only behavioural difference. Defaulted to 'normal' so
  -- every pre-existing booking keeps its current meaning.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS token_type TEXT DEFAULT 'normal';

  -- booking_date: the day the buyer booked (ISO YYYY-MM-DD, TEXT like ats_timeline).
  -- payment_screenshot_url: Cloudinary URL of the token-payment proof. Both are
  -- mandatory before a booking is mailed (or, for a conditional token, saved from
  -- page 2); NULL on rows captured before they existed.
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS booking_date           TEXT;
  ALTER TABLE booking_details ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT;
  -- The CRM's cancel archives bookings by copying only the columns the archive
  -- already has, so a column missing there is silently dropped on cancel.
  ALTER TABLE IF EXISTS booking_details_archive ADD COLUMN IF NOT EXISTS booking_date           TEXT;
  ALTER TABLE IF EXISTS booking_details_archive ADD COLUMN IF NOT EXISTS payment_screenshot_url TEXT;
  CREATE INDEX IF NOT EXISTS idx_booking_selling_cp_code  ON booking_details(selling_cp_code);
  CREATE INDEX IF NOT EXISTS idx_booking_selling_cp_phone ON booking_details(selling_cp_phone);

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
  -- The unit's home on core (Django get-home-details ?id=), the legacy twin of
  -- properties.core_home_id. Legacy units carry no OHID on core, so the CRM's
  -- listing-status push can only reach their website listing through this.
  ALTER TABLE legacy_properties ADD COLUMN IF NOT EXISTS core_home_id INTEGER;

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

  ${LOAN_DDL}
`;

async function ensureTable() {
  try {
    await pool.query(INIT_SQL);
  } catch (err) {
    console.error('[ensureTable] INIT_SQL error:', err.message);
  }
}

// The loan form is a public route, so it never passes through requireAuth() and
// therefore never triggers ensureTable(). It calls this instead: the same two
// CREATE statements, isolated so a public request cannot run the whole INIT_SQL
// (which touches every table in the app). Cached after the first success so it
// costs one round trip per warm instance, not one per submission.
let _loanTablesReady = false;

async function ensureLoanTables() {
  if (_loanTablesReady) return true;
  try {
    await pool.query(LOAN_DDL);
    _loanTablesReady = true;
    return true;
  } catch (err) {
    console.error('[ensureLoanTables]', err.message);
    return false;
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
// absent on some deployments. Cache its column list once per cold start so the
// LEFT JOIN in /api/list can fold in per-society attributes (affordable flag,
// micro-market) without risking a crash where the table or a column is missing.
// Empty array = table absent or unreadable, which disables every dependent feature.
let _masterSocietiesCols = null;

async function masterSocietiesColumns() {
  if (_masterSocietiesCols !== null) return _masterSocietiesCols;
  try {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'master_societies'
    `);
    _masterSocietiesCols = rows.map(r => r.column_name);
  } catch (err) {
    console.warn('[masterSocietiesColumns]', err.message);
    _masterSocietiesCols = [];
  }
  return _masterSocietiesCols;
}

// society_name is the join key, so every lookup needs it present alongside the
// column actually being read.
async function masterSocietiesHasAffordable() {
  const cols = await masterSocietiesColumns();
  return cols.includes('society_name') && cols.includes('affordable');
}

// micro_market: the sub-city area a society sits in (e.g. "Sector 150", "Dwarka
// Expressway"). Same column the Direct Inventory app reads for its micro-market
// geometry, so the naming stays consistent across dashboards.
async function masterSocietiesHasMicroMarket() {
  const cols = await masterSocietiesColumns();
  return cols.includes('society_name') && cols.includes('micro_market');
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
  ensureLoanTables,
  logActivity,
  getPropertiesColumns,
  hasCol,
  masterSocietiesHasAffordable,
  masterSocietiesHasMicroMarket,
  projectIfExists,
  DEMAND_STATUSES,
  SUPPLY_READY_STATUSES,
  TEST_SOCIETIES,
  canSeeTestUnits,
  notTestUnitSql,
  isHiddenTestUnit,
  KEY_HANDOVER_DONE_STATUS,
  ADMIN_ONLY_COLUMNS,
  stripAdminOnlyColumns,
};
