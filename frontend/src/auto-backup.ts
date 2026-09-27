import AsyncStorage from "@react-native-async-storage/async-storage";
import { storage } from "@/src/utils/storage";
import * as FileSystem from "expo-file-system/legacy";
import { StorageAccessFramework } from "expo-file-system/legacy";
import { dehydrate } from "@tanstack/react-query";
import { queryClient } from "@/src/query-client";

const PREFIX = "ssm.";
const LAST_AUTO = "ssm.autoBackup.last";
const AUTO_DIR_KEY = "ssm.auto-backup-dir";
const AUTO_DIR = FileSystem.documentDirectory ? FileSystem.documentDirectory + "auto-backups/" : null;

async function writeAutoBackup() {
  if (!AUTO_DIR) return;
  await FileSystem.makeDirectoryAsync(AUTO_DIR, { intermediates: true });
  const liveCache = dehydrate(queryClient, { shouldDehydrateQuery: (q) => q.state.status === "success" });
  await AsyncStorage.setItem("ssm.qcache.v1", JSON.stringify(liveCache));
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
  const pairs = await AsyncStorage.multiGet(keys);
  const storage: Record<string,string> = {};
  for (const [k,v] of pairs) if (v !== null) storage[k] = v;
  const d = new Date();
  const pad=(n:number)=>String(n).padStart(2,"0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-06-00`;
  const json = JSON.stringify({app:"surgical-store",backup_version:2,created_at:new Date().toISOString(),storage}, null, 2);
  const selectedDir = await storage.getItem<string | null>(AUTO_DIR_KEY, null);
  if (selectedDir) {
    try {
      const uri = await StorageAccessFramework.createFileAsync(selectedDir, `SurgicalStore-Auto-${stamp}.json`, "application/json");
      await FileSystem.writeAsStringAsync(uri, json, {encoding: FileSystem.EncodingType.UTF8});
    } catch {
      const file = AUTO_DIR + `SurgicalStore-Auto-${stamp}.json`;
      await FileSystem.writeAsStringAsync(file, json, {encoding: FileSystem.EncodingType.UTF8});
    }
  } else {
    const file = AUTO_DIR + `SurgicalStore-Auto-${stamp}.json`;
    await FileSystem.writeAsStringAsync(file, json, {encoding: FileSystem.EncodingType.UTF8});
  }
  await AsyncStorage.setItem(LAST_AUTO, d.toISOString().slice(0,10));
  // Keep only the newest 7 automatic backups.
  const files = (await FileSystem.readDirectoryAsync(AUTO_DIR)).filter(x => x.endsWith(".json")).sort().reverse();
  for (const old of files.slice(7)) { try { await FileSystem.deleteAsync(AUTO_DIR + old, {idempotent:true}); } catch {} }
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
