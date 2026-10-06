import { useEffect, useMemo, useState } from "react";
import { Pressable, SectionList, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { usePurchases, usePurchaseReturns, useProducts, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { Purchase } from "@/src/models";
import { ConfirmModal, EmptyState, Loader, ScreenHeader, formatDateTime, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { getHiddenSupplierIds } from "@/src/utils/finance-display";
import { useFakeFinanceDisplay, fakePurchaseTotal, fakePurchaseNetTotal } from "@/src/utils/finance-display";

export default function PurchasesHistory() {
  const styles = useStyles();
  const { colors } = useTheme();
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);

  const { data: purchases, isLoading } = usePurchases();
  const { data: products = [] } = useProducts();
  const productsById = new Map(products.map((p: any) => [String(p.id), p]));
  const { data: purchaseReturns } = usePurchaseReturns();
  const [search, setSearch] = useState("");
  const [date, setDate] = useState("");
  const [toDelete, setToDelete] = useState<Purchase | null>(null);
  const [busy, setBusy] = useState(false);
  const [hiddenSupplierIds, setHiddenSupplierIds] = useState<string[]>([]);
  useEffect(() => { void getHiddenSupplierIds().then(setHiddenSupplierIds); }, []);

  // Total refunded per purchase, from the purchase-returns cache (works both
  // offline and online — the /purchases list endpoint omits return data).
  const refundByPurchase = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of (purchaseReturns ?? []) as any[]) {
      if (!r.purchase_id) continue;
      m[r.purchase_id] = (m[r.purchase_id] ?? 0) + Number(r.refund_total ?? 0);
    }
    return m;
  }, [purchaseReturns]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const d = date.trim();
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(d);
    const localDate = (iso: string) => { const x = new Date(iso); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`; };
    return (purchases ?? []).filter((p) => {
      if (p.supplier_id && hiddenSupplierIds.includes(p.supplier_id)) return false;
      const matchesSearch = !q || p.ref_no.toLowerCase().includes(q) || p.supplier_name.toLowerCase().includes(q);
      const matchesDate = !validDate || localDate(String(p.created_at ?? "")) === d;
      return matchesSearch && matchesDate;
    });
  }, [purchases, search, date, hiddenSupplierIds]);

  // Group purchases by supplier so each supplier is shown separately, each with
  // its own net (after supplier returns) subtotal.
  const allSupplierTotal = useMemo(() => {
    return filtered.reduce((sum, p) => {
      if (fakeFinanceDisplay) {
        return sum + fakePurchaseNetTotal(p.items ?? [], Object.fromEntries(products.map((x: any) => [String(x.id), x])), String(p.id), refundByPurchase[p.id] ?? 0);
      }
      return sum + Number(p.total ?? 0);
    }, 0);
  }, [filtered, fakeFinanceDisplay, products, refundByPurchase]);

  const sections = useMemo(() => {
    const bySupplier: Record<string, Purchase[]> = {};
    for (const p of filtered) {
      const key = p.supplier_name || "—";
      (bySupplier[key] ||= []).push(p);
    }
    return Object.entries(bySupplier)
      .map(([title, data]) => {
        const gross = fakeFinanceDisplay
          ? data.reduce((s, p) => s + fakePurchaseNetTotal(
              p.items ?? [],
              Object.fromEntries(products.map((x: any) => [String(x.id), x])),
              String(p.id),
              refundByPurchase[p.id] ?? 0,
            ), 0)
          : data.reduce((s, p) => s + Number(p.total ?? 0), 0);
        const refunded = fakeFinanceDisplay ? 0 : data.reduce((s, p) => s + (refundByPurchase[p.id] ?? 0), 0);
        return { title, data, gross, refunded, net: Math.max(0, gross - refunded) };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [filtered, refundByPurchase, fakeFinanceDisplay, products]);

  const doDelete = async () => {
    if (!toDelete) return;
    setBusy(true);
    try {
      await apiRequest(`/purchases/${toDelete.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk.purchases });
      await queryClient.invalidateQueries({ queryKey: qk.purchaseReturns });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      await queryClient.invalidateQueries({ queryKey: qk.parties("supplier") });
      await queryClient.invalidateQueries({ queryKey: ["report"] });
      await queryClient.invalidateQueries({ queryKey: qk.payments() });
      toast("Purchase deleted — its returns & finance updated", "success");
    } catch (e: any) {
      toast(e?.message || "Could not delete purchase", "error");
    } finally {
      setBusy(false);
      setToDelete(null);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Purchases"
        subtitle="Restock history"
        topInset={insets.top}
        onBack={() => router.back()}
      />
      <View style={styles.searchWrap}>
        <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
        <TextInput
          testID="purchase-search-input"
          style={styles.searchInput}
          placeholder="Search ref or supplier"
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
        />
      </View>
      <View style={styles.dateWrap}>
        <MaterialDesignIcons name="calendar" size={20} color={colors.muted} />
        <TextInput
          testID="purchase-date-input"
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
        <>
        <View style={styles.allSupplierCard} testID="all-suppliers-purchase-total">
          <View style={{ flex: 1 }}>
            <Text style={styles.allSupplierLabel}>All suppliers</Text>
            <Text style={styles.allSupplierSub}>
              {date.trim() ? "Total for selected date" : "Total purchases — all time"}
            </Text>
          </View>
          <Text style={styles.allSupplierTotal}>{money(allSupplierTotal)}</Text>
        </View>
        <SectionList
          sections={sections}
          keyExtractor={(p) => p.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96, gap: 10 }}
          ListEmptyComponent={
            <EmptyState
              icon="truck-outline"
              title="No purchases yet"
              message="Restock your products and they will appear here."
              testID="purchases-empty"
            />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.supplierHeader} testID={`supplier-group-${section.title}`}>
              <View style={styles.supplierIcon}>
                <MaterialDesignIcons name="domain" size={16} color={colors.brandPrimary} />
              </View>
              <Text style={styles.supplierName} numberOfLines={1}>{section.title}</Text>
              <View style={styles.supplierTotals}>
                <Text style={styles.supplierNet} testID={`supplier-net-${section.title}`}>{money(section.net)}</Text>
                {section.refunded > 0 && (
                  <Text style={styles.supplierRefund}>refund -{money(section.refunded)}</Text>
                )}
              </View>
            </View>
          )}
          renderItem={({ item }) => {
            const canEdit = admin;
            const refunded = refundByPurchase[item.id] ?? 0;
            const realNet = Math.max(0, Number(item.total ?? 0) - refunded);
            const net = fakeFinanceDisplay
              ? fakePurchaseNetTotal(item.items ?? [], productsById, String(item.id), refunded)
              : realNet;
            return (
              <View style={styles.row} testID={`purchase-row-${item.id}`}>
                <View style={styles.rowIcon}>
                  <MaterialDesignIcons name="truck" size={22} color={colors.brandPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.refLine}>
                    <Text style={styles.ref}>{item.ref_no}</Text>
                    {item.pending && (
                      <View style={styles.pendingTag}>
                        <MaterialDesignIcons name="cloud-off-outline" size={11} color={colors.warning} />
                        <Text style={styles.pendingText}>Pending</Text>
                      </View>
                    )}
                    {!fakeFinanceDisplay && refunded > 0 && (
                      <View style={styles.returnedTag} testID={`purchase-returned-tag-${item.id}`}>
                        <MaterialDesignIcons name="undo-variant" size={11} color={colors.error} />
                        <Text style={styles.returnedText}>Returned</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.meta}>
                    {item.supplier_name} · {formatDateTime(item.created_at)}
                  </Text>
                  <Text style={styles.sub}>{item.items.length} item(s) · by {item.user_name}</Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.total} testID={`purchase-net-${item.id}`}>{money(net)}</Text>
                  {!fakeFinanceDisplay && refunded > 0 && (
                    <View style={styles.refundLine} testID={`purchase-refund-info-${item.id}`}>
                      <Text style={styles.origStruck}>{money(fakeFinanceDisplay ? fakePurchaseTotal(item.items ?? [], productsById, String(item.id)) : item.total)}</Text>
                      <Text style={styles.refundAmt}>-{money(refunded)}</Text>
                    </View>
                  )}
                  {canEdit && (
                    <View style={styles.actions}>
                      <Pressable
                        testID={`return-purchase-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => router.push(`/purchase-return-form?purchase_id=${item.id}`)}
                      >
                        <MaterialDesignIcons name="undo-variant" size={18} color={colors.error} />
                      </Pressable>
                      <Pressable
                        testID={`edit-purchase-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => router.push(`/purchase?id=${item.id}`)}
                      >
                        <MaterialDesignIcons name="pencil" size={18} color={colors.brandPrimary} />
                      </Pressable>
                      <Pressable
                        testID={`delete-purchase-${item.id}`}
                        hitSlop={8}
                        style={styles.actionBtn}
                        onPress={() => setToDelete(item)}
                      >
                        <MaterialDesignIcons name="trash-can-outline" size={18} color={colors.error} />
                      </Pressable>
                    </View>
                  )}
                </View>
              </View>
            );
          }}
        />
        </>
      )}

      <Pressable
        testID="new-purchase-button"
        style={[styles.fab, { bottom: insets.bottom + 16 }]}
        onPress={() => router.push("/purchase")}
      >
        <MaterialDesignIcons name="plus" size={22} color={colors.onBrandPrimary} />
        <Text style={styles.fabText}>New purchase</Text>
      </Pressable>

      <ConfirmModal
        visible={!!toDelete}
        title="Delete purchase?"
        message={`This removes ${toDelete?.ref_no ?? ""}, any supplier returns linked to it, and reverses stock. This cannot be undone.`}
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
  refLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  ref: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
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
  allSupplierCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginTop: 10,
  },
  allSupplierLabel: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  allSupplierSub: { fontSize: 11, color: colors.muted, marginTop: 2 },
  allSupplierTotal: { fontSize: 18, fontWeight: "900", color: colors.brandPrimary },
  supplierHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  supplierIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  supplierName: { flex: 1, fontSize: 14, fontWeight: "800", color: colors.onSurface },
  supplierTotals: { alignItems: "flex-end" },
  supplierNet: { fontSize: 15, fontWeight: "800", color: colors.brandPrimary },
  supplierRefund: { fontSize: 11, fontWeight: "700", color: colors.error, marginTop: 1 },
  actions: { flexDirection: "row", gap: 6 },
  actionBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceTertiary,
  },
  fab: {
    position: "absolute",
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    borderRadius: 16,
    paddingHorizontal: 18,
    minHeight: 52,
  },
  fabText: { color: colors.onBrandPrimary, fontSize: 15, fontWeight: "800" },
}));
