# Demand Dashboard

Sells properties that the Supply team has acquired. Reads from the same Neon PostgreSQL database as the Supply Closure Tracker and Acquired Property Dashboard.

## What it shows

Only properties where `ap_details.status` ∈ {`AMA Signed`, `Key Handover Done`} — i.e., truly ready to be listed and sold.

## Pipeline (demand-side status)

`Buyer Visit` → `Buyer Interested` → `Buyer Revisit` → `Negotiation Meeting` → `Booking Done` → `ATS Signed` → `Registry Done` → `Sold`

## Roles

| role   | abilities                                                                  |
| ------ | -------------------------------------------------------------------------- |
| admin  | edit Listing Price, edit demand status / dates / remarks, manage users     |
| editor | edit demand status / dates / remarks (NOT listing price)                   |
| viewer | read-only                                                                  |

The first user to sign in becomes admin automatically. After that, admins must pre-add new users by email.

## Stack

- Vercel serverless (Node 20.x), no build step
- Neon PostgreSQL via `pg`
- Google Sign-In + JWT in HttpOnly cookie (`oh_session_demand`)
- Vanilla HTML/CSS/JS frontend

## Tables this app owns

- `demand_users` — independent of `ap_users`. Demand team has its own login pool.
- `demand_details` — one row per property `uid` with listing price, demand status, pipeline timestamps, internal remarks.
- Writes audit rows to the shared `activity_logs` table with `dashboard = 'Demand Dashboard'`.

Tables it reads from (owned by other apps): `properties`, `ap_details`.

## Env vars

| name                 | required | description                                             |
| -------------------- | -------- | ------------------------------------------------------- |
| `DATABASE_URL`       | yes      | Neon Postgres connection string                         |
| `GOOGLE_CLIENT_ID`   | yes      | Google OAuth client ID                                  |
| `JWT_SECRET`         | yes      | secret used to sign session JWTs                        |
| `ALLOWED_ORIGIN`     | no       | CORS origin (only needed if frontend is on a 2nd host)  |
| `SMTP_HOST`          | yes\*    | SMTP server hostname (\*required only if Send Mail used) |
| `SMTP_PORT`          | no       | SMTP port — defaults to 587 (STARTTLS)                  |
| `SMTP_SECURE`        | no       | `true` for implicit TLS port 465; defaults to `false`   |
| `SMTP_USER`          | yes\*    | SMTP auth username                                      |
| `SMTP_PASS`          | yes\*    | SMTP auth password / app password                       |
| `SMTP_FROM`          | no       | From address (defaults to SMTP_USER)                    |

## Run locally

```bash
npm install
vercel dev
```

## Deploy

```bash
vercel --prod
```
