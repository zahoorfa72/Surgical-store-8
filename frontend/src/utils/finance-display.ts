import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const FAKE_FINANCE_KEY = ["fake-finance-display"] as const;
export const FAKE_FINANCE_STORAGE_KEY = "ssm.fakeFinanceDisplay.v1";
const FAKE_MASK_FACTOR_KEY = "ssm.fakeFinanceMaskFactor.v1";
let privateMaskFactor = 0.825;
let privateMaskProfilePromise: Promise<void> | null = null;

async function ensurePrivateMaskProfile(): Promise<void> {
  if (!privateMaskProfilePromise) {
    privateMaskProfilePromise = (async () => {
      try {
        const factorRaw = await SecureStore.getItemAsync(FAKE_MASK_FACTOR_KEY);
        const parsedFactor = Number(factorRaw);
        if (Number.isFinite(parsedFactor) && parsedFactor >= 0.65 && parsedFactor <= 0.95) {
          privateMaskFactor = parsedFactor;
          return;
        }
        const bytes = await Crypto.getRandomBytesAsync(18);
        const random = ((bytes[0] << 8) | bytes[1]) / 65535;
        const factor = 0.68 + random * 0.25;
        await SecureStore.setItemAsync(FAKE_MASK_FACTOR_KEY, factor.toFixed(6));
        privateMaskFactor = factor;
      } catch {
        // A privacy mask must never block the POS if secure storage is unavailable.
        privateMaskFactor = 0.825;
      }
    })();
  }
  await privateMaskProfilePromise;
}
// Display-only finance masking. This file intentionally never changes stored finance values.

export async function getFakeFinanceDisplay(): Promise<boolean> {
  await ensurePrivateMaskProfile();
  try {
    return (await AsyncStorage.getItem(FAKE_FINANCE_STORAGE_KEY)) === "1";
  } catch {
    return true;
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
  // Fail closed while SecureStore and the display preference are loading; do not flash real figures.
  return data !== false;
}

export function notifyFakeFinanceDisplay(queryClient: ReturnType<typeof useQueryClient>, enabled: boolean) {
  queryClient.setQueryData(FAKE_FINANCE_KEY, enabled);
}

export function fakePurchaseTotal(
  items: Array<{ product_id?: string; quantity?: number; unit_cost?: number }>,
  _productsById: Record<string, { sale_price?: number }>,
  recordKey: string,
): number {
  // Supplier finance must use one identical display factor everywhere.
  // The real purchase lot costs remain untouched; only the displayed total is masked.
  const realTotal = items.reduce((total, item) => {
    const unitCost = Math.max(0, Number(item.unit_cost ?? 0) || 0);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    return total + quantity * unitCost;
  }, 0);
  return fakeDisplayAmount(realTotal);
}
export function fakePurchaseNetTotal(
  items: Array<{ product_id?: string; quantity?: number; unit_cost?: number }>,
  productsById: Record<string, { sale_price?: number }>,
  recordKey: string,
  refundTotal = 0,
): number {
  return Math.max(0, fakePurchaseTotal(items, productsById, recordKey) - fakeDisplayAmount(refundTotal));
}

export function fakePaymentAmount(amount: unknown, _key?: string): number {
  // Supplier payment history uses the same display factor as supplier purchases.
  return fakeDisplayAmount(amount);
}

export function fakeDisplayAmount(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount * privateMaskFactor : 0;
}

export function fakeReportRevenue(report?: { revenue?: number } | null): number {
  return fakeDisplayAmount(report?.revenue);
}

export function fakeReportProfit(report?: { gross_profit?: number } | null): number {
  // Never estimate profit from revenue or a percentage. If the recorded figure
  // is unavailable, show no synthetic profit value.
  const recordedProfit = Number(report?.gross_profit);
  return Number.isFinite(recordedProfit) ? fakeDisplayAmount(recordedProfit) : 0;
}


export function fakeReportNetProfit(report?: {
  revenue?: number;
  operating_expenses?: number;
  personal_expenses?: number;
  lost_stock_gross_profit_transfer?: number;
  lost_products_net_profit_deduction?: number;
  profit_products_net_profit_addition?: number;
  net_profit_adjustment?: number;
  net_profit?: number;
} | null): number {
  // Use the backend/offline-engine result only. Missing recorded net profit
  // must never be filled with a made-up percentage or reconstructed estimate.
  const recordedNetProfit = Number(report?.net_profit);
  return Number.isFinite(recordedNetProfit) ? fakeDisplayAmount(recordedNetProfit) : 0;
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
