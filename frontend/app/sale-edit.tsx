import { useCallback, useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useParties, useSale, useProducts, qk } from "@/src/data";
import { Loader, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { storage } from "@/src/utils/storage";

type Line = { id: string; name: string; quantity: number; unit_price: number };

export default function SaleEdit() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: sale, isLoading } = useSale(id ?? "");
  const { data: customers } = useParties("customer");
  const { data: products } = useProducts();

  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("0");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [custPickerOpen, setCustPickerOpen] = useState(false);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [showSellProfitDiscount, setShowSellProfitDiscount] = useState(true);
  const [saleEditLockHours, setSaleEditLockHours] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void storage.getItem<boolean>("ssm.showSellProfitDiscount", true).then((value) => {
        if (active) setShowSellProfitDiscount(value !== false);
      });
      void storage.getItem<number>("ssm.saleEditLockHours", 0).then((value) => {
        if (active) setSaleEditLockHours(Math.max(0, Number(value ?? 0)));
      });
      return () => { active = false; };
    }, []),
  );

  useEffect(() => {
    if (sale && !prefilled) {
      setLines(
        sale.items.map((it) => ({
          id: it.product_id,
          name: it.name,
          quantity: it.quantity,
          unit_price: it.unit_price,
        })),
      );
      setDiscount(String(sale.discount ?? 0));
      setCustomerId(sale.customer_id ?? null);
      setPrefilled(true);
    }
  }, [sale, prefilled]);

  const setQty = (lid: string, q: number) =>
    setLines((prev) => prev.map((l) => (l.id === lid ? { ...l, quantity: Math.max(0, q) } : l)));
  const setPrice = (lid: string, p: number) =>
    setLines((prev) => prev.map((l) => (l.id === lid ? { ...l, unit_price: Math.max(0, p) } : l)));
  const removeLine = (lid: string) => setLines((prev) => prev.filter((l) => l.id !== lid));
  const addProduct = (p: any) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.id === p.id);
      if (existing) return prev.map((l) => l.id === p.id ? { ...l, quantity: l.quantity + 1 } : l);
      return [...prev, { id: p.id, name: p.name, quantity: 1, unit_price: Number(p.sale_price ?? 0) }];
    });
    setProductPickerOpen(false); setProductSearch("");
  };

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  const discountNum = Math.max(0, parseFloat(discount) || 0);
  const total = Math.max(0, subtotal - discountNum);
  const customerName = customers?.find((c) => c.id === customerId)?.name ?? "Walk-in customer";

  const save = async () => {
    if (saleEditLockHours > 0 && sale?.created_at) {
      const ageHours = Math.max(0, (Date.now() - new Date(sale.created_at).getTime()) / 3600000);
      if (ageHours > saleEditLockHours) {
        Alert.alert("Sale is locked", `This sale is older than ${saleEditLockHours} hours and is protected by the store edit policy.`);
        return;
      }
    }
    const valid = lines.filter((l) => l.quantity > 0);
    if (!valid.length) {
      toast("A sale needs at least one item", "error");
      return;
    }
    const invalid = lines.find((l) => !Number.isFinite(l.quantity) || l.quantity <= 0 || !Number.isFinite(l.unit_price) || l.unit_price < 0);
    if (invalid) { toast("Check quantity and price for every item", "error"); return; }
    const stockById = new Map((products ?? []).map((p: any) => [p.id, Number(p.quantity ?? 0)]));
    const requested = new Map<string, number>();
    for (const l of lines) requested.set(l.id, (requested.get(l.id) ?? 0) + Math.floor(l.quantity));
    for (const [pid, qty] of requested) {
      const originalQty = sale.items.find((x) => x.product_id === pid)?.quantity ?? 0;
      const availableAfterRestore = (stockById.get(pid) ?? 0) + originalQty;
      if (qty > availableAfterRestore) { const name = lines.find((l) => l.id === pid)?.name ?? "Product"; toast(name + " has only " + availableAfterRestore + " available for this sale", "error"); return; }
    }
    setBusy(true);
    try {
      await apiRequest(`/sales/${id}`, {
        method: "PUT",
        body: {
          items: valid.map((l) => ({ product_id: l.id, quantity: l.quantity, unit_price: l.unit_price })),
          customer_id: customerId,
          discount: discountNum,
        },
      });
      await queryClient.invalidateQueries({ queryKey: qk.sales });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      await queryClient.invalidateQueries({ queryKey: qk.sale(id!) });
      toast("Sale updated", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Could not update sale", "error");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !sale) return <Loader />;

  return (
    <View style={styles.root}>
      <ScreenHeader title={`Edit ${sale.invoice_no}`} subtitle={saleEditLockHours > 0 ? `Edit policy: ${saleEditLockHours}h` : (showSellProfitDiscount ? "Adjust items, price & discount" : "Adjust items & price")} topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }} bottomOffset={20}>
        <Pressable testID="edit-select-customer-button" style={styles.customerRow} onPress={() => setCustPickerOpen(true)}>
          <MaterialDesignIcons name="account" size={20} color={colors.brandPrimary} />
          <Text style={styles.customerText}>{customerName}</Text>
          <MaterialDesignIcons name="chevron-right" size={22} color={colors.muted} />
        </Pressable>

        {lines.map((l) => (
          <View key={l.id} style={styles.line} testID={`edit-line-${l.id}`}>
            <View style={styles.lineHead}>
              <Text style={styles.lineName}>{l.name}</Text>
              <Pressable testID={`edit-remove-${l.id}`} hitSlop={8} onPress={() => removeLine(l.id)}>
                <MaterialDesignIcons name="close" size={20} color={colors.muted} />
              </Pressable>
            </View>
            <View style={styles.lineInputs}>
              <View style={styles.miniField}>
                <Text style={styles.miniLabel}>Quantity</Text>
                <TextInput
                  testID={`edit-qty-${l.id}`}
                  style={styles.miniInput}
                  keyboardType="numeric"
                  value={String(l.quantity)}
                  onChangeText={(t) => setQty(l.id, parseInt(t || "0", 10))}
                />
              </View>
              <View style={styles.miniField}>
                <Text style={styles.miniLabel}>Unit price</Text>
                <TextInput
                  testID={`edit-price-${l.id}`}
                  style={styles.miniInput}
                  keyboardType="numeric"
                  value={String(l.unit_price)}
                  onChangeText={(t) => setPrice(l.id, parseFloat(t || "0"))}
                />
              </View>
              <View style={styles.miniField}>
                <Text style={styles.miniLabel}>Total</Text>
                <Text style={styles.lineTotal}>{money(l.quantity * l.unit_price)}</Text>
              </View>
            </View>
          </View>
        ))}

        <Pressable testID="edit-add-product-button" style={styles.addProductBtn} onPress={() => setProductPickerOpen(true)}>
          <MaterialDesignIcons name="plus-circle-outline" size={20} color={colors.brandPrimary} />
          <Text style={styles.addProductText}>Add other product</Text>
        </Pressable>

        {showSellProfitDiscount && (
          <View style={styles.discountRow}>
            <Text style={styles.discountLabel}>Discount</Text>
            <TextInput
              testID="edit-discount-input"
              style={styles.discountInput}
              keyboardType="numeric"
              value={discount}
              onChangeText={setDiscount}
            />
          </View>
        )}

        <View style={styles.totalsCard}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Subtotal</Text>
            <Text style={styles.totalValue}>{money(subtotal)}</Text>
          </View>
          <View style={styles.totalRow}>
            {showSellProfitDiscount && <><Text style={styles.totalLabel}>Discount</Text>
            <Text style={styles.totalValue}>- {money(discountNum)}</Text></>}
          </View>
          <View style={styles.totalDivider} />
          <View style={styles.totalRow}>
            <Text style={styles.totalBold}>Total payable</Text>
            <Text style={styles.totalBold}>{money(total)}</Text>
          </View>
        </View>
      </KeyboardAwareScrollView>

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable testID="save-sale-edit-button" disabled={busy} style={[styles.saveBtn, busy && { opacity: 0.6 }]} onPress={save}>
          <MaterialDesignIcons name="check-bold" size={20} color={colors.onBrandPrimary} />
          <Text style={styles.saveText}>{busy ? "Saving…" : "Save changes"}</Text>
        </Pressable>
      </View>

      <Modal visible={productPickerOpen} animationType="slide" onRequestClose={() => setProductPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Add product" subtitle="Search and add another product" topInset={insets.top} onBack={() => setProductPickerOpen(false)} />
          <View style={styles.searchWrap}>
            <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
            <TextInput testID="edit-product-search" style={styles.searchInput} placeholder="Search product, category or SKU" placeholderTextColor={colors.muted} value={productSearch} onChangeText={setProductSearch} autoFocus />
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
            {(products ?? []).filter((p: any) => { const q = productSearch.trim().toLowerCase(); return !q || String(p.name ?? "").toLowerCase().includes(q) || String(p.category ?? "").toLowerCase().includes(q) || String(p.barcode ?? p.sku ?? "").toLowerCase().includes(q); }).map((p: any) => {
              const already = lines.some((l) => l.id === p.id);
              return <Pressable key={p.id} testID={"edit-add-product-" + p.id} disabled={already || Number(p.quantity ?? 0) <= 0} style={[styles.productOption, (already || Number(p.quantity ?? 0) <= 0) && { opacity: 0.45 }]} onPress={() => addProduct(p)}>
                <View style={{ flex: 1 }}><Text style={styles.productName}>{p.name}</Text><Text style={styles.productMeta}>Stock: {p.quantity} · Price: {money(Number(p.sale_price ?? 0))}</Text></View>
                <MaterialDesignIcons name={already ? "check-circle" : "plus-circle"} size={22} color={already ? colors.muted : colors.brandPrimary} />
              </Pressable>;
            })}
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={custPickerOpen} animationType="slide" onRequestClose={() => setCustPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Select customer" topInset={insets.top} onBack={() => setCustPickerOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
            <Pressable
              testID="edit-customer-walkin"
              style={styles.custOption}
              onPress={() => { setCustomerId(null); setCustPickerOpen(false); }}
            >
              <Text style={styles.custOptionText}>Walk-in customer</Text>
              {!customerId && <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />}
            </Pressable>
            {(customers ?? []).map((c) => (
              <Pressable
                key={c.id}
                testID={`edit-customer-${c.id}`}
                style={styles.custOption}
                onPress={() => { setCustomerId(c.id); setCustPickerOpen(false); }}
              >
                <Text style={styles.custOptionText}>{c.name}</Text>
                {customerId === c.id && <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.brandTertiary,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  customerText: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.onSurface },
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
  addProductBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.brandSecondary, backgroundColor: colors.brandTertiary },
  addProductText: { color: colors.brandPrimary, fontSize: 14, fontWeight: "800" },
  searchWrap: { flexDirection: "row", alignItems: "center", gap: 8, margin: 16, paddingHorizontal: 12, height: 46, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  searchInput: { flex: 1, fontSize: 15, color: colors.onSurface },
  productOption: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  productName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  productMeta: { fontSize: 12, color: colors.muted, marginTop: 3 },
  discountRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  discountLabel: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
  discountInput: {
    width: 130,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    height: 46,
    fontSize: 15,
    color: colors.onSurface,
    textAlign: "right",
  },
  totalsCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { fontSize: 14, color: colors.onSurfaceSecondary },
  totalValue: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  totalBold: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  totalDivider: { height: 1, backgroundColor: colors.divider, marginVertical: 4 },
  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    minHeight: 54,
  },
  saveText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "800" },
  custOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  custOptionText: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
}));
