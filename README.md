# ETS. DIEU MERCI — API server (`jean-server`)

Express 5 + MongoDB (Mongoose 8) API behind the ETS. DIEU MERCI point of sale and back office:
sales and receipts, stock ledger, cash in / cash out, debts, exchange rate, reports and an audit trail.

Every request is checked **on the server**. Hiding a button in the interface is never the protection:
each route verifies the token, the role, the page permission and the data it receives.

---

## 1. Requirements

- Node.js 22 or newer
- MongoDB 6+ (replica set recommended: sales and stock use transactions)
- Optional: a USB ESC/POS receipt printer (`escpos`, `escpos-usb`)

## 2. Install and run

```bash
npm install
cp .env.example .env        # then fill in the values below
npm run dev                 # nodemon, restarts on change
npm start                   # production
```

The API listens on `PORT` (default `5000`) under `/api`.

## 3. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Token signing secret, **at least 32 characters** |
| `RECEIPT_TOKEN_ENCRYPTION_KEY` | yes | Base64 32-byte key that encrypts the receipt QR codes (`openssl rand -base64 32`) |
| `CLIENT_URL` | yes in production | Allowed browser origins (CORS), comma separated |
| `NODE_ENV` | no | `production` enables the strict checks |
| `PORT` | no | HTTP port |
| `SUPER_ADMIN_EMAIL` | no | Protected admin account: hidden from and not editable by other admins |
| `ADMIN_EMAILS` / `DEFAULT_ADMIN_EMAIL` | no | Who receives expense notifications |
| `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM` | no | SMTP for notifications |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | no | Gmail transport used by `utils/emailService.js` |
| `APP_URL`, `POS_URL` | no | Links written in notification e-mails |
| `AUDIT_RETENTION_DAYS` | no | Delete audit entries older than N days (TTL index). Empty = keep forever |
| `AUDIT_BUSINESS_HOURS` | no | Opening hours used to flag off-hours actions, `open-close` in Lubumbashi time (default `6-21`) |

The server refuses to start if a required secret is missing or too weak.

## 4. Project layout

```
index.js                 app, security headers, CORS, rate limits, route mounting
middleware/
  auth.js                JWT check, loads the user (inactive accounts are refused)
  isAdmin.js             admin-only guard
  security.js            NoSQL-injection filter, request hygiene
  auditTrail.js          records every action in the audit log (see §7)
models/                  Mongoose schemas (Product, Sale, StockMovement, Entry, Expense, AuditLog, …)
routes/                  one router per area (sales, products, entries, expenses, analytics, audit, …)
utils/
  accessPolicy.js        which role / permission can reach which page and API
  profitPipeline.js      aggregation stages for valid sale lines (revenue, units)
  stockLedger.js         stock movements, opening / closing stock per period
  auditActions.js        catalogue of actions and their category
  auditRules.js          rules that mark an action as suspicious
test/                    node:test suites (no database needed)
```

## 5. Access control

`utils/accessPolicy.js` is the single source of truth and mirrors the client navigation:

- Fixed-role pages: `/reports`, `/customers`, `/remboursements`, `/audit`, `/dashboard`, `/admin` are **admin only**;
  `/rate` (exchange rate) is admin **and manager**.
- Other pages follow the role defaults or the user's custom page permissions (set in Administration).
- `requirePageAccess(...)` protects each router; refusals are logged with the flag `ACCESS_DENIED`.
- Identity fields (`salesPerson`, `recordedBy`, `validatedBy`) always come from the authenticated user,
  never from the request body.
- `POST /api/auth/verify-password` re-checks the password before the reports open (wrong password → `422`).

## 6. Money and stock

- **Prices** — products carry **no purchase price and no selling price to manage**: every selling price is typed
  at the till when the sale is made (NewSale) and stored on the sale line (USD, with the FC snapshot).
- **Net cash** — `GET /api/analytics/summary` and `GET /api/analytics/timeseries` compute, with MongoDB aggregation
  pipelines, the sales revenue, the money in (entries), the validated expenses and the net cash:
  - net cash = (sales + money in) − validated expenses;
  - voided / corrected sales are never revenue;
  - `timeseries` returns zero-filled day / week / month buckets for the trend chart.
- **Stock** — every change is a `StockMovement`; the dashboard tells, per sold item, the opening stock of the
  period, what came in, what was sold and what remains.

## 7. Audit trail

`middleware/auditTrail.js` writes an `AuditLog` entry for every non-GET request, every refusal, sensitive reads
and injection attempts (passwords and tokens are removed from the stored details). `utils/auditRules.js` marks
an entry **suspicious** (shown in red in the interface) for, among others:

failed or brute-force logins · repeated access refusals · actions outside business hours · deletions and voids ·
privilege changes (especially on one's own account) · large stock
removals · bursts of activity · exchange-rate jumps ≥ 10 % · validating one's own expense · identity mismatch ·
injection attempts · server errors.

API (admin only): `GET /api/audit` (filters, pagination, summary) and `PATCH /api/audit/:id/review`.
Entries cannot be edited or deleted through the API (`PUT` / `DELETE` → `405`).

## 8. Main endpoints

| Area | Routes |
|---|---|
| Auth | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/verify-password` |
| Sales | `GET/POST /api/sales`, `PUT /api/sales/:id`, `PATCH /api/sales/:id/void`, receipt scan / verify, edit approvals |
| Products & stock | `/api/products`, `/api/categories`, `/api/dashboard/summary` |
| Cash | `/api/entries`, `/api/expenses`, `/api/creditors`, `/api/exchange-rates` |
| Reports | `/api/analytics/summary`, `/api/analytics/timeseries` |
| Admin | `/api/users`, `/api/settings/receipt`, `/api/audit` |

Server messages are sent in French; the client shows them in the user's language (FR / EN).

## 9. Tests

```bash
npm test                    # unit + architecture tests (in-memory, no MongoDB)
npm run test:integration    # needs a MongoDB replica set
```
