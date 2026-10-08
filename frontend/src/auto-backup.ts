import AsyncStorage from "@react-native-async-storage/async-storage";
import { dehydrate } from "@tanstack/react-query";
import { storage } from "@/src/utils/storage";
import * as FileSystem from "expo-file-system/legacy";
import { hasGoogleDriveConnection, uploadBackupToGoogleDrive } from "@/src/google-drive";
import { queryClient } from "@/src/query-client";

const PREFIX = "ssm.";
const LAST_AUTO = "ssm.autoBackup.last";
const AUTO_DIR_KEY = "ssm.auto-backup-dir";
const AUTO_DIR = FileSystem.documentDirectory ? FileSystem.documentDirectory + "auto-backups/" : null;
const SESSION_KEYS = new Set(["ssm.token", "ssm.user", "ssm.vault", "ssm.connectionmode.v2"]);
const AUTO_STATUS_KEY = "ssm.auto-drive-backup-status.v1";
export type AutoBackupStatus = "idle" | "pending" | "uploading" | "backed_up";

async function writeAutoBackup() {
  if (!AUTO_DIR) return;
  await FileSystem.makeDirectoryAsync(AUTO_DIR, { intermediates: true });
  // Persist the live query cache first so the scheduled backup includes the
  // newest local payments, expenses, sales and inventory state.
  try {
    const liveCache = dehydrate(queryClient, { shouldDehydrateQuery: (q) => q.state.status === "success" });
    await AsyncStorage.setItem("ssm.qcache.v1", JSON.stringify(liveCache));
  } catch {}
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX) && !SESSION_KEYS.has(k));
  const pairs = await AsyncStorage.multiGet(keys);
  const storage: Record<string,string> = {};
  for (const [k,v] of pairs) if (v !== null) storage[k] = v;
  const d = new Date();
  const pad=(n:number)=>String(n).padStart(2,"0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-06-00`;
  const json = JSON.stringify({app:"surgical-store",backup_version:3,created_at:new Date().toISOString(),storage}, null, 2);
  const selectedDir = await storage.getItem<string | null>(AUTO_DIR_KEY, null);
  if (selectedDir) {
    try {
      const uri = await FileSystem.StorageAccessFramework.createFileAsync(selectedDir, `SurgicalStore-Auto-${stamp}.json`, "application/json");
      await FileSystem.writeAsStringAsync(uri, json, {encoding: FileSystem.EncodingType.UTF8});
    } catch {
      const file = AUTO_DIR + `SurgicalStore-Auto-${stamp}.json`;
      await FileSystem.writeAsStringAsync(file, json, {encoding: FileSystem.EncodingType.UTF8});
    }
  } else {
    const file = AUTO_DIR + `SurgicalStore-Auto-${stamp}.json`;
    await FileSystem.writeAsStringAsync(file, json, {encoding: FileSystem.EncodingType.UTF8});
  }
  try {
    if (await hasGoogleDriveConnection()) {
      await uploadBackupToGoogleDrive(json, `SurgicalStore-Auto-${stamp}.json`);
    }
  } catch (e) {
    // Local backup remains the source of truth if Drive is unavailable.
    console.warn("[backup] Google Drive upload skipped", e);
  }
  await AsyncStorage.setItem(LAST_AUTO, d.toISOString().slice(0,10));
  // Keep only the newest 7 automatic backups.
  const files = (await FileSystem.readDirectoryAsync(AUTO_DIR)).filter(x => x.endsWith(".json")).sort().reverse();
  for (const old of files.slice(7)) { try { await FileSystem.deleteAsync(AUTO_DIR + old, {idempotent:true}); } catch {} }
}

async function buildBackupJson(): Promise<string> {
  const liveCache = dehydrate(queryClient, {
    shouldDehydrateQuery: (q) => q.state.status === "success",
  });
  await AsyncStorage.setItem("ssm.qcache.v1", JSON.stringify(liveCache));
  const keys = (await AsyncStorage.getAllKeys()).filter(
    (k) => k.startsWith(PREFIX) && !SESSION_KEYS.has(k),
  );
  const pairs = await AsyncStorage.multiGet(keys);
  const saved: Record<string, string> = {};
  for (const [k, v] of pairs) if (v !== null) saved[k] = v;
  return JSON.stringify({
    app: "surgical-store",
    backup_version: 3,
    created_at: new Date().toISOString(),
    storage: saved,
  });
}

let driveTimer: ReturnType<typeof setTimeout> | null = null;
let driveUploading = false;
let driveDirty = false;
const statusListeners = new Set<(status: AutoBackupStatus) => void>();

function publishStatus(status: AutoBackupStatus) {
  void AsyncStorage.setItem(AUTO_STATUS_KEY, JSON.stringify({ status, at: new Date().toISOString() }));
  statusListeners.forEach((listener) => listener(status));
}

export function subscribeAutomaticBackupStatus(listener: (status: AutoBackupStatus) => void) {
  statusListeners.add(listener);
  void AsyncStorage.getItem(AUTO_STATUS_KEY).then((raw) => {
    try { listener((JSON.parse(raw || "{}")?.status as AutoBackupStatus) || "idle"); } catch { listener("idle"); }
  });
  return () => statusListeners.delete(listener);
}

export async function getAutomaticBackupStatus(): Promise<{ status: AutoBackupStatus; at: string | null }> {
  try {
    const raw = await AsyncStorage.getItem(AUTO_STATUS_KEY);
    const value = JSON.parse(raw || "{}");
    return { status: (value?.status as AutoBackupStatus) || "idle", at: value?.at || null };
  } catch { return { status: "idle", at: null }; }
}

async function uploadLatestToDrive() {
  if (driveUploading) return;
  driveUploading = true;
  publishStatus("uploading");
  try {
    if (!(await hasGoogleDriveConnection())) return;
    const json = await buildBackupJson();
    await uploadBackupToGoogleDrive(json, "SurgicalStore-Auto-Backup.json");
    driveDirty = false;
    publishStatus("backed_up");
  } catch {
    driveDirty = true;
    publishStatus("pending");
  } finally {
    driveUploading = false;
  }
}

export function scheduleAutomaticGoogleDriveBackup(delayMs = 1800) {
  driveDirty = true;
  publishStatus("pending");
  if (driveTimer) clearTimeout(driveTimer);
  driveTimer = setTimeout(() => {
    driveTimer = null;
    void uploadLatestToDrive();
  }, delayMs);
}

export function retryAutomaticGoogleDriveBackup() {
  if (driveDirty) scheduleAutomaticGoogleDriveBackup(500);
}

export async function runDailyAutoBackup() {
  try {
    const now = new Date();
    if (now.getHours() < 6) return;
    const today = now.toISOString().slice(0,10);
    const last = await AsyncStorage.getItem(LAST_AUTO);
    if (last === today) return;
    await writeAutoBackup();
  } catch {
    // Automatic backup must never block or crash the app.
  }
}

export function startDailyAutoBackup() {
  void runDailyAutoBackup();
  const timer = setInterval(() => void runDailyAutoBackup(), 60_000);
  return () => clearInterval(timer);
}
