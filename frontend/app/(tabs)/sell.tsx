import { useMemo, useState, useEffect } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { useParties, useProducts, qk } from "@/src/data";
import { useAuth } from "@/src/auth";
import { useOffline } from "@/src/offline";
import { Product } from "@/src/models";
import { BarcodeScannerModal } from "@/src/components/barcode-scanner";
import { EmptyState, Loader, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

type CartLine = { id: string; name: string; stock: number; quantity: number; unit_price: number; threshold: number };
type HeldSale = { id: string; createdAt: string; cart: CartLine[]; customerId: string | null; discount: string; credit: boolean };

export default function Sell() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { createSale } = useOffline();

  const { data: products, isLoading } = useProducts();
  const { data: customers } = useParties("customer");

  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [custPickerOpen, setCustPickerOpen] = useState(false);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [discount, setDiscount] = useState("0");
  const [credit, setCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);
  const [heldOpen, setHeldOpen] = useState(false);
  const [reviewSearch, setReviewSearch] = useState("");
  const [addProductOpen, setAddProductOpen] = useState(false);
  const [addProductSearch, setAddProductSearch] = useState("");

  const onScanned = (value: string) => {
    setScanOpen(false);
    const match = (products ?? []).find((p) => p.barcode && p.barcode === value.trim());
    if (match) {
      addToCart(match);
      toast(`Added ${match.name}`, "success");
    } else {
      toast("No product for this barcode", "error");
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [products, search]);

  const cartMap = useMemo(() => new Map(cart.map((c) => [c.id, c])), [cart]);
  const subtotal = cart.reduce((s, c) => s + c.quantity * c.unit_price, 0);
  const discountNum = Math.max(0, parseFloat(discount) || 0);
  const total = Math.max(0, subtotal - discountNum);
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0);

  const reviewedCart = useMemo(() => { const q = reviewSearch.trim().toLowerCase(); return cart.filter((c) => !q || c.name.toLowerCase().includes(q)); }, [cart, reviewSearch]);

  useEffect(() => { AsyncStorage.getItem("ssm.heldSales").then((raw) => { if (!raw) return; try { setHeldSales(JSON.parse(raw)); } catch { setHeldSales([]); } }); }, []);
  const persistHeldSales = async (next: HeldSale[]) => { setHeldSales(next); await AsyncStorage.setItem("ssm.heldSales", JSON.stringify(next)); };
  const holdCurrentSale = async () => { const lines = cart.filter((c) => c.quantity > 0); if (!lines.length) { toast("Add products before holding the sale", "error"); return; } const held: HeldSale = { id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, createdAt: new Date().toISOString(), cart: lines, customerId, discount, credit }; await persistHeldSales([held, ...heldSales]); setCart([]); setDiscount("0"); setCustomerId(null); setCredit(false); setReviewOpen(false); toast("Sale held. You can start a new sale.", "success"); };
  const resumeHeldSale = (held: HeldSale) => { if (cart.length) { Alert.alert("Current sale", "Hold or complete the current sale before opening another held sale."); return; } const restored = held.cart.map((line) => { const p = (products ?? []).find((x) => x.id === line.id); return { ...line, stock: p?.quantity ?? line.stock, threshold: p?.low_stock_threshold ?? line.threshold }; }).filter((line) => line.stock > 0); if (!restored.length) { toast("Products in this held sale are no longer available", "error"); return; } setCart(restored); setCustomerId(held.customerId); setDiscount(held.discount); setCredit(held.credit); void persistHeldSales(heldSales.filter((x) => x.id !== held.id)); setHeldOpen(false); setReviewOpen(true); };
  const deleteHeldSale = (held: HeldSale) => Alert.alert("Delete held sale?", "This removes only the held draft.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void persistHeldSales(heldSales.filter((x) => x.id !== held.id)) }]);

  const customerName =
    customers?.find((c) => c.id === customerId)?.name ?? "Walk-in customer";

  const addToCart = (p: Product) => {
    if (p.quantity <= 0) {
      toast(`${p.name} is out of stock`, "error");
      return;
    }
    setCart((prev) => {
      const found = prev.find((c) => c.id === p.id);
      if (found) {
        if (found.quantity >= p.quantity) {
          toast(`Only ${p.quantity} in stock`, "error");
          return prev;
        }
        return prev.map((c) => (c.id === p.id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      return [...prev, { id: p.id, name: p.name, stock: p.quantity, quantity: 1, unit_price: p.sale_price, threshold: p.low_stock_threshold }];
    });
  };

  const setQty = (id: string, qty: number) => {
    setCart((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, quantity: Math.min(Math.max(0, qty), c.stock) } : c))
        .filter((c) => c.quantity > 0)
    );
  };
  // Used by the editable Qty text field in the cart. Unlike the +/- steppers,
  // typing/clearing the field must NEVER remove the line (that made products
  // "vanish" while editing). The line stays; an empty field shows as 0 and is
  // simply ignored at checkout.
  const setQtyText = (id: string, text: string) => {
    const n = parseInt(text || "0", 10);
    const qty = isNaN(n) ? 0 : n;
    setCart((prev) =>
      prev.map((c) => (c.id === id ? { ...c, quantity: Math.min(Math.max(0, qty), c.stock) } : c))
    );
  };
  const setPrice = (id: string, price: number) =>
    setCart((prev) => prev.map((c) => (c.id === id ? { ...c, unit_price: Math.max(0, price) } : c)));
  const removeLine = (id: string) => setCart((prev) => prev.filter((c) => c.id !== id));

  const checkout = async () => {
    if (!cart.length) return;
    const lines = cart.filter((c) => c.quantity > 0);
    if (!lines.length) {
      toast("Set a quantity to sell", "error");
      return;
    }
    const invalid = lines.find((c) => !Number.isFinite(c.quantity) || c.quantity <= 0 || !Number.isFinite(c.unit_price) || c.unit_price < 0);
    if (invalid) {
      toast("Please enter a valid quantity and unit price", "error");
      return;
    }
    const overStock = lines.find((c) => c.quantity > c.stock);
    if (overStock) {
      toast(`${overStock.name} has only ${overStock.stock} in stock`, "error");
      return;
    }
    setBusy(true);
    try {
      const { sale, queued } = await createSale(
        {
          items: lines.map((c) => ({ product_id: c.id, quantity: Math.floor(c.quantity), unit_price: Number(c.unit_price) })),
          customer_id: customerId,
          discount: Number(discountNum),
          credit,
        },
        user?.name || user?.email || "Staff",
      );
      await queryClient.invalidateQueries({ queryKey: qk.products });
      await queryClient.invalidateQueries({ queryKey: qk.sales });
      setCart([]);
      setDiscount("0");
      setCustomerId(null);
      setCredit(false);
      setReviewOpen(false);
      toast(queued ? "Saved offline — will sync when online" : "Sale completed", queued ? "info" : "success");
      router.push(`/receipt?id=${sale.id}`);
    } catch (e: any) {
      toast(e?.message || "Could not complete sale", "error");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Loader />;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Sell" subtitle="Add items to the cart" topInset={insets.top} showStatus />

      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
          <TextInput
            testID="product-search-input"
            style={styles.searchInput}
            placeholder="Search products"
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
          />
        </View>
        <Pressable testID="scan-to-cart-button" style={styles.scanBtn} onPress={() => setScanOpen(true)}>
          <MaterialDesignIcons name="barcode-scan" size={24} color={colors.onBrandPrimary} />
        </Pressable>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 140, gap: 10 }}
        ListEmptyComponent={
          <EmptyState
            icon="package-variant"
            title="No products"
            message="Add products in Stock to start selling."
            testID="sell-empty"
          />
        }
        renderItem={({ item }) => {
          const line = cartMap.get(item.id);
          const out = item.quantity <= 0;
          const low = !out && item.quantity <= item.low_stock_threshold;
          return (
            <View style={styles.prodRow} testID={`product-${item.id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.prodName}>{item.name}</Text>
                <Text style={styles.prodMeta}>
                  {money(item.sale_price)} · {out ? "Out of stock" : `${item.quantity} in stock`}
                </Text>
                {low && (
                  <View style={styles.lowTagRow} testID={`low-stock-tag-${item.id}`}>
                    <MaterialDesignIcons name="alert-outline" size={13} color={colors.warning} />
                    <Text style={styles.lowTagText}>Low stock · reorder soon</Text>
                  </View>
                )}
              </View>
              {line ? (
                <View style={styles.stepper}>
                  <Pressable
                    testID={`dec-${item.id}`}
                    style={styles.stepBtn}
                    onPress={() => setQty(item.id, line.quantity - 1)}
                  >
                    <MaterialDesignIcons name="minus" size={18} color={colors.brandPrimary} />
                  </Pressable>
                  <Text style={styles.stepQty}>{line.quantity}</Text>
                  <Pressable
                    testID={`inc-${item.id}`}
                    style={styles.stepBtn}
                    onPress={() => setQty(item.id, line.quantity + 1)}
                  >
                    <MaterialDesignIcons name="plus" size={18} color={colors.brandPrimary} />
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  testID={`add-${item.id}`}
                  disabled={out}
                  style={[styles.addBtn, out && { opacity: 0.4 }]}
                  onPress={() => addToCart(item)}
                >
                  <MaterialDesignIcons name="cart-plus" size={20} color={colors.onBrandPrimary} />
                </Pressable>
              )}
            </View>
          );
        }}
      />

      <View style={styles.bottomActions}><Pressable testID="held-sales-button" style={styles.heldBtn} onPress={() => setHeldOpen(true)}><MaterialDesignIcons name="pause-circle-outline" size={20} color={colors.brandPrimary} /><Text style={styles.heldBtnText}>Held ({heldSales.length})</Text></Pressable>{cart.length > 0 && (
        <Pressable
          testID="open-cart-button"
          style={[styles.cartBar, { paddingBottom: 14 }]}
          onPress={() => setReviewOpen(true)}
        >
          <View style={styles.cartCountBubble}>
            <Text style={styles.cartCountText}>{cartCount}</Text>
          </View>
          <Text style={styles.cartBarText}>Review & Checkout</Text>
          <Text style={styles.cartBarTotal}>{money(subtotal)}</Text>
        </Pressable> )}</View>

      {/* Cart review modal */}
      <Modal visible={reviewOpen} animationType="slide" onRequestClose={() => setReviewOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader
            title="Cart"
            subtitle={`${cartCount} item(s)`}
            topInset={insets.top}
            onBack={() => setReviewOpen(false)}
          />
          <View style={styles.reviewSearchRow}><MaterialDesignIcons name="magnify" size={20} color={colors.muted} /><TextInput testID="review-search-input" style={styles.searchInput} placeholder="Search items in this sale" placeholderTextColor={colors.muted} value={reviewSearch} onChangeText={setReviewSearch} /><Pressable testID="review-add-products" onPress={() => setAddProductOpen(true)} style={styles.reviewAddBtn}><MaterialDesignIcons name="plus" size={20} color={colors.onBrandPrimary} /><Text style={styles.reviewAddText}>Add</Text></Pressable></View>
          <KeyboardAwareScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}
            bottomOffset={20}
          >
            <Pressable
              testID="select-customer-button"
              style={styles.customerRow}
              onPress={() => setCustPickerOpen(true)}
            >
              <MaterialDesignIcons name="account" size={20} color={colors.brandPrimary} />
              <Text style={styles.customerText}>{customerName}</Text>
              <MaterialDesignIcons name="chevron-right" size={22} color={colors.muted} />
            </Pressable>

            {reviewedCart.map((c) => (
              <View key={c.id} style={styles.cartLine} testID={`cart-line-${c.id}`}>
                <View style={styles.cartLineHead}>
                  <Text style={styles.cartLineName}>{c.name}</Text>
                  <Pressable testID={`remove-${c.id}`} onPress={() => removeLine(c.id)} hitSlop={8}>
                    <MaterialDesignIcons name="close" size={20} color={colors.muted} />
                  </Pressable>
                </View>
                <View style={styles.cartLineInputs}>
                  <View style={styles.miniField}>
                    <Text style={styles.miniLabel}>Qty (max {c.stock})</Text>
                    <TextInput
                      testID={`qty-input-${c.id}`}
                      style={styles.miniInput}
                      keyboardType="numeric"
                      value={c.quantity === 0 ? "" : String(c.quantity)}
                      placeholder="0"
                      placeholderTextColor={colors.muted}
                      onChangeText={(t) => setQtyText(c.id, t)}
                    />
                  </View>
                  <View style={styles.miniField}>
                    <Text style={styles.miniLabel}>Unit price</Text>
                    <TextInput
                      testID={`price-input-${c.id}`}
                      style={styles.miniInput}
                      keyboardType="numeric"
                      value={String(c.unit_price)}
                      onChangeText={(t) => setPrice(c.id, parseFloat(t || "0"))}
                    />
                  </View>
                  <View style={styles.lineTotalBox}>
                    <Text style={styles.miniLabel}>Total</Text>
                    <Text style={styles.lineTotal}>{money(c.quantity * c.unit_price)}</Text>
                  </View>
                </View>
                {c.stock - c.quantity <= c.threshold && (
                  <View style={styles.lowWarn} testID={`low-stock-warn-${c.id}`}>
                    <MaterialDesignIcons name="alert-outline" size={15} color={colors.warning} />
                    <Text style={styles.lowWarnText}>
                      {c.stock - c.quantity <= 0
                        ? "This sale uses the last of your stock"
                        : `Only ${c.stock - c.quantity} will remain — consider reordering`}
                    </Text>
                  </View>
                )}
              </View>
            ))}

            <View style={styles.discountRow}>
              <Text style={styles.discountLabel}>Discount</Text>
              <TextInput
                testID="discount-input"
                style={styles.discountInput}
                keyboardType="numeric"
                value={discount}
                onChangeText={setDiscount}
              />
            </View>

            <Pressable
              testID="credit-toggle"
              style={styles.creditRow}
              onPress={() => {
                if (!customerId) {
                  toast("Select a customer for credit sale", "error");
                  return;
                }
                setCredit((v) => !v);
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.discountLabel}>Sell on credit (pay later)</Text>
                <Text style={styles.creditHint}>Adds the total to the customer's owed balance</Text>
              </View>
              <MaterialDesignIcons
                name={credit ? "toggle-switch" : "toggle-switch-off-outline"}
                size={40}
                color={credit ? colors.brandPrimary : colors.muted}
              />
            </Pressable>

            <View style={styles.totalsCard}>
              <Row label="Subtotal" value={money(subtotal)} />
              <Row label="Discount" value={"- " + money(discountNum)} />
              <View style={styles.totalDivider} />
              <Row label={credit ? "Total (on credit)" : "Total payable"} value={money(total)} bold />
            </View>
          </KeyboardAwareScrollView>

          <View style={[styles.checkoutBar, { paddingBottom: insets.bottom + 12 }]}>
            <Pressable
              testID="checkout-button"
              disabled={busy}
              style={[styles.checkoutBtn, busy && { opacity: 0.6 }]}
              onPress={checkout}
            >
              <MaterialDesignIcons name="check-bold" size={22} color={colors.onBrandPrimary} />
              <Text style={styles.checkoutText}>{busy ? "Processing…" : `Complete Sale · ${money(total)}`}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={heldOpen} animationType="slide" onRequestClose={() => setHeldOpen(false)}><View style={styles.root}><ScreenHeader title="Held sales" subtitle="Resume a sale whenever you need" topInset={insets.top} onBack={() => setHeldOpen(false)} /><ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}>{heldSales.length === 0 ? <EmptyState icon="pause-circle-outline" title="No held sales" message="Hold a sale to continue it later." /> : heldSales.map((h) => <View key={h.id} style={styles.heldCard}><View style={{ flex: 1 }}><Text style={styles.heldTitle}>{new Date(h.createdAt).toLocaleString()}</Text><Text style={styles.heldMeta}>{h.cart.length} product(s) · {h.cart.reduce((n,x)=>n+x.quantity,0)} unit(s)</Text><Text style={styles.heldProducts} numberOfLines={2}>{h.cart.map(x=>x.name).join(" · ")}</Text></View><View style={styles.heldActions}><Pressable onPress={() => resumeHeldSale(h)} style={styles.resumeBtn}><MaterialDesignIcons name="play" size={18} color={colors.onBrandPrimary} /><Text style={styles.resumeText}>Open</Text></Pressable><Pressable onPress={() => deleteHeldSale(h)} hitSlop={8}><MaterialDesignIcons name="delete-outline" size={22} color={colors.error} /></Pressable></View></View>)}</ScrollView></View></Modal>
      <Modal visible={addProductOpen} animationType="slide" onRequestClose={() => setAddProductOpen(false)}><View style={styles.root}><ScreenHeader title="Add products" subtitle="Search and add to this sale" topInset={insets.top} onBack={() => setAddProductOpen(false)} /><View style={[styles.searchWrap,{margin:16}]}><MaterialDesignIcons name="magnify" size={20} color={colors.muted}/><TextInput testID="review-product-search-input" style={styles.searchInput} placeholder="Search product, category or SKU" placeholderTextColor={colors.muted} value={addProductSearch} onChangeText={setAddProductSearch} autoFocus /></View><FlatList data={(products??[]).filter(p=>{const q=addProductSearch.trim().toLowerCase();return !q||p.name.toLowerCase().includes(q)||String(p.category??"").toLowerCase().includes(q)||String(p.barcode??p.sku??"").toLowerCase().includes(q)})} keyExtractor={p=>p.id} contentContainerStyle={{padding:16,gap:8}} renderItem={({item})=><Pressable disabled={item.quantity<=0} style={[styles.addProductOption,item.quantity<=0&&{opacity:.45}]} onPress={()=>addToCart(item)}><View style={{flex:1}}><Text style={styles.prodName}>{item.name}</Text><Text style={styles.prodMeta}>{item.quantity} in stock · {money(item.sale_price)}</Text></View><MaterialDesignIcons name="plus-circle" size={22} color={colors.brandPrimary}/></Pressable>} /></View></Modal>

      {/* Customer picker */}
      <Modal visible={custPickerOpen} animationType="slide" onRequestClose={() => setCustPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Select customer" topInset={insets.top} onBack={() => setCustPickerOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
            <Pressable
              testID="customer-walkin"
              style={styles.custOption}
              onPress={() => {
                setCustomerId(null);
                setCustPickerOpen(false);
              }}
            >
              <Text style={styles.custOptionText}>Walk-in customer</Text>
              {!customerId && <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />}
            </Pressable>
            {(customers ?? []).map((c) => (
              <Pressable
                key={c.id}
                testID={`customer-${c.id}`}
                style={styles.custOption}
                onPress={() => {
                  setCustomerId(c.id);
                  setCustPickerOpen(false);
                }}
              >
                <View>
                  <Text style={styles.custOptionText}>{c.name}</Text>
                  {!!c.phone && <Text style={styles.custPhone}>{c.phone}</Text>}
                </View>
                {customerId === c.id && (
                  <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />
                )}
              </Pressable>
            ))}
            {(!customers || customers.length === 0) && (
              <Text style={styles.custHint}>No customers yet. Add them in More → Customers.</Text>
            )}
          </ScrollView>
        </View>
      </Modal>

      <BarcodeScannerModal visible={scanOpen} onClose={() => setScanOpen(false)} onScanned={onScanned} />
    </View>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && styles.totalBold]}>{label}</Text>
      <Text style={[styles.totalValue, bold && styles.totalBold]}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 12 },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scanBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.onSurface },
  prodRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  prodName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  prodMeta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  lowTagRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  lowTagText: { fontSize: 12, color: colors.warning, fontWeight: "700" },
  lowWarn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.warning + "18",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  lowWarnText: { flex: 1, fontSize: 12.5, color: colors.warning, fontWeight: "600" },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepQty: { minWidth: 26, textAlign: "center", fontSize: 16, fontWeight: "800", color: colors.onSurface },
  bottomActions: { position:"absolute", left:12, right:12, bottom:10, flexDirection:"row", alignItems:"center", gap:8 },
  heldBtn: { minHeight:52, paddingHorizontal:14, borderRadius:14, borderWidth:1, borderColor:colors.border, backgroundColor:colors.surface, flexDirection:"row", alignItems:"center", gap:6 },
  heldBtnText: { fontSize:13, fontWeight:"800", color:colors.brandPrimary },
  holdCheckoutRow: { paddingHorizontal:16, paddingTop:8, backgroundColor:colors.surface },
  holdSaleBtn: { minHeight:44, paddingHorizontal:16, borderRadius:12, borderWidth:1, borderColor:colors.brandPrimary, flexDirection:"row", alignItems:"center", justifyContent:"center", gap:7 },
  holdSaleText: { color:colors.brandPrimary, fontSize:14, fontWeight:"800" },
  reviewSearchRow: { marginHorizontal:16, marginBottom:4, minHeight:46, borderWidth:1, borderColor:colors.border, borderRadius:12, flexDirection:"row", alignItems:"center", paddingLeft:12, paddingRight:6, gap:7, backgroundColor:colors.surfaceSecondary },
  reviewAddBtn: { minHeight:36, paddingHorizontal:10, borderRadius:9, backgroundColor:colors.brandPrimary, flexDirection:"row", alignItems:"center", gap:4 },
  reviewAddText: { color:colors.onBrandPrimary, fontWeight:"800", fontSize:12 },
  heldCard: { borderWidth:1, borderColor:colors.border, borderRadius:14, padding:13, backgroundColor:colors.surface, flexDirection:"row", gap:10 },
  heldTitle: { fontSize:14, fontWeight:"800", color:colors.onSurface }, heldMeta:{fontSize:12,color:colors.muted,marginTop:3}, heldProducts:{fontSize:12,color:colors.onSurfaceSecondary,marginTop:6}, heldActions:{alignItems:"center",justifyContent:"center",gap:12}, resumeBtn:{minHeight:38,paddingHorizontal:11,borderRadius:9,backgroundColor:colors.brandPrimary,flexDirection:"row",alignItems:"center",gap:4}, resumeText:{color:colors.onBrandPrimary,fontSize:12,fontWeight:"800"}, addProductOption:{flexDirection:"row",alignItems:"center",gap:10,padding:13,borderRadius:12,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface},
  cartBar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.brandPrimary,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  cartCountBubble: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.onBrandPrimary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  cartCountText: { color: colors.brandPrimary, fontWeight: "800", fontSize: 14 },
  cartBarText: { flex: 1, color: colors.onBrandPrimary, fontWeight: "700", fontSize: 16 },
  cartBarTotal: { color: colors.onBrandPrimary, fontWeight: "800", fontSize: 16 },
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
  cartLine: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  cartLineHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cartLineName: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.onSurface },
  cartLineInputs: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
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
  lineTotalBox: { flex: 1, gap: 4 },
  lineTotal: { fontSize: 15, fontWeight: "800", color: colors.brandPrimary, paddingVertical: 10 },
  discountRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  discountLabel: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
  creditRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  creditHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
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
  checkoutBar: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
  },
  checkoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    minHeight: 54,
  },
  checkoutText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "800" },
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
  custPhone: { fontSize: 13, color: colors.muted, marginTop: 2 },
  custHint: { fontSize: 14, color: colors.muted, textAlign: "center", marginTop: 20 },
}));
