# AK VisionFlow 1.0 — Release, Rollback and Administration

Version: **1.0.0** (`backend/package.json`, `frontend/package.json`; the running version is shown by `GET /api/health`).
Architecture and first-time server setup: [DEPLOYMENT.md](DEPLOYMENT.md). Security posture: [V1-SECURITY-AUDIT.md](V1-SECURITY-AUDIT.md).

## 1. Production release build

```bash
git checkout <release tag>
cd deploy && cp .env.production.example .env      # first time only; fill every value (see below)
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```
This builds the frontend (`VITE_API_URL=/api`, same origin as the API) and the backend image, applies database migrations, seeds the permission catalog (idempotent) and starts everything behind HTTPS.

### Environment configuration (deploy/.env)

| Variable | Required | Meaning |
|---|---|---|
| `APP_DOMAIN` | yes | Public host name; DNS must point at the server. Caddy obtains the HTTPS certificate. |
| `POSTGRES_PASSWORD` | yes | Long random. |
| `JWT_SECRET` | yes | ≥ 32 random characters (`openssl rand -base64 48`). The app refuses to start with a weak or placeholder value. Also used to derive the key that encrypts AI provider credentials at rest (`backend/src/utils/credentialCrypto.js`) — rotating it makes previously-saved AI provider credentials undecryptable and they must be re-entered. |
| `SIGNUP_INVITE_CODE` **or** `SIGNUP_OPEN=true` | one of them | Who may create a business. With neither, registration is closed. |
| `ALERT_WEBHOOK_URL` | strongly advised | Slack/Discord/Mattermost webhook for error and backup-failure alerts. |
| `SMTP_*` | optional | Enables "Forgot password" emails. Without it administrators issue reset links. |
| `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION_DAYS` | optional | Defaults 24 h / 14 days. |

Never commit `deploy/.env` or `backend/.env`.

## 2. Deployment checklist

Before:
- [ ] Release tag chosen; CI green on that commit (backend, frontend, migrations, drift check).
- [ ] A fresh backup exists: `docker compose -f docker-compose.prod.yml exec backup sh /scripts/backup.sh`.
- [ ] Off-server copy of the newest dump made.

Deploy:
- [ ] `git pull` / checkout tag, then `docker compose -f docker-compose.prod.yml --env-file .env up -d --build`.
- [ ] `docker compose ... logs backend | tail` shows migrations applied and "API listening".

After (smoke):
- [ ] `curl https://<domain>/api/health` → `status: ok` and the expected `version`.
- [ ] `BASE_URL=https://<domain>/api node backend/scripts/validation/smoke.js` → `SMOKE PASSED` (creates one tenant named "SMOKE …"; deactivate it afterwards).
- [ ] Open the site in a browser, sign in, make a sale, check it appears in Sales History.
- [ ] Uptime monitor on `/api/health` is green; a test alert reaches the webhook.
- [ ] Confirm error reporting is live: backend errors and frontend crashes (React error boundary, uncaught exceptions/rejections — reported via `POST /api/client-errors`) both route through the same `ALERT_WEBHOOK_URL`. Without that variable set, errors still log to stdout/stderr but no alert is sent — this is expected, not a failure, when no webhook has been provisioned.

## 3. Database migration procedure

* Migrations are forward-only SQL files in `backend/prisma/migrations`, applied automatically on backend start by `prisma migrate deploy` (never `migrate dev` or `migrate reset` on real data).
* CI proves the whole chain applies to an empty database and that `schema.prisma` matches it (no drift).
* For a release that contains a new migration: take a backup first (checklist above); deploy; confirm `prisma migrate status` reports up to date:
  `docker compose ... exec backend npx prisma migrate status`.
* Migrations added for 1.0: `auth_password_reset` (password reset tokens, session revocation column) and `sequence_counters` (atomic document numbering). Both only add objects.

## 4. Rollback

| Situation | Action |
|---|---|
| New release misbehaves, **no new migration** | Check out the previous tag, rebuild: `git checkout <prev-tag> && docker compose ... up -d --build`. Data untouched. |
| New release contains migrations that only **add** tables/columns (as in 1.0) | Same as above — the previous code simply ignores the extra objects. |
| A migration damaged data or must be undone | Stop the stack, restore the pre-deploy dump into a **new** database (`restore.sh`, then `verify-restore.sh`), point `DATABASE_URL` at it, redeploy the previous tag. Work done after the backup is lost — say so to the customers affected. Terminals keep unsent offline work locally and will resubmit it. |
| Server lost | New server → `DEPLOYMENT.md` → restore the latest off-server dump. |

## 5. Administrator guide (business owner / tenant admin)

**First sign-in.** Register (needs your invitation code if the provider set one). You become Tenant Admin with a Main Branch, default company and chart of accounts.

**Set up.** Business Profile → business details and enabled industry packs. Branches / Warehouses → add locations. Users → add staff and give each a role and branch:

| Role | Can do (from the permission catalog) |
|---|---|
| Tenant Admin | Everything, including users, reset links and roles |
| Manager | All business operations, approvals, accounting and reports, across branches; owner mobile app. Cannot manage users |
| Accountant | Accounting (journal, chart of accounts, opening balances), payments, expenses, credit/debit notes, reports |
| Cashier | POS sales, sales returns, quotations/sales orders, customers, payments |
| Store Keeper | Products/inventory, purchases and purchase returns, warehouses, stock transfers, procurement |
| Receptionist | Patients, appointments, examinations, prescriptions, optical orders, payments, customer messages |
| Doctor | Patients, appointments, examinations, prescriptions |

A user can additionally be restricted to specific branches/warehouses (Users → Access); a restricted user only sees and posts to those.

**Passwords.** Password rules: 8–72 characters with a letter and a number. If someone forgets theirs: Users → **Reset link** → give them the one-time link (valid 24 h, works once). Changing a password signs that person out on every device. If SMTP is configured, users can use "Forgot password" themselves.

**Offline.** POS keeps working without internet; sales, payments and other entries queue on that computer and send automatically when the connection returns. **Sync Monitor** (managers) shows terminals with unsent work and any entries the server refused (for example an item sold out elsewhere) so they can be fixed. Do not clear the browser's site data while a terminal has unsent work.

**Daily/weekly.** Reports → sales, stock, expenses, receivables; Accounting → trial balance and reconciliation should always agree. Check the alert channel and that last night's backup exists.

**Not available in 1.0 (disabled, not broken).** WhatsApp messaging/automation, customer-portal sign-in by WhatsApp code, and phone push notifications are switched off because no delivery provider is connected; the screens say so. Subscription billing is not built.
