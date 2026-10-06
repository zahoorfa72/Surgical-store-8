import { useCallback, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { BarcodeScannerModal } from "@/src/components/barcode-scanner";
import { canManageStore, useAuth } from "@/src/auth";
import { useProducts, useInventoryUsage, usePurchases, useSales, qk } from "@/src/data";
import { Product } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { Badge, Card, ConfirmModal, EmptyState, IconButton, Loader, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay, fakeUnitCost, fakeProfit } from "@/src/utils/finance-display";

const formatDetailDate = (value: string) => new Date(value).toLocaleString();

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
  const [usageRange, setUsageRange] = useState<"month" | "year" | "all">("month");
  const { data: usageAnalytics = [] } = useInventoryUsage(usageRange);
  const { data: purchases = [] } = usePurchases();
  const { data: sales = [] } = useSales();
  const [search, setSearch] = useState("");
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const [showInventoryProfitMargin, setShowInventoryProfitMargin] = useState(true);
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [detailsProduct, setDetailsProduct] = useState<Product | null>(null);

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
    return (products ?? []).filter((p) => {
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || String(p.barcode ?? "").toLowerCase().includes(q);
    });
  }, [products, search]);

  const inventoryFinance = useMemo(() => {
    const rows = products ?? [];
    const costValue = rows.reduce((n, p) => n + (p.cost_layers?.length
      ? p.cost_layers.reduce((sum, layer, index) => {
          const unit = fakeFinanceDisplay ? fakeUnitCost(Number(p.sale_price ?? 0), String(p.id) + ":lot:" + index) : Number(layer.unit_cost ?? 0);
          return sum + Number(layer.quantity ?? 0) * unit;
        }, 0)
      : Number(p.quantity ?? 0) * (fakeFinanceDisplay ? fakeUnitCost(Number(p.sale_price ?? 0), String(p.id)) : Number(p.purchase_price ?? 0))), 0);
    const retailValue = rows.reduce((n, p) => n + Number(p.quantity ?? 0) * Number(p.sale_price ?? 0), 0);
    return { costValue, retailValue, potentialProfit: retailValue - costValue };
  }, [products, fakeFinanceDisplay]);

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
          placeholder="Search name or barcode"
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
        />
        <Pressable testID="stock-barcode-scan-button" hitSlop={8} onPress={() => setScannerOpen(true)} style={styles.scanBtn}>
          <MaterialDesignIcons name="barcode-scan" size={21} color={colors.brandPrimary} />
        </Pressable>
      </View>

      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 10 }}
          ListHeaderComponent={
            <View>
                    {!isLoading && (
                      <Card style={styles.usageCard}>
                        <View style={styles.financeHead}>
                          <View>
                            <Text style={styles.financeTitle}>Inventory usage</Text>
                            <Text style={styles.financeSub}>See which products are used most, medium, or least</Text>
                          </View>
                          <MaterialDesignIcons name="chart-bar" size={22} color={colors.brandPrimary} />
                        </View>
                        <View style={styles.usageTabs}>
                          {([["month", "This month"], ["year", "This year"], ["all", "All time"]] as const).map(([key, label]) => (
                            <Pressable key={key} onPress={() => setUsageRange(key)} style={[styles.usageTab, usageRange === key && { backgroundColor: colors.brandPrimary }]}>
                              <Text style={[styles.usageTabText, usageRange === key && { color: colors.onBrandPrimary }]}>{label}</Text>
                            </Pressable>
                          ))}
                        </View>
                        {usageAnalytics.length === 0 ? (
                          <Text style={styles.usageEmpty}>No inventory items available.</Text>
                        ) : (
                          <View style={{ gap: 7 }}>
                            {usageAnalytics.slice(0, 10).map((row) => (
                              <View key={row.product_id} style={styles.usageRow}>
                                <View style={styles.usageRank}><Text style={styles.usageRankText}>{row.rank}</Text></View>
                                <View style={{ flex: 1 }}><Text style={styles.usageName} numberOfLines={1}>{row.name}</Text><Text style={styles.usageQty}>{row.quantity} units used</Text></View>
                                <Badge text={row.level} tone={row.level === "High" ? "success" : row.level === "Low" ? "warning" : "muted"} />
                              </View>
                            ))}
                            {usageAnalytics.length > 10 && <Text style={styles.usageMore}>Showing top 10. Lower-use products remain included in the calculations.</Text>}
                          </View>
                        )}
                      </Card>
                    )}
              
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
            </View>
          }
          ListHeaderComponentStyle={{ paddingBottom: 2 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          nestedScrollEnabled
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={7}
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
            const displayStockCost = item.cost_layers?.length
              ? item.cost_layers.reduce(
                  (sum, layer, index) =>
                    sum +
                    Number(layer.quantity ?? 0) *
                      (fakeFinanceDisplay
                        ? fakeUnitCost(
                            Number(item.sale_price ?? 0),
                            String(item.id) + ":lot:" + index,
                          )
                        : Number(layer.unit_cost ?? 0)),
                  0,
                )
              : Number(item.quantity ?? 0) *
                (fakeFinanceDisplay
                  ? fakeUnitCost(Number(item.sale_price ?? 0), String(item.id))
                  : Number(item.purchase_price ?? 0));
            const displayMargin = Number(item.quantity ?? 0) * Number(item.sale_price ?? 0) - displayStockCost;
            return (
              <Pressable
                testID={`product-row-${item.id}`}
                style={styles.row}
                onPress={() => setDetailsProduct(item)}
              >
                <View style={styles.rowIcon}>
                  <MaterialDesignIcons name="pill" size={22} color={colors.brandPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    Sell {money(item.sale_price)} · {item.cost_layers?.length ? "Latest buy " + money(fakeFinanceDisplay ? fakeUnitCost(Number(item.sale_price ?? 0), String(item.id) + ":latest") : Number(item.cost_layers[item.cost_layers.length - 1]?.unit_cost ?? item.purchase_price ?? 0)) : "Buy " + money(fakeFinanceDisplay ? fakeUnitCost(Number(item.sale_price ?? 0), String(item.id)) : Number(item.purchase_price ?? 0))}
                  </Text>
                  {!!item.cost_layers?.length && (
                    <View style={{ gap: 2, marginTop: 3 }}>
                      {item.cost_layers.map((layer, index) => (
                        <Text key={`${item.id}-lot-${index}`} style={styles.lotText}>
                          Lot {index + 1}: {Number(layer.quantity)} × {money(fakeFinanceDisplay ? fakeUnitCost(Number(item.sale_price ?? 0), String(item.id) + ":lot:" + index) : Number(layer.unit_cost ?? 0))}
                        </Text>
                      ))}
                    </View>
                  )}
                  {showInventoryProfitMargin && (
                    <Text style={styles.itemFinance}>
                      Stock value {money(displayStockCost)} · Margin {money(displayMargin)}
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
          <MaterialDesignIcons name="plus" size={22} color={colors.onBrandPrimary} /><Text style={styles.fabText}>Add product</Text>
        </Pressable>
      )}

      <Modal visible={!!detailsProduct} animationType="slide" onRequestClose={() => setDetailsProduct(null)}>
        <View style={styles.root}>
          <ScreenHeader title={detailsProduct?.name ?? "Product details"} subtitle="Complete stock, purchase and sales history" topInset={insets.top} onBack={() => setDetailsProduct(null)} />
          <FlatList
            data={[detailsProduct]}
            keyExtractor={(p) => p?.id ?? "details"}
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, gap: 12 }}
            renderItem={() => {
              const p = detailsProduct;
              if (!p) return null;
              const productPurchases = purchases.flatMap((purchase) => purchase.items.filter((line) => line.product_id === p.id).map((line) => ({ purchase, line })));
              const productSales = sales.flatMap((sale) => sale.items.filter((line) => line.product_id === p.id).map((line, index) => ({ sale, line, index })));
              return (
                <View style={{ gap: 12 }}>
                  <Card>
                    <Text style={styles.detailTitle}>Current stock</Text>
                    <Text style={styles.detailBig}>{Number(p.quantity ?? 0)} units</Text>
                    <Text style={styles.meta}>Sale price {money(p.sale_price)} · Latest buy {money(fakeFinanceDisplay ? fakeUnitCost(Number(p.sale_price ?? 0), String(p.id) + ":latest") : Number(p.cost_layers?.[p.cost_layers.length - 1]?.unit_cost ?? p.purchase_price ?? 0))}</Text>
                  </Card>
                  <Card>
                    <Text style={styles.detailTitle}>Purchase lots ({productPurchases.length})</Text>
                    {productPurchases.length === 0 && <Text style={styles.meta}>No purchase history found.</Text>}
                    {productPurchases.map(({ purchase, line }) => {
                      const unit = fakeFinanceDisplay ? fakeUnitCost(Number(p.sale_price ?? 0), String(purchase.id) + ":" + line.product_id) : Number(line.unit_cost ?? 0);
                      return <View key={purchase.id + ":" + line.product_id + ":" + String(line.quantity)} style={styles.detailRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailName}>{purchase.ref_no} · {line.quantity} units</Text>
                          <Text style={styles.meta}>{purchase.supplier_name} · {formatDetailDate(purchase.created_at)}</Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={styles.detailValue}>{money(unit)}/unit</Text>
                          <Text style={styles.meta}>{money(unit * Number(line.quantity ?? 0))}</Text>
                        </View>
                      </View>;
                    })}
                  </Card>
                  <Card>
                    <Text style={styles.detailTitle}>Sales history ({productSales.length})</Text>
                    {productSales.length === 0 && <Text style={styles.meta}>No sales history found.</Text>}
                    {productSales.map(({ sale, line, index }) => {
                      const qty = Number(line.quantity ?? 0);
                      const sell = Number(line.unit_price ?? 0);
                      const profit = fakeFinanceDisplay ? fakeProfit(sell, String(sale.id) + ":" + index) * qty : (sell - Number(line.purchase_price ?? 0)) * qty;
                      return <View key={sale.id + ":" + line.product_id + ":" + String(index)} style={styles.detailRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailName}>{sale.invoice_no} · {qty} units</Text>
                          <Text style={styles.meta}>{sale.customer_name || "Walk-in customer"} · {formatDetailDate(sale.created_at)}</Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={styles.detailValue}>Sell {money(sell * qty)}</Text>
                          <Text style={styles.detailProfit}>Profit {money(profit)}</Text>
                        </View>
                      </View>;
                    })}
                  </Card>
                  {staff && <Pressable testID="edit-product-from-details" style={styles.detailEditBtn} onPress={() => { const id = p.id; setDetailsProduct(null); router.push("/product-form?id=" + id); }}>
                    <MaterialDesignIcons name="pencil" size={19} color={colors.onBrandPrimary} />
                    <Text style={styles.detailEditText}>Edit product</Text>
                  </Pressable>}
                </View>
              );
            }}
          />
        </View>
      </Modal>

      <BarcodeScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(value) => {
          setSearch(value);
          setScannerOpen(false);
          const hit = (products ?? []).find((p) => String(p.barcode ?? "").trim() === String(value).trim());
          if (!hit) toast("No product matches this barcode. You can still search it manually.", "error");
        }}
      />

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
  scanBtn: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },

  usageCard: { marginHorizontal: 16, marginTop: 12, marginBottom: 2 },
  usageTabs: { flexDirection: "row", gap: 6, marginBottom: 10 },
  usageTab: { flex: 1, minHeight: 36, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  usageTabText: { fontSize: 11, fontWeight: "700", color: colors.onSurface },
  usageRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 7 },
  usageRank: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  usageRankText: { fontSize: 11, fontWeight: "800", color: colors.onSurface },
  usageName: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  usageQty: { fontSize: 11, color: colors.muted, marginTop: 2 },
  usageMore: { fontSize: 10, color: colors.muted, marginTop: 4 },
  usageEmpty: { fontSize: 12, color: colors.muted },
  financeCard: { marginHorizontal: 16, marginTop: 12, marginBottom: 2 },
  financeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  financeTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  financeSub: { fontSize: 11, color: colors.muted, marginTop: 2 },
  financeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  financeCell: { flexGrow: 1, minWidth: "30%", padding: 10, borderRadius: 10, backgroundColor: colors.surfaceTertiary },
  financeLabel: { fontSize: 11, color: colors.muted, marginBottom: 3 },
  financeValue: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  itemFinance: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 4 },
  lotText: { fontSize: 11, color: colors.muted },
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
  detailTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface, marginBottom: 5 },
  detailBig: { fontSize: 26, fontWeight: "900", color: colors.brandPrimary, marginBottom: 4 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  detailName: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  detailValue: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  detailProfit: { fontSize: 12, fontWeight: "800", color: colors.success },
  detailEditBtn: { minHeight: 48, borderRadius: 12, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  detailEditText: { color: colors.onBrandPrimary, fontWeight: "800" },
  delBtn: { padding: 4 },
  fab: {
    position: "absolute", right: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
    minHeight: 52, paddingHorizontal: 18, borderRadius: 18, backgroundColor: colors.brandPrimary,
    elevation: 4,
  },
  fabText: { color: colors.onBrandPrimary, fontSize: 14, fontWeight: "900" },
}));
