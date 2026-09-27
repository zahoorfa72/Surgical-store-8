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

type Line = { id: string; name: string; quantity: number; unit_cost: number };

export default function Purchase() {
  const styles = useStyles();
  const { colors } = useTheme();
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
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
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
  const total = lines.reduce((s, l) => s + l.quantity * l.unit_cost, 0);
  const supplierName = suppliers?.find((s) => s.id === supplierId)?.name ?? "No supplier";

  const addLine = (pid: string, name: string, cost: number) => {
    setLines((prev) => [...prev, { id: pid, name, quantity: 1, unit_cost: cost }]);
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
                    value={String(l.unit_cost)}
                    onChangeText={(t) => setCost(l.id, parseFloat(t || "0"))}
                  />
                </View>
                <View style={styles.miniField}>
                  <Text style={styles.miniLabel}>Total</Text>
                  <Text style={styles.lineTotal}>{money(l.quantity * l.unit_cost)}</Text>
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
          <Text style={styles.totalLabel}>Total cost</Text>
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
          <ScreenHeader title="Add product" topInset={insets.top} onBack={() => setPickerOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
            {(products ?? []).map((p) => {
              const added = lineIds.has(p.id);
              return (
                <Pressable
                  key={p.id}
                  testID={`pick-product-${p.id}`}
                  disabled={added}
                  style={[styles.pickRow, added && { opacity: 0.4 }]}
                  onPress={() => addLine(p.id, p.name, p.purchase_price)}
                >
                  <View>
                    <Text style={styles.pickName}>{p.name}</Text>
                    <Text style={styles.pickMeta}>Cost {money(p.purchase_price)} · {p.quantity} in stock</Text>
                  </View>
                  <MaterialDesignIcons name={added ? "check" : "plus-circle"} size={22} color={colors.brandPrimary} />
                </Pressable>
              );
            })}
            {(!products || products.length === 0) && (
              <Text style={styles.hint}>No products yet. Add products in Stock first.</Text>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Supplier picker */}
      <Modal visible={supplierPickerOpen} animationType="slide" onRequestClose={() => setSupplierPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Select supplier" topInset={insets.top} onBack={() => setSupplierPickerOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
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
  pickName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  pickMeta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  hint: { fontSize: 14, color: colors.muted, textAlign: "center", marginTop: 20 },
}));
