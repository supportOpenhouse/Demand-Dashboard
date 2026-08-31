# Follow-up #2 — Update Home API

Both asks from the last note are live on staging and verified. Thanks — the
furnishing shape you picked (`[{ name, count }]`) is better than what we proposed:
it round-trips straight into `furnishingData` and the app/website keep reading
`item.name` unchanged.

Verified on staging:

- `home.society.id` — real ids coming through (`1436`, `1452`, `317`, …). No more
  name-matching to find a society.
- `furnishings` now carries `count`.
- `home.layout.id` and `society.layouts[].id` both populated.

One item from the last note is still outstanding, and we now have much better
numbers on what it costs.

---

## Still open: backfill `Society.layouts`

**What we measured.** Sampled 45 societies on staging via `get-home-details`:

- `society.layouts` returns **0 or 1 entries for every one of them** — no society
  returned more than one.
- But **12 of those 45 societies have multiple different layouts actually in use**
  by their homes:

| Society | `society.id` | Layout ids actually in use | `society.layouts` size |
| --- | --- | --- | --- |
| Panchsheel Greens 2 | 1436 | 45, 63, 73, 127 | 1 |
| SS The Coralwood | 1449 | 7, 38, 117, 128 | 1 |
| Bestech Park View Ananda | 1460 | 81, 82, 102 | 1 |
| Sare Crescent Parc, Sector 92 | 1438 | 89, 94, 123 | 1 |
| Eros Sampoornam | 1473 | 63, 110, 125 | 1 |
| Umang Winter Hills | 1459 | 63, 79 | 1 |
| Ajnara Le Garden | 1465 | 91, 97 | 1 |
| Supertech Livingston | 1475 | 112, 142 | 1 |

Those layouts exist and are linked to homes via `Home.layout`. They're just not on
`Society.layouts`.

**Why it matters.** Per the doc, resolve matches *"only against layouts already on
that society's M2M"*. So for a Coralwood home whose floor plan is layout 38 — a
layout that already exists and is already in use — resolve won't find it, and
`createIfMissing: true` will create a **duplicate of a layout that already exists**.
That's the outcome the endpoint was built to prevent, and each duplicate is
permanent and visible on the public listing.

**Cause and fix.** Layouts have been created against `Home.layout` without being
added to `Society.layouts`. New writes are already handled — `layouts/resolve/` and
`update-home` both add to the M2M now. It's the existing rows that need catching up:

```python
for home in Home.objects.exclude(layout=None).select_related("society", "layout"):
    if home.society_id:
        home.society.layouts.add(home.layout)
```

**Timing matters.** Please run this **before** we start calling resolve in volume.
Duplicates created in the meantime won't be cleaned up by the migration — the
backfill only adds missing links, it can't merge two layouts that already exist.

If instead the serializer is deliberately slicing `society.layouts` to one entry,
tell us — then it's a serializer change rather than a migration, and the numbers
above are measuring the wrong thing.

---

## Smaller

**`http://` in the doc.** The base URL is still documented as
`http://staging-561394753846.asia-south2.run.app/api/v1/oh`. That host 302s
`http` → `https`, and Node's `fetch` downgrades a redirected `PATCH` to `GET` and
drops the body — so an `http` base silently turns `update-home` into a no-op. We hit
this exact bug already. Worth making every URL in the doc `https://`.

**Production deploy.** All of the above is staging-only right now — on
`backend-prod-…`, `home.layout.id` is absent and `POST /layouts/resolve/` returns
404. Let us know when it ships to prod; the dashboard points at prod and we can't
wire any of this up until then.

**`config`** — still curious what it represents, since we may need to send it on
create. Not blocking: we're following your guidance and not matching on it.
