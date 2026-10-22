-- ─────────────────────────────────────────────────────────────────────────────
-- Openhouse Loans — run once against the properties (Demand Dashboard) database.
-- The same DDL lives in api/_db.js (LOAN_DDL) and in the Transaction CRM
-- (backend/app/loans.py), which also creates it on boot. Columns are exactly the
-- loans spec panel table. See docs/LOANS_API.md in the CRM repo.
-- ─────────────────────────────────────────────────────────────────────────────
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
