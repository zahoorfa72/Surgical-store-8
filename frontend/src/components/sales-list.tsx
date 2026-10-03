import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useSales, useReturns, qk } from "@/src/data";
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
  const cashier = user?.role === "cashier";

  const { data: sales, isLoading } = useSales();
  const { data: returns } = useReturns();
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [toDelete, setToDelete] = useState<Sale | null>(null);
  const [busy, setBusy] = useState(false);

  // Total refunded per sale, computed from the returns cache so the figure is
  // identical offline and online (the /sales list endpoint omits returns).
  const refundBySale = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of returns ?? []) {
      if (!r.sale_id) continue;
      m[r.sale_id] = (m[r.sale_id] ?? 0) + Number(r.refund_total ?? 0);
    }
    return m;
  }, [returns]);

  const refundProfitBySale = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of returns ?? []) {
      if (!r.sale_id) continue;
      m[r.sale_id] = (m[r.sale_id] ?? 0) + Number(r.refund_profit ?? 0);
    }
    return m;
  }, [returns]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const d = date.trim();
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(d);
    const localDate = (iso: string) => { const x = new Date(iso); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };
    return (sales ?? []).filter((s) => {
      const matchesSearch = !q || s.invoice_no.toLowerCase().includes(q) || s.customer_name.toLowerCase().includes(q);
      const matchesDate = !validDate || localDate(String(s.created_at ?? "")) === d;
      return matchesSearch && matchesDate;
    });
  }, [sales, search, date]);

  const doDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await apiRequest(`/sales/${toDelete.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk.sales });
      await queryClient.invalidateQueries({ queryKey: qk.returns });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      await queryClient.invalidateQueries({ queryKey: qk.parties("customer") });
      await queryClient.invalidateQueries({ queryKey: ["report"] });
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
      await queryClient.invalidateQueries({ queryKey: ["day-close"] });
      await queryClient.invalidateQueries({ queryKey: qk.payments() });
      toast("Sale deleted — its returns & finance updated", "success");
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
      <View style={styles.dateWrap}>
        <MaterialDesignIcons name="calendar" size={20} color={colors.muted} />
        <TextInput
          testID="receipt-date-input"
          style={styles.searchInput}
          placeholder="Exact date: YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
        />
        {!!date && <Pressable onPress={() => setDate("")}><Text style={styles.clearDate}>Clear</Text></Pressable>}
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
            const canModify = admin || (cashier && item.cashier_id === user?.id);
            const refunded = refundBySale[item.id] ?? 0;
            const refundedProfit = refundProfitBySale[item.id] ?? 0;
            const net = Math.max(0, Number(item.total ?? 0) - refunded);
            const saleProfit = Number(item.profit ?? 0) - refundedProfit;
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
                    {refunded > 0 && (
                      <View style={styles.returnedTag} testID={`sale-returned-tag-${item.id}`}>
                        <MaterialDesignIcons name="cash-refund" size={11} color={colors.error} />
                        <Text style={styles.returnedText}>Refunded</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.meta}>
                    {item.customer_name} · {formatDateTime(item.created_at)}
                  </Text>
                  <Text style={styles.sub}>
                    {item.items.length} item(s) · by {item.cashier_name}
                  </Text>
                  <Text style={styles.finance}>
                    Discount {money(item.discount ?? 0)} · Profit {money(saleProfit)}
                  </Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.total} testID={`sale-net-${item.id}`}>{money(net)}</Text>
                  {refunded > 0 && (
                    <View style={styles.refundLine} testID={`sale-refund-info-${item.id}`}>
                      <Text style={styles.origStruck}>{money(item.total)}</Text>
                      <Text style={styles.refundAmt}>-{money(refunded)}</Text>
                    </View>
                  )}
                  {canModify ? (
                    <View style={styles.actions}>
                      {(!cashier || item.cashier_id === user?.id) && <Pressable
                        testID={`return-sale-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => router.push(`/return-form?sale_id=${item.id}`)}
                      >
                        <MaterialDesignIcons name="undo-variant" size={18} color={colors.error} />
                      </Pressable>}
                      <Pressable
                        testID={`edit-sale-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => router.push(`/sale-edit?id=${item.id}`)}
                      >
                        <MaterialDesignIcons name="pencil" size={18} color={colors.brandPrimary} />
                      </Pressable>
                      {admin && <Pressable
                        testID={`delete-sale-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => setToDelete(item)}
                      >
                        <MaterialDesignIcons name="trash-can-outline" size={18} color={colors.error} />
                      </Pressable>}
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
        message={`This removes ${toDelete?.invoice_no ?? ""}, any returns/refunds linked to it, and restores stock. This cannot be undone.`}
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
  dateWrap: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 14, height: 44, borderRadius: 12, backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border },
  clearDate: { color: colors.brandPrimary, fontWeight: "800", fontSize: 13 },
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
  finance: { fontSize: 12, color: colors.onSurfaceSecondary, marginTop: 3, fontWeight: "600" },
  rowRight: { alignItems: "flex-end", gap: 6 },
  total: { fontSize: 16, fontWeight: "800", color: colors.brandPrimary },
  refundLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  origStruck: { fontSize: 12, color: colors.muted, textDecorationLine: "line-through" },
  refundAmt: { fontSize: 12, fontWeight: "800", color: colors.error },
  returnedTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.error + "18",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  returnedText: { fontSize: 10, fontWeight: "700", color: colors.error },
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
