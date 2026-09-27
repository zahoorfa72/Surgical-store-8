import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { dehydrate, hydrate } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { queryClient } from "@/src/query-client";
import { storage } from "@/src/utils/storage";
import { useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import * as AuthSession from "expo-auth-session";
import { useAuthRequest, ResponseType } from "expo-auth-session";
import { hasGoogleDriveConnection, saveGoogleDriveToken, clearGoogleDriveConnection, googleDriveClientId, googleDriveRedirectUri, GOOGLE_DRIVE_SCOPE, uploadBackupToGoogleDrive, listGoogleDriveBackups, downloadGoogleDriveBackup, setGoogleDriveClientId, clearGoogleDriveClientId, getStoredGoogleDriveClientId } from "@/src/google-drive";

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
      const uri = await FileSystem.StorageAccessFramework.createFileAsync(dir, name, "application/json");
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
  const [driveConnected, setDriveConnected] = useState(false);
  const [manualClientId, setManualClientId] = useState("");
  const [showClientIdForm, setShowClientIdForm] = useState(false);
  const [clientId, setClientId] = useState<string | null>(googleDriveClientId());
  const redirectUri = googleDriveRedirectUri();
  const [request, response, promptAsync] = useAuthRequest({
    clientId: clientId ?? "missing-client-id",
    responseType: ResponseType.Code,
    scopes: [GOOGLE_DRIVE_SCOPE],
    redirectUri,
    usePKCE: true,
    extraParams: { access_type: "offline", prompt: "consent" },
  }, { authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", tokenEndpoint: "https://oauth2.googleapis.com/token" });

  useEffect(() => {
    Promise.all([hasGoogleDriveConnection(), getStoredGoogleDriveClientId()]).then(([connected, storedId]) => {
      setDriveConnected(connected);
      if (!clientId && storedId) setClientId(storedId);
      if (storedId) setManualClientId(storedId);
    }).catch(() => setDriveConnected(false));
  }, []);

  useEffect(() => {
    if (response?.type !== "success") return;
    (async () => {
      try {
        const code = response.params?.code;
        if (!code || !clientId || !request?.codeVerifier) throw new Error("Google Drive authorization was incomplete.");
        const token = await AuthSession.exchangeCodeAsync({
          clientId,
          code,
          redirectUri,
          extraParams: { code_verifier: request.codeVerifier },
        }, { tokenEndpoint: "https://oauth2.googleapis.com/token" });
        await saveGoogleDriveToken({ accessToken: token.accessToken, refreshToken: token.refreshToken ?? undefined, expiresIn: token.expiresIn, issuedAt: token.issuedAt, tokenType: token.tokenType });
        setDriveConnected(true);
        toast("Google Drive connected. Automatic backups will also upload there.", "success");
      } catch (e: any) { toast(e?.message || "Google Drive connection failed", "error"); }
    })();
  }, [response]);

  useEffect(() => {
    // Android background execution cannot be guaranteed by a normal JS timer.
    // We therefore run the automatic backup when the app is opened/resumed
    // after 06:00, and reuse the last selected backup folder when available.
    saveAutoBackupIfDue().catch(() => {});
  }, []);

  const uploadCurrentBackupToDrive = async () => {
    setBusy(true);
    try {
      const json = await makeBackup();
      await uploadBackupToGoogleDrive(json, fileName());
      toast("Backup uploaded to Google Drive", "success");
    } catch (e: any) { toast(e?.message || "Google Drive upload failed", "error"); }
    finally { setBusy(false); }
  };

  const exportBackup = async (directoryUri?: string) => {
    setBusy(true);
    try {
      const json = await makeBackup();
      const name = fileName();

      if (Platform.OS === "android") {
        const dir = directoryUri ?? await storage.getItem<string | null>("ssm.auto-backup-dir", null);
        if (dir) {
          const uri = await FileSystem.StorageAccessFramework.createFileAsync(dir, name, "application/json");
          await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
          toast("Backup saved to the selected folder", "success");
          return;
        }
        const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permission.granted) return;
        await storage.setItem("ssm.auto-backup-dir", permission.directoryUri);
        const uri = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, name, "application/json");
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

  const applyBackupPayload = async (payload: BackupPayload) => {
    const currentKeys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX));
    if (currentKeys.length) await AsyncStorage.multiRemove(currentKeys);
    const entries = Object.entries(payload.storage).filter(([key]) => key.startsWith(PREFIX));
    if (entries.length) await AsyncStorage.multiSet(entries);
    queryClient.clear();
    const cacheRaw = payload.storage["ssm.qcache.v1"];
    if (cacheRaw) { try { hydrate(queryClient, JSON.parse(cacheRaw)); } catch {} }
  };

  const restoreGoogleDriveBackup = async () => {
    setBusy(true);
    try {
      const files = await listGoogleDriveBackups();
      if (!files[0]) throw new Error("No Surgical Store backup was found in Google Drive.");
      const raw = await downloadGoogleDriveBackup(files[0].id);
      const payload = JSON.parse(raw) as BackupPayload;
      if (payload?.app !== "surgical-store" || payload?.backup_version !== BACKUP_VERSION || !payload?.storage || typeof payload.storage !== "object") {
        throw new Error("The Google Drive file is not a valid Surgical Store backup.");
      }
      const safety = await makeBackup();
      if (Platform.OS === "android") {
        const dir = await storage.getItem<string | null>("ssm.auto-backup-dir", null);
        if (dir) {
          const uri = await FileSystem.StorageAccessFramework.createFileAsync(dir, `SurgicalStore-Before-Restore-${Date.now()}.json`, "application/json");
          await FileSystem.writeAsStringAsync(uri, safety, { encoding: FileSystem.EncodingType.UTF8 });
        }
      }
      await applyBackupPayload(payload);
      toast("Latest Google Drive backup restored.", "success");
      router.replace("/(tabs)");
    } catch (e: any) {
      toast(e?.message || "Google Drive restore failed", "error");
    } finally { setBusy(false); }
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
      if (payload?.app !== "surgical-store" || payload?.backup_version !== BACKUP_VERSION || !payload?.storage || typeof payload.storage !== "object") {
        throw new Error("This is not a valid Surgical Store backup.");
      }
      Alert.alert("Restore backup?", "A safety copy will be created before local data is replaced.", [
        { text: "Cancel", style: "cancel" },
        { text: "Restore", style: "destructive", onPress: async () => {
          try {
            const safety = await makeBackup();
            if (Platform.OS === "android") {
              const dir = await storage.getItem<string | null>("ssm.auto-backup-dir", null);
              if (dir) {
                const uri2 = await FileSystem.StorageAccessFramework.createFileAsync(dir, `SurgicalStore-Before-Restore-${Date.now()}.json`, "application/json");
                await FileSystem.writeAsStringAsync(uri2, safety, { encoding: FileSystem.EncodingType.UTF8 });
              }
            }
            await applyBackupPayload(payload);
            toast("Backup restored. Local data is ready.", "success");
            router.replace("/(tabs)");
          } catch (e: any) { toast(e?.message || "Restore failed", "error"); }
        }},
      ]);
    } catch (e: any) { toast(e?.message || "Could not read this backup", "error"); }
    finally { setBusy(false); }
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
              const p = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
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

                <View style={styles.driveCard}>
          <MaterialDesignIcons name="google-drive" size={28} color={colors.brandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.actionTitle}>Google Drive backup</Text>
            <Text style={styles.driveStatus}>{driveConnected ? "Connected — automatic backup will upload to Drive" : "Not connected"}</Text>
          </View>
        </View>
        {!driveConnected ? (
          <>
            <View style={styles.clientIdBox}>
              <Text style={styles.clientIdLabel}>Google OAuth Client ID</Text>
              <TextInput value={manualClientId} onChangeText={setManualClientId} placeholder="Paste your Google OAuth Client ID" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={styles.clientIdInput} />
              <Pressable style={[styles.action, styles.restore, (!manualClientId.trim() || busy) && styles.disabled]} disabled={!manualClientId.trim() || busy} onPress={async () => {
                try {
                  const id = manualClientId.trim();
                  await setGoogleDriveClientId(id);
                  setClientId(id);
                  toast("Google OAuth Client ID saved on this phone. Tap Connect Google Drive.", "success");
                } catch (e: any) { toast(e?.message || "Could not save Client ID", "error"); }
              }}>
                <MaterialDesignIcons name="content-save-outline" size={24} color={colors.brandPrimary} />
                <View style={{ flex: 1 }}><Text style={[styles.actionTitle, { color: colors.onSurface }]}>Save Client ID</Text><Text style={styles.actionSub}>Stored locally on this phone</Text></View>
              </Pressable>
            </View>
            <Pressable style={[styles.action, styles.restore, (!request || !clientId || busy) && styles.disabled]} onPress={() => promptAsync()} disabled={!request || !clientId || busy}>
              <MaterialDesignIcons name="google-drive" size={24} color={colors.brandPrimary} />
              <View style={{ flex: 1 }}><Text style={[styles.actionTitle, { color: colors.onSurface }]}>Connect Google Drive</Text><Text style={styles.actionSub}>{clientId ? "Sign in with your Google account" : "Save the Client ID first"}</Text></View>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable style={[styles.action, styles.restore, busy && styles.disabled]} onPress={uploadCurrentBackupToDrive} disabled={busy}>
              <MaterialDesignIcons name="cloud-upload-outline" size={24} color={colors.brandPrimary} />
              <View style={{ flex: 1 }}><Text style={[styles.actionTitle, { color: colors.onSurface }]}>Backup now to Google Drive</Text><Text style={styles.actionSub}>Creates a separate timestamped cloud backup</Text></View>
            </Pressable>
            <Pressable style={[styles.linkButton, busy && styles.disabled]} onPress={async () => { await clearGoogleDriveConnection(); setDriveConnected(false); toast("Google Drive disconnected", "success"); }} disabled={busy}><Text style={styles.linkText}>Disconnect Google Drive</Text></Pressable>
          </>
        )}

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
  driveCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 16, backgroundColor: colors.brandTertiary, borderWidth: 1, borderColor: colors.brandSecondary },
  driveStatus: { fontSize: 12, color: colors.muted, marginTop: 3 },
  linkButton: { alignItems: "center", paddingVertical: 10 },
  linkText: { color: colors.error, fontSize: 13, fontWeight: "700" },
  clientIdBox: { gap: 10, padding: 14, borderRadius: 16, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  clientIdLabel: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  clientIdInput: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, color: colors.onSurface, backgroundColor: colors.surface },
  note: { fontSize: 12, lineHeight: 18, color: colors.muted, paddingHorizontal: 4 },
}));
