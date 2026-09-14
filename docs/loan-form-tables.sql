-- ─────────────────────────────────────────────────────────────────────────────
-- OH Loan Form — run once against the Demand Dashboard database.
--
-- Also present in api/_db.js INIT_SQL, but INIT_SQL only executes inside
-- requireAuth() on a cold start. The loan form is a PUBLIC route that never
-- calls requireAuth, so on a fresh deployment these tables might not exist by
-- the time the first application is submitted. Running this by hand removes
-- that dependency.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loan_applications (
  id                  SERIAL PRIMARY KEY,
  reference           TEXT UNIQUE NOT NULL,   -- human-quotable, e.g. OHL-7F3A2B

  -- Primary applicant, denormalised for listing/searching without opening JSONB.
  primary_name        TEXT,
  primary_email       TEXT,
  primary_mobile      TEXT,

  property_interest   TEXT,                   -- free text: society / unit, optional
  loan_amount         NUMERIC(14, 2),         -- rupees
  notes               TEXT,

  -- Every applicant, in order; applicants[0] is the primary. One JSONB column
  -- rather than fixed columns because the form is explicitly "all applicants"
  -- and the count is not known ahead of time.
  --   [{ name, relationship, mothers_name, mobile, email, dob,
  --      employment_type, qualification, career_start_year,
  --      current_org_since, current_address_same_as_aadhaar,
  --      additional_income_amount, ongoing_emi_amount, documents: {...} }]
  applicants          JSONB NOT NULL DEFAULT '[]',

  -- Cloudinary secure_urls, grouped by applicant index then document slug.
  --   { "0": { "photo": "https://…", "pan": "https://…" }, "1": { … } }
  documents           JSONB NOT NULL DEFAULT '{}',

  submitted_ip        TEXT,                   -- for rate limiting + abuse review
  user_agent          TEXT,
  mail_sent_at        TIMESTAMPTZ,            -- null if the notification failed
  mail_error          TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_apps_created ON loan_applications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_apps_email   ON loan_applications(LOWER(primary_email));
CREATE INDEX IF NOT EXISTS idx_loan_apps_mobile  ON loan_applications(primary_mobile);

-- Per-IP rate limiting. Kept in Postgres, not memory: serverless instances do
-- not share memory, so an in-process counter resets on every cold start and
-- limits nothing in practice.
CREATE TABLE IF NOT EXISTS loan_form_rate_limit (
  ip              TEXT PRIMARY KEY,
  window_started  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hits            INTEGER     NOT NULL DEFAULT 0,
  last_hit        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_rl_window ON loan_form_rate_limit(window_started);
