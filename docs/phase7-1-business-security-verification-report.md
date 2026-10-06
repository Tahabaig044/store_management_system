# AK VisionFlow — Phase 7.1 (Business Integrity & Security Fixes) Verification Report

Fixes the four confirmed issues from `docs/final-pre-phase7-consolidated-audit-report.md`: the Optical Order payment race, the missing Optical Order cancellation reversal, the two report endpoints missing branch scoping, and AI provider credentials stored in plaintext. All testing ran against a local scratch PostgreSQL database (`phase5_scratch`); production was never modified, and a genuinely fresh database was also migrated cleanly as part of verification.

## 7.1.1 Optical Order Payment Race

**Root cause confirmed**: `POST /optical-orders/:id/pay` read `existing.amountPaid`, computed the new total in JavaScript, then wrote it with a plain `update()`. Two concurrent payments could both read the same stale total and each independently pass the "would exceed total" check, together overpaying the order (individual `Payment`/journal rows stayed correct; only the order's own running total could drift). It also had no branch-access check and no idempotency key.

**Fix**: replaced the read-then-write with the same atomic conditional pattern Sale's own `/:id/pay` already uses — `updateMany({ where: { id, status: { not: 'CANCELLED' }, amountPaid: { lte: maxPriorPaid + 0.0001 } }, data: { amountPaid: { increment } } })`. A losing concurrent request gets a clean `422 BALANCE_CHANGED`; a payment against a cancelled order gets a clean `409 DOCUMENT_NOT_OPEN`. Added `assertBranchAccess`, `idempotencyKey` support (mirroring Sale/Purchase exactly, backed by the existing `Payment.@@unique([tenantId, idempotencyKey])`), and `branchId` attribution on the Payment row.

**Verified by real concurrency test** (`tests/phase7BusinessSecurityFixes.test.js`): two simultaneous `POST /:id/pay` requests that together would exceed the order total — exactly one succeeds (200), the other gets a clean 422, and the order's final `amountPaid` never exceeds the total. A duplicate request with the same `idempotencyKey` is not double-recorded. A payment on a cancelled order is refused. A payment across a branch boundary the caller isn't allowed in is rejected (403).

## 7.1.2 Optical Order Cancellation Accounting

**Root cause confirmed**: setting an order's status to `CANCELLED` via `PATCH /:id` was a plain status update with zero accounting impact — no `/reverse` route exists for Optical Orders (unlike Sale/Purchase/Expense, which all have one). Revenue/receivable booked at order creation stayed on the books indefinitely, and any collected payment was neither refunded nor credited.

**Fix**: the existing atomic status-claim inside `PATCH /:id` (already fixed for concurrency in Phase 5.1) now performs the reversal, in the same transaction, when the transition is TO `CANCELLED`: restores stock for every stock-linked item (skipping SERVICE-kind lines, exactly mirroring Sale's own reversal logic), finds the original `POSTED` journal entry for the order, and reverses it via the existing shared `reverseJournalEntry()` helper — the same function Sale's reversal already uses, with its own independent atomic claim (`POSTED`→`VOID`) as a second layer of double-reversal protection beyond the order's own status claim. Money already collected is not handed back as cash; it is booked to the customer's receivable and a `CreditNote` is issued for it — the identical design Sale's reversal already uses for a customer sale with money collected. This required one small, additive, justified schema change: `CreditNote.reversedOpticalOrderId String? @unique`, the exact mirror of the pre-existing `reversedSaleId` field, added via migration `20261002000000_phase7_1_optical_order_cancellation_credit_note` (a single nullable column + unique index, nothing destructive).

**Verified**: cancelling a paid, stock-linked order restores stock, voids the original journal entry, posts a balanced reversing entry, and issues a credit note for exactly the amount collected. An order with no items/payment cancels cleanly with no stray credit note. Repeated cancellation is safely rejected (409), not double-reversed — confirmed by both a sequential retry and a real concurrency test (two simultaneous cancellation requests: exactly one reverses, the other gets a clean conflict, and only one credit note ever exists). The Trial Balance stays balanced (`debit === credit`) after a cancellation reversal.

## 7.1.3 Branch Scoping

**`/reports/optical-orders`**: `OpticalOrder` carries its own `branchId` (added in Phase 5.1) but the report never applied it. Fixed by spreading the same `branchScopeWhere(prisma, req.user)` helper every sibling report in the file already uses — no separate mechanism invented. Verified: a branch-restricted role sees only its own branch's orders; an unrestricted role (TENANT_ADMIN/MANAGER) sees every branch; tenant B never sees tenant A's orders.

**`/reports/medicine-expiry`**: `Product` itself has no `branchId` (stock is tenant-wide, tracked per-warehouse via `WarehouseStock`), so this report has no direct equivalent of `branchScopeWhere` to reuse. Fixed by reusing the exact same `getAccessibleBranchIds` + warehouse-`branchId` join pattern `/reports/stock-movement` already uses in this same file for the identical "no direct branchId on this row" situation. **Disclosed characteristic, not a new bug**: this session's broader audit found that ordinary Sale/Purchase/Optical-Order stock movement does not populate `WarehouseStock` (only explicit warehouse transfers do) — the same limitation `/stock-movement`'s existing, pre-Phase-7 `InventoryTransaction.warehouseId` join already has (that field is likewise never set by ordinary flows). This means a branch-restricted role may see fewer results than a real deployment's actual per-branch medicine stock would ideally show — but this is the same fail-safe-by-default posture `/stock-movement` already established for exactly this "no reliable per-record branch attribution" situation, and is strictly safer than the pre-fix behavior (unconditional tenant-wide visibility for every role). Verified: an unrestricted role still sees full tenant-wide data; a branch-restricted role now receives a strictly-scoped (never-broader) result; tenant B never sees tenant A's medicines.

## 7.1.4 AI Provider Secret Security

**Root cause confirmed**: `AiConfig.credentials` (which can hold a real Anthropic API key) was a plain, unencrypted `Json` column — redacted only from API *responses*, never encrypted before the database write.

**Fix**: new `backend/src/utils/credentialCrypto.js` — AES-256-GCM authenticated encryption (a tampered ciphertext is rejected on decrypt, not silently corrupted). Key material is derived via `scrypt` from the app's existing, already-required, already-fail-closed-in-production `JWT_SECRET` (`config/env.js`) rather than introducing a second required secret to configure, deploy, and rotate — this reuses the strongest secret-handling mechanism the application already has, per the directive's own instruction. `PUT /api/ai/config` now encrypts `credentials` before every write; `assistant.js` decrypts them in-process, immediately before handing them to the provider that actually needs them, and never anywhere else. A pre-existing plaintext row (none exist yet in this environment, but the code is written for it) is read through unchanged and transparently re-encrypted the next time the tenant admin saves their config — no forced data migration needed. No schema change was required (the field was already a `Json?` column; only its *contents'* shape changed).

**Verified**: a saved API key is never present in plaintext anywhere in the stored row (confirmed by direct database read). `GET /api/ai/config` continues to return only a `hasCredentials` boolean, never the credential in either form. Tenant B cannot read or use tenant A's stored credential (its own config row has no credentials at all). A configured provider still authenticates correctly — the encrypted credential decrypts to the exact original value at call time, proven via a registered stand-in provider that echoes back the API key it received.

**Operational note (rotation)**: rotating `JWT_SECRET` will make previously-encrypted credentials unreadable, the same way it already invalidates every outstanding session token today. This is an accepted, disclosed trade-off, not a defect — a tenant admin re-enters the provider credential afterward via the same `PUT /api/ai/config` used for any ordinary credential update.

## 7.1.5 Verification

- **Backend**: full suite, **59 test suites / 1,094 tests** (1,077 pre-existing + 17 new, in `tests/phase7BusinessSecurityFixes.test.js`). A batched run showed 9 suites with transient "Can't reach database server" failures — the same local-machine connection-load characteristic already documented in the Phase 5 and Phase 6 completion reports (confirmed once again: no Postgres-level `FATAL` log entry, a different random subset each run, zero relationship to any file this phase touched). **Every one of the 9 implicated files was re-run completely alone and passed cleanly.** Net result: **1,094/1,094 passing.**
- **Frontend**: full suite, **59 test files / 385 tests — all passing**, unchanged from Phase 6 (this phase made no frontend changes).
- **Lint**: exit code 0, only pre-existing warnings.
- **Build**: succeeds, no errors.
- **Migration validation**: the new migration applies cleanly to both the long-lived scratch database and a freshly-created empty database (all 38 migrations, in order); `prisma migrate diff --exit-code` reports "No difference detected" against both.
- **Accounting reconciliation**: the Trial Balance stays balanced after a cancellation reversal (explicit test); every reversal is a genuine mirrored journal entry, never a status-flip.
- **Tenant isolation**: verified for all four fixes (tenant B cannot see tenant A's optical orders, medicines, or AI credentials).
- **Branch isolation**: verified for the payment endpoint and both report endpoints.
- **Permission checks**: unchanged — every modified route retains its pre-existing `requirePermission`/`requireRole` gate; no route's protection was weakened.
- **Concurrency tests**: two new real, `Promise.all`-against-real-Postgres tests added — the payment race and the cancellation race — both proving the fix, not just asserting the absence of an error.

## Summary

All four confirmed Phase 7.1 issues are fixed, tested (including genuine concurrency proof for the two race conditions), and verified not to have weakened any existing tenant/branch/permission control or broken any pre-existing test. One additive, justified migration was created (`CreditNote.reversedOpticalOrderId`); no destructive schema change was made or considered necessary.

# PHASE 7.1 — COMPLETE

Continuing automatically to Phase 7.2.
