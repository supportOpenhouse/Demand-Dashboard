-- Fixes a gap in scripts/add-demand-details-trigger.sql.
--
-- THE BUG
-- properties.demand_details was only ever written by demand_details_autocreate(),
-- which fires on ap_details INSERT OR UPDATE OF status. But a demand_details row
-- has four other ways to be born, none of which touch ap_details:
--
--   api/list.js:281            reconcile INSERT on every dashboard load
--   api/demand-details/[uid]   inline edit UPSERT
--   api/booking-details/[uid]  booking submit / mail sent
--   scripts/import-legacy.js   CSV import
--
-- So any property whose ap_details status transition happened BEFORE the
-- migration ran (no future trigger event) but whose demand_details row was
-- created AFTER the backfill ends up permanently unlinked. 20 rows are in
-- that state today, e.g. OHGHC1421.
--
-- THE FIX
-- Hang the link off demand_details itself, which is the thing being mirrored.
-- Every creation path goes through an INSERT on that table, so one trigger
-- there covers all five. Deletes are already handled by the FK's
-- ON DELETE SET NULL.
--
-- Run once, by hand:
--   psql "$DATABASE_URL" -f scripts/fix-demand-details-link.sql
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_properties_link_demand_details ON demand_details;
--   DROP FUNCTION IF EXISTS properties_link_demand_details();

-- ── The link trigger, on the right table this time ─────────────────────────
CREATE OR REPLACE FUNCTION properties_link_demand_details() RETURNS TRIGGER AS $$
BEGIN
  -- Matches 0 rows for legacy uids, which don't live in properties.
  -- Safe for the CP Inventory app: trg_cp_inventory_status is declared
  -- UPDATE OF <specific columns> and demand_details isn't one of them.
  UPDATE properties SET demand_details = NEW.uid
    WHERE uid = NEW.uid AND demand_details IS DISTINCT FROM NEW.uid;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never roll back the caller's write over a bookkeeping column.
  RAISE WARNING 'properties_link_demand_details failed for uid %: %', NEW.uid, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_link_demand_details ON demand_details;
CREATE TRIGGER trg_properties_link_demand_details
  AFTER INSERT ON demand_details
  FOR EACH ROW
  EXECUTE FUNCTION properties_link_demand_details();

-- ── Drop the now-redundant UPDATE from the ap_details trigger ──────────────
-- Inserting into demand_details fires the trigger above, so doing the same
-- UPDATE here would just be a second write of the same value.
CREATE OR REPLACE FUNCTION demand_details_autocreate() RETURNS TRIGGER AS $$
BEGIN
  -- Column defaults supply the values: 'Available' / 'Buyer Visit' / ''.
  -- updated_by stays NULL, which is what marks a row as never user-edited.
  INSERT INTO demand_details (uid) VALUES (NEW.uid) ON CONFLICT (uid) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- This fires inside the *Supply* app's transaction. A demand-side problem
  -- must never roll back their write, so swallow and log rather than raise.
  RAISE WARNING 'demand_details_autocreate failed for uid %: %', NEW.uid, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Repair the 20 rows the gap already stranded ────────────────────────────
UPDATE properties p SET demand_details = p.uid
 WHERE p.demand_details IS DISTINCT FROM p.uid
   AND EXISTS (SELECT 1 FROM demand_details dd WHERE dd.uid = p.uid);
