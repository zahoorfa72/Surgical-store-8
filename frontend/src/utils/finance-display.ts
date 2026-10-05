import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const FAKE_FINANCE_KEY = ["fake-finance-display"] as const;
export const FAKE_FINANCE_STORAGE_KEY = "ssm.fakeFinanceDisplay.v1";

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
  productsById: Record<string, { sale_price?: number }>,
  recordKey: string,
): number {
  return items.reduce((total, item, index) => {
    const product = item.product_id ? productsById[item.product_id] : undefined;
    const salePrice = Number(product?.sale_price ?? 0);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    return total + quantity * fakeUnitCost(salePrice, recordKey + ":" + index);
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

export function fakeReportProfit(report: { revenue?: number }): number {
  return Math.max(0, Number(report.revenue) || 0) * 0.175;
}

export function fakeReportNetProfit(report: {
  revenue?: number;
  operating_expenses?: number;
  personal_expenses?: number;
}): number {
  const gross = fakeReportProfit(report);
  const expenses = Math.max(0, Number(report.operating_expenses) || 0)
    + Math.max(0, Number(report.personal_expenses) || 0);
  return gross - expenses;
}
