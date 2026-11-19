# Demand Dashboard panel: owner-vacate, real documents, deposits, deviation

Date: 2026-11-19 · Size: small change · Repo touched: Demand-Dashboard only (TMD code unchanged)

## Why

The demand team sells units Supply has acquired. The property panel still shows the
old self-declared "Documents Available" list and nothing about deposits, whether an
owner who is staying will ever leave, or what the seller still owes after the AMA.
All of that is already recorded in TMD and the supply forms; the panel should show it.

## What changes (in the expanded property panel)

1. **Will Owner Vacate** — shown when Current Occupancy is `Owner Staying`, value from
   `properties.owner_will_vacate` (asked in token Form 3). When it is `No`,
   **Key Handover Status reads `NA`** (grey) instead of Done/Pending, and the list's
   "Tentative" tag is not shown for that unit.
2. **Documents** — replaces "Documents Available" for supply-pipeline units with the
   real documents from TMD's *Docs Verified & AMA Draft* stage:
   - Ownership checklist — `properties.ama_prop_docs` (Allotment Letter, Possession
     Letter, BBA, Conveyance/Sub Lease/Sale Deed, Car Parking Letter, NOC, GPA,
     Mutation); entries marked yes or carrying a file.
   - Seller App property documents — TMD `seller_app_docs_seen` (latest file per name).
   - Additional Documents — TMD `documents` where `doc_type = 'additional_doc'`.
   - Not included: co-owner Aadhaar/PAN/cheque, broker documents.
   Admin + manager see each as a link that opens the file; viewers see names only
   (links removed on the server, not just hidden).
3. **Perf. Guarantee / Forfeitable / Refundable** — under Acquisition Price, from
   `properties.total_deposit`, `performance_guarantee`, `refundable_deposit` (same
   mapping TMD's Deal Terms & Bank uses). Admin + manager only; stripped from the
   viewer payload in both `/api/list` and `/api/detail`.
4. **Deviation** — when TMD's deviation is Yes, its text is shown under Documents
   (with "resolved on <date>" if TMD marked it resolved). Hidden when No/unset.

## Approaches considered

- TMD endpoint behind a shared key — keeps TMD the single source; needs a key on both deploys.
- **Direct read access to TMD's database (chosen)** — no TMD code change;
  Seller App docs come from TMD's own `seller_app_docs_seen` ledger, so the Demand
  Dashboard needs no Seller App key.
- TMD copying data onto `properties` — writes into a supply-owned table; rejected.

## How

- New env var on Vercel: `TMD_DATABASE_URL` (ideally a read-only role on TMD's Neon DB).
  Unset → the panel shows ownership-checklist docs only and a quiet "TMD not connected" note.
- New route `GET /api/tmd-docs/[uid]`: finds the unit's live deal
  (`units.property_uid = uid`, latest non-cancelled deal), returns
  `{ documents: [{name, url?, source}], deviation: {text, resolved_at} | null }`.
  Loaded when a row is expanded and cached per uid for the session — the main list
  query is untouched for points 2 and 4.
- `owner_will_vacate` and the three deposit columns added to `UNIFIED_COLS`
  (legacy side NULL).

## Calls made (correct any)

- Legacy (CSV-imported) units have no TMD data, so they keep their old Documents list.
- Deviation text is visible to all roles (it names missing paperwork, not money or IDs).
- CSV export keeps its existing Documents column for now (per-row TMD reads at export
  time would be slow); can be changed later.
- Known limit: a Seller App upload only reaches TMD's ledger when TMD polls it (while the
  deal is in Docs Verified) or someone opens that stage in TMD.
