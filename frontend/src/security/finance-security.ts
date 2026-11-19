import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { DeviceEventEmitter } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const PIN_HASH_KEY = "ssm.security.adminPinHash.v1";
const PIN_SALT_KEY = "ssm.security.adminPinSalt.v1";
const BIOMETRIC_FLAG_KEY = "ssm.security.biometricEnabled.v1";
const BIOMETRIC_SECRET_KEY = "ssm.security.biometricGate.v1";
const GROSS_HIDDEN_KEY = "ssm.privacy.grossProfitHidden.v1";
const NET_HIDDEN_KEY = "ssm.privacy.netProfitHidden.v1";

export type ProfitVisibility = { grossHidden: boolean; netHidden: boolean };
export const PROFIT_VISIBILITY_QUERY_KEY = ["profit-visibility"] as const;

const validPin = (pin: string) => /^\d{6}$/.test(pin);

async function pinDigest(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `surgical-store-admin-pin:v1:${salt}:${pin}`,
  );
}

export async function isAdminPinConfigured(): Promise<boolean> {
  try { return !!(await SecureStore.getItemAsync(PIN_HASH_KEY)); } catch { return false; }
}

export async function setAdminPin(pin: string): Promise<void> {
  if (!validPin(pin)) throw new Error("PIN must contain exactly 6 digits.");
  const salt = Crypto.randomUUID();
  const digest = await pinDigest(pin, salt);
  await SecureStore.setItemAsync(PIN_SALT_KEY, salt);
  await SecureStore.setItemAsync(PIN_HASH_KEY, digest);
  DeviceEventEmitter.emit("ssm.admin-pin-configured", true);
}

export async function verifyAdminPin(pin: string): Promise<boolean> {
  if (!validPin(pin)) return false;
  try {
    const [salt, stored] = await Promise.all([
      SecureStore.getItemAsync(PIN_SALT_KEY),
      SecureStore.getItemAsync(PIN_HASH_KEY),
    ]);
    if (!salt || !stored) return false;
    const actual = await pinDigest(pin, salt);
    if (actual.length !== stored.length) return false;
    let difference = 0;
    for (let i = 0; i < actual.length; i += 1) difference |= actual.charCodeAt(i) ^ stored.charCodeAt(i);
    return difference === 0;
  } catch {
    return false;
  }
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(BIOMETRIC_FLAG_KEY)) === "1"; } catch { return false; }
}

export async function enableBiometricUnlock(): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_SECRET_KEY, "surgical-store-biometric-ok", {
    requireAuthentication: true,
    authenticationPrompt: "Confirm your fingerprint to enable app unlock",
  });
  const proof = await SecureStore.getItemAsync(BIOMETRIC_SECRET_KEY, {
    requireAuthentication: true,
    authenticationPrompt: "Verify fingerprint to finish enabling app unlock",
  });
  if (proof !== "surgical-store-biometric-ok") throw new Error("Fingerprint verification did not complete.");
  await SecureStore.setItemAsync(BIOMETRIC_FLAG_KEY, "1");
}

export async function disableBiometricUnlock(): Promise<void> {
  await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_SECRET_KEY);
}

export async function authenticateWithBiometric(): Promise<boolean> {
  if (!(await isBiometricUnlockEnabled())) return false;
  const proof = await SecureStore.getItemAsync(BIOMETRIC_SECRET_KEY, {
    requireAuthentication: true,
    authenticationPrompt: "Unlock Surgical Store",
  });
  return proof === "surgical-store-biometric-ok";
}

export async function getProfitVisibility(): Promise<ProfitVisibility> {
  try {
    const [gross, net] = await Promise.all([
      SecureStore.getItemAsync(GROSS_HIDDEN_KEY),
      SecureStore.getItemAsync(NET_HIDDEN_KEY),
    ]);
    return { grossHidden: gross === "1", netHidden: net === "1" };
  } catch {
    return { grossHidden: false, netHidden: false };
  }
}

export async function setProfitHidden(kind: "gross" | "net", hidden: boolean): Promise<ProfitVisibility> {
  await SecureStore.setItemAsync(kind === "gross" ? GROSS_HIDDEN_KEY : NET_HIDDEN_KEY, hidden ? "1" : "0");
  return getProfitVisibility();
}

export function useProfitVisibility(): ProfitVisibility {
  const { data } = useQuery({
    queryKey: PROFIT_VISIBILITY_QUERY_KEY,
    queryFn: getProfitVisibility,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? { grossHidden: false, netHidden: false };
}

export async function updateProfitVisibilityCache(
  queryClient: ReturnType<typeof useQueryClient>,
  kind: "gross" | "net",
  hidden: boolean,
): Promise<void> {
  const visibility = await setProfitHidden(kind, hidden);
  queryClient.setQueryData(PROFIT_VISIBILITY_QUERY_KEY, visibility);
}
