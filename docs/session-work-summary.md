# Session Work Summary

This document covers only the work done in this session - UI polish, missing
functionality, and getting the app ready to deploy. It does not repeat the
project's pre-existing feature set (see the root `README.md` for that).

## Local environment setup

- No Docker and no local PostgreSQL install were available on this machine.
  Installed a portable (no-installer) PostgreSQL build at `D:\pgsql-portable`
  and used it to run the app locally before switching to Neon (below).

## UI / UX redesign

- **Brand system**: introduced a consistent purple/blue color system (matching
  the app's favicon), the Inter font, card shadows/radius, and dark-mode
  tokens in `frontend/src/index.css`.
- **Sidebar & header** (`frontend/src/components/Layout.jsx`): added a logo
  mark, per-page nav icons, a status pill for online/offline, and a
  user-avatar chip instead of plain text.
- **Dashboard** (`frontend/src/pages/dashboard/Dashboard.jsx`): stat cards
  redesigned with icons and color-coded accents instead of plain
  Bootstrap-colored borders; low-stock/expiring lists got icons.
- **Point of Sale** (`frontend/src/pages/sales/Pos.jsx`): product grid
  redesigned as cards with stock-status badges; cart line items got labeled
  Qty/Price/Discount fields (previously three unlabeled number boxes).

## Missing functionality added

- **Deactivate / Reactivate** for Products, Customers, and Suppliers
  (`frontend/src/pages/products/Products.jsx`,
  `.../customers/Customers.jsx`, `.../suppliers/Suppliers.jsx`) - the backend
  already supported soft-delete/archive, but no page exposed it. Added a
  "Show deactivated" filter and a per-row Deactivate/Activate button,
  matching the existing pattern on the Users page. Deliberately not a hard
  delete, to keep historical sales/purchases referencing these records valid
  (the app's existing soft-delete convention).
- **Report export** (`frontend/src/pages/reports/Reports.jsx`): added
  "Export CSV" (per-report-type CSV download) and "Print / Save as PDF"
  (browser print with a print stylesheet that hides the sidebar/header).

## Database

- Production/shared database is now **Neon** (serverless Postgres),
  connection string ending in `...neon.tech/neondb`. All 4 Prisma migrations
  applied and the seed script run against it (SUPER_ADMIN + demo tenant
  "Khalid Eye Clinic", with strong generated passwords - not the dev default
  `change-me-now`).
- Local dev (`backend/.env`) now points at the same Neon database, at the
  user's request, rather than the local portable Postgres.
- Local `JWT_SECRET` was rotated from the placeholder `dev-secret-not-for-production`
  to a random 256-bit value.

## Deployment prep

- Code pushed to a new GitHub repo (`clinickhalideye/clinickhalideye`) under
  a new GitHub account, replacing the original `origin` remote.
- **Backend**: originally prepared for Render (`render.yaml`), but switched
  to **Vercel serverless** after Render asked for a credit card on this
  account. Added `backend/api/index.js` (wraps the existing Express app as a
  Vercel serverless function) and `backend/vercel.json` (rewrites all
  requests to that function), plus a `postinstall: prisma generate` script
  so Vercel's build generates the Prisma client. `render.yaml` was removed.
- **Frontend**: `frontend/vercel.json` added for SPA client-side routing
  (rewrites all paths to `index.html`), deploy root directory = `frontend`.
- Both are meant to deploy as **two separate Vercel projects** from the same
  repo (root directory `backend` and `frontend` respectively). Deployment
  itself (creating the Vercel projects, setting env vars) is still pending -
  this file reflects what's committed and ready, not what's live yet.

## Known follow-ups (not yet done)

- Vercel project for the backend has not been created/deployed yet.
- Once the backend has a live Vercel URL, the frontend's `VITE_API_URL` and
  the backend's `CORS_ORIGINS` env vars still need to be set to match each
  other.
