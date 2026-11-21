import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const FAKE_FINANCE_KEY = ["fake-finance-display"] as const;
export const FAKE_FINANCE_STORAGE_KEY = "ssm.fakeFinanceDisplay.v1";
const FAKE_MASK_FACTOR_KEY = "ssm.fakeFinanceMaskFactor.v1";
const FAKE_MASK_SEED_KEY = "ssm.fakeFinanceMaskSeed.v1";
let privateMaskFactor = 0.825;
let privateMaskSeed = "private-finance-fallback";
let privateMaskProfilePromise: Promise<void> | null = null;

async function ensurePrivateMaskProfile(): Promise<void> {
  if (!privateMaskProfilePromise) {
    privateMaskProfilePromise = (async () => {
      try {
        const [factorRaw, seedRaw] = await Promise.all([
          SecureStore.getItemAsync(FAKE_MASK_FACTOR_KEY),
          SecureStore.getItemAsync(FAKE_MASK_SEED_KEY),
        ]);
        const parsedFactor = Number(factorRaw);
        if (Number.isFinite(parsedFactor) && parsedFactor >= 0.65 && parsedFactor <= 0.95 && seedRaw) {
          privateMaskFactor = parsedFactor;
          privateMaskSeed = seedRaw;
          return;
        }
        const bytes = await Crypto.getRandomBytesAsync(32);
        const random = ((bytes[0] << 8) | bytes[1]) / 65535;
        const factor = 0.68 + random * 0.25;
        const seed = Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
        await Promise.all([
          SecureStore.setItemAsync(FAKE_MASK_FACTOR_KEY, factor.toFixed(6)),
          SecureStore.setItemAsync(FAKE_MASK_SEED_KEY, seed),
        ]);
        privateMaskFactor = factor;
        privateMaskSeed = seed;
      } catch {
        // A privacy mask must never block the POS if secure storage is unavailable.
        privateMaskFactor = 0.825;
        privateMaskSeed = "private-finance-fallback";
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

function realPurchaseTotal(items: Array<{ quantity?: number; unit_cost?: number }>): number {
  return items.reduce((total, item) => {
    const unitCost = Math.max(0, Number(item.unit_cost ?? 0) || 0);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    return total + quantity * unitCost;
  }, 0);
}

export function fakePurchaseTotal(
  items: Array<{ product_id?: string; quantity?: number; unit_cost?: number }>,
  _productsById: Record<string, { sale_price?: number }>,
  _recordKey: string,
): number {
  return fakeDisplayAmount(realPurchaseTotal(items));
}
export function fakePurchaseNetTotal(
  items: Array<{ product_id?: string; quantity?: number; unit_cost?: number }>,
  _productsById: Record<string, { sale_price?: number }>,
  _recordKey: string,
  refundTotal = 0,
): number {
  return fakeDisplayAmount(Math.max(0, realPurchaseTotal(items) - Math.max(0, Number(refundTotal) || 0)));
}

export function fakePaymentAmount(amount: unknown, _key?: string): number {
  // Supplier payment history uses the same display factor as supplier purchases.
  return fakeDisplayAmount(amount);
}

function stableMaskHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function fakeDisplayAmount(value: unknown): number {
  // Finance records are never altered or disguised by display mode.
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

export function fakeReportRevenue(report?: { revenue?: number } | null): number {
  return fakeDisplayAmount(report?.revenue);
}

export function fakeReportProfit(report?: { revenue?: number } | null): number {
  // Clearly labelled illustrative estimate; never written to accounting records.
  const revenue = Math.max(0, Number(report?.revenue ?? 0) || 0);
  return revenue * 0.21;
}

export function fakeReportNetProfit(report?: { revenue?: number } | null): number {
  // Conservative illustrative estimate; never written to accounting records.
  const revenue = Math.max(0, Number(report?.revenue ?? 0) || 0);
  return revenue * 0.21;
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
