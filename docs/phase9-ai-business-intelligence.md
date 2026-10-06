# Phase 9 — AI + Business Intelligence + Predictive Analytics

## Overview

Phase 9 adds an intelligence layer on top of the existing platform: an AI Business Assistant that answers natural-language business questions, a Daily Business Brief, statistical sales forecasting, deterministic anomaly/risk detection, and an AI Recommendation Center — all integrated into the owner/admin Command Center. No existing Phase 1–8 functionality, schema, or data was changed or removed.

## Core Design Decision: Deterministic-First AI

The phase's own non-negotiable rules require that "financial calculations and source-of-truth reports remain deterministic/backend-authoritative" and that AI "must not fabricate numbers." Given that, and that this environment has no configured external LLM credentials, the shipped default AI provider (`deterministic`) is **not a call to a hosted language model** — it is a rule-based/statistical engine that:

- Computes every factual number via a plain, auditable aggregation query (`src/modules/ai/analytics.js`) — no randomness, no external call.
- Produces forecasts via ordinary-least-squares linear trend plus (for daily granularity) day-of-week seasonality, with confidence bands from the fit's own residual spread (`src/modules/ai/forecast.js`).
- Detects anomalies via z-score/threshold statistics against each tenant's own trailing history (`src/modules/ai/anomaly.js`).
- Composes natural-language phrasing around those numbers via simple templates (`src/modules/ai/providers/deterministicProvider.js`) — it can only read from the facts object it's given, never invent a figure.

This means the whole AI layer works with **zero configuration, no API key, and no network access**, is fully deterministic and reproducible in tests, and can never violate the "AI must not replace deterministic financial calculations" rule because it *is* those calculations, phrased. A real hosted LLM can be registered later as an additional provider (see Provider Architecture below) purely to improve phrasing/fluency — it would still only ever be handed the same structured `facts` object and would never be trusted for the numbers themselves.

## Data Model

All new tables are additive (migration `20260914043854_phase9_ai_business_intelligence`, verified to contain no `DROP`/`TRUNCATE`/column removal):

| Model | Purpose |
|---|---|
| `AiConfig` | Per-tenant AI enable/disable, provider selection, daily request quota. `credentials` (for a future real provider) is write-only from the API. |
| `AiConversation` / `AiMessage` | Business Assistant chat history. Every `ASSISTANT` message stores its `grounding` (the exact facts object used), `intent`, and `confidence`. |
| `AiInsight` | The Recommendation Center's data: recommendations and anomalies, with severity, evidence, a source-record drill-down (`sourceType`/`sourceId`), and a `dedupeKey` unique per tenant so repeated scans update rather than duplicate. |
| `AiForecast` | Persisted forecast runs (scope, granularity, method, series) for later forecast-vs-actual comparison. |
| `AiUsageLog` | One row per AI feature invocation — the basis for quota enforcement and the usage/cost report. |
| `AiFeedback` | Thumbs-up/down + comment on an insight. |

No core business table (Sale, Product, Customer, Patient, etc.) was touched.

## Deterministic Data/Analytics Layer

`src/modules/ai/analytics.js` is the single source of truth every AI feature reads from: sales totals/comparison, branch profitability, profit-decline decomposition, product/margin intelligence, supplier price-change tracking, low-stock/reorder risk with days-of-stock-remaining, slow-moving stock with capital tied up, expiry risk, receivables aging, payables summary, new-vs-returning/inactive/high-value customers, delayed optical jobs, lab turnaround, appointment no-show rate, and examination-to-order conversion. Every function is independently unit-testable and takes `tenantId` as its mandatory first argument.

## AI Business Assistant

`POST /api/ai/assistant/ask` (owner/admin only — `TENANT_ADMIN`/`MANAGER`) takes a natural-language question, matches it against a small, auditable set of intent patterns covering every example question in the phase document (sales comparison, branch profitability, product margin, receivables overdue, low stock, slow-moving stock, profit decline, delayed optical jobs, supplier price changes, daily brief), retrieves the matching deterministic facts, and returns a grounded, confidence-scored answer. An unrecognized question returns the suggested-questions list instead of guessing. Conversations persist per user and are strictly tenant/user-scoped.

## Daily Business Brief

`GET /api/ai/brief` (`src/modules/ai/brief.js`) compiles today's sales performance, cash/receivables/payables snapshot, inventory and expiry risks, delayed optical jobs, today's appointment count, pending approvals, an unusual-activity count, and the top 3 recommended actions (by severity) — refreshing the Recommendation Center's insights first so it always reflects current data.

## Sales Forecasting

`POST /api/ai/forecasts/generate` supports `TENANT`/`BRANCH`/`CATEGORY`/`PRODUCT` scope and `DAILY`/`WEEKLY`/`MONTHLY` granularity. Below a minimum data-point threshold (10/6/4 respectively) it returns `insufficientData: true` with a clear reason rather than guessing. Otherwise it returns history alongside the projection, an ~80% confidence band, and a `disclaimer` explicitly labeling it an estimate. Every generated forecast is persisted for later forecast-vs-actual reporting.

## Anomaly & Risk Detection

`src/modules/ai/anomaly.js` scans (all statistical/threshold-based, all tenant-scoped): unusually high discounts (z-score vs 90-day baseline), abnormal sale-reversal rate, unexpected large stock adjustments, expense category spikes, unexpected sales decline, sudden per-branch performance drops, elevated optical-job delay counts, and potential duplicate sales (same customer, same amount, within 5 minutes).

## AI Recommendation Center

`src/modules/ai/recommendations.js` turns the risk analytics and anomaly scans into stored `AiInsight` rows via `POST /api/ai/insights/refresh`, each with severity (`URGENT`/`ATTENTION`/`OPPORTUNITY`/`INFORMATION`), evidence, a recommended action, and a source-record link. Refreshing is idempotent per `dedupeKey` — it **never resets a status a user already set** (acknowledged/dismissed), which is what keeps repeated noise down over time. `POST /api/ai/insights/:id/acknowledge`, `/dismiss`, and `/feedback` let an authorized user act on or rate an insight.

## Command Center Integration

The existing `GET /api/dashboard/command-center` endpoint gained an additive `ai` block: top risks, top opportunities, anomaly alerts, and inventory/receivables-focused insight subsets. This is a **plain, fast read of already-generated `AiInsight` rows** — it never triggers a live AI scan on dashboard load, so the Command Center stays exactly as responsive as before regardless of AI provider availability, and correctly reports when AI is disabled for a tenant.

## Provider Architecture & Failure Handling

`src/modules/ai/providers/provider.js` is the same abstraction pattern as Phase 8's messaging providers: application code never talks to a specific provider directly. `callProvider()` enforces an 8-second timeout and unconditionally falls back to the deterministic provider on any unknown-provider name, thrown error, or timeout — the caller always gets a grounded, factual answer (with `fellBack: true` reported) and a misbehaving external provider can never block a request. `registerProvider()` exists for tests to inject a mock failing/hanging provider without shipping fake code in production paths.

## Usage & Cost Controls

Every AI feature invocation is logged to `AiUsageLog`. `assertWithinQuota()` checks the tenant's `AiConfig.dailyRequestLimit` (and `isEnabled`) before any AI work begins, returning a clear 409 rather than a crash once exceeded. `GET /api/ai/usage` (TENANT_ADMIN only) reports request volume by feature and estimated cost; `GET /api/ai/usage/most-used-questions` reports intent frequency.

## Security / RBAC / Privacy

- Every AI route requires `MANAGEMENT` (`TENANT_ADMIN`/`MANAGER`) at minimum — the same owner/admin-facing scope the phase specifies — and `AiConfig`/usage reports require `TENANT_ADMIN`.
- Every analytics/anomaly/forecast function is `tenantId`-scoped by construction; every route additionally verifies any caller-supplied `branchId`/`scopeId` belongs to the caller's own tenant before use (404 otherwise), preventing cross-tenant data from ever entering an AI context.
- No AI endpoint mutates business data: it can suggest a reorder quantity or flag an anomaly, but there is no "apply" action anywhere in this phase that touches stock, accounting, or clinical records — verified directly in tests.
- `AiConfig.credentials` is never returned by the API.

## Testing

`backend/tests/ai.test.js` (23 tests): RBAC gating of every AI route, branchId/scopeId cross-tenant rejection, conversation/insight/forecast tenant isolation, answer grounding verified against the analytics layer's own direct output, a manually constructed receivables fixture checked to the exact cent, insufficient-data forecast handling, a forecast built from 15 days of controlled historical sales checked for confidence-band consistency, two constructed anomaly scenarios (discount outlier, duplicate sale), insight refresh idempotency (no duplicate rows, dismissed status preserved across re-refresh), insight feedback, provider-throws and provider-timeout fallback (via `registerProvider`), daily quota enforcement, and proof that asking questions/refreshing insights never changes stock, sale, or journal-entry counts. All 253 backend tests (230 pre-existing + 23 new) pass together. Frontend adds 6 new component tests (AI Assistant, Recommendation Center) against the existing 57, for 63 passing.

## Frontend

- **AI Assistant** (`/ai-assistant`) — chat-style page with suggested questions, conversation history, confidence badges, and an expandable "source data used" panel per answer.
- **AI Recommendation Center** (`/recommendations`) — filterable insight list with severity badges, evidence drill-down, acknowledge/dismiss, and thumbs up/down feedback.
- **Command Center** — a new "AI Business Summary" card (top risks/opportunities/anomalies, clearly labeled "AI-generated") above the existing KPI widgets, with links into the two pages above; renders correctly (and says so) when AI is disabled for the tenant.

## Known Limitations / Follow-ups

- No real hosted LLM provider is wired up (by design, per the deterministic-first decision above); adding one is a matter of a new `providers/` module plus tenant-supplied credentials, no other code changes.
- Anomaly/forecast quality depends on data volume — a brand-new tenant with little history will correctly see "insufficient data" rather than a forecast, and won't yet have enough baseline for z-score anomaly checks (which require ≥10 historical points).
- `POST /api/ai/insights/refresh` is invoked on demand (by the Daily Brief, or manually from the Recommendation Center) rather than on a schedule — wiring it to the Phase 8 scheduled-automation endpoint would let insights refresh automatically; not implemented in this phase.
- As with Phase 8, no live-browser click-through was performed for the new frontend pages — verified via `vite build`, `oxlint`, and component tests with real interaction/API assertions (no browser automation tool was available in this environment).
