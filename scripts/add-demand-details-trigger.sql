-- Wire demand_details into the schema so the table always mirrors the UI
-- without the app reconciling on every /api/list call.
--
--   Part 1  auto-create the demand_details row when a property becomes visible
--   Part 2  properties.demand_details column + foreign key back to it
--
-- Run once, by hand:
--   psql "$DATABASE_URL" -f scripts/add-demand-details-trigger.sql
--
-- Deliberately NOT in _db.js INIT_SQL: that runs on every request, and these
-- statements take ACCESS EXCLUSIVE locks on ap_details / properties — tables
-- the Supply and CP Inventory apps write to. Paying that per request would
-- stall them.
--
-- Rollback:
--   ALTER TABLE properties DROP CONSTRAINT IF EXISTS fk_properties_demand_details;
--   ALTER TABLE properties DROP COLUMN IF EXISTS demand_details;
--   DROP TRIGGER IF EXISTS trg_demand_details_autocreate     ON ap_details;
--   DROP TRIGGER IF EXISTS trg_demand_details_autocreate_leg ON legacy_properties;
--   DROP FUNCTION IF EXISTS demand_details_autocreate();


-- ── Part 2a: the column ────────────────────────────────────────────────────
-- Added before the trigger function so the function can reference it.
--
-- Holds the uid of this property's demand_details row, or NULL when it has
-- none. It can only ever equal properties.uid — the value is derivable via
-- EXISTS — so this is denormalization bought purely for the FK guarantee below.
--
-- Note the FK only works in this direction. demand_details.uid -> properties.uid
-- is impossible: 55 demand_details rows are legacy (LEG-*) or orphaned uids
-- that have no properties row at all.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS demand_details TEXT;


-- ── Part 1: auto-create the demand_details row ─────────────────────────────
CREATE OR REPLACE FUNCTION demand_details_autocreate() RETURNS TRIGGER AS $$
BEGIN
  -- Column defaults supply the values: 'Available' / 'Buyer Visit' / ''.
  -- updated_by stays NULL, which is what marks a row as never user-edited.
  INSERT INTO demand_details (uid) VALUES (NEW.uid) ON CONFLICT (uid) DO NOTHING;

  -- Point properties.demand_details at the row we just guaranteed. Matches 0
  -- rows for legacy uids, which don't live in properties.
  -- Safe for the CP Inventory app: trg_cp_inventory_status is declared
  -- UPDATE OF <specific columns> and demand_details isn't one of them, so
  -- this write does not fire it.
  UPDATE properties SET demand_details = NEW.uid
    WHERE uid = NEW.uid AND demand_details IS DISTINCT FROM NEW.uid;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- This fires inside the *Supply* app's transaction. A demand-side problem
  -- must never roll back their write, so swallow and log rather than raise.
  RAISE WARNING 'demand_details_autocreate failed for uid %: %', NEW.uid, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Real properties: fires when Supply moves a unit into a demand-ready status.
-- WHEN clause keeps it inert for every other status transition.
DROP TRIGGER IF EXISTS trg_demand_details_autocreate ON ap_details;
CREATE TRIGGER trg_demand_details_autocreate
  AFTER INSERT OR UPDATE OF status ON ap_details
  FOR EACH ROW
  WHEN (NEW.status IN ('AMA Signed', 'Key Handover Done'))
  EXECUTE FUNCTION demand_details_autocreate();

-- Legacy properties: no status gate — every row in this table is visible to
-- the dashboard on insert (see /api/list, legacy side of the UNION).
DROP TRIGGER IF EXISTS trg_demand_details_autocreate_leg ON legacy_properties;
CREATE TRIGGER trg_demand_details_autocreate_leg
  AFTER INSERT ON legacy_properties
  FOR EACH ROW
  EXECUTE FUNCTION demand_details_autocreate();


-- ── Part 2b: backfill + foreign key ────────────────────────────────────────
-- Backfill must run before the constraint is added, or validation fails.
-- Expect ~240 of 2952 properties rows to be set; the rest stay NULL.
UPDATE properties p SET demand_details = p.uid
 WHERE EXISTS (SELECT 1 FROM demand_details dd WHERE dd.uid = p.uid)
   AND p.demand_details IS DISTINCT FROM p.uid;

-- ON DELETE SET NULL is required, not cosmetic: scripts/rollback-legacy.js
-- deletes demand_details rows, and a plain RESTRICT would make that fail.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS fk_properties_demand_details;
ALTER TABLE properties ADD CONSTRAINT fk_properties_demand_details
  FOREIGN KEY (demand_details) REFERENCES demand_details(uid)
  ON UPDATE CASCADE ON DELETE SET NULL;

-- Postgres does not index the referencing side automatically, and ON DELETE
-- SET NULL has to scan it on every demand_details delete.
CREATE INDEX IF NOT EXISTS idx_properties_demand_details ON properties(demand_details);
