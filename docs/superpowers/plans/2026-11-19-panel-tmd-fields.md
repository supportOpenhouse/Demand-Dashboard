# Panel TMD Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show owner-will-vacate (+ Key Handover NA), real TMD documents, deposit split and deviation text in the Demand Dashboard property panel.

**Architecture:** Deposit + owner-vacate columns ride the existing `/api/list` projection. Documents + deviation come from a new lazy route `GET /api/tmd-docs/[uid]` that reads `properties.ama_prop_docs` (main DB) and TMD's own DB (`TMD_DATABASE_URL`), shaped by pure functions in `api/_tmd.js`.

**Tech Stack:** Vercel Node serverless, `pg`, vanilla JS frontend, `node:test` for unit tests (no new deps).

**Spec:** `docs/superpowers/specs/2026-11-19-panel-tmd-fields-design.md`

## Global Constraints

- Roles: `admin`, `manager`, `viewer`. "Staff" = admin + manager (`canEdit()` in app.js).
- Deposit columns (`total_deposit`, `performance_guarantee`, `refundable_deposit`, all REAL) are stripped from viewer payloads server-side in `/api/list` and `/api/detail`.
- Document URLs are removed server-side for viewers.
- `owner_will_vacate` values in data: `'Yes'`, `'No'`, NULL. NA rule: `trim(value).toLowerCase() === 'no'`.
- TMD DB unset or unreachable → route still answers 200 with ownership docs only and `tmd: false`; never 500 the panel.
- Labels: "Will Owner Vacate", "Perf. Guarantee", "Forfeitable", "Refundable", "Documents", "Deviation".

## Review Focus

- `owner_will_vacate = 'No'` with a key_handover_date present → status NA, no "Tentative" tag in the list.
- Same file in Seller App ledger and CRM documents (pushed from TMD) → listed once.
- Seller App doc replaced (two URLs, same name) → only the newest shown.
- Unit with only cancelled TMD deals → no TMD docs, no deviation (not an error).
- Ownership checklist entry with status `Yes` but empty url → listed by name without a link even for admins.

---

### Task 1: Pure shaping + role strip (`api/_tmd.js`, `api/_db.js`)

**Files:** Create `api/_tmd.js`, `tests/tmd.test.js`; Modify `api/_db.js` (add `STAFF_ONLY_COLUMNS`, `stripStaffOnlyColumns`).

**Interfaces — Produces:**
- `buildDocuments({ propDocs, sellerApp, crm }) -> [{ name, url, source }]` — `propDocs` = raw `ama_prop_docs` (object|string|null); `sellerApp` = rows `{document_name,url,first_seen_at}`; `crm` = rows `{filename,url,created_at}`. Order: checklist (fixed TMD order), Seller App named, Seller App additional, CRM. Checklist entry included when status is `yes` (case-insens.) or url non-empty. Seller App: newest per name. Dedupe by url across all.
- `forRole(docs, role) -> docs` — viewer: drop `url`.
- `shapeDeviation(row) -> {text, resolved_at} | null` — null unless `has_deviation` and trimmed text.
- `stripStaffOnlyColumns(row, user)` — deletes the 3 deposit columns when role is viewer.

- [ ] Tests (`node --test tests/`): checklist yes-without-url kept with `url: null`; status `na`/`no` without url dropped; seller-app duplicate name keeps newest; url shared by seller-app + crm appears once; `forRole(...,'viewer')` has no `url` keys, `'manager'` keeps them; `shapeDeviation({has_deviation:false,text:'x'})===null`; strip removes deposits for viewer only.
- [ ] Implement; run `node --test tests/` → all pass.

### Task 2: Route `GET /api/tmd-docs/[uid]`

**Files:** Create `api/tmd-docs/[uid].js`; Modify `api/_db.js` (lazy `tmdPool()` from `TMD_DATABASE_URL`, `max: 2`).

- Auth via `requireAuth`; `isHiddenTestUnit` → 404.
- Main DB: `SELECT ama_prop_docs FROM properties WHERE uid=$1`. Legacy/absent → `{ documents: [], deviation: null, tmd: false, legacy: true }` when the uid is only in `legacy_properties`.
- TMD DB: latest non-cancelled deal for `units.property_uid = uid` (`ORDER BY d.created_at DESC LIMIT 1`), then `seller_app_docs_seen`, `documents WHERE doc_type='additional_doc'`, `deal_deviations`.
- Response `{ success, documents: forRole(...), deviation, tmd: bool }`.
- [ ] Verify locally with a script calling the handler against real DBs for one known uid (read-only).

### Task 3: List projection + strips

**Files:** Modify `api/list.js` (`UNIFIED_COLS`: `owner_will_vacate` TEXT, three deposits REAL, legacy NULL; call `stripStaffOnlyColumns`), `api/detail/[uid].js` (call `stripStaffOnlyColumns`).
- [ ] `node -e "require('./api/list.js'); require('./api/detail/[uid].js')"` loads.

### Task 4: Frontend panel

**Files:** Modify `public/app.js`.
- `keyHandoverNA(r)`; Key Handover Status → `NA` (muted) when true; list Tentative tag suppressed; CSV status column too.
- "Will Owner Vacate" field after Current Occupancy when occupancy is `Owner Staying`.
- Deposits under Acquisition Price when `canEdit()`, formatted `₹` en-IN.
- Owner & Loan: real units render `<div data-tmd-docs-for=uid>` placeholder, filled after expand via `loadTmdDocs(uid)` (cached in `state.tmdDocs`); links for staff, names for viewers; Deviation block below. Legacy keeps `formatList(documents_available)`.
- [ ] `node --check public/app.js`; manual check in `vercel dev` if available.
