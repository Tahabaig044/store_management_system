# AK VisionFlow — Production Deployment

## Architecture decision

**One VPS, Docker Compose, one persistent Node process** (`deploy/docker-compose.prod.yml`).

| Requirement found in the code | Why serverless (Vercel) does not fit |
|---|---|
| Realtime "something changed" stream (Server-Sent Events, `/api/sync/stream`) keeps connections open and holds subscriber state in process memory (`modules/sync/realtime.js`) | Functions are short-lived and instances do not share memory; the stream would drop or never notify |
| Time-based automations (`communication/scheduled.routes.js`) need a caller on a schedule | Vercel Cron was the assumed caller; on a VPS any cron/timer can call it |
| Prisma connection pool, in-process rate limiting (`express-rate-limit` memory store) | Per-instance state gives inconsistent limits and many DB connections |

`backend/api/index.js` and `backend/vercel.json` are left in place but are **not** the production path.
There is no file/object storage requirement (no uploads exist in the code).

```
Internet -> Caddy (HTTPS, auto certificates)
              |-- /api/*  -> backend (Express, :4000, SSE not buffered)
              `-- /*      -> frontend (nginx, built SPA + service worker)
backend -> postgres (private Docker network, no published port)
backup  -> daily pg_dump (custom format) into the `backups` volume, 14-day retention
```

The frontend is built with `VITE_API_URL=/api`, so the SPA and API share one origin (no CORS surprises).

## First deployment

Prerequisites: a Linux VPS with Docker + Compose, a domain whose DNS `A` record points at it, ports 80/443 open.

```bash
git clone <repo> && cd <repo>/deploy
cp .env.production.example .env          # fill APP_DOMAIN, POSTGRES_PASSWORD, JWT_SECRET (openssl rand -base64 48)
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
docker compose -f docker-compose.prod.yml logs backend | tail    # migrations + permission seed run automatically
curl https://$APP_DOMAIN/api/health                              # {"status":"ok",...}
```

The backend container runs `prisma migrate deploy` and the idempotent permission seed on every start, so a fresh
database is usable immediately. The app refuses to start in production with the placeholder `JWT_SECRET`.

Do **not** run `npm run seed` in production: it creates a demo tenant with a default password.
Create the first business through the registration page (`/register`).

## Backups and restore

* The `backup` service dumps the database every `BACKUP_INTERVAL_HOURS` (default 24) into the `backups` volume and
  deletes dumps older than `BACKUP_RETENTION_DAYS` (default 14). A failed backup posts to `ALERT_WEBHOOK_URL`.
* **Copy dumps off the server** (a backup on the same disk is not a disaster backup): e.g. a daily
  `docker cp`/`rclone` of the volume to another provider. Not automated here because it needs your storage account.
* Restore into a NEW database, verify, then switch over — never restore over the live database:

```bash
docker compose -f docker-compose.prod.yml exec backup sh /scripts/restore.sh /backups/<file>.dump akvisionflow_restored
docker compose -f docker-compose.prod.yml exec backup sh /scripts/verify-restore.sh   # restore-test: newest dump vs live counts
```

`verify-restore.sh` restores the newest dump into a scratch database, compares the row count of every table with the
live database, prints `RESTORE VERIFIED` (exit 0) or a diff (exit 2), and drops the scratch database.
Run it after setup and monthly. Rows written after the dump appear as differences — run it right after a fresh backup.

## Monitoring

* Set `ALERT_WEBHOOK_URL` (Slack / Discord / Mattermost incoming webhook). The backend posts unexpected 500s,
  uncaught exceptions, unhandled rejections and failed database health checks (message + request id + method/path
  only; identical alerts throttled to one per 5 minutes, at most 30 per hour). Failed backups post to the same URL.
* Point an external uptime monitor (e.g. UptimeRobot, free) at `https://<domain>/api/health`. It returns 503 when the
  database is unreachable. This also covers "deployment failed / container down", which cannot alert from inside itself.
* Sync failures are stored server-side (`SyncIssue`) and visible to managers in the app's Sync Monitor page.

## Updating

```bash
git pull && docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```
Take a backup first (`docker compose ... exec backup sh /scripts/backup.sh`). Rollback = check out the previous tag and
rebuild; migrations are forward-only, so restore a backup if a migration must be undone.

## Scheduled automations

`POST /api/automation/run-scheduled` (tenant-admin authenticated, per tenant) must be triggered by a scheduler. With messaging providers still mocked
(see Phase 3 decision) there is nothing customer-facing to send, so no cron is configured yet.

## Verification status (Phase 2)

| Item | Status |
|---|---|
| Backup script + retention + restore + restore verification | LOCAL VERIFIED (real `pg_dump`/`pg_restore` against a 92-table, 17,151-row test database; detects a missing row) |
| Error alert webhook, throttling, no sensitive data in payload | LOCAL VERIFIED (automated tests) |
| Compose file, Caddy config, HTTPS, SSE through the proxy | NOT VERIFIED — no Docker on the dev machine and no server/domain provided |
| Live deployment, live backups, uptime monitor | NOT DONE — requires your VPS, domain and webhook |
