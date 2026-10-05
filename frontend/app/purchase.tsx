import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useParties, useProducts, usePurchase, qk } from "@/src/data";
import { useAuth } from "@/src/auth";
import { useOffline } from "@/src/offline";
import { EmptyState, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay, fakeUnitCost } from "@/src/utils/finance-display";

type Line = { id: string; name: string; quantity: number; unit_cost: number };

export default function Purchase() {
  const styles = useStyles();
  const { colors } = useTheme();
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { createPurchase } = useOffline();

  const { id: editId } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!editId;
  const { data: editing } = usePurchase(editId ?? "");

  const { data: products } = useProducts();
  const { data: suppliers } = useParties("supplier");

  const [lines, setLines] = useState<Line[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [productSearch, setProductSearch] = useState("");
  const [productCreateOpen, setProductCreateOpen] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [newProductBarcode, setNewProductBarcode] = useState("");
  const [newProductSalePrice, setNewProductSalePrice] = useState("");
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierCreateOpen, setSupplierCreateOpen] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [newSupplierAddress, setNewSupplierAddress] = useState("");
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  // Prefill the form once when editing an existing purchase.
  useEffect(() => {
    if (isEdit && editing && !prefilled) {
      setLines(
        editing.items.map((it) => ({
          id: it.product_id,
          name: it.name,
          quantity: it.quantity,
          unit_cost: it.unit_cost,
        })),
      );
      setSupplierId(editing.supplier_id ?? null);
      setPrefilled(true);
    }
  }, [isEdit, editing, prefilled]);

  const lineIds = useMemo(() => new Set(lines.map((l) => l.id)), [lines]);
  const total = lines.reduce((s, l) => { const p = products?.find((x: any) => x.id === l.id); const cost = fakeFinanceDisplay ? fakeUnitCost(Number(p?.sale_price ?? 0), String(l.id)) : l.unit_cost; return s + l.quantity * cost; }, 0);
  const supplierName = suppliers?.find((s) => s.id === supplierId)?.name ?? "No supplier";

  const createSupplier = async () => {
    const name = newSupplierName.trim();
    if (!name) {
      toast("Enter supplier name", "error");
      return;
    }
    try {
      const created = await apiRequest<any>("/parties", {
        method: "POST",
        body: { name, type: "supplier", phone: newSupplierPhone.trim(), address: newSupplierAddress.trim() },
      });
      setSupplierId(created.id);
      await queryClient.invalidateQueries({ queryKey: qk.parties("supplier") });
      await queryClient.invalidateQueries({ queryKey: qk.parties() });
      setNewSupplierName("");
      setNewSupplierPhone("");
      setNewSupplierAddress("");
      setSupplierCreateOpen(false);
      setSupplierPickerOpen(false);
      toast("Supplier created and selected", "success");
    } catch (e: any) {
      toast(e?.message || "Could not create supplier", "error");
    }
  };

  const toggleProduct = (pid: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };
  const filteredPickerProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return (products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || String((p as any).category ?? "").toLowerCase().includes(q) || String((p as any).barcode ?? (p as any).sku ?? "").toLowerCase().includes(q));
  }, [products, productSearch]);
  const createProductForPurchase = async () => {
    const name = newProductName.trim();
    const barcode = newProductBarcode.trim();
    const salePrice = Math.max(0, parseFloat(newProductSalePrice) || 0);
    if (!name) { toast("Enter product name", "error"); return; }
    const normalize = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const existing = (products ?? []).find((p: any) =>
      (barcode && String(p.barcode ?? "").trim() === barcode) || normalize(p.name) === normalize(name)
    );
    if (existing) {
      setLines((prev) => prev.some((l) => l.id === existing.id) ? prev : [...prev, { id: existing.id, name: existing.name, quantity: 1, unit_cost: Number(existing.purchase_price ?? 0) }]);
      setProductCreateOpen(false);
      setNewProductName(""); setNewProductBarcode(""); setNewProductSalePrice("");
      toast("Existing product found — added to this purchase", "info");
      return;
    }
    try {
      const created = await apiRequest<any>("/products", {
        method: "POST",
        body: { name, barcode, purchase_price: 0, sale_price: salePrice, low_stock_threshold: 5, expiry_date: null },
      });
      const id = String(created.id);
      setLines((prev) => [...prev, { id, name: created.name ?? name, quantity: 1, unit_cost: Number(created.purchase_price ?? 0) }]);
      await queryClient.invalidateQueries({ queryKey: qk.products });
      setProductCreateOpen(false);
      setPickerOpen(false);
      setNewProductName(""); setNewProductBarcode(""); setNewProductSalePrice("");
      toast("Product created — enter quantity and purchase cost, then save. Stock will be added without a duplicate.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not create product", "error");
    }
  };

  const addSelectedProducts = () => {
    const selected = products?.filter((p) => selectedProductIds.has(p.id) && !lineIds.has(p.id)) ?? [];
    if (!selected.length) {
      toast("Select at least one new product", "error");
      return;
    }
    setLines((prev) => [...prev, ...selected.map((p) => ({ id: p.id, name: p.name, quantity: 1, unit_cost: p.purchase_price }))]);
    setSelectedProductIds(new Set());
    setPickerOpen(false);
  };
  const setQty = (id: string, q: number) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, quantity: Math.max(0, q) } : l)));
  const setCost = (id: string, c: number) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, unit_cost: Math.max(0, c) } : l)));
  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id));

  const save = async () => {
    const valid = lines.filter((l) => l.quantity > 0);
    if (!valid.length) {
      toast("Add at least one product", "error");
      return;
    }
    setBusy(true);
    const body = {
      supplier_id: supplierId,
      items: valid.map((l) => ({ product_id: l.id, quantity: l.quantity, unit_cost: l.unit_cost })),
    };
    try {
      if (isEdit) {
        await apiRequest(`/purchases/${editId}`, { method: "PUT", body });
        await queryClient.invalidateQueries({ queryKey: qk.products });
        await queryClient.invalidateQueries({ queryKey: qk.purchases });
        await queryClient.invalidateQueries({ queryKey: qk.purchase(editId!) });
        toast("Purchase updated", "success");
        router.back();
      } else {
        const { queued } = await createPurchase(body, user?.name || user?.email || "Staff");
        await queryClient.invalidateQueries({ queryKey: qk.products });
        await queryClient.invalidateQueries({ queryKey: qk.purchases });
        toast(queued ? "Saved offline — will sync when online" : "Stock purchased & updated", queued ? "info" : "success");
        router.back();
      }
    } catch (e: any) {
      toast(e?.message || "Purchase failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title={isEdit ? "Edit purchase" : "Purchase stock"} subtitle={isEdit ? "Update items & costs" : "Restock multiple products"} topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }} bottomOffset={20}>
        <Pressable testID="select-supplier-button" style={styles.supplierRow} onPress={() => setSupplierPickerOpen(true)}>
          <MaterialDesignIcons name="domain" size={20} color={colors.brandPrimary} />
          <Text style={styles.supplierText}>{supplierName}</Text>
          <MaterialDesignIcons name="chevron-right" size={22} color={colors.muted} />
        </Pressable>

        {lines.length === 0 ? (
          <EmptyState icon="truck-plus" title="No products added" message="Tap the button below to add products to purchase." testID="purchase-empty" />
        ) : (
          lines.map((l) => (
            <View key={l.id} style={styles.line} testID={`purchase-line-${l.id}`}>
              <View style={styles.lineHead}>
                <Text style={styles.lineName}>{l.name}</Text>
                <Pressable testID={`remove-purchase-${l.id}`} hitSlop={8} onPress={() => removeLine(l.id)}>
                  <MaterialDesignIcons name="close" size={20} color={colors.muted} />
                </Pressable>
              </View>
              <View style={styles.lineInputs}>
                <View style={styles.miniField}>
                  <Text style={styles.miniLabel}>Quantity</Text>
                  <TextInput
                    testID={`purchase-qty-${l.id}`}
                    style={styles.miniInput}
                    keyboardType="numeric"
                    value={String(l.quantity)}
                    onChangeText={(t) => setQty(l.id, parseInt(t || "0", 10))}
                  />
                </View>
                <View style={styles.miniField}>
                  <Text style={styles.miniLabel}>Unit cost</Text>
                  <TextInput
                    testID={`purchase-cost-${l.id}`}
                    style={styles.miniInput}
                    keyboardType="numeric"
                    value={String(fakeFinanceDisplay ? fakeUnitCost(Number(products?.find((p: any) => p.id === l.id)?.sale_price ?? 0), String(l.id)) : l.unit_cost)}
                    editable={!fakeFinanceDisplay}
                    onChangeText={(t) => setCost(l.id, parseFloat(t || "0"))}
                  />
                </View>
                <View style={styles.miniField}>
                  <Text style={styles.miniLabel}>Total</Text>
                  <Text style={styles.lineTotal}>{money(l.quantity * (fakeFinanceDisplay ? fakeUnitCost(Number(products?.find((p: any) => p.id === l.id)?.sale_price ?? 0), String(l.id)) : l.unit_cost))}</Text>
                </View>
              </View>
            </View>
          ))
        )}

        <Pressable testID="add-purchase-product-button" style={styles.addProductBtn} onPress={() => setPickerOpen(true)}>
          <MaterialDesignIcons name="plus" size={20} color={colors.brandPrimary} />
          <Text style={styles.addProductText}>Add product</Text>
        </Pressable>
      </KeyboardAwareScrollView>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.totalWrap}>
          <Text style={styles.totalLabel}>{fakeFinanceDisplay ? "Displayed purchase cost" : "Total cost"}</Text>
          <Text style={styles.totalValue}>{money(total)}</Text>
        </View>
        <Pressable testID="save-purchase-button" disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} onPress={save}>
          <MaterialDesignIcons name="check-bold" size={20} color={colors.onBrandPrimary} />
          <Text style={styles.saveText}>{busy ? "Saving…" : isEdit ? "Update purchase" : "Save purchase"}</Text>
        </Pressable>
      </View>

      {/* Product picker */}
      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Add products" subtitle="Select multiple items at once" topInset={insets.top} onBack={() => { setSelectedProductIds(new Set()); setProductSearch(""); setPickerOpen(false); }} />
          <View style={styles.searchWrap}><MaterialDesignIcons name="magnify" size={20} color={colors.muted} /><TextInput testID="purchase-product-search" style={styles.searchInput} placeholder="Search product, category or SKU" placeholderTextColor={colors.muted} value={productSearch} onChangeText={setProductSearch} /><Pressable onPress={() => setProductSearch("")} hitSlop={8}><MaterialDesignIcons name="close-circle" size={18} color={colors.muted} /></Pressable></View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 90, gap: 8 }}>            <Pressable
              testID="create-product-from-purchase"
              style={styles.createPartyBtn}
              onPress={() => setProductCreateOpen(true)}
            >
              <MaterialDesignIcons name="package-variant-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.createPartyText}>+ Add product not in stock</Text>
            </Pressable>

            {filteredPickerProducts.map((p) => {
              const added = lineIds.has(p.id);
              const selected = selectedProductIds.has(p.id);
              return (
                <Pressable
                  key={p.id}
                  testID={`pick-product-${p.id}`}
                  disabled={added}
                  style={[styles.pickRow, added && { opacity: 0.4 }, selected && styles.pickRowSelected]}
                  onPress={() => toggleProduct(p.id)}
                >
                  <View style={styles.checkCircle}>
                    <MaterialDesignIcons name={added || selected ? "check" : "checkbox-blank-outline"} size={22} color={added ? colors.muted : colors.brandPrimary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickName}>{p.name}</Text>
                    <Text style={styles.pickMeta}>Cost {money(fakeFinanceDisplay ? fakeUnitCost(Number(p.sale_price ?? 0), String(p.id)) : Number(p.purchase_price ?? 0))} · {p.quantity} in stock</Text>
                  </View>
                </Pressable>
              );
            })}
            {filteredPickerProducts.length === 0 && <Text style={styles.hint}>{productSearch.trim() ? "No matching products found." : "No products yet. Add products in Stock first."}</Text>}
          </ScrollView>
          <View style={[styles.pickerBottom, { paddingBottom: insets.bottom + 10 }]}>
            <Text style={styles.selectionText}>{selectedProductIds.size} selected</Text>
            <Pressable style={styles.addSelectedBtn} onPress={addSelectedProducts}>
              <MaterialDesignIcons name="plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.saveText}>Add selected</Text>
            </Pressable>
          </View>
        </View>
      </Modal>


      <Modal visible={productCreateOpen} animationType="slide" onRequestClose={() => setProductCreateOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Add product" subtitle="Create it here, then purchase stock" topInset={insets.top} onBack={() => setProductCreateOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
            <Text style={styles.formLabel}>Product name *</Text>
            <TextInput testID="new-purchase-product-name" style={styles.formInput} placeholder="Product name" placeholderTextColor={colors.muted} value={newProductName} onChangeText={setNewProductName} />
            <Text style={styles.formLabel}>Barcode / SKU</Text>
            <TextInput testID="new-purchase-product-barcode" style={styles.formInput} placeholder="Optional barcode" placeholderTextColor={colors.muted} value={newProductBarcode} onChangeText={setNewProductBarcode} />
            <Text style={styles.formLabel}>Sale price</Text>
            <TextInput testID="new-purchase-product-sale-price" style={styles.formInput} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.muted} value={newProductSalePrice} onChangeText={setNewProductSalePrice} />
            <Text style={styles.hint}>The purchase quantity and real purchase cost are entered on the purchase line. The same product record is used, so stock is not duplicated.</Text>
            <Pressable testID="save-new-purchase-product" style={styles.createPartySaveBtn} onPress={createProductForPurchase}>
              <MaterialDesignIcons name="package-variant-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.saveText}>Create & Add to Purchase</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* Supplier picker */}
      <Modal visible={supplierPickerOpen} animationType="slide" onRequestClose={() => setSupplierPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Select supplier" topInset={insets.top} onBack={() => setSupplierPickerOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
            <Pressable
              testID="create-supplier-button"
              style={styles.createPartyBtn}
              onPress={() => setSupplierCreateOpen(true)}
            >
              <MaterialDesignIcons name="account-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.createPartyText}>+ Create new supplier</Text>
            </Pressable>
            <Pressable testID="supplier-none" style={styles.pickRow} onPress={() => { setSupplierId(null); setSupplierPickerOpen(false); }}>
              <Text style={styles.pickName}>No supplier</Text>
              {!supplierId && <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />}
            </Pressable>
            {(suppliers ?? []).map((s) => (
              <Pressable key={s.id} testID={`supplier-${s.id}`} style={styles.pickRow} onPress={() => { setSupplierId(s.id); setSupplierPickerOpen(false); }}>
                <Text style={styles.pickName}>{s.name}</Text>
                {supplierId === s.id && <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />}
              </Pressable>
            ))}
            {(!suppliers || suppliers.length === 0) && (
              <Text style={styles.hint}>No suppliers yet. Add them in More → Suppliers.</Text>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Create supplier directly from purchase */}
      <Modal visible={supplierCreateOpen} animationType="slide" onRequestClose={() => setSupplierCreateOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Create supplier" subtitle="Add supplier without leaving purchase" topInset={insets.top} onBack={() => setSupplierCreateOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
            <Text style={styles.formLabel}>Supplier name *</Text>
            <TextInput testID="new-supplier-name" style={styles.formInput} placeholder="Supplier name" placeholderTextColor={colors.muted} value={newSupplierName} onChangeText={setNewSupplierName} />
            <Text style={styles.formLabel}>Phone</Text>
            <TextInput testID="new-supplier-phone" style={styles.formInput} placeholder="Phone number" placeholderTextColor={colors.muted} keyboardType="phone-pad" value={newSupplierPhone} onChangeText={setNewSupplierPhone} />
            <Text style={styles.formLabel}>Address</Text>
            <TextInput testID="new-supplier-address" style={[styles.formInput, styles.formInputMulti]} placeholder="Address (optional)" placeholderTextColor={colors.muted} multiline value={newSupplierAddress} onChangeText={setNewSupplierAddress} />
            <Pressable testID="save-new-supplier-button" style={styles.createPartySaveBtn} onPress={createSupplier}>
              <MaterialDesignIcons name="account-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.saveText}>Create & Select Supplier</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  supplierRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.brandTertiary,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  supplierText: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.onSurface },
  line: { backgroundColor: colors.surfaceSecondary, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10 },
  lineHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  lineName: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.onSurface },
  lineInputs: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  miniField: { flex: 1, gap: 4 },
  miniLabel: { fontSize: 11, color: colors.muted, fontWeight: "600" },
  miniInput: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    height: 44,
    fontSize: 15,
    color: colors.onSurface,
  },
  lineTotal: { fontSize: 15, fontWeight: "800", color: colors.brandPrimary, paddingVertical: 10 },
  addProductBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.brandSecondary,
    borderStyle: "dashed",
    paddingVertical: 16,
    backgroundColor: colors.brandTertiary,
  },
  addProductText: { fontSize: 15, fontWeight: "700", color: colors.brandPrimary },
  bottomBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
  },
  totalWrap: { flex: 1 },
  totalLabel: { fontSize: 12, color: colors.muted },
  totalValue: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    minHeight: 52,
    paddingHorizontal: 20,
  },
  saveText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "800" },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 12, height: 46, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  searchInput: { flex: 1, fontSize: 15, color: colors.onSurface },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  pickRowSelected: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  checkCircle: { width: 28, alignItems: "center", justifyContent: "center" },
  pickerBottom: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.surface },
  selectionText: { flex: 1, fontSize: 14, color: colors.muted, fontWeight: "700" },
  addSelectedBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 48, paddingHorizontal: 18, borderRadius: 12, backgroundColor: colors.brandPrimary },
  pickName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  pickMeta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  hint: { fontSize: 14, color: colors.muted, textAlign: "center", marginTop: 20 },
  createPartyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.brandPrimary, borderRadius: 12, paddingVertical: 14, marginBottom: 4 },
  createPartyText: { color: colors.onBrandPrimary, fontSize: 15, fontWeight: "800" },
  formLabel: { fontSize: 13, color: colors.muted, fontWeight: "700", marginTop: 4 },
  formInput: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, paddingHorizontal: 14, color: colors.onSurface, fontSize: 15 },
  formInputMulti: { minHeight: 90, paddingTop: 12, textAlignVertical: "top" },
  createPartySaveBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.brandPrimary, borderRadius: 14, minHeight: 52, marginTop: 8 }
}));
