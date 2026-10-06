import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const FAKE_FINANCE_KEY = ["fake-finance-display"] as const;
export const FAKE_FINANCE_STORAGE_KEY = "ssm.fakeFinanceDisplay.v1";
// Display-only finance masking. This file intentionally never changes stored finance values.

export async function getFakeFinanceDisplay(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(FAKE_FINANCE_STORAGE_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function setFakeFinanceDisplay(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(FAKE_FINANCE_STORAGE_KEY, enabled ? "1" : "0");
}

export function useFakeFinanceDisplay(): boolean {
  const { data } = useQuery({
    queryKey: FAKE_FINANCE_KEY,
    queryFn: getFakeFinanceDisplay,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data === true;
}

export function notifyFakeFinanceDisplay(queryClient: ReturnType<typeof useQueryClient>, enabled: boolean) {
  queryClient.setQueryData(FAKE_FINANCE_KEY, enabled);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function fakeMarginPercent(key: string): number {
  return 15 + (stableHash(key) % 6);
}

export function fakeUnitCost(salePrice: number, key: string): number {
  const sale = Math.max(0, Number(salePrice) || 0);
  return sale * (1 - fakeMarginPercent(key) / 100);
}

export function fakeProfit(salePrice: number, key: string): number {
  const sale = Math.max(0, Number(salePrice) || 0);
  return sale - fakeUnitCost(sale, key);
}

export function fakePurchaseTotal(
  items: Array<{ product_id?: string; quantity?: number; unit_cost?: number }>,
  _productsById: Record<string, { sale_price?: number }>,
  recordKey: string,
): number {
  // Fake finance is display-only. Use the REAL recorded purchase lot cost as
  // the source value, then apply one deterministic display factor. This makes
  // every receipt line, purchase receipt total, supplier subtotal and supplier
  // grand total use exactly the same calculation.
  return items.reduce((total, item, index) => {
    const realUnitCost = Math.max(0, Number(item.unit_cost ?? 0) || 0);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    return total + quantity * fakeUnitCost(realUnitCost, recordKey + ":" + index);
  }, 0);
}
export function fakeSaleProfit(sale: {
  id?: string;
  items?: Array<{ product_id?: string; quantity?: number; unit_price?: number; sale_price?: number }>;
}): number {
  return (sale.items ?? []).reduce((total, item, index) => {
    const price = Number(item.unit_price ?? item.sale_price ?? 0);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    return total + quantity * fakeProfit(price, String(sale.id ?? "sale") + ":" + index);
  }, 0);
}

export function fakeDisplayAmount(value: unknown): number {
  return Math.max(0, Number(value ?? 0) || 0) * 0.825;
}

export function fakeReportRevenue(report: { revenue?: number }): number {
  return fakeDisplayAmount(report.revenue);
}

export function fakeReportProfit(report: { revenue?: number }): number {
  return fakeReportRevenue(report) * 0.175;
}


export function fakeReportNetProfit(report: {
  revenue?: number;
  operating_expenses?: number;
  personal_expenses?: number;
}): number {
  const gross = fakeReportProfit(report);
  const expenses = fakeDisplayAmount(report.operating_expenses) + fakeDisplayAmount(report.personal_expenses);
  return gross - expenses;
}


export const HIDDEN_SUPPLIERS_KEY = "ssm.hiddenSupplierIds";
export const SECRET_CONTROLS_KEY = "ssm.secretControlsUnlocked";
export const FINANCE_DETAIL_DRILLDOWN_KEY = "ssm.financeDetailDrilldown";

export async function getHiddenSupplierIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(HIDDEN_SUPPLIERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

export async function setSupplierHidden(id: string, hidden: boolean): Promise<void> {
  const ids = new Set(await getHiddenSupplierIds());
  if (hidden) ids.add(id); else ids.delete(id);
  await AsyncStorage.setItem(HIDDEN_SUPPLIERS_KEY, JSON.stringify(Array.from(ids)));
}

export async function getSecretControlsUnlocked(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(SECRET_CONTROLS_KEY)) === "1"; } catch { return false; }
}

export async function setSecretControlsUnlocked(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(SECRET_CONTROLS_KEY, enabled ? "1" : "0");
}

export async function getFinanceDetailDrilldown(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(FINANCE_DETAIL_DRILLDOWN_KEY)) !== "0"; } catch { return true; }
}

export async function setFinanceDetailDrilldown(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(FINANCE_DETAIL_DRILLDOWN_KEY, enabled ? "1" : "0");
}
