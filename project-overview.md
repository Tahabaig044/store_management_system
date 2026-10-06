# AK VisionFlow — Complete Project Overview

**Owner:** AKLINES.COM
**Product Type:** Commercial, Multi-Tenant SaaS ERP
**Target Industry:** Independent optical shops, eye clinics, medical stores, and lens laboratories
**Test Tenant:** Khalid Eye Clinic (used for testing only — never hard-coded into the product)

---

## 1. What This Project Is

AK VisionFlow is a cloud-based business management system (ERP) purpose-built for the optical and eyecare retail industry. It replaces manual registers, spreadsheets, and disconnected tools with a single connected platform that handles inventory, sales, customers, suppliers, optical prescriptions/orders, payments, and reporting.

It is a **SaaS (Software-as-a-Service)** product — not a one-off app for a single business. Any number of unrelated shops can subscribe to it, and each one operates in complete data isolation from the others (multi-tenancy), while all running on the same shared codebase and infrastructure.

---

## 2. Core Product Principles (Non-Negotiable Rules)

1. AK VisionFlow is a **generic** SaaS product — never Khalid Eye Clinic-specific.
2. Built in **exactly 3 phases** — no overbuilding Phase 1.
3. Phase 1 must be **deployable and usable** by a real business.
4. **Multi-tenancy and tenant isolation** must exist from day one.
5. **Existing production data must never be lost** when new features are installed.
6. Use **versioned database migrations** for every update — never destructive resets.
7. New features must be **modular and backward-compatible**.
8. **Never hard-code** one tenant's identity into the core product.
9. Do **not implement future-phase features early**.
10. Prioritize a **stable, deployable product** over unnecessary complexity.

---

## 3. System Architecture

| Property | Requirement |
|---|---|
| Architecture style | Multi-Tenant SaaS ERP |
| Hosting | Cloud-based web application |
| App type | Progressive Web App (PWA) |
| UI | Responsive — desktop, tablet, mobile |
| Backend/Frontend | Strict separation — API-first backend |
| Modularity | New modules added without rewriting existing ones |
| Offline readiness | Architecture prepared for offline-first from Phase 1, implemented in Phase 2 |
| Scale target | Designed to support thousands of tenants and millions of records |

---

## 4. Tech Stack

The source documents specify **architectural requirements**, not a locked framework — but they dictate a very specific kind of stack. Below is the stack implied by the requirements:

### Frontend
- **UI Framework:** Bootstrap 5 (mandated), paired with a JS framework (React/Vue/Angular) or server-rendered templates
- **Design:** Professional medical/optical SaaS look, light mode + dark mode
- **PWA layer:** Web App Manifest + Service Worker
- **Offline storage (Phase 2):** IndexedDB (commonly via a wrapper like Dexie.js)

### Backend
- **Style:** API-first REST (or similar) backend
- **Language/Framework:** Any framework with strong ORM + migration tooling — e.g., Node.js (Express/NestJS), Laravel (PHP), Django (Python), or Rails
- **Auth:** JWT or session-based authentication, with server-side role/permission enforcement
- **Password security:** Modern hashing algorithm (bcrypt/argon2 class)

### Database
- **Type:** Relational database (PostgreSQL or MySQL recommended)
- **Design:** Normalized schema, `tenant_id` isolation on every tenant-owned table
- **Migrations:** Versioned, additive, never destructive
- **Data integrity:** Foreign keys, indexes, unique constraints, timestamps, soft-delete/archive, transaction-safe financial/stock operations

### Sync Layer (Phase 2)
- **Local DB:** IndexedDB with its own versioned migration system
- **Sync engine:** Durable local operation queue, idempotency keys, conflict detection/resolution
- **Service Worker:** Application shell caching, safe offline asset strategy

### DevOps / Infrastructure
- **Containerization:** Docker (if used by the chosen stack)
- **Secrets/config:** Environment variables, no hard-coded secrets
- **Transport security:** HTTPS in production
- **Backup/restore:** Documented, tested procedures
- **Version control:** Git with a clear migration/versioning strategy

### Security Stack
- CSRF protection where applicable
- Parameterized queries / ORM (SQL injection protection)
- Input validation & output encoding
- Rate limiting / brute-force protection
- Audit logging for sensitive actions
- Tenant isolation enforced server-side on every query

---

## 5. Core Database Entities

At minimum, the schema must include:

```
tenants, subscriptions, branches, users, roles, permissions,
products, categories, inventory, sales, sale_items,
purchases, purchase_items, customers, suppliers, expenses,
optical_orders, prescriptions, payments, audit_logs,
sync_logs, notifications, settings
```

Every tenant-owned record carries a `tenant_id` (or equivalent), and cross-tenant access must be architecturally impossible — not just filtered in the UI.

---

## 6. Core Business Modules

| Module | Purpose |
|---|---|
| **Product Management** | General product CRUD, categories, SKU/barcode |
| **Medicine Management** | Batch & expiry tracking |
| **Frame Management** | Frame inventory records |
| **Lens Management** | Lens inventory records |
| **Customer Management** | Customer CRUD, contact info, transaction history |
| **Supplier Management** | Supplier CRUD, ledger |
| **Purchase Module** | Create purchases, receive stock, atomic inventory updates |
| **Sales / POS** | Fast checkout, cart, discounts, payments, invoices |
| **Optical Orders** | Prescription, frame/lens selection, lab/fitting status, delivery tracking |
| **Inventory Management** | Stock movements, adjustments, audit trail, low-stock thresholds |
| **Expense Management** | Expense categories, records, reporting |
| **Reporting System** | Sales, inventory, ledgers, P&L, expiry, optical order reports |

---

## 7. Users & Roles

**Standard roles (foundation from Phase 1, expanded in Phase 3):**
- Super Admin *(platform-level, full portal in Phase 3)*
- Tenant Admin
- Manager
- Cashier
- Store Keeper
- Receptionist
- Accountant

All permission checks are enforced **server-side**, never trusted from the client.

---

## 8. Development Roadmap — 3 Phases

### 🟢 Phase 1 — Core Commercial MVP
**Goal:** A real business can log in and run its full daily operation.

Includes:
- Tenant setup & isolation
- Auth + basic RBAC
- Users & branches foundation
- Products, categories, medicine, frames, lenses
- Customers & suppliers
- Purchases & purchase items
- Inventory & stock movements
- Sales/POS & sale items
- Payments, expenses, invoices
- Optical orders, prescriptions, lab orders
- Dashboard KPIs
- Daily/monthly sales, inventory, stock movement, financial reports
- PWA foundation (installable shell, manifest, basic SW)
- Security, audit trail, backup/restore foundation
- Production-ready deployment config

**Explicitly excluded from Phase 1:** Master Portal, subscription billing UI, offline transactions, push notifications, WhatsApp/SMS, EMR, AI prescription reader, OCT integration, hospital management.

---

### 🟡 Phase 2 — Offline-First & Cloud Synchronization
**Goal:** The app keeps working during internet outages and syncs safely once reconnected — with zero data loss or duplication.

Includes:
- IndexedDB local data store (with its own versioned migrations)
- Service Worker for offline asset caching
- Offline-capable: sales, purchases, inventory transactions, customers, suppliers, expenses, optical orders
- Durable local sync queue (survives refresh/restart)
- Unique client-generated operation IDs for every offline write
- Automatic sync on reconnect + manual sync trigger
- Deterministic conflict detection (not blind last-write-wins)
- Explicit conflict resolution strategy per entity type
- Idempotent sync APIs (no duplicate transactions on retry)
- Visible sync status UI (online/offline, pending counts, last sync time, conflicts)
- Sync/audit logs

**Non-negotiable:** Existing Phase 1 data and workflows must remain fully intact and functional online.

---

### 🔵 Phase 3 — SaaS Control Plane & Advanced Platform
**Goal:** Turn the stable product into a mature, centrally-managed commercial SaaS platform.

Includes:
- Super Admin / Master Portal (tenant list, status, onboarding, monitoring)
- Subscription & package management (configurable pricing, feature limits, trials)
- Billing architecture (tenant billing records, invoices, payment gateway abstraction)
- Advanced roles & granular/custom permissions
- Full multi-branch expansion (branch-level inventory, sales, reporting)
- Advanced analytics (trends, comparisons, platform-level metrics)
- In-app + push notifications (low stock, expiry, orders, billing)
- Support ticket system
- Feature flags for safe, gradual rollouts
- Mature versioned release/migration system
- Platform monitoring (health checks, error/queue monitoring)
- Backup & recovery maturity (automated, tested, point-in-time where supported)
- Future integration framework (WhatsApp/SMS/email abstraction, AI prescription reader hook, OCT hook, EMR module boundary) — **extension points only, not built out**

**Non-negotiable:** Phases 1 and 2 must remain fully functional — offline queues, sync state, and all existing tenant data must survive the upgrade.

---

## 9. Data Integrity & Safety Rules (Apply Across All Phases)

- Sales/purchases/stock updates must be **atomic** (database transactions)
- No negative/inconsistent stock unless explicitly configured
- Totals calculated **server-side only**
- Financial/stock transactions are **immutable or reversal-based** — never physically deleted to "fix" mistakes
- Every transaction has a unique ID suitable for idempotency/sync
- Migrations are always **additive**, backups run before major changes
- Tenant isolation enforced on **every** protected query — client-supplied tenant IDs are never trusted

---

## 10. Development Workflow (Every Phase)

```
Inspect existing code → Plan → Implement → Migrate DB → Test → Fix →
Security Check → Regression Test → Build → Deploy → Verify → Document → Release
```

Working code is never rewritten unnecessarily. Each phase ends with a report covering: implemented modules, migrations, API endpoints, UI pages, tests performed, remaining issues, and deployment steps.

---

## 11. Deliverables

- Full system architecture & ERD
- Database schema + migration system
- API documentation
- Frontend & backend codebases
- Auth & authorization system
- Offline engine & synchronization engine (Phase 2+)
- Test suites (unit, API, migration, regression)
- Docker configuration
- Deployment & installation guides
- Environment configuration docs
- Version/release documentation

---

## 12. One-Line Summary

**AK VisionFlow is a multi-tenant, offline-capable, PWA-based SaaS ERP that gives optical shops, eye clinics, medical stores, and lens labs a single platform to manage inventory, POS sales, customers/suppliers, optical prescriptions and orders, payments, and reporting — built in three safe, non-destructive phases from MVP to full commercial platform.**