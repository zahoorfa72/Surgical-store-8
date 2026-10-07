// React Query hooks + query keys for all backend collections.
// Offline-first reads: when the device is offline, never call fetch. Return
// the last persisted cache (or an empty safe value on a fresh install).

import { useQuery } from "@tanstack/react-query";
import NetInfo from "@react-native-community/netinfo";

import { apiRequest, getConnectionMode, getSettings, StoreSettings } from "@/src/api";
import { queryClient } from "@/src/query-client";
import {
  Budget, CustomerRow, DayClose, Expense, ExpenseBucket, Party, PartyType,
  Payment, Product, Purchase, ReportSummary, ReturnRecord, Sale, InventoryUsageRow,
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
  inventoryUsage: (range: string) => ["inventory-usage", range] as const,
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
  const exactDate = range.startsWith("date:") ? range.slice(5) : null;
  const dateRange = range.startsWith("date-range:") ? range.slice(11).split(":") : null;
  const monthValue = range.startsWith("month:") ? range.slice(6) : null;
  const yearValue = range.startsWith("year:") ? range.slice(5) : null;
  const exactStart = exactDate ? new Date(exactDate + "T00:00:00") : null;
  const exactEnd = exactStart ? new Date(exactStart.getTime() + 86400000) : null;
  const fromStart = dateRange?.[0] ? new Date(dateRange[0] + "T00:00:00") : null;
  const toEnd = dateRange?.[1] ? new Date(new Date(dateRange[1] + "T00:00:00").getTime() + 86400000) : null;
  const monthStart = monthValue && /^\d{4}-\d{2}$/.test(monthValue) ? new Date(monthValue + "-01T00:00:00") : null;
  const monthEnd = monthStart ? new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1) : null;
  const yearStart = yearValue && /^\d{4}$/.test(yearValue) ? new Date(yearValue + "-01-01T00:00:00") : null;
  const yearEnd = yearStart ? new Date(yearStart.getFullYear() + 1, 0, 1) : null;
  const matchesDate = (iso?: string) => {
    if (!iso) return false;
    const d = new Date(iso);
    if (exactStart) return d >= exactStart && d < exactEnd!;
    if (fromStart && toEnd) return d >= fromStart && d < toEnd;
    if (fromStart) return d >= fromStart;
    if (toEnd) return d < toEnd;
    if (monthStart && monthEnd) return d >= monthStart && d < monthEnd;
    if (yearStart && yearEnd) return d >= yearStart && d < yearEnd;
    return inRange(iso, range);
  };
  const customPeriod = !!(exactStart || fromStart || toEnd || (monthStart && monthEnd) || (yearStart && yearEnd));
  const filterRows = <T extends { created_at?: string }>(rows: T[]) => customPeriod ? rows.filter(r => matchesDate(r.created_at)) : rows.filter(r => inRange(r.created_at, range));
  const sales = filterRows(queryClient.getQueryData<Sale[]>(qk.sales) ?? []);
  const purchases = filterRows(queryClient.getQueryData<Purchase[]>(qk.purchases) ?? []);
  const returns = filterRows(queryClient.getQueryData<ReturnRecord[]>(qk.returns) ?? []);
  const purchaseReturns = filterRows(queryClient.getQueryData<any[]>(qk.purchaseReturns) ?? []);
  const expenses = filterRows(queryClient.getQueryData<Expense[]>(qk.expenses(undefined)) ?? []);
  const payments = filterRows(queryClient.getQueryData<Payment[]>(qk.payments()) ?? []);
  const products = queryClient.getQueryData<Product[]>(qk.products) ?? [];
  const budget = queryClient.getQueryData<Budget>(qk.budget) ?? { monthly_amount: 0, opening_amount: 0, spent_this_month: 0 };

  const grossRevenue = sales.reduce((n, s) => n + Number(s.subtotal ?? 0), 0);
  const salesRevenue = sales.reduce((n, s) => n + Number(s.total ?? 0), 0);
  const returnsTotal = returns.reduce((n, r) => n + Number(r.refund_total ?? 0), 0);
  // Match Sell exactly: use the stored profit on each sale and reverse
  // returned profit. This keeps offline Remaining Balance identical to Sell.
  const storedSaleProfit = sales.reduce((n, s) => n + Number(s.profit ?? 0), 0);
  const storedReturnProfit = returns.reduce((n, r) => n + Number(r.refund_profit ?? 0), 0);
  const grossProfit = storedSaleProfit - storedReturnProfit;
  const cogsGoods = sales.reduce((n, s) => n + Number(s.cogs ?? 0), 0) - returns.reduce((n, r) => n + Number(r.refund_cogs ?? 0), 0);
  const cogsExpenses = expenses.filter(e => e.bucket === "cogs").reduce((n, e) => n + Number(e.amount ?? 0), 0);
  const personal = expenses.filter(e => e.bucket === "personal").reduce((n, e) => n + Number(e.amount ?? 0), 0);
  const operating = expenses.filter(e => e.bucket === "operating").reduce((n, e) => n + Number(e.amount ?? 0), 0);
  const revenue = salesRevenue - returnsTotal;
  // Cash movement is the actual amount field only. Adjustment is a
  // non-cash settlement/discount and must not be counted as money in hand.
  const supplierPayments = payments.filter(p => p.kind === "pay").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const customerReceipts = payments.filter(p => p.kind === "receive").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const supplierRefunds = payments.filter(p => p.kind === "supplier_refund").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const customerRefunds = payments.filter(p => p.kind === "customer_refund").reduce((n, p) => n + Number(p.amount ?? 0), 0);
  const purchaseGross = purchases.reduce((n, p) => n + Number(p.total ?? 0), 0);
  const purchaseReturnsTotal = purchaseReturns.reduce((n, r) => n + Number(r.refund_total ?? 0), 0);
  const purchaseTotal = purchaseGross - purchaseReturnsTotal;
  const inventoryValue = products.reduce((n, p) => {
    const layers = Array.isArray((p as any).cost_layers) ? (p as any).cost_layers : [];
    const value = layers.length
      ? layers.reduce((sum: number, layer: any) => sum + Number(layer.quantity ?? 0) * Number(layer.unit_cost ?? 0), 0)
      : Number(p.quantity ?? 0) * Number(p.purchase_price ?? 0);
    return n + value;
  }, 0);

  return {
    range, revenue, gross_revenue: grossRevenue, returns_total: returnsTotal, returns_count: returns.length,
    cogs_goods: cogsGoods, cogs_expenses: cogsExpenses, cogs_total: cogsGoods + cogsExpenses,
    personal_expenses: personal, gross_profit: grossProfit, operating_expenses: operating,
    total_expenses: cogsExpenses + operating + personal,
    supplier_payments: supplierPayments, customer_receipts: customerReceipts,
    // Remaining Balance = Net Sales - Gross Profit - Supplier Payments - Operational Expenses
    // - COGS Expenses + Supplier Refunds + Opening Purchase Budget + Monthly Expenses Budget.
    remaining_balance:
      revenue - grossProfit - supplierPayments - operating - cogsExpenses + supplierRefunds
      + Number(budget.opening_amount ?? 0) + Number(budget.monthly_amount ?? 0),

    units_sold: sales.reduce((n, s) => n + s.items.reduce((m, i) => m + Number(i.quantity ?? 0), 0), 0),
    net_profit: grossProfit - personal,\n    transactions: sales.length, purchase_total: purchaseTotal, purchase_gross: purchaseGross, purchase_returns_total: purchaseReturnsTotal, inventory_value: inventoryValue,
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
export function useReport(range: string, enabled = true) {
  const exactDate = range.startsWith("date:") ? range.slice(5) : null;
  const cacheRange = exactDate ? `date:${exactDate}` : range;
  return useQuery({ enabled, queryKey: qk.report(cacheRange), queryFn: async () => {
    if ((await getConnectionMode()) === "offline") return localReport(range);
    if (!(await online())) return localReport(range);
    try {
      const tzOffsetMinutes = new Date().getTimezoneOffset();
      const url = exactDate
        ? `/reports/summary?range=today&date=${encodeURIComponent(exactDate)}&tz_offset_minutes=${tzOffsetMinutes}`
        : `/reports/summary?range=${encodeURIComponent(range)}&tz_offset_minutes=${tzOffsetMinutes}`;
      return await apiRequest<ReportSummary>(url);
    } catch { return localReport(range); }
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
  return useQuery({ queryKey: qk.dayClose(range), queryFn: () => { const tzOffsetMinutes = new Date().getTimezoneOffset(); return localOrFetch(qk.dayClose(range), () => apiRequest<DayClose>(`/reports/day-close?range=${range}&tz_offset_minutes=${tzOffsetMinutes}`), { me: { user_name: "", transactions: 0, units: 0, gross_sales: 0, discount: 0, range }, by_user: null }); } });
}
export function useInventoryUsage(range: "month" | "year" | "all") {
  return useQuery({
    queryKey: qk.inventoryUsage(range),
    queryFn: async () => {
      const fallback = localInventoryUsage(range);
      if ((await getConnectionMode()) === "offline" || !(await online())) return fallback;
      try {
        const tzOffsetMinutes = new Date().getTimezoneOffset();
        return await apiRequest<InventoryUsageRow[]>(
          `/reports/inventory-usage?range=${range}&tz_offset_minutes=${tzOffsetMinutes}`,
        );
      } catch {
        return fallback;
      }
    },
  });
}

function localInventoryUsage(range: "month" | "year" | "all"): InventoryUsageRow[] {
  const now = new Date();
  const start = range === "month"
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : range === "year"
      ? new Date(now.getFullYear(), 0, 1)
      : null;
  const products = queryClient.getQueryData<Product[]>(qk.products) ?? [];
  const sales = queryClient.getQueryData<Sale[]>(qk.sales) ?? [];
  const returns = queryClient.getQueryData<ReturnRecord[]>(qk.returns) ?? [];
  const usage = new Map<string, { name: string; quantity: number }>();

  for (const product of products) {
    usage.set(product.id, { name: product.name, quantity: 0 });
  }
  for (const sale of sales) {
    if (start && new Date(sale.created_at) < start) continue;
    for (const item of sale.items ?? []) {
      const row = usage.get(item.product_id) ?? { name: item.name, quantity: 0 };
      row.quantity += Math.max(0, Number(item.quantity ?? 0));
      usage.set(item.product_id, row);
    }
  }
  for (const ret of returns) {
    if (start && new Date(ret.created_at) < start) continue;
    for (const item of ret.items ?? []) {
      const row = usage.get(item.product_id) ?? { name: item.name, quantity: 0 };
      row.quantity -= Math.max(0, Number(item.quantity ?? 0));
      usage.set(item.product_id, row);
    }
  }

  const rows = Array.from(usage.entries()).map(([product_id, value]) => ({
    product_id,
    name: value.name,
    quantity: Math.max(0, Math.floor(value.quantity)),
    rank: 0,
    level: "Low" as const,
  }));
  const active = rows.filter(row => row.quantity > 0);
  const average = active.length
    ? active.reduce((sum, row) => sum + row.quantity, 0) / active.length
    : 0;
  rows.sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    level: row.quantity <= 0
      ? "Low"
      : average > 0 && row.quantity >= average * 1.5
        ? "High"
        : average > 0 && row.quantity <= average * 0.5
          ? "Low"
          : "Medium",
  }));
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => localOrFetch(qk.settings, () => getSettings(), { store_name: "Surgical Store", has_logo: false, logo_version: 0 }) });
}
export type { StoreSettings };
