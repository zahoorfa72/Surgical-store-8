import { useCallback, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { BarcodeScannerModal } from "@/src/components/barcode-scanner";
import { canManageStore, useAuth } from "@/src/auth";
import { useProducts, usePurchases, useSales, useStockMovements, useSettings, qk } from "@/src/data";
import { Product } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { Badge, Card, ConfirmModal, EmptyState, IconButton, Loader, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay, fakeDisplayAmount } from "@/src/utils/finance-display";
import { useProfitVisibility } from "@/src/security/finance-security";
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
  const { data: settings } = useSettings();
  const { data: purchases = [] } = usePurchases();
  const { data: sales = [] } = useSales();
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkTargetCategory, setBulkTargetCategory] = useState("");
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const isAdmin = String(user?.role ?? "").toLowerCase() === "admin";
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const [showInventoryProfitMargin, setShowInventoryProfitMargin] = useState(true);
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const { grossHidden } = useProfitVisibility();
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
    const saved = Array.isArray(settings?.product_categories) ? settings.product_categories : [];
    const all = new Set([...saved, ...counts.keys()].filter(Boolean));
    return ["All", ...Array.from(all).sort((a, b) => a.localeCompare(b))];
  }, [products, settings?.product_categories]);

  const filtered = useMemo(() => fuzzyFilter(
    products ?? [],
    search,
    [(p) => p.name, (p) => p.barcode, (p) => p.category],
  ).filter((product) => selectedCategory === "All" || String(product.category || "General Surgical Supplies") === selectedCategory),
  [products, search, selectedCategory]);

  const toggleProductSelection = (productId: string) => {
    setSelectedProductIds((current) => current.includes(productId)
      ? current.filter((id) => id !== productId)
      : [...current, productId]);
  };
  const stopBulkSelection = () => {
    setSelectionMode(false);
    setSelectedProductIds([]);
  };

  const [replenishmentRange, setReplenishmentRange] = useState<"month" | "year" | "all">("month");
  const [replenishmentDropdownOpen, setReplenishmentDropdownOpen] = useState(false);
  const replenishmentRangeLabel = replenishmentRange === "month" ? "This month" : replenishmentRange === "year" ? "This year" : "All time";

  const replenishmentSuggestions = useMemo(() => {
    const now = new Date();
    const rangeStart = replenishmentRange === "month"
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : replenishmentRange === "year" ? new Date(now.getFullYear(), 0, 1) : null;
    const relevantSales = (sales ?? []).filter((sale) => {
      const rawDate = sale.transaction_date || sale.created_at;
      const timestamp = rawDate ? new Date(rawDate).getTime() : 0;
      return Number.isFinite(timestamp) && timestamp > 0 && (!rangeStart || timestamp >= rangeStart.getTime());
    });
    const firstSaleTime = relevantSales.reduce((earliest, sale) => {
      const rawDate = sale.transaction_date || sale.created_at;
      const timestamp = rawDate ? new Date(rawDate).getTime() : 0;
      return timestamp > 0 ? Math.min(earliest, timestamp) : earliest;
    }, now.getTime());
    const periodStart = rangeStart?.getTime() ?? firstSaleTime;
    const elapsedDays = Math.max(1, Math.ceil((now.getTime() - periodStart) / 86400000) + 1);
    const soldByProduct: Record<string, number> = {};
    for (const sale of relevantSales) {
      for (const line of sale.items ?? []) {
        soldByProduct[line.product_id] = (soldByProduct[line.product_id] ?? 0) + Number(line.quantity ?? 0);
      }
    }
    return (products ?? []).map((product) => {
      const soldInRange = soldByProduct[product.id] ?? 0;
      const averageDaily = soldInRange / elapsedDays;
      const targetStock = averageDaily > 0
        ? Math.ceil(averageDaily * 30 + Number(product.low_stock_threshold ?? 0))
        : Math.ceil(Number(product.low_stock_threshold ?? 0) * 2);
      const suggestedQuantity = Math.max(0, targetStock - Number(product.quantity ?? 0));
      return { product, soldInRange, averageDaily, targetStock, suggestedQuantity };
    }).filter((row) => row.suggestedQuantity > 0)
      .sort((a, b) => b.suggestedQuantity - a.suggestedQuantity)
      ;
  }, [products, sales, replenishmentRange]);

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
    const realCostValue = rows.reduce((n, p) => n + (p.cost_layers?.length
      ? p.cost_layers.reduce((sum, layer) => sum + Number(layer.quantity ?? 0) * Number(layer.unit_cost ?? 0), 0)
      : Number(p.quantity ?? 0) * Number(p.purchase_price ?? 0)), 0);
    const realRetailValue = rows.reduce((n, p) => n + Number(p.quantity ?? 0) * Number(p.sale_price ?? 0), 0);
    return {
      costValue: fakeFinanceDisplay ? fakeDisplayAmount(realCostValue) : realCostValue,
      retailValue: fakeFinanceDisplay ? fakeDisplayAmount(realRetailValue) : realRetailValue,
      potentialProfit: fakeFinanceDisplay ? fakeDisplayAmount(realRetailValue - realCostValue) : realRetailValue - realCostValue,
    };
  }, [products, fakeFinanceDisplay]);

  const moveSelectedProducts = async () => {
    const selected = (products ?? []).filter((product) => selectedProductIds.includes(product.id));
    const target = bulkTargetCategory.trim();
    if (!selected.length) return toast("Select at least one product.", "error");
    if (!target) return toast("Choose a destination category.", "error");
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(selected.map((product) => apiRequest(`/products/${product.id}`, {
        method: "PUT",
        body: {
          name: product.name,
          barcode: product.barcode ?? "",
          category: target,
          purchase_price: Number(product.purchase_price ?? 0),
          sale_price: Number(product.sale_price ?? 0),
          low_stock_threshold: Number(product.low_stock_threshold ?? 5),
          expiry_date: product.expiry_date ?? null,
        },
      })));
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - succeeded;
      await queryClient.invalidateQueries({ queryKey: qk.products });
      setBulkMoveOpen(false);
      setBulkTargetCategory("");
      stopBulkSelection();
      if (failed) toast(`${succeeded} products moved; ${failed} could not be moved.`, "error");
      else toast(`${succeeded} products moved to ${target}.`, "success");
    } catch (error: any) {
      toast(error?.message || "Could not move selected products.", "error");
    } finally {
      setBulkBusy(false);
    }
  };

  const deleteSelectedProducts = async () => {
    if (!isAdmin) return toast("Only an administrator can delete products.", "error");
    const ids = [...selectedProductIds];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => apiRequest(`/products/${id}`, { method: "DELETE" })));
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - succeeded;
      await queryClient.invalidateQueries({ queryKey: qk.products });
      setBulkDeleteOpen(false);
      stopBulkSelection();
      if (failed) toast(`${succeeded} products removed; ${failed} could not be removed.`, "error");
      else toast(`${succeeded} products removed from active stock. Transaction history is preserved.`, "success");
    } catch (error: any) {
      toast(error?.message || "Could not delete selected products.", "error");
    } finally {
      setBulkBusy(false);
    }
  };

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
                        <View style={{ flex: 1 }}>
                          <Text style={styles.financeTitle}>Product categories</Text>
                          <Text style={styles.financeSub}>Create your own groups and filter stock by category</Text>
                        </View>
                        <View style={styles.categoryHeaderActions}>
                          {isAdmin ? (
                            <Pressable testID="manage-product-categories" style={styles.manageCategoriesButton} onPress={() => setCategoryManagerOpen(true)}>
                              <MaterialDesignIcons name="cog-outline" size={17} color={colors.brandPrimary} />
                              <Text style={styles.manageCategoriesText}>Manage</Text>
                            </Pressable>
                          ) : !staff ? <MaterialDesignIcons name="shape-outline" size={22} color={colors.brandPrimary} /> : null}
                        </View>
                      </View>
                      <View style={styles.categoryChips}>
                        {categoryOptions.map((category) => {
                          const count = category === "All" ? (products ?? []).length : (products ?? []).filter((p) => String(p.category || "General Surgical Supplies") === category).length;
                          return (
                            <Pressable key={category} testID={`stock-category-${category.replace(/[^a-z0-9]+/gi, "-")}`} onPress={() => setSelectedCategory(category)} style={[styles.categoryChip, selectedCategory === category && styles.categoryChipActive]}>
                              <Text style={[styles.categoryChipText, selectedCategory === category && styles.categoryChipTextActive]}>{category}</Text>
                              <Text style={[styles.categoryCount, selectedCategory === category && styles.categoryCountActive]}>{count}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </Card>
                    <Card style={styles.usageCard}>
                      <View style={{ gap: 10, marginBottom: 10 }}>
                        <View>
                          <Text style={styles.financeTitle}>Replenishment suggestions</Text>
                          <Text style={styles.financeSub}>Based on the selected sales period · target is 30 days of stock plus your low-stock buffer</Text>
                        </View>
                        <Pressable testID="replenishment-period-dropdown" onPress={() => setReplenishmentDropdownOpen(true)} style={styles.periodDropdownWide}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <MaterialDesignIcons name="calendar-range" size={18} color={colors.brandPrimary} />
                            <Text style={styles.periodDropdownLabel}>Sales period</Text>
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <Text style={styles.periodDropdownText}>{replenishmentRangeLabel}</Text>
                            <MaterialDesignIcons name="chevron-down" size={20} color={colors.brandPrimary} />
                          </View>
                        </Pressable>
                      </View>
                      {replenishmentSuggestions.length === 0 ? (
                        <Text style={styles.usageEmpty}>No replenishment needed at current sales and stock levels.</Text>
                      ) : (
                        <>
                          {replenishmentSuggestions.map((row) => (
                            <View key={row.product.id} style={styles.usageRow} testID={`replenishment-${row.product.id}`}>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.usageName}>{row.product.name}</Text>
                                <Text style={styles.usageQty}>
                                  Stock {row.product.quantity} · Sold {row.soldInRange} · Suggest {row.suggestedQuantity}
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
                      ) : expiryWatch.map((row, index) => (
                        <View key={row.product.id + row.batch + row.expiry + index} style={styles.usageRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.usageName}>{row.product.name} · {row.batch}</Text>
                            <Text style={styles.usageQty}>Qty {row.quantity} · Expiry {row.expiry}</Text>
                          </View>
                          <Badge text={row.expired ? "Expired" : "Expiring"} tone="warning" />
                        </View>
                      ))}
                    </Card>

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
                          {!grossHidden && <View style={styles.financeCell}><Text style={styles.financeLabel}>Potential margin</Text><Text style={[styles.financeValue,{color:inventoryFinance.potentialProfit>=0?colors.success:colors.error}]}>{money(inventoryFinance.potentialProfit)}</Text></View>}
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
            const realStockCost = item.cost_layers?.length
              ? item.cost_layers.reduce((sum, layer) => sum + Number(layer.quantity ?? 0) * Number(layer.unit_cost ?? 0), 0)
              : Number(item.quantity ?? 0) * Number(item.purchase_price ?? 0);
            const displayStockCost = fakeFinanceDisplay ? fakeDisplayAmount(realStockCost) : realStockCost;
            const realMargin = Number(item.quantity ?? 0) * Number(item.sale_price ?? 0) - realStockCost;
            const displayMargin = fakeFinanceDisplay ? fakeDisplayAmount(realMargin) : realMargin;
            return (
              <Pressable
                testID={`product-row-${item.id}`}
                style={[styles.row, selectionMode && selectedProductIds.includes(item.id) && styles.rowSelected]}
                onPress={() => selectionMode ? toggleProductSelection(item.id) : setDetailsProduct(item)}
                onLongPress={() => {
                  if (!selectionMode) {
                    setSelectionMode(true);
                    setSelectedProductIds([item.id]);
                  }
                }}
                delayLongPress={450}
              >
                {selectionMode ? (
                  <View style={styles.selectionMarker}>
                    <MaterialDesignIcons name={selectedProductIds.includes(item.id) ? "checkbox-marked-circle" : "checkbox-blank-circle-outline"} size={25} color={selectedProductIds.includes(item.id) ? colors.brandPrimary : colors.muted} />
                  </View>
                ) : (
                  <View style={styles.rowIcon}>
                    <MaterialDesignIcons name="pill" size={22} color={colors.brandPrimary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.meta}>
                    {item.category || "General Surgical Supplies"} · Sell {money(item.sale_price)} · {item.cost_layers?.length ? "Latest buy " + money(fakeFinanceDisplay ? fakeDisplayAmount(Number(item.cost_layers[item.cost_layers.length - 1]?.unit_cost ?? item.purchase_price ?? 0)) : Number(item.cost_layers[item.cost_layers.length - 1]?.unit_cost ?? item.purchase_price ?? 0)) : "Buy " + money(fakeFinanceDisplay ? fakeDisplayAmount(Number(item.purchase_price ?? 0)) : Number(item.purchase_price ?? 0))}
                  </Text>
                  {!!item.cost_layers?.length && (
                    <View style={{ gap: 2, marginTop: 3 }}>
                      {item.cost_layers.map((layer, index) => (
                        <Text key={`${item.id}-lot-${index}`} style={styles.lotText}>
                          Lot {index + 1}: {Number(layer.quantity)} × {money(fakeFinanceDisplay ? fakeDisplayAmount(Number(layer.unit_cost ?? 0)) : Number(layer.unit_cost ?? 0))}
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
                {staff && !selectionMode && (
                  <Pressable testID={`delete-product-${item.id}`} hitSlop={8} onPress={() => setToDelete(item)} style={styles.delBtn}>
                    <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} />
                  </Pressable>
                )}
              </Pressable>
            );
          }}
        />
      )}

      {staff && selectionMode && selectedProductIds.length > 0 && (
        <View style={[styles.bulkActionBar, { bottom: insets.bottom + 12 }]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bulkActionCount}>{selectedProductIds.length} selected</Text>
            <Text style={styles.bulkActionHint}>Tap other products to add them</Text>
          </View>
          <Pressable
            testID="move-selected-products"
            disabled={bulkBusy}
            onPress={() => { setBulkTargetCategory(""); setBulkMoveOpen(true); }}
            style={[styles.bulkActionButton, bulkBusy && { opacity: 0.55 }]}
          >
            <MaterialDesignIcons name="folder-move-outline" size={17} color={colors.onBrandPrimary} />
            <Text style={styles.bulkActionButtonText}>Move to</Text>
          </Pressable>
          {isAdmin && (
            <Pressable
              testID="delete-selected-products"
              disabled={bulkBusy}
              onPress={() => setBulkDeleteOpen(true)}
              style={[styles.bulkDeleteButton, bulkBusy && { opacity: 0.55 }]}
            >
              <MaterialDesignIcons name="trash-can-outline" size={17} color={colors.error} />
              <Text style={styles.bulkDeleteButtonText}>Delete</Text>
            </Pressable>
          )}
          <Pressable
            testID="finish-product-selection"
            disabled={bulkBusy}
            onPress={stopBulkSelection}
            style={styles.bulkDeleteButton}
          >
            <Text style={styles.bulkLinkText}>Done</Text>
          </Pressable>
        </View>
      )}

      {staff && !selectionMode && (
        <Pressable
          testID="add-product-fab"
          style={[styles.fab, { bottom: 16 }]}
          onPress={() => router.push("/product-form")}
        >
          <MaterialDesignIcons name="plus" size={22} color={colors.onBrandPrimary} /><Text style={styles.fabText}>Add product</Text>
        </Pressable>
      )}

      <Modal visible={bulkMoveOpen} transparent animationType="fade" onRequestClose={() => setBulkMoveOpen(false)}>
        <Pressable style={styles.bulkBackdrop} onPress={() => setBulkMoveOpen(false)}>
          <Pressable style={styles.bulkDialog} onPress={() => {}}>
            <Text style={styles.bulkDialogTitle}>Move selected products</Text>
            <Text style={styles.bulkDialogHint}>{selectedProductIds.length} products will be moved to the category you choose. Existing purchase and sales records will not be changed.</Text>
            <Text style={styles.categoryListHeading}>Destination category</Text>
            <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 8 }}>
              {categoryOptions.slice(1).map((category) => (
                <Pressable
                  key={category}
                  testID={`bulk-move-category-${category.replace(/[^a-z0-9]+/gi, "-")}`}
                  onPress={() => setBulkTargetCategory(category)}
                  style={[styles.bulkCategoryOption, bulkTargetCategory === category && styles.bulkCategoryOptionSelected]}
                >
                  <Text style={[styles.bulkCategoryText, bulkTargetCategory === category && styles.bulkCategoryTextSelected]}>{category}</Text>
                  {bulkTargetCategory === category && <MaterialDesignIcons name="check-circle" size={19} color={colors.brandPrimary} />}
                </Pressable>
              ))}
              {categoryOptions.length <= 1 && <Text style={styles.financeSub}>No categories are available yet. Close this window and create a category using Manage.</Text>}
            </ScrollView>
            <Pressable
              testID="confirm-move-selected-products"
              disabled={bulkBusy || !bulkTargetCategory}
              onPress={() => void moveSelectedProducts()}
              style={[styles.bulkModalButton, (bulkBusy || !bulkTargetCategory) && { opacity: 0.5 }]}
            >
              <Text style={styles.bulkModalButtonText}>{bulkBusy ? "Moving…" : `Move ${selectedProductIds.length} products`}</Text>
            </Pressable>
            <Pressable style={styles.bulkCancelButton} onPress={() => setBulkMoveOpen(false)}>
              <Text style={styles.bulkCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={categoryManagerOpen} animationType="slide" onRequestClose={() => setCategoryManagerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Manage categories" subtitle="Create and organize your stock groups" topInset={insets.top} onBack={() => setCategoryManagerOpen(false)} />
          <View style={{ padding: 16, gap: 14, flex: 1 }}>
            <Card>
              <Text style={styles.financeTitle}>Create a category</Text>
              <Text style={styles.financeSub}>Examples: Gloves & PPE, IV & Infusion, Syringes & Needles</Text>
              <TextInput testID="new-product-category-input" value={newCategoryName} onChangeText={setNewCategoryName} placeholder="Enter category name" placeholderTextColor={colors.muted} maxLength={60} style={styles.newCategoryInput} />
              <Pressable testID="add-product-category" disabled={categoryBusy || !newCategoryName.trim()} style={[styles.addCategoryButton, (categoryBusy || !newCategoryName.trim()) && { opacity: 0.5 }]} onPress={async () => {
                const name = newCategoryName.trim();
                if (!name) return;
                const current = Array.isArray(settings?.product_categories) ? settings.product_categories : [];
                const existing = new Set([...current, ...categoryOptions.slice(1)].map((v) => v.toLowerCase()));
                if (existing.has(name.toLowerCase())) { toast("This category already exists", "error"); return; }
                const next = [...current, name];
                setCategoryBusy(true);
                try {
                  await apiRequest("/settings", { method: "PUT", body: { product_categories: next } });
                  queryClient.setQueryData(qk.settings, { ...(settings ?? {}), product_categories: next });
                  setNewCategoryName("");
                  toast("Category created", "success");
                } catch (error: any) { toast(error?.message || "Could not create category", "error"); }
                finally { setCategoryBusy(false); }
              }}>
                <MaterialDesignIcons name="plus" size={18} color={colors.onBrandPrimary} />
                <Text style={styles.addCategoryButtonText}>Create category</Text>
              </Pressable>
            </Card>
            <Text style={styles.categoryListHeading}>Available categories</Text>
            <FlatList data={categoryOptions.slice(1)} keyExtractor={(item) => item} contentContainerStyle={{ gap: 8, paddingBottom: insets.bottom + 24 }} renderItem={({ item }) => {
              const count = (products ?? []).filter((p) => String(p.category || "General Surgical Supplies") === item).length;
              return (
                <View style={styles.categoryManageRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.categoryManageName}>{item}</Text>
                    <Text style={styles.categoryManageMeta}>{count} products assigned</Text>
                  </View>
                  {count > 0 ? <Badge text="In use" tone="success" /> : (
                    <Pressable testID={`delete-category-${item.replace(/[^a-z0-9]+/gi, "-")}`} hitSlop={8} onPress={async () => {
                      const current = Array.isArray(settings?.product_categories) ? settings.product_categories : [];
                      const next = current.filter((v) => v !== item);
                      setCategoryBusy(true);
                      try {
                        await apiRequest("/settings", { method: "PUT", body: { product_categories: next } });
                        queryClient.setQueryData(qk.settings, { ...(settings ?? {}), product_categories: next });
                        if (selectedCategory === item) setSelectedCategory("All");
                        toast("Category removed", "success");
                      } catch (error: any) { toast(error?.message || "Could not remove category", "error"); }
                      finally { setCategoryBusy(false); }
                    }}>
                      <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} />
                    </Pressable>
                  )}
                </View>
              );
            }} />
          </View>
        </View>
      </Modal>

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
                    <Text style={styles.meta}>Sale price {money(p.sale_price)} · Latest buy {money(fakeFinanceDisplay ? fakeDisplayAmount(Number(p.cost_layers?.[p.cost_layers.length - 1]?.unit_cost ?? p.purchase_price ?? 0)) : Number(p.cost_layers?.[p.cost_layers.length - 1]?.unit_cost ?? p.purchase_price ?? 0))}</Text>
                  </Card>
                  <Card>
                    <Text style={styles.detailTitle}>Purchase lots ({productPurchases.length})</Text>
                    {productPurchases.length === 0 && <Text style={styles.meta}>No purchase history found.</Text>}
                    {productPurchases.map(({ purchase, line }) => {
                      const unit = fakeFinanceDisplay ? fakeDisplayAmount(Number(line.unit_cost ?? 0)) : Number(line.unit_cost ?? 0);
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
                      const profit = fakeFinanceDisplay ? fakeDisplayAmount((sell - Number(line.purchase_price ?? 0)) * qty) : (sell - Number(line.purchase_price ?? 0)) * qty;
                      return <View key={sale.id + ":" + line.product_id + ":" + String(index)} style={styles.detailRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailName}>{sale.invoice_no} · {qty} units</Text>
                          <Text style={styles.meta}>{sale.customer_name || "Walk-in customer"} · {formatDetailDate(sale.created_at)}</Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={styles.detailValue}>Sell {money(sell * qty)}</Text>
                          {!grossHidden && <Text style={styles.detailProfit}>Profit {money(profit)}</Text>}
                        </View>
                      </View>;
                    })}
                  </Card>
                  <Card>
                    <Text style={styles.detailTitle}>Stock movement history</Text>
                    {stockMovements.filter((movement) => movement.product_id === p.id).length === 0 && (
                      <Text style={styles.meta}>No recorded stock movements found.</Text>
                    )}
                    {stockMovements.filter((movement) => movement.product_id === p.id).map((movement) => (
                      <View key={movement.id} style={styles.detailRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailName}>
                            {movement.movement_type.replace(/_/g, " ")} · {movement.reference || "Stock event"}
                          </Text>
                          <Text style={styles.meta}>
                            {formatDetailDate(movement.created_at)}
                            {movement.batch_number ? ` · Batch ${movement.batch_number}` : ""}
                            {movement.non_expiring ? " · Non-expiring" : movement.expiry_date ? ` · Expiry ${movement.expiry_date}` : ""}
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

      <Modal visible={replenishmentDropdownOpen} transparent animationType="fade" onRequestClose={() => setReplenishmentDropdownOpen(false)}>
        <Pressable style={styles.dropdownBackdrop} onPress={() => setReplenishmentDropdownOpen(false)}>
          <View style={styles.dropdownMenu}>
            {([
              ["month", "This month"],
              ["year", "This year"],
              ["all", "All time"],
            ] as const).map(([key, label]) => (
              <Pressable
                key={key}
                testID={`replenishment-period-${key}`}
                style={styles.dropdownOption}
                onPress={() => { setReplenishmentRange(key); setReplenishmentDropdownOpen(false); }}
              >
                <Text style={[styles.dropdownOptionText, replenishmentRange === key && { color: colors.brandPrimary, fontWeight: "900" }]}>{label}</Text>
                {replenishmentRange === key && <MaterialDesignIcons name="check" size={18} color={colors.brandPrimary} />}
              </Pressable>
            ))}
          </View>
        </Pressable>
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
        visible={bulkDeleteOpen}
        title={`Delete ${selectedProductIds.length} selected products?`}
        message="These products will be removed from active stock. Existing sales and purchase history will remain recorded. This action can only be reversed by restoring the products through support."
        confirmLabel={bulkBusy ? "Deleting…" : "Delete selected"}
        onConfirm={deleteSelectedProducts}
        onCancel={() => setBulkDeleteOpen(false)}
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
  categoryChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  categoryChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  categoryCount: { minWidth: 19, textAlign: "center", fontSize: 10, fontWeight: "800", color: colors.muted, backgroundColor: colors.surface, borderRadius: 10, overflow: "hidden", paddingHorizontal: 5, paddingVertical: 2 },
  categoryCountActive: { color: colors.brandPrimary, backgroundColor: colors.onBrandPrimary },
  manageCategoriesButton: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 9, backgroundColor: colors.surfaceTertiary },
  manageCategoriesText: { fontSize: 12, fontWeight: "800", color: colors.brandPrimary },
  newCategoryInput: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.onSurface, marginTop: 12 },
  addCategoryButton: { minHeight: 44, marginTop: 10, borderRadius: 10, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  addCategoryButtonText: { color: colors.onBrandPrimary, fontWeight: "800" },
  categoryListHeading: { fontSize: 14, fontWeight: "900", color: colors.onSurface },
  categoryManageRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, 
  categoryManageName: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  categoryManageMeta: { fontSize: 11, color: colors.muted, marginTop: 3 },
  categoryHeaderActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  bulkToggleButton: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, borderRadius: 9, borderWidth: 1, borderColor: colors.brandSecondary, backgroundColor: colors.brandTertiary },
  bulkToggleButtonActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  bulkToggleText: { fontSize: 11, fontWeight: "800", color: colors.brandPrimary },
  bulkSelectControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider },
  bulkSelectedCount: { flex: 1, color: colors.onSurface, fontSize: 12, fontWeight: "800" },
  bulkLinkText: { color: colors.brandPrimary, fontSize: 11, fontWeight: "800" },
  rowSelected: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  selectionMarker: { width: 34, alignItems: "center", justifyContent: "center" },
  bulkActionBar: { position: "absolute", left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, elevation: 8 },
  bulkActionCount: { color: colors.onSurface, fontSize: 13, fontWeight: "900" },
  bulkActionHint: { color: colors.muted, fontSize: 10, marginTop: 2 },
  bulkActionButton: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 11, borderRadius: 10, backgroundColor: colors.brandPrimary },
  bulkActionButtonText: { color: colors.onBrandPrimary, fontSize: 11, fontWeight: "900" },
  bulkDeleteButton: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border },
  bulkDeleteButtonText: { color: colors.error, fontSize: 11, fontWeight: "900" },
  bulkBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.48)", justifyContent: "center", padding: 20 },
  bulkDialog: { width: "100%", maxWidth: 460, alignSelf: "center", gap: 12, backgroundColor: colors.surface, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: colors.border },
  bulkDialogTitle: { color: colors.onSurface, fontSize: 18, fontWeight: "900" },
  bulkDialogHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  bulkCategoryOption: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  bulkCategoryOptionSelected: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  bulkCategoryText: { color: colors.onSurface, fontSize: 13, fontWeight: "700" },
  bulkCategoryTextSelected: { color: colors.brandPrimary, fontWeight: "900" },
  bulkModalButton: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: colors.brandPrimary },
  bulkModalButtonText: { color: colors.onBrandPrimary, fontSize: 13, fontWeight: "900" },
  bulkCancelButton: { minHeight: 38, alignItems: "center", justifyContent: "center" },
  bulkCancelText: { color: colors.muted, fontSize: 13, fontWeight: "800" },
  categoryChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  categoryChipText: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceSecondary },
  categoryChipTextActive: { color: colors.onBrandPrimary },
  periodDropdownWide: { width: "100%", minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  periodDropdownLabel: { fontSize: 12, color: colors.muted, fontWeight: "700" },
  periodDropdownText: { fontSize: 12, fontWeight: "800", color: colors.brandPrimary },
  dropdownBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "center", padding: 28 },
  dropdownMenu: { alignSelf: "flex-end", minWidth: 180, borderRadius: 14, paddingVertical: 6, backgroundColor: colors.surface, elevation: 8, borderWidth: 1, borderColor: colors.border },
  dropdownOption: { minHeight: 46, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dropdownOptionText: { fontSize: 14, color: colors.onSurface, fontWeight: "700" },
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
