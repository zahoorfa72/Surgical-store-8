import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { StorageAccessFramework } from "expo-file-system/legacy";
import { dehydrate, hydrate } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { queryClient } from "@/src/query-client";
import { storage } from "@/src/utils/storage";
import { useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const PREFIX = "ssm.";
const BACKUP_VERSION = 2;
const AUTO_BACKUP_KEY = "ssm.auto-backup.v2";

type BackupPayload = {
  app: "surgical-store";
  backup_version: number;
  created_at: string;
  storage: Record<string, string>;
};

async function makeBackup(): Promise<string> {
  // Capture the live React Query cache immediately so a very recent offline
  // change is included even if the normal 800 ms cache-persistence debounce
  // has not fired yet.
  const liveCache = dehydrate(queryClient, {
    shouldDehydrateQuery: (q) => q.state.status === "success",
  });
  await AsyncStorage.setItem("ssm.qcache.v1", JSON.stringify(liveCache));

  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX));
  const pairs = await AsyncStorage.multiGet(keys);
  const storage: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (value !== null) storage[key] = value;
  }
  const payload: BackupPayload = {
    app: "surgical-store",
    backup_version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    storage,
  };
  return JSON.stringify(payload, null, 2);
}

function fileName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `SurgicalStore-Backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}.json`;
}

async function saveAutoBackupIfDue() {
  const now = new Date();
  const last = await storage.getItem<string | null>(AUTO_BACKUP_KEY, null);
  const stamp = now.toISOString().slice(0, 10);
  if (last === stamp || now.getHours() < 6) return;
  const json = await makeBackup();
  const name = fileName().replace(".json", "-AUTO.json");
  await storage.setItem(AUTO_BACKUP_KEY, stamp);
  if (Platform.OS === "android") {
    const dir = await storage.getItem<string | null>("ssm.auto-backup-dir", null);
    if (dir) {
      const uri = await StorageAccessFramework.createFileAsync(dir, name, "application/json");
      await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
    } else {
      const localUri = FileSystem.documentDirectory + name;
      await FileSystem.writeAsStringAsync(localUri, json, { encoding: FileSystem.EncodingType.UTF8 });
    }
  } else {
    const localUri = FileSystem.documentDirectory + name;
    await FileSystem.writeAsStringAsync(localUri, json, { encoding: FileSystem.EncodingType.UTF8 });
  }
}

export default function BackupRestore() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Android background execution cannot be guaranteed by a normal JS timer.
    // We therefore run the automatic backup when the app is opened/resumed
    // after 06:00, and reuse the last selected backup folder when available.
    saveAutoBackupIfDue().catch(() => {});
  }, []);

  const exportBackup = async (directoryUri?: string) => {
    setBusy(true);
    try {
      const json = await makeBackup();
      const name = fileName();

      if (Platform.OS === "android") {
        const dir = directoryUri ?? await storage.getItem<string | null>("ssm.auto-backup-dir", null);
        if (dir) {
          const uri = await StorageAccessFramework.createFileAsync(dir, name, "application/json");
          await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
          toast("Backup saved to the selected folder", "success");
          return;
        }
        const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permission.granted) return;
        await storage.setItem("ssm.auto-backup-dir", permission.directoryUri);
        const uri = await StorageAccessFramework.createFileAsync(permission.directoryUri, name, "application/json");
        await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
        toast("Backup saved to the selected folder", "success");
        return;
      }

      // iOS/web fallback: create a local file and open the normal share/save sheet.
      const localUri = FileSystem.documentDirectory + name;
      await FileSystem.writeAsStringAsync(localUri, json, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri, { mimeType: "application/json", dialogTitle: "Save Surgical Store backup" });
      } else {
        toast("Backup created, but sharing is not available", "error");
      }
    } catch (e: any) {
      toast(e?.message || "Backup failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "text/plain", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;

      const uri = picked.assets[0]?.uri;
      if (!uri) throw new Error("No backup file was selected.");

      const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
      const payload = JSON.parse(raw) as BackupPayload;

      if (
        payload?.app !== "surgical-store" ||
        payload?.backup_version !== BACKUP_VERSION ||
        !payload?.storage ||
        typeof payload.storage !== "object"
      ) {
        throw new Error("This is not a valid Surgical Store backup.");
      }

      Alert.alert(
        "Restore backup?",
        "This will replace the current local Surgical Store data with the data in this backup. Server data is not deleted.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Restore",
            style: "destructive",
            onPress: async () => {
              try {
                const currentKeys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX));
                if (currentKeys.length) await AsyncStorage.multiRemove(currentKeys);

                const entries = Object.entries(payload.storage).filter(([key]) => key.startsWith(PREFIX));
                if (entries.length) await AsyncStorage.multiSet(entries);

                queryClient.clear();

                const cacheRaw = payload.storage["ssm.qcache.v1"];
                if (cacheRaw) {
                  try {
                    hydrate(queryClient, JSON.parse(cacheRaw));
                  } catch {
                    // A backup without a readable cache is still a valid data backup.
                  }
                }

                toast("Backup restored. Local data is ready.", "success");
                router.replace("/(tabs)");
              } catch (e: any) {
                toast(e?.message || "Restore failed", "error");
              }
            },
          },
        ],
      );
    } catch (e: any) {
      toast(e?.message || "Could not read this backup", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <MaterialDesignIcons name="arrow-left" size={24} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Backup & Restore</Text>
          <Text style={styles.subtitle}>Keep your store data safe offline</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}>
        <View style={styles.infoCard}>
          <MaterialDesignIcons name="database-lock-outline" size={28} color={colors.brandPrimary} />
          <Text style={styles.infoTitle}>Complete local backup</Text>
          <Text style={styles.infoText}>
            Saves products, sales, purchases, customers, suppliers, expenses, payments, offline pending changes,
            settings and the saved offline cache into one JSON backup file.
          </Text>
        </View>

        <Pressable
          style={[styles.action, busy && styles.disabled]}
          onPress={async () => {
            let dir: string | undefined;
            if (Platform.OS === "android") {
              const p = await StorageAccessFramework.requestDirectoryPermissionsAsync();
              if (!p.granted) return;
              dir = p.directoryUri;
              await storage.setItem("ssm.auto-backup-dir", dir);
            }
            await exportBackup(dir);
          }}
          disabled={busy}
        >
          {busy ? <ActivityIndicator color={colors.onBrandPrimary} /> : <MaterialDesignIcons name="content-save-outline" size={24} color={colors.onBrandPrimary} />}
          <View style={{ flex: 1 }}>
            <Text style={styles.actionTitle}>Backup to phone</Text>
            <Text style={styles.actionSub}>Choose a folder in the phone's file manager</Text>
          </View>
        </Pressable>

        <Pressable style={[styles.action, styles.restore, busy && styles.disabled]} onPress={restoreBackup} disabled={busy}>
          <MaterialDesignIcons name="backup-restore" size={24} color={colors.brandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.actionTitle, { color: colors.onSurface }]}>Restore backup</Text>
            <Text style={styles.actionSub}>Select a Surgical Store .json backup file</Text>
          </View>
        </Pressable>

        <Text style={styles.note}>Automatic backup checks at 6:00 AM when the app is opened/resumed. On Android, select the backup folder once above so automatic backups can be written there.
          Offline changes remain on this phone until the server is available again. Restoring a backup does not delete
          anything from the online server.
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  back: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  title: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  subtitle: { fontSize: 13, color: colors.muted, marginTop: 2 },
  infoCard: { backgroundColor: colors.brandTertiary, borderWidth: 1, borderColor: colors.brandSecondary, borderRadius: 16, padding: 16, gap: 8 },
  infoTitle: { fontSize: 16, fontWeight: "800", color: colors.onSurface },
  infoText: { fontSize: 13, lineHeight: 19, color: colors.onSurfaceSecondary },
  action: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 76, padding: 16, borderRadius: 16, backgroundColor: colors.brandPrimary },
  restore: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  actionTitle: { fontSize: 16, fontWeight: "800", color: colors.onBrandPrimary },
  actionSub: { fontSize: 12, color: colors.muted, marginTop: 3 },
  disabled: { opacity: 0.55 },
  note: { fontSize: 12, lineHeight: 18, color: colors.muted, paddingHorizontal: 4 },
}));
