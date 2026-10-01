import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { canManageStore, useAuth } from "@/src/auth";
import { useProducts, qk } from "@/src/data";
import { Product } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { Badge, Card, ConfirmModal, EmptyState, IconButton, Loader, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function Products() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const staff = canManageStore(user?.role);

  const { data: products, isLoading } = useProducts();
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const [showInventoryProfitMargin, setShowInventoryProfitMargin] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void storage.getItem<boolean>("ssm.showInventoryProfitMargin", true).then((value) => {
        if (active) setShowInventoryProfitMargin(value !== false);
      });
      return () => { active = false; };
    }, []),
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [products, search]);

  const inventoryFinance = useMemo(() => {
    const rows = products ?? [];
    const costValue = rows.reduce((n, p) => n + Number(p.quantity ?? 0) * Number(p.purchase_price ?? 0), 0);
    const retailValue = rows.reduce((n, p) => n + Number(p.quantity ?? 0) * Number(p.sale_price ?? 0), 0);
    return { costValue, retailValue, potentialProfit: retailValue - costValue };
  }, [products]);

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await apiRequest(`/products/${toDelete.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      toast("Product removed", "success");
    } catch (e: any) {
      toast(e?.message || "Delete failed", "error");
    } finally {
      setToDelete(null);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Stock"
        subtitle={`${products?.length ?? 0} products`}
        topInset={insets.top}
        showStatus
        right={
          staff ? (
            <IconButton name="truck-plus" tone="brand" testID="restock-button" onPress={() => router.push("/purchase")} />
          ) : undefined
        }
      />

      <View style={styles.searchWrap}>
        <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
        <TextInput
          testID="stock-search-input"
          style={styles.searchInput}
          placeholder="Search products"
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {!isLoading && showInventoryProfitMargin && (
        <Card style={styles.financeCard}>
          <View style={styles.financeHead}>
            <View>
              <Text style={styles.financeTitle}>Inventory finance</Text>
              <Text style={styles.financeSub}>Current stock at buy and sell values</Text>
            </View>
            <MaterialDesignIcons name="chart-box-outline" size={22} color={colors.brandPrimary} />
          </View>
          <View style={styles.financeGrid}>
            <View style={styles.financeCell}><Text style={styles.financeLabel}>Cost value</Text><Text style={styles.financeValue}>{money(inventoryFinance.costValue)}</Text></View>
            <View style={styles.financeCell}><Text style={styles.financeLabel}>Retail value</Text><Text style={styles.financeValue}>{money(inventoryFinance.retailValue)}</Text></View>
            <View style={styles.financeCell}><Text style={styles.financeLabel}>Potential margin</Text><Text style={[styles.financeValue,{color:inventoryFinance.potentialProfit>=0?colors.success:colors.error}]}>{money(inventoryFinance.potentialProfit)}</Text></View>
          </View>
        </Card>
      )}

      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 10 }}
          ListEmptyComponent={
            <EmptyState
              icon="package-variant"
              title="No products yet"
              message={staff ? "Tap + to add your first product." : "No products available."}
              testID="products-empty"
            />
          }
          renderItem={({ item }) => {
            const low = item.quantity <= item.low_stock_threshold;
            return (
              <Pressable
                testID={`product-row-${item.id}`}
                disabled={!staff}
                style={styles.row}
                onPress={() => router.push(`/product-form?id=${item.id}`)}
              >
                <View style={styles.rowIcon}>
                  <MaterialDesignIcons name="pill" size={22} color={colors.brandPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    Buy {money(item.purchase_price)} · Sell {money(item.sale_price)}
                  </Text>
                  {showInventoryProfitMargin && (
                    <Text style={styles.itemFinance}>
                      Stock value {money(Number(item.quantity ?? 0) * Number(item.purchase_price ?? 0))} · Margin {money(Number(item.quantity ?? 0) * (Number(item.sale_price ?? 0) - Number(item.purchase_price ?? 0)))}
                    </Text>
                  )}
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.qty, low && { color: colors.warning }]}>{item.quantity}</Text>
                  {low ? <Badge text="Low" tone="warning" /> : <Text style={styles.inStock}>in stock</Text>}
                </View>
                {staff && (
                  <Pressable testID={`delete-product-${item.id}`} hitSlop={8} onPress={() => setToDelete(item)} style={styles.delBtn}>
                    <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} />
                  </Pressable>
                )}
              </Pressable>
            );
          }}
        />
      )}

      {staff && (
        <Pressable
          testID="add-product-fab"
          style={[styles.fab, { bottom: 16 }]}
          onPress={() => router.push("/product-form")}
        >
          <MaterialDesignIcons name="plus" size={28} color={colors.onBrandPrimary} />
        </Pressable>
      )}

      <ConfirmModal
        visible={!!toDelete}
        title="Remove product?"
        message={`"${toDelete?.name}" will be removed from stock. This can be restored by support if needed.`}
        confirmLabel="Remove"
        onConfirm={confirmDelete}
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
  financeCard: { marginHorizontal: 16, marginTop: 12, marginBottom: 2 },
  financeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  financeTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  financeSub: { fontSize: 11, color: colors.muted, marginTop: 2 },
  financeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  financeCell: { flexGrow: 1, minWidth: "30%", padding: 10, borderRadius: 10, backgroundColor: colors.surfaceTertiary },
  financeLabel: { fontSize: 11, color: colors.muted, marginBottom: 3 },
  financeValue: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  itemFinance: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 4 },
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
  name: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  rowRight: { alignItems: "flex-end", gap: 2, minWidth: 54 },
  qty: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  inStock: { fontSize: 11, color: colors.muted },
  delBtn: { padding: 4 },
  fab: {
    position: "absolute",
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
}));
