import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useSales, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { Sale } from "@/src/models";
import { ConfirmModal, EmptyState, Loader, ScreenHeader, formatDateTime, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

// Shared sales/receipt list used by the Receipts tab (cashier) and the
// Sales history modal (staff). Admins get inline edit/delete.
export function SalesListView({ onBack }: { onBack?: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);

  const { data: sales, isLoading } = useSales();
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<Sale | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (sales ?? []).filter(
      (s) =>
        !q ||
        s.invoice_no.toLowerCase().includes(q) ||
        s.customer_name.toLowerCase().includes(q)
    );
  }, [sales, search]);

  const doDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await apiRequest(`/sales/${toDelete.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk.sales });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      toast("Sale deleted & stock restored", "success");
    } catch (e: any) {
      toast(e?.message || "Could not delete sale", "error");
    } finally {
      setBusy(false);
      setToDelete(null);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Receipts"
        subtitle="Tap any sale to view or reprint"
        topInset={insets.top}
        onBack={onBack}
        showStatus={!onBack}
      />
      <View style={styles.searchWrap}>
        <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
        <TextInput
          testID="receipt-search-input"
          style={styles.searchInput}
          placeholder="Search invoice or customer"
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}
          ListEmptyComponent={
            <EmptyState
              icon="receipt-text-outline"
              title="No sales yet"
              message="Completed sales will appear here for reprinting."
              testID="receipts-empty"
            />
          }
          renderItem={({ item }) => {
            const canModify = admin;
            return (
              <Pressable
                testID={`receipt-row-${item.id}`}
                style={styles.row}
                onPress={() => router.push(`/receipt?id=${item.id}`)}
              >
                <View style={styles.rowIcon}>
                  <MaterialDesignIcons name="receipt" size={22} color={colors.brandPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.invLine}>
                    <Text style={styles.invoice}>{item.invoice_no}</Text>
                    {item.pending && (
                      <View style={styles.pendingTag}>
                        <MaterialDesignIcons name="cloud-off-outline" size={11} color={colors.warning} />
                        <Text style={styles.pendingText}>Pending</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.meta}>
                    {item.customer_name} · {formatDateTime(item.created_at)}
                  </Text>
                  <Text style={styles.sub}>
                    {item.items.length} item(s) · by {item.cashier_name}
                  </Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.total}>{money(item.total)}</Text>
                  {canModify ? (
                    <View style={styles.actions}>
                      <Pressable
                        testID={`return-sale-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => router.push(`/return-form?sale_id=${item.id}`)}
                      >
                        <MaterialDesignIcons name="undo-variant" size={18} color={colors.error} />
                      </Pressable>
                      <Pressable
                        testID={`edit-sale-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => router.push(`/sale-edit?id=${item.id}`)}
                      >
                        <MaterialDesignIcons name="pencil" size={18} color={colors.brandPrimary} />
                      </Pressable>
                      <Pressable
                        testID={`delete-sale-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => setToDelete(item)}
                      >
                        <MaterialDesignIcons name="trash-can-outline" size={18} color={colors.error} />
                      </Pressable>
                    </View>
                  ) : (
                    <MaterialDesignIcons name="chevron-right" size={22} color={colors.muted} />
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <ConfirmModal
        visible={!!toDelete}
        title="Delete sale?"
        message={`This removes ${toDelete?.invoice_no ?? ""} and restores its stock. This cannot be undone.`}
        confirmLabel={busy ? "Deleting…" : "Delete"}
        onConfirm={doDelete}
        onCancel={() => setToDelete(null)}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.onSurface },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  invLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  invoice: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  pendingTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.warning + "22",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pendingText: { fontSize: 10, fontWeight: "700", color: colors.warning },
  meta: { fontSize: 13, color: colors.onSurfaceSecondary, marginTop: 2 },
  sub: { fontSize: 12, color: colors.muted, marginTop: 1 },
  rowRight: { alignItems: "flex-end", gap: 6 },
  total: { fontSize: 16, fontWeight: "800", color: colors.brandPrimary },
  actions: { flexDirection: "row", gap: 6 },
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceTertiary,
  },
}));
