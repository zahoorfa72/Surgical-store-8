// React Query hooks + query keys for all backend collections.
// Offline-first reads: when the device is offline, never call fetch. Return
// the last persisted cache (or an empty safe value on a fresh install).

import { useQuery } from "@tanstack/react-query";
import NetInfo from "@react-native-community/netinfo";

import { apiRequest, getConnectionMode, getSettings, StoreSettings } from "@/src/api";
import { queryClient } from "@/src/query-client";
import {
  Budget, CustomerRow, DayClose, Expense, ExpenseBucket, Party, PartyType,
  Payment, Product, Purchase, ReportSummary, ReturnRecord, Sale,
} from "@/src/models";
import { AppUser } from "@/src/api";
import { notifyLowStock } from "@/src/low-stock-notifications";

export const qk = {
  products: ["products"] as const,
  parties: (type?: PartyType) => ["parties", type ?? "all"] as const,
  sales: ["sales"] as const,
  sale: (id: string) => ["sale", id] as const,
  purchase: (id: string) => ["purchase", id] as const,
  expenses: (bucket?: ExpenseBucket) => ["expenses", bucket ?? "all"] as const,
  purchases: ["purchases"] as const,
  payments: (partyId?: string) => ["payments", partyId ?? "all"] as const,
  budget: ["budget"] as const,
  returns: ["returns"] as const,
  purchaseReturns: ["purchase-returns"] as const,
  users: ["users"] as const,
  report: (range: string) => ["report", range] as const,
  customers: (range: string) => ["customers", range] as const,
  dayClose: (range: string) => ["day-close", range] as const,
  settings: ["settings"] as const,
};

async function online(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return !!(state.isConnected && state.isInternetReachable !== false);
}

async function localOrFetch<T>(key: readonly unknown[], fetcher: () => Promise<T>, fallback: T): Promise<T> {
  if ((await getConnectionMode()) === "offline") {
    return (queryClient.getQueryData<T>(key) ?? fallback) as T;
  }
  if (!(await online())) return (queryClient.getQueryData<T>(key) ?? fallback) as T;
  try {
    return await fetcher();
  } catch {
    return (queryClient.getQueryData<T>(key) ?? fallback) as T;
  }
}

function startOfRange(range: string): Date | null {
  const now = new Date();
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (range === "year") return new Date(now.getFullYear(), 0, 1);
  if (range === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return d;
  }
  return null;
}

function inRange(iso: string | undefined, range: string): boolean {
  if (!iso) return true;
  const start = startOfRange(range);
  return !start || new Date(iso) >= start;
}

function localReport(range: string): ReportSummary {
  const sales = ((queryClient.getQueryData<Sale[]>(qk.sales) ?? [])).filter(s => inRange(s.created_at, range));
  const purchases = ((queryClient.getQueryData<Purchase[]>(qk.purchases) ?? [])).filter(p => inRange(p.created_at, range));
  const returns = ((queryClient.getQueryData<ReturnRecord[]>(qk.returns) ?? [])).filter(r => inRange(r.created_at, range));
  const purchaseReturns = ((queryClient.getQueryData<any[]>(qk.purchaseReturns) ?? [])).filter(r => inRange(r.created_at, range));
  const expenses = ((queryClient.getQueryData<Expense[]>(qk.expenses(undefined)) ?? [])).filter(e => inRange(e.created_at, range));
  const payments = ((queryClient.getQueryData<Payment[]>(qk.payments()) ?? [])).filter(p => inRange(p.created_at, range));
  const products = queryClient.getQueryData<Product[]>(qk.products) ?? [];

  const grossRevenue = sales.reduce((n, s) => n + Number(s.subtotal ?? 0), 0);
  const salesRevenue = sales.reduce((n, s) => n + Number(s.total ?? 0), 0);
  const returnsTotal = returns.reduce((n, r) => n + Number(r.refund_total ?? 0), 0);
  const cogsGoods = Math.max(0, sales.reduce((n, s) => n + Number(s.cogs ?? 0), 0) - returns.reduce((n, r) => n + Number(r.refund_cogs ?? 0), 0));
  const cogsExpenses = expenses.filter(e => e.bucket === "cogs").reduce((n, e) => n + Number(e.amount ?? 0), 0);
  const personal = expenses.filter(e => e.bucket === "personal").reduce((n, e) => n + Number(e.amount ?? 0), 0);
  const operating = expenses.filter(e => e.bucket === "operating").reduce((n, e) => n + Number(e.amount ?? 0), 0);
  const revenue = Math.max(0, salesRevenue - returnsTotal);
  const grossProfit = revenue - cogsGoods;
  // Cash movement is the actual amount field only. Adjustment is a
  // non-cash settlement/discount and must not be counted as money in hand.
  const supplierPayments = payments.filter(p => p.kind === "pay").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const customerReceipts = payments.filter(p => p.kind === "receive").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const supplierRefunds = payments.filter(p => p.kind === "supplier_refund").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const customerRefunds = payments.filter(p => p.kind === "customer_refund").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const purchaseGross = purchases.reduce((n, p) => n + Number(p.total ?? 0), 0);
  const purchaseReturnsTotal = purchaseReturns.reduce((n, r) => n + Number(r.refund_total ?? 0), 0);
  const purchaseTotal = purchaseGross - purchaseReturnsTotal;
  const inventoryValue = products.reduce((n, p) => n + Number(p.quantity ?? 0) * Number(p.purchase_price ?? 0), 0);

  return {
    range, revenue, gross_revenue: grossRevenue, returns_total: returnsTotal, returns_count: returns.length,
    cogs_goods: cogsGoods, cogs_expenses: cogsExpenses, cogs_total: cogsGoods + cogsExpenses,
    personal_expenses: personal, gross_profit: grossProfit, operating_expenses: operating,
    total_expenses: cogsExpenses + operating + personal,
    supplier_payments: supplierPayments, customer_receipts: customerReceipts,
    // Profit is affected only by personal expenses. Supplier payments and
    // operating/COGS cash outflows affect cash remaining, not profit.
    net_profit: grossProfit - personal,
    // Same cash rule as the server: include opening cash, cash sales,
    // supplier-return refunds, customer receipts, supplier payments and cash
    // expenses. Purchases themselves are inventory, not a cash-outflow in this
    // simplified ledger unless a supplier payment is recorded.
    remaining_balance: (
      Number((queryClient.getQueryData<any>(qk.budget)?.opening_amount ?? 0))
      + sales.filter(s => !s.credit).reduce((n, s) => n + Number(s.total ?? 0), 0)
      - returns.filter(r => {
          const sale = sales.find(s => s.id === r.sale_id);
          return !!sale && !sale.credit;
        }).reduce((n, r) => n + Number(r.refund_total ?? 0), 0)
      + customerReceipts
      + supplierRefunds
      - customerRefunds
      - supplierPayments
      - cogsExpenses
      - operating
      - grossProfit
    ),
    units_sold: sales.reduce((n, s) => n + s.items.reduce((m, i) => m + Number(i.quantity ?? 0), 0), 0),
    transactions: sales.length, purchase_total: purchaseTotal, purchase_gross: purchaseGross, purchase_returns_total: purchaseReturnsTotal, inventory_value: inventoryValue,
    product_count: products.length,
    low_stock: products.filter(p => Number(p.quantity ?? 0) <= Number(p.low_stock_threshold ?? 0)),
  };
}

export function useProducts() {
  return useQuery({
    queryKey: qk.products,
    queryFn: async () => {
      const products = await localOrFetch(qk.products, () => apiRequest<Product[]>("/products"), []);
      void notifyLowStock(products).catch(() => {});
      return products;
    },
  });
}
export function useParties(type?: PartyType) {
  return useQuery({ queryKey: qk.parties(type), queryFn: () => localOrFetch(qk.parties(type), () => apiRequest<Party[]>(`/parties${type ? `?type=${type}` : ""}`), []) });
}
export function useSales() {
  return useQuery({ queryKey: qk.sales, queryFn: () => localOrFetch(qk.sales, () => apiRequest<Sale[]>("/sales"), []) });
}
export function useSale(id: string) {
  return useQuery({
    queryKey: qk.sale(id), enabled: !!id,
    queryFn: () => {
      if (id.startsWith("local-")) {
        const cached = queryClient.getQueryData<Sale>(qk.sale(id));
        if (cached) return Promise.resolve(cached);
      }
      return localOrFetch(qk.sale(id), () => apiRequest<Sale>(`/sales/${id}`), queryClient.getQueryData<Sale>(qk.sale(id)) as Sale);
    },
  });
}
export function useExpenses(bucket?: ExpenseBucket) {
  return useQuery({ queryKey: qk.expenses(bucket), queryFn: () => localOrFetch(qk.expenses(bucket), () => apiRequest<Expense[]>(`/expenses${bucket ? `?bucket=${bucket}` : ""}`), []) });
}
export function usePurchases() {
  return useQuery({ queryKey: qk.purchases, queryFn: () => localOrFetch(qk.purchases, () => apiRequest<Purchase[]>("/purchases"), []) });
}
export function usePurchase(id: string) {
  return useQuery({
    queryKey: qk.purchase(id), enabled: !!id,
    queryFn: () => localOrFetch(qk.purchase(id), () => apiRequest<Purchase>(`/purchases/${id}`), queryClient.getQueryData<Purchase>(qk.purchases)?.find(p => p.id === id) as Purchase),
  });
}
export function usePayments(partyId?: string) {
  return useQuery({ queryKey: qk.payments(partyId), queryFn: () => localOrFetch(qk.payments(partyId), () => apiRequest<Payment[]>(`/payments${partyId ? `?party_id=${partyId}` : ""}`), []) });
}
export function useBudget() {
  return useQuery({ queryKey: qk.budget, queryFn: () => localOrFetch(qk.budget, () => apiRequest<Budget>("/budget"), { monthly_amount: 0, spent_this_month: 0 }) });
}
export function useUsers() {
  return useQuery({ queryKey: qk.users, queryFn: () => localOrFetch(qk.users, () => apiRequest<AppUser[]>("/users"), []) });
}
export function useReport(range: string) {
  return useQuery({ queryKey: qk.report(range), queryFn: async () => {
    if ((await getConnectionMode()) === "offline") return localReport(range);
    if (!(await online())) return localReport(range);
    try { return await apiRequest<ReportSummary>(`/reports/summary?range=${range}`); }
    catch { return localReport(range); }
  }});
}
export function useCustomers(range: string) {
  return useQuery({ queryKey: qk.customers(range), queryFn: () => localOrFetch(qk.customers(range), () => apiRequest<CustomerRow[]>(`/reports/customers?range=${range}`), []) });
}
export function useReturns() {
  return useQuery({ queryKey: qk.returns, queryFn: () => localOrFetch(qk.returns, () => apiRequest<ReturnRecord[]>("/returns"), []) });
}
export function usePurchaseReturns() {
  return useQuery({ queryKey: qk.purchaseReturns, queryFn: () => localOrFetch(qk.purchaseReturns, () => apiRequest<any[]>("/purchase-returns"), []) });
}
export function useDayClose(range: string) {
  return useQuery({ queryKey: qk.dayClose(range), queryFn: () => localOrFetch(qk.dayClose(range), () => apiRequest<DayClose>(`/reports/day-close?range=${range}`), { me: { user_name: "", transactions: 0, units: 0, gross_sales: 0, discount: 0, range }, by_user: null }) });
}
export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => localOrFetch(qk.settings, () => getSettings(), { store_name: "Surgical Store", has_logo: false, logo_version: 0 }) });
}
export type { StoreSettings };
