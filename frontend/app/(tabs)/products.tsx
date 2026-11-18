import { useCallback, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { BarcodeScannerModal } from "@/src/components/barcode-scanner";
import { canManageStore, useAuth } from "@/src/auth";
import { useProducts, useInventoryUsage, usePurchases, useSales, useStockMovements, qk } from "@/src/data";
import { Product } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { Badge, Card, ConfirmModal, EmptyState, IconButton, Loader, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay, fakeUnitCost, fakeProfit } from "@/src/utils/finance-display";
import { fuzzyFilter } from "@/src/utils/fuzzy-search";

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
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const [showInventoryProfitMargin, setShowInventoryProfitMargin] = useState(true);
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [detailsProduct, setDetailsProduct] = useState<Product | null>(null);
  const { data: stockMovements = [] } = useStockMovements(detailsProduct?.id);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void storage.getItem<boolean>("ssm.showInventoryProfitMargin", true).then((value) => {
        if (active) setShowInventoryProfitMargin(value !== false);
      });
      return () => { active = false; };
    }, []),
  );

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products ?? []) {
      const category = String(product.category || "General Surgical Supplies");
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return ["All", ...Array.from(counts.keys()).sort((a, b) => a.localeCompare(b))];
  }, [products]);

  const filtered = useMemo(() => fuzzyFilter(
    products ?? [],
    search,
    [(p) => p.name, (p) => p.barcode, (p) => p.category],
  ).filter((product) => selectedCategory === "All" || String(product.category || "General Surgical Supplies") === selectedCategory),
  [products, search, selectedCategory]);

  const replenishmentSuggestions = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const soldByProduct: Record<string, number> = {};
    for (const sale of sales ?? []) {
      const timestamp = new Date(sale.created_at || sale.transaction_date || 0).getTime();
      if (!timestamp || timestamp < cutoff) continue;
      for (const line of sale.items ?? []) {
        soldByProduct[line.product_id] = (soldByProduct[line.product_id] ?? 0) + Number(line.quantity ?? 0);
      }
    }
    return (products ?? []).map((product) => {
      const sold30Days = soldByProduct[product.id] ?? 0;
      const averageDaily = sold30Days / 30;
      const targetStock = averageDaily > 0
        ? Math.ceil(averageDaily * 30 + Number(product.low_stock_threshold ?? 0))
        : Math.ceil(Number(product.low_stock_threshold ?? 0) * 2);
      const suggestedQuantity = Math.max(0, targetStock - Number(product.quantity ?? 0));
      return { product, sold30Days, averageDaily, targetStock, suggestedQuantity };
    }).filter((row) => row.suggestedQuantity > 0)
      .sort((a, b) => b.suggestedQuantity - a.suggestedQuantity)
      .slice(0, 12);
  }, [products, sales]);

  const expiryWatch = useMemo(() => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const endKey = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows: { product: Product; batch: string; expiry: string; quantity: number; expired: boolean }[] = [];
    for (const product of products ?? []) {
      const currentLayers: Array<{ quantity: number; expiry_date?: string | null; batch_number?: string }> =
        Array.isArray(product.cost_layers) ? product.cost_layers : [];
      const layers: Array<{ quantity: number; expiry_date?: string | null; batch_number?: string }> =
        currentLayers.some((layer) => !!layer.expiry_date)
          ? currentLayers
          : product.expiry_date ? [{ quantity: product.quantity, expiry_date: product.expiry_date, batch_number: "Product default" }] : currentLayers;
      for (const layer of layers) {
        const expiry = String(layer.expiry_date || "").slice(0, 10);
        if (Number(layer.quantity ?? 0) <= 0) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry > endKey) continue;
        rows.push({
          product,
          batch: layer.batch_number || "No batch number",
          expiry,
          quantity: Number(layer.quantity ?? 0),
          expired: expiry < todayKey,
        });
      }
    }
    return rows.sort((a, b) => a.expiry.localeCompare(b.expiry));
  }, [products]);

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
                    <Card style={styles.usageCard}>
                      <View style={styles.financeHead}>
                        <View>
                          <Text style={styles.financeTitle}>Product categories</Text>
                          <Text style={styles.financeSub}>Existing items are categorized automatically; edit any category in product details</Text>
                        </View>
                        <MaterialDesignIcons name="shape-outline" size={22} color={colors.brandPrimary} />
                      </View>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
                        {categoryOptions.map((category) => (
                          <Pressable
                            key={category}
                            testID={`stock-category-${category.replace(/[^a-z0-9]+/gi, "-")}`}
                            onPress={() => setSelectedCategory(category)}
                            style={[styles.categoryChip, selectedCategory === category && styles.categoryChipActive]}
                          >
                            <Text style={[styles.categoryChipText, selectedCategory === category && styles.categoryChipTextActive]}>{category}</Text>
                          </Pressable>
                        ))}
                      </ScrollView>
                    </Card>

                    <Card style={styles.usageCard}>
                      <View style={styles.financeHead}>
                        <View>
                          <Text style={styles.financeTitle}>Replenishment suggestions</Text>
                          <Text style={styles.financeSub}>Last 30 days of sales · target 30 days of cover plus your low-stock buffer</Text>
                        </View>
                        <MaterialDesignIcons name="cart-arrow-down" size={22} color={colors.brandPrimary} />
                      </View>
                      {replenishmentSuggestions.length === 0 ? (
                        <Text style={styles.usageEmpty}>No replenishment needed at current sales and stock levels.</Text>
                      ) : (
                        <>
                          {replenishmentSuggestions.slice(0, 7).map((row) => (
                            <View key={row.product.id} style={styles.usageRow} testID={`replenishment-${row.product.id}`}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.usageName}>{row.product.name}</Text>
                                <Text style={styles.usageQty}>
                                  Stock {row.product.quantity} · Sold {row.sold30Days} in 30 days · Suggest {row.suggestedQuantity}
                                </Text>
                              </View>
                              <Badge text={row.averageDaily > 0 ? "Sales based" : "Low stock"} tone={row.averageDaily > 0 ? "success" : "warning"} />
                            </View>
                          ))}
                          <Pressable
                            testID="create-replenishment-order"
                            style={styles.replenishmentButton}
                            onPress={() => router.push("/purchase?product_ids=" + replenishmentSuggestions.map((row) => row.product.id + ":" + row.suggestedQuantity).join(","))}
                          >
                            <MaterialDesignIcons name="truck-plus" size={18} color={colors.onBrandPrimary} />
                            <Text style={styles.replenishmentButtonText}>Create purchase list ({replenishmentSuggestions.length} items)</Text>
                          </Pressable>
                        </>
                      )}
                    </Card>

                    <Card style={styles.usageCard}>
                      <View style={styles.financeHead}>
                        <View>
                          <Text style={styles.financeTitle}>Expiry watch · next 60 days</Text>
                          <Text style={styles.financeSub}>Batch-level expiry where batch information is available</Text>
                        </View>
                        <MaterialDesignIcons name="calendar-alert" size={22} color={expiryWatch.some((row) => row.expired) ? colors.error : colors.warning} />
                      </View>
                      {expiryWatch.length === 0 ? (
                        <Text style={styles.usageEmpty}>No recorded batches expiring within 60 days.</Text>
                      ) : expiryWatch.slice(0, 6).map((row, index) => (
                        <View key={row.product.id + row.batch + row.expiry + index} style={styles.usageRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.usageName}>{row.product.name} · {row.batch}</Text>
                            <Text style={styles.usageQty}>Qty {row.quantity} · Expiry {row.expiry}</Text>
                          </View>
                          <Badge text={row.expired ? "Expired" : "Expiring"} tone="warning" />
                        </View>
                      ))}
                    </Card>

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
                    {item.category || "General Surgical Supplies"} · Sell {money(item.sale_price)} · {item.cost_layers?.length ? "Latest buy " + money(fakeFinanceDisplay ? fakeUnitCost(Number(item.sale_price ?? 0), String(item.id) + ":latest") : Number(item.cost_layers[item.cost_layers.length - 1]?.unit_cost ?? item.purchase_price ?? 0)) : "Buy " + money(fakeFinanceDisplay ? fakeUnitCost(Number(item.sale_price ?? 0), String(item.id)) : Number(item.purchase_price ?? 0))}
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
                          {(line.batch_number || line.expiry_date) && (
                            <Text style={styles.meta}>
                              {line.batch_number ? `Batch ${line.batch_number}` : "Batch not recorded"}
                              {line.expiry_date ? ` · Expiry ${line.expiry_date}` : ""}
                            </Text>
                          )}
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
                  <Card>
                    <Text style={styles.detailTitle}>Stock movement history</Text>
                    {stockMovements.filter((movement) => movement.product_id === p.id).length === 0 && (
                      <Text style={styles.meta}>No recorded stock movements found.</Text>
                    )}
                    {stockMovements.filter((movement) => movement.product_id === p.id).slice(0, 60).map((movement) => (
                      <View key={movement.id} style={styles.detailRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailName}>
                            {movement.movement_type.replace(/_/g, " ")} · {movement.reference || "Stock event"}
                          </Text>
                          <Text style={styles.meta}>
                            {formatDetailDate(movement.created_at)}
                            {movement.batch_number ? ` · Batch ${movement.batch_number}` : ""}
                            {movement.expiry_date ? ` · Expiry ${movement.expiry_date}` : ""}
                          </Text>
                          {!!movement.note && <Text style={styles.meta}>{movement.note}</Text>}
                          {!!movement.user_name && <Text style={styles.meta}>By {movement.user_name}</Text>}
                        </View>
                        <Text style={[styles.detailValue, { color: movement.quantity_delta >= 0 ? colors.success : colors.error }]}>
                          {movement.quantity_delta > 0 ? "+" : ""}{movement.quantity_delta}
                        </Text>
                      </View>
                    ))}
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
  categoryChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  categoryChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  categoryChipText: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceSecondary },
  categoryChipTextActive: { color: colors.onBrandPrimary },
  replenishmentButton: { minHeight: 42, borderRadius: 10, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 12, marginTop: 8 },
  replenishmentButtonText: { color: colors.onBrandPrimary, fontSize: 12, fontWeight: "800" },
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
