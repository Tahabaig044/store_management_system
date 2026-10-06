# API Versioning Strategy

Status: **policy document only** — no route paths changed as part of this. Written as part of Web ERP Phase 12 (Production Hardening), REQ-12-018.

## Current state (as of Phase 12)

| Surface | Current path prefix | Versioned? |
|---|---|---|
| Main web API (staff/admin, consumed by the existing React frontend) | `/api/*` | No |
| Customer Portal API | `/api/portal/*` | No |
| Owner Mobile (Android) API | `/api/mobile/v1/*` | Yes |

Only the Owner Mobile surface carries an explicit version segment. This is not an oversight to "fix" retroactively — it reflects when each surface was built: the mobile API was introduced later (Phase 1 of the Owner Android App) with versioning designed in from the start, specifically because it has an external, independently-updated client (the Android app) that cannot be forced to update in lockstep with the backend. The web frontend and portal are both first-party, deployed-together clients of their respective APIs, so an unversioned path has not historically caused a compatibility problem.

## Policy going forward

**Do not retrofit a version prefix onto `/api/*` or `/api/portal/*`.** Doing so would be a breaking change to every existing frontend and portal request with no functional benefit — the existing paths continue to work exactly as they do today, indefinitely.

**When a genuinely breaking change to the main web API or the Customer Portal API becomes necessary** (a response shape change, a removed field, a changed validation rule that existing clients depend on) — introduce the new behavior at a new version prefix alongside the existing one, rather than mutating the existing path in place:

- Existing: `/api/<resource>` continues to serve exactly as it does today, unchanged, for as long as any client depends on it.
- New: `/api/v2/<resource>` (or `/api/portal/v2/*` for the portal) carries the breaking change.
- The frontend/portal migrates to the new path on its own schedule; the old path is only removed once nothing depends on it.

This mirrors the pattern already proven safe for the Owner Mobile API's own versioning, and for how a hypothetical `/api/mobile/v2/*` would be introduced if the Android app ever needed a breaking mobile API change.

**A non-breaking change** (a new optional field, a new endpoint, a new optional query parameter) never requires a new version — it's added to the existing path exactly as has been done throughout Phases 1–9.

## What counts as breaking

- Removing or renaming a response field an existing client reads.
- Changing the type or meaning of an existing field.
- Removing an endpoint or changing its required request shape in a way existing callers don't already satisfy.
- Tightening validation in a way that would reject requests the current client already sends.

Adding a field, adding an endpoint, or loosening a validation rule is never breaking and never needs a new version.

## Non-goals of this document

This is a policy for *future* changes, not a plan to version the existing `/api/*` or `/api/portal/*` surfaces now. No code change accompanies this document.
