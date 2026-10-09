import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import { getTrashEntries, removeTrashEntry, TrashEntry } from "@/src/trash";
import { apiRequest } from "@/src/api";
import { ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function TrashScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => setEntries(await getTrashEntries()), []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const restore = (entry: TrashEntry) => {
    Alert.alert("Restore entry?", `Restore “${entry.label}” from Trash?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Restore", onPress: () => { void (async () => {
        setBusyId(entry.id);
        try {
          const record = { ...entry.record };
          delete record.pending;
          await apiRequest(entry.path, { method: "POST", body: record });
          await removeTrashEntry(entry.id);
          await refresh();
          toast("Entry restored. Check the original list to confirm it appears correctly.", "success");
        } catch (e: any) {
          toast(e?.message || "Could not restore entry", "error");
        } finally { setBusyId(null); }
      })(); } },
    ]);
  };

  const permanentlyDelete = (entry: TrashEntry) => {
    Alert.alert("Delete permanently?", `“${entry.label}” cannot be restored after this.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete forever", style: "destructive", onPress: () => { void (async () => {
        await removeTrashEntry(entry.id);
        await refresh();
        toast("Removed from Trash", "success");
      })(); } },
    ]);
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Trash" subtitle="Deleted entries are kept for 30 days" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 28, gap: 12 }}>
        <View style={styles.note}>
          <MaterialDesignIcons name="information-outline" size={20} color={colors.brandPrimary} />
          <Text style={styles.noteText}>Entries expire automatically after 30 days. Trash is included in local data backups when saved in app storage.</Text>
        </View>
        {entries.length === 0 ? (
          <View style={styles.empty}><MaterialDesignIcons name="delete-empty-outline" size={36} color={colors.muted} /><Text style={styles.emptyText}>Trash is empty</Text></View>
        ) : entries.map((entry) => (
          <View key={entry.id} style={styles.card}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.title}>{entry.label}</Text>
              <Text style={styles.meta}>{entry.path.replace(/^\//, "")} · Deleted {new Date(entry.deletedAt).toLocaleDateString()}</Text>
              <Text style={styles.meta}>Expires {new Date(entry.expiresAt).toLocaleDateString()}</Text>
            </View>
            <View style={styles.actions}>
              <Pressable disabled={busyId === entry.id} style={[styles.action, { backgroundColor: colors.brandPrimary }]} onPress={() => restore(entry)}>
                <MaterialDesignIcons name="restore" size={18} color={colors.onBrandPrimary} /><Text style={styles.actionText}>Restore</Text>
              </Pressable>
              <Pressable style={[styles.action, { backgroundColor: colors.error }]} onPress={() => permanentlyDelete(entry)}>
                <MaterialDesignIcons name="delete-forever-outline" size={18} color="#FFFFFF" /><Text style={styles.actionText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  note: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.brandTertiary, padding: 12, borderRadius: 12 },
  noteText: { flex: 1, fontSize: 12, lineHeight: 18, color: colors.onSurface },
  empty: { alignItems: "center", gap: 8, padding: 40 },
  emptyText: { color: colors.muted, fontSize: 15, fontWeight: "700" },
  card: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surfaceSecondary },
  title: { color: colors.onSurface, fontSize: 14, fontWeight: "800" },
  meta: { color: colors.muted, fontSize: 11 },
  actions: { gap: 6 },
  action: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 8 },
  actionText: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
}));
