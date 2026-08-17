# Update Home API

Partial update for an existing home and publish it as **Coming Soon** (`listing_status = CS`).
Used internally after AMS is signed — caller clicks "Updated Home" to move a home from **Archive (`Arc`)** to **Coming Soon (`CS`)** and refresh listing fields.

> **Demand Dashboard note:** this dashboard stores the API key in the `X_DEMAND_DASHBOARD_KEY` env var and sends it as the `X-Demand-Dashboard-Key` header via server-side proxy routes under `/api/core-home/*`. The frontend never sees the key. The external property that a dashboard row maps to is `properties.core_home_id`.
>
> **Use `https://`.** The Cloud Run host 302-redirects `http`→`https`. Node's `fetch` follows the redirect but downgrades a redirected POST/PATCH to GET and drops the body, so an `http` base silently turns `update-home` into a no-op. `api/_core.js` defaults to the `https` base; override with `CORE_API_BASE_URL` if needed (keep it `https`).
>
> **`get-home-details` speaks labels, not codes.** It returns `listingStatus: "Ready"`, `facing: "North"`, `furnishingStatus: "Semi Furnished"`, `ageUnits: "Years"`, and `propertyType`/`overlooking`/`whyChooseThisHome`/`documentationAndLoan` as `{name}`/`{reason}` objects **without ids**. The Update Home modal maps these back to the codes/ids that `update-home` expects (name → masters id, label → code). `furnishings` come back as `[{name}]` with **no count**, so they are not prefilled (update requires a count per item).

## Production server

Base URL: `https://backend-prod-561394753846.asia-south2.run.app/api/v1/oh`

Examples:

- `PATCH https://backend-prod-561394753846.asia-south2.run.app/api/v1/oh/update-home/`
- `GET https://backend-prod-561394753846.asia-south2.run.app/api/v1/oh/home-form-masters/`

---

## Prerequisites

### 1. Server env

In `core/.env` (the Django server):

```bash
DEMAND_DASHBOARD_API_KEY=<strong-secret>
```

Restart the server after changing env.
If this key is missing → API returns **503**.
If header is missing/wrong → **401**.

### 2. Existing home

`home_id` must already exist in DB (typically in `Arc` status). This API only updates existing homes.

### 3. Auth header (every call)

```http
X-Demand-Dashboard-Key: <DEMAND_DASHBOARD_API_KEY>
```

Same key for both:

- `PATCH /api/v1/oh/update-home/`
- `GET /api/v1/oh/home-form-masters/`

---

## What you need before calling update

| Field in update body         | Where options come from                              | Notes                                                         |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `home_id`                    | Existing home                                        | **Required**                                                  |
| `listing_status`             | Must be `CS`                                         | **Required**. Any other value → `400`, no update              |
| `commission`                 | Free text                                            | Optional, e.g. `"1.5"`                                        |
| `society_id`                 | `GET /get-public-masters/?city=...`                  | Optional, existing society ID                                 |
| `property_type_id`           | `GET /home-form-masters/` → `property_types`         | Optional, existing ID, no create                              |
| `layout_id`                  | Existing layouts (admin / home details)              | Optional, existing layout ID                                  |
| `facing`                     | Fixed choices (below)                                | Optional, dropdown codes only                                 |
| `furnishing_status`          | Fixed choices (below)                                | Optional                                                      |
| `age_units`                  | Fixed choices (below)                                | Optional                                                      |
| `natural_light_score`        | Number 0–10                                          | Optional, decimal OK                                          |
| `property_age`               | Integer 0–40                                         | Optional                                                      |
| `overlooking_ids`            | `GET /home-form-masters/` → `overlooking`            | Optional, multiselect IDs, no create                          |
| `why_choose_this_home_ids`   | `GET /home-form-masters/` → `why_choose_this_home`   | Optional, multiselect IDs                                     |
| `documentation_and_loan_ids` | `GET /home-form-masters/` → `documentation_and_loan` | Optional, multiselect IDs                                     |
| `price_data`                 | Manual                                               | Optional, `{ "total", "per_sq_ft?" }` — no `includes`         |
| `parking_data`               | Manual                                               | Optional, `{ "covered", "open" }` (0–9)                       |
| `furnishing_data`            | Name + count                                         | Optional, `[{ "name", "count" }]` — `count` required per item |

Photos are **not** sent in the request. On every successful update the backend auto-ensures one Coming Soon photo (see Behaviour notes).

Masters for overlooking / why-choose / docs / property type must already exist in Django admin. This API does **not** create those master rows.

---

## Fixed dropdown codes (send these exact values)

### `listing_status` (required)

| Code | Label       |
| ---- | ----------- |
| `CS` | Coming soon |

Any other code (`Rdy`, `Arc`, etc.) → **400** `{ "error": "Invalid listing status" }`. No fields are updated.

### `facing`

| Code | Label     |
| ---- | --------- |
| `N`  | North     |
| `E`  | East      |
| `W`  | West      |
| `S`  | South     |
| `NE` | Northeast |
| `NW` | Northwest |
| `SE` | Southeast |
| `SW` | Southwest |

Invalid code (e.g. `"NEr"`) → **400** `{ "error": "\"NEr\" is not a valid choice." }`

### `furnishing_status`

| Code | Label           |
| ---- | --------------- |
| `UF` | Unfurnished     |
| `SF` | Semi furnished  |
| `FF` | Fully furnished |

### `age_units`

| Code | Label  |
| ---- | ------ |
| `y`  | Years  |
| `m`  | Months |

Do **not** send labels like `"Ready"` or `"North"` — only codes.

---

## Endpoints

Base (production): `https://backend-prod-561394753846.asia-south2.run.app/api/v1/oh`
Base (local docker): `http://localhost:8080/api/v1/oh`

### A) Load form masters

```http
GET /home-form-masters/
X-Demand-Dashboard-Key: <DEMAND_DASHBOARD_API_KEY>
```

Example response:

```json
{
  "propertyTypes": [{ "id": 1, "name": "Apartment" }],
  "overlooking": [{ "id": 2, "name": "Park" }],
  "whyChooseThisHome": [{ "id": 1, "reason": "Sunrise view balconies" }],
  "documentationAndLoan": [{ "id": 3, "reason": "Allotment Letter" }]
}
```

Use these `id` values in the update body.

### B) Load societies (for `society_id`)

```http
GET /get-public-masters/?city=Gurgaon
```

Response includes:

```json
{
  "societies": [
    { "id": 45, "name": "Some Society", "localityId": 2, "cityId": 1 }
  ]
}
```

### C) Update home (partial)

```http
PATCH /update-home/
Content-Type: application/json
X-Demand-Dashboard-Key: <DEMAND_DASHBOARD_API_KEY>
```

Send `home_id` + `listing_status: "CS"` on every call. Other fields are optional — only provided keys change.

---

## Example request body

```json
{
  "homeId": 123,
  "listingStatus": "CS",
  "commission": "1.5",
  "societyId": 45,
  "propertyTypeId": 1,
  "layoutId": 88,
  "facing": "NE",
  "naturalLightScore": 8.5,
  "furnishingStatus": "SF",
  "propertyAge": 5,
  "ageUnits": "y",
  "overlookingIds": [2, 5, 8],
  "whyChooseThisHomeIds": [1, 4],
  "documentationAndLoanIds": [3, 6],
  "priceData": {
    "total": 12500000,
    "perSqFt": 12000
  },
  "parkingData": {
    "covered": 1,
    "open": 0
  },
  "furnishingData": [
    { "name": "ACs", "count": 3 },
    { "name": "Fans", "count": 4 }
  ]
}
```

### Success response (`200`)

```json
{
  "message": "Home updated successfully",
  "homeId": 123,
  "home": { }
}
```

`home` is the full `HomeSerializer` payload after update.

---

## Behaviour notes

| Topic               | Behaviour                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Typical flow        | Home is `Arc` → this API sets `CS` + updates fields + adds Coming Soon photo                                                                   |
| `listing_status`    | Required. Only `CS` accepted; any other value → `400`, no update                                                                               |
| Partial update      | Only provided keys change (after validation passes)                                                                                            |
| Multiselect masters | `.set(ids)` — replaces selection; does not create master rows                                                                                  |
| `furnishing_data`   | Upserts by name; `count` is required per item (no default)                                                                                     |
| Coming Soon photo   | Auto-added if no photo tagged `coming_soon`. Existing photos are never deleted or replaced                                                     |
| `price_data`        | Updates existing `Price`, or creates one if home has none. No `includes`. If creating and `per_sq_ft` omitted, model default `10000` may apply |
| Typesense           | If enabled, home is reindexed after update. Reindex failure does not fail the API — update still returns `200`                                 |

### Coming Soon photo (automatic)

Do **not** send `home_photos`. Floor-plan / client photo upload is not supported on this API.

After a successful update, the backend:

1. Checks if the home already has a `HomePhoto` with tag `coming_soon`.
2. If **missing** → creates one photo:
   - Fixed Cloudinary URL (hardcoded in `HomeUpdateSerializer.COMING_SOON_IMAGE_URL`)
   - `alt_text`: `"Coming Soon"`
   - `tags`: `["coming_soon"]`
   - `is_thumbnail`: `true`
   - `is_detail_image`: `true`
3. If **already present** → skips (no duplicate).

Example: home already has 10 other photos → after first update it may have 11 (old 10 + Coming Soon). Later updates keep the same set.

---

## Error responses

All errors return a single string in `error` (no `details`, no field keys):

```json
{ "error": "<message>" }
```

Validation returns only the **first** error message when multiple fields fail.

| Status | When                                      | Example                                                            |
| ------ | ----------------------------------------- | ----------------------------------------------------------------- |
| `401`  | Missing/wrong `X-Demand-Dashboard-Key`    | `{ "error": "Unauthorized" }`                                     |
| `503`  | `DEMAND_DASHBOARD_API_KEY` not configured | `{ "error": "Server misconfiguration: DEMAND_DASHBOARD_API_KEY" }` |
| `400`  | Invalid payload                           | `{ "error": "Invalid listing status" }`                           |
| `400`  | Bad choice code                           | `{ "error": "\"NEr\" is not a valid choice." }`                   |
| `400`  | Missing required field                    | `{ "error": "This field is required." }`                          |
| `404`  | `home_id` not found                       | `{ "error": "Home not found" }`                                   |
| `500`  | Server error during apply                 | `{ "error": "Failed to update home." }`                           |
| `429`  | Rate limit exceeded                       | DRF default throttle response                                     |

---

## Suggested caller flow (AMS)

1. Set `DEMAND_DASHBOARD_API_KEY` and restart server.
2. AMS signed → show "Updated Home" button.
3. `GET /home-form-masters/` → property type + multiselect dropdowns.
4. `GET /get-public-masters/?city=...` → society dropdown.
5. Static dropdowns for facing, furnishing status, age units (codes above).
6. `PATCH /update-home/` with `homeId`, `listingStatus: "CS"`, and fields to update.
7. Optionally confirm with `GET /get-home-details/?id=<home_id>` — expect `listingStatus: "CS"` and a `coming_soon` photo.
