# Core API — 2 requirements for floor plan → layout

Context: the Demand Dashboard needs to attach a floor plan to a home and set its
`layout_id` via `update-home`. Two things are missing today.

Findings below are from production `get-home-details` (26 homes sampled, 20 with
populated layouts) plus `django schema.md`.

---

## 1. Floor plan image — GET + POST

**Today:** there is no floor plan anywhere in the API. `oh_layout` has no image
field, and the `HomePhoto.tags` actually in use are room names — `Kitchen`,
`Balcony`, `Living Room`, `Room 2`. Nothing marks an image as a floor plan.

**Ask:** add a floor plan image to **`oh_layout`**, not to the home.

A floor plan describes the *layout* — a society-level template shared by every
unit of that type — not one flat. Storing it per-home duplicates the same image
across every unit and gives no way to say "this image is the plan for layout 88".

| | |
|---|---|
| **Schema** | `oh_layout.floor_plan` — Cloudinary image (same as `Society.cover_image`) |
| **GET** | Return `floor_plan` (URL) in the layout serializer. It is used for both `home.layout` and `society.layouts[]`, so one change covers both. |
| **POST** | An endpoint to upload/replace the floor plan for a given `layout_id`. Multipart upload or a Cloudinary URL — either is fine on our side. |

If unit-specific plans are ever needed, keep those as a `HomePhoto` with a
reserved `floor_plan` tag. The layout-level one is what we read and write.

---

## 2. Layout id — fetch from master, create if missing, map to society

### 2a. Return `id` in the layout serializer

**Today:** the serializer returns `config, name, areaUnit, builtUp, carpet,
superBuiltUp, bath, numberOfBalconies, servantQtr, pujaRoom, studyRoom,
bedrooms[], bathrooms[], balconies[], kitchen, living, dining, livingDining` —
every field **except the primary key**.

`update-home` accepts `layout_id`, but nothing in the read API ever tells us what
that id is. This is a one-line serializer change and it unblocks everything else.

Same pass, if cheap: ids on `propertyType`, `society`, `overlooking[]`,
`whyChooseThisHome[]`, `documentationAndLoan[]` (we currently reverse-map those by
display name, which breaks on renames), and `furnishings` as `{name: count}` —
your own schema doc documents that shape, but the API returns `[{name}]` with no
counts, and `update-home` requires a count per item.

### 2b. Master list of layouts per society

Per schema, `Society ↔ Layout` is **many-to-many** and `Home → Layout` is an FK.
So a society's layout list is exactly the valid candidate set for its homes.

`society.layouts` **already ships** in `get-home-details` — but:

- it never returns more than one layout (26/26 societies sampled returned 0 or 1)
- in **15 of 26** homes, the home's own layout was **not** in its society's list
  (e.g. home 140 has `2 BHK`, its society lists only `3 BHK`)

**Question:** is the serializer slicing to one, or is the M2M genuinely
under-populated because layouts are created against `Home.layout` without ever
being added to `Society.layouts`? If the latter, we need a backfill — and 2c has
to write both sides going forward.

### 2c. Resolve endpoint — match, or create and map to society

One endpoint, not two: "reuse it if it exists, create it if it doesn't" is a
single decision that has to be made where the data lives. Split across a match
call and a create call, two operators uploading the same plan both miss and both
create.

```http
POST /api/v1/oh/layouts/resolve/
{
  "society_id": 45,
  "create_if_missing": true,
  "name": "3 BHK + Study — Tower C",
  "area_unit": "sqft",
  "super_built_up": 1790, "built_up": 1520, "carpet": 1180,
  "bath": 3, "number_of_balconies": 3,
  "servant_qtr": 0, "puja_room": 1, "study_room": 1,
  "bedrooms":  [{"type":"m","area":158.51,"length":13.1,"breadth":12.1,
                 "area_unit":"sqft","length_unit":"ft"}],
  "bathrooms": [{"type":"p","area":15.99,"length":4.1,"breadth":3.9, "...": ""}],
  "balconies": [{"area":77.33,"length":16.11,"breadth":4.8, "...": ""}],
  "kitchen": {}, "living": {}, "dining": {}, "living_dining": {},
  "floor_plan_url": "https://res.cloudinary.com/..."
}
```

```jsonc
// existing layout matched
200 { "layout_id": 88,  "created": false,
      "matched_on": ["bedrooms", "super_built_up", "carpet"] }

// nothing matched, new layout created AND added to Society.layouts
201 { "layout_id": 412, "created": true }
```

**Mapping to society (the important part).** `Layout` has no society FK — the
link is the `Society.layouts` M2M. So on create the endpoint must add the new
layout to `Society.layouts`, not just return it. A layout that is only pointed at
by `Home.layout` is invisible in the society's master list, which is very likely
what produced the data described in 2b.

**`create_if_missing: false`** should return candidates without writing — that's
the call we make while the operator is still choosing.

### 2d. What to match on

| Match on | Don't match on |
|---|---|
| bedroom count (`len(bedrooms)`) | **`config`** — it is *not* the BHK count. Layouts named `3 BHK` carry `config` of 1, 2 and 3; most rows are 1 regardless of size. |
| `super_built_up` and `carpet`, within ~2% | **`name`** — production has `3 BHK`, `3BHK`, `3 BHK + Puja Room`, `3 BHK + SQ` as separate spellings of overlapping things. |
| bathroom / balcony counts as tiebreakers | **`built_up`** — identical to `super_built_up` in 18 of 20 layouts sampled, so it adds no signal. |

**Question:** what does `config` actually mean? Schema types it `Integer 1–500`
with no description and the data doesn't behave like a BHK count. Our guess is a
variant index (Type 1 / Type 2 within a project) — we'd rather not guess at a
field we may need to write on create.

---

## Also worth fixing: `update-home` doesn't validate `layout_id`

`Home.layout` is a plain `SET_NULL` FK with no society constraint, so
`update-home` will currently accept a `layout_id` belonging to a different
project and silently attach it. Suggest rejecting with 400 unless
`layout_id ∈ home.society.layouts`.

---

## Priority

| | Ask | Why first |
|---|---|---|
| 1 | **2a** — `id` in layout serializer | One line. Turns our blind "Layout ID" number box into a real dropdown. Nothing else works without it. |
| 2 | **2b** — society layout list | Gives us the candidate set. No new endpoint needed if `society.layouts` is fixed. |
| 3 | **1** — floor plan GET + POST | Gives the plan somewhere to live and something to read. |
| 4 | **2c** — resolve endpoint | Enables create-if-missing. |
