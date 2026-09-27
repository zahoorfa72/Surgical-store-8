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
- 2026-06: Migrated existing project into workspace; installed deps; verified
  offline demo login and navigation.
- 2026-06: Added Reports screen (`app/reports.tsx`) — Daily/Weekly/Monthly/
  Yearly ranges showing Sales (gross/net/returns/txns/units), Purchases
  (gross/returns/net), Returns & refunds, Expenses (direct/operating/personal),
  and Profit (gross/net). Computed fully offline from cache. Linked from the
  "More" tab (Accounts section) and registered as a modal route.

## Backlog
- P1: Export/share report as PDF (expo-print is already a dependency).
- P2: Per-day trend chart in reports.
- P2: Custom date-range picker in reports.

## Next tasks
- Populate/QA reports with real recorded sales/purchases/expenses.
