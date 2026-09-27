# Surgical Store Manager — PRD

## Original problem statement
Existing offline-first Surgical Store POS/inventory/accounting app (Expo +
FastAPI + Supabase). User wants upgrades and error fixes, keep the Supabase
backend unchanged, and keep the app 100% offline-capable.
Latest explicit request: "Add daily, weekly, monthly, yearly report showing
purchases, sales, returns, refunds and expenses — and show it."

## Architecture
- Frontend: Expo Router (React Native), React Query offline cache + outbox sync.
- Backend: FastAPI + Supabase PostgreSQL (JWT auth, roles: admin/partner/cashier).
- Offline: default connection mode is "offline"; data reads come from the
  persisted React Query cache; writes are queued in an outbox and replayed when
  online. Reports are computed client-side (src/data.ts -> localReport).

## User personas
- Admin: full access incl. user management.
- Partner: sell, stock, purchases, parties, expenses, reports.
- Cashier: sell + reprint receipts.

## Core requirements (static)
- Must remain 100% usable offline.
- Do not change/replace the Supabase backend.

## Implemented (dates)
- 2026-06: Migrated existing project; verified offline demo login and navigation.
- 2026-06: Added Reports screen (Daily/Weekly/Monthly/Yearly).
- 2026-06: Net-after-return amounts in Sales & Purchases history; per-supplier
  grouping in Purchases; refund labels + per-party grouping in Payments.
- 2026-06: Remaining Balance formula corrected to "net sales − gross profit"
  (backend server.py + frontend data.ts, kept identical online/offline).
- 2026-06: Cascade delete — deleting a sale/purchase now also removes its
  linked returns/refunds, restores net stock, updates party balances & finance,
  with a clear confirm message + toast (backend + offline optimistic patch).
- 2026-06: Added GitHub Actions APK build workflow (.github/workflows/build-apk.yml).

## Backlog
- P1: Export/share report as PDF (expo-print is already a dependency).
- P2: Per-day trend chart in reports.
- P2: Custom date-range picker in reports.

## Next tasks
- Populate/QA reports with real recorded sales/purchases/expenses.
