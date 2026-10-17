import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as ImagePicker from "expo-image-picker";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import { ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { scheduleAutomaticGoogleDriveBackup } from "@/src/auto-backup";

type WProduct = { id: string; name: string; sku: string; quantity: number; cost: number; price: number };
type WParty = { id: string; name: string; phone: string; address: string; type: "customer" | "supplier" };
type WItem = { productId: string; name: string; quantity: number; cost: number; price: number; lineTotal: number; itemDiscountMode?: "amount" | "percentage"; itemDiscountValue?: number };
type WSale = { id: string; invoice: string; customer: string; customerPhone: string; items: WItem[]; subtotal: number; discount: number; cartDiscountAmount?: number; cartDiscountMode?: "amount" | "percentage"; cartDiscountValue?: number; total: number; profit: number; date: string };
type WState = { products: WProduct[]; parties: WParty[]; sales: WSale[]; name: string; logo: string | null };
const KEY = "surgical-store.wholesale.v1";
const emptyState: WState = { products: [], parties: [], sales: [], name: "Wholesale Store", logo: null };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const n = (v: string) => Math.max(0, Number(v) || 0);

export default function WholesaleStore() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<WState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const firstPersist = useRef(true);
  const [tab, setTab] = useState<"dashboard" | "products" | "sale" | "parties" | "history" | "settings">("dashboard");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("1");
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [partyName, setPartyName] = useState("");
  const [partyPhone, setPartyPhone] = useState("");
  const [partyAddress, setPartyAddress] = useState("");
  const [partyType, setPartyType] = useState<"customer" | "supplier">("customer");
  const [customer, setCustomer] = useState("");
  const [cart, setCart] = useState<WItem[]>([]);
  const [discount, setDiscount] = useState("0");
  const [discountMode, setDiscountMode] = useState<"amount" | "percentage">("amount");
  const [salePriceOverride, setSalePriceOverride] = useState("");
  const [selectedProduct, setSelectedProduct] = useState("");
  const [restockAmounts, setRestockAmounts] = useState<Record<string, string>>({});
  const [editingSale, setEditingSale] = useState<string | null>(null);
  const [range, setRange] = useState<"today" | "week" | "month" | "year" | "all">("today");
  const [storeName, setStoreName] = useState("Wholesale Store");

  useEffect(() => {
    AsyncStorage.getItem(KEY).then(raw => {
      if (raw) {
        try { const parsed = JSON.parse(raw) as WState; setState({ ...emptyState, ...parsed }); setStoreName(parsed.name || "Wholesale Store"); }
        catch { toast("Wholesale data could not be read. Existing retail data was not changed.", "error"); }
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(KEY, JSON.stringify({ ...state, name: storeName }))
      .then(() => {
        // Skip the initial hydration write; only actual wholesale edits schedule a backup.
        if (firstPersist.current) { firstPersist.current = false; return; }
        scheduleAutomaticGoogleDriveBackup(7000);
      })
      .catch(() => toast("Could not save wholesale data on this device.", "error"));
  }, [state, storeName, loaded]);

  const patchState = (patch: Partial<WState>) => setState(prev => ({ ...prev, ...patch }));
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const itemDiscountAmount = (item: WItem) => {
    const base = item.price * item.quantity;
    const value = Math.max(0, item.itemDiscountValue || 0);
    const requested = item.itemDiscountMode === "percentage" ? base * Math.min(100, value) / 100 : value * item.quantity;
    return Math.min(base, requested);
  };
  const itemDiscountTotal = cart.reduce((sum, item) => sum + itemDiscountAmount(item), 0);
  const afterItemDiscounts = Math.max(0, total - itemDiscountTotal);
  const discountValue = Math.min(afterItemDiscounts, discountMode === "percentage" ? afterItemDiscounts * Math.min(100, n(discount)) / 100 : n(discount));
  const net = Math.max(0, afterItemDiscounts - discountValue);
  const totalDiscount = itemDiscountTotal + discountValue;
  const profit = net - cart.reduce((sum, item) => sum + item.cost * item.quantity, 0);
  const rangeStart = useMemo(() => {
    const d = new Date();
    if (range === "today") d.setHours(0, 0, 0, 0);
    if (range === "week") { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); }
    if (range === "month") { d.setDate(1); d.setHours(0, 0, 0, 0); }
    if (range === "year") { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); }
    return range === "all" ? 0 : d.getTime();
  }, [range]);
  const salesInRange = state.sales.filter(s => new Date(s.date).getTime() >= rangeStart);
  const revenue = salesInRange.reduce((s, r) => s + r.total, 0);
  const netProfit = salesInRange.reduce((s, r) => s + r.profit, 0);

  const saveProduct = () => {
    if (!name.trim()) return toast("Enter a product name.", "error");
    const item: WProduct = { id: editingProduct || uid(), name: name.trim(), sku: sku.trim(), quantity: n(qty), cost: n(cost), price: n(price) };
    const products = editingProduct ? state.products.map(p => p.id === editingProduct ? item : p) : [...state.products, item];
    patchState({ products }); setName(""); setSku(""); setQty("1"); setCost(""); setPrice(""); setEditingProduct(null);
    toast(editingProduct ? "Wholesale product updated." : "Wholesale product saved.", "success");
  };
  const editProduct = (p: WProduct) => { setEditingProduct(p.id); setName(p.name); setSku(p.sku); setQty(String(p.quantity)); setCost(String(p.cost)); setPrice(String(p.price)); setTab("products"); };
  const deleteProduct = (p: WProduct) => Alert.alert("Delete wholesale product?", p.name, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => patchState({ products: state.products.filter(x => x.id !== p.id) }) }]);

  const addCartItem = () => {
    const p = state.products.find(x => x.id === selectedProduct);
    if (!p) return toast("Select a wholesale product.", "error");
    const quantity = n(qty) || 1;
    // Wholesale B2B orders may be entered against incoming stock; shortages are visible as negative stock.
    const unitPrice = salePriceOverride.trim() ? n(salePriceOverride) : p.price;
    setCart(prev => [...prev, { productId: p.id, name: p.name, quantity, cost: p.cost, price: unitPrice, lineTotal: unitPrice * quantity, itemDiscountMode: "amount", itemDiscountValue: 0 }]);
    setSelectedProduct(""); setSalePriceOverride(""); setQty("1");
  };

  const restockProduct = (productId: string) => {
    const amount = n(restockAmounts[productId] || "");
    if (amount <= 0) return toast("Enter a restock quantity greater than zero.", "error");
    const product = state.products.find(p => p.id === productId);
    if (!product) return toast("Wholesale product not found.", "error");
    patchState({ products: state.products.map(p => p.id === productId ? { ...p, quantity: p.quantity + amount } : p) });
    setRestockAmounts(prev => ({ ...prev, [productId]: "" }));
    toast("Wholesale stock increased. Continue with the sale.", "success");
  };
  const saveSale = () => {
    if (!cart.length) return toast("Add at least one item.", "error");
    const byProduct = new Map<string, number>();
    cart.forEach(i => byProduct.set(i.productId, (byProduct.get(i.productId) || 0) + i.quantity));
    for (const id of byProduct.keys()) {
      if (!state.products.some(p => p.id === id)) return toast("A product in this cart no longer exists. Remove it and try again.", "error");
    }
    const sub = total;
    const disc = totalDiscount;
    const sale: WSale = { id: editingSale || uid(), invoice: editingSale ? (state.sales.find(s => s.id === editingSale)?.invoice || "W-" + Date.now()) : "W-" + Date.now().toString().slice(-8), customer: customer.trim() || "Walk-in customer", customerPhone: state.parties.find(p => p.name === customer.trim() && p.type === "customer")?.phone || "", items: cart.map(i => ({ ...i })), subtotal: sub, discount: disc, cartDiscountAmount: discountValue, cartDiscountMode: discountMode, cartDiscountValue: n(discount), total: net, profit, date: editingSale ? (state.sales.find(s => s.id === editingSale)?.date || new Date().toISOString()) : new Date().toISOString() };
    let products = state.products.map(p => {
      const sold = byProduct.get(p.id) || 0;
      const old = editingSale ? (state.sales.find(s => s.id === editingSale)?.items.filter(i => i.productId === p.id).reduce((a, i) => a + i.quantity, 0) || 0) : 0;
      return sold || old ? { ...p, quantity: p.quantity + old - sold } : p;
    });
    const sales = editingSale ? state.sales.map(s => s.id === editingSale ? sale : s) : [sale, ...state.sales];
    patchState({ products, sales }); setCart([]); setDiscount("0"); setDiscountMode("amount"); setCustomer(""); setEditingSale(null); setTab("history");
    toast(editingSale ? "Wholesale sale updated; stock and profit recalculated." : "Wholesale sale saved and stock updated.", "success");
  };
  const editSale = (s: WSale) => { setEditingSale(s.id); setCustomer(s.customer); setCart(s.items.map(i => ({ ...i, itemDiscountMode: i.itemDiscountMode || "amount", itemDiscountValue: i.itemDiscountValue || 0 }))); setDiscount(String(s.cartDiscountValue ?? s.cartDiscountAmount ?? s.discount)); setDiscountMode(s.cartDiscountMode || "amount"); setTab("sale"); };
  const deleteSale = (s: WSale) => Alert.alert("Delete wholesale sale?", "The sale will be removed and its quantities returned to wholesale stock.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => {
    const products = state.products.map(p => ({ ...p, quantity: p.quantity + s.items.filter(i => i.productId === p.id).reduce((a, i) => a + i.quantity, 0) }));
    patchState({ products, sales: state.sales.filter(x => x.id !== s.id) });
  } }]);
  const saveParty = () => {
    if (!partyName.trim()) return toast("Enter a customer or supplier name.", "error");
    const party: WParty = { id: uid(), name: partyName.trim(), phone: partyPhone.trim(), address: partyAddress.trim(), type: partyType };
    patchState({ parties: [...state.parties, party] }); setPartyName(""); setPartyPhone(""); setPartyAddress(""); toast("Wholesale party saved.", "success");
  };
  const pickLogo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.65 });
    if (!result.canceled && result.assets[0]?.uri) {
      try {
        const response = await fetch(result.assets[0].uri); const blob = await response.blob();
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onloadend = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("logo")); reader.onerror = reject; reader.readAsDataURL(blob); });
        patchState({ logo: data }); toast("Wholesale logo saved.", "success");
      } catch { toast("Could not load this logo.", "error"); }
    }
  };
  const printSale = async (s: WSale, format: "58" | "75" | "A4") => {
    const width = format === "58" ? 54 : 71;
    const rows = s.items.map((i, index) => { const base = i.price * i.quantity; const itemDisc = Math.min(base, i.itemDiscountMode === "percentage" ? base * Math.min(100, i.itemDiscountValue || 0) / 100 : Math.max(0, i.itemDiscountValue || 0) * i.quantity); return "<tr><td>" + (index + 1) + "</td><td>" + esc(i.name) + "</td><td>" + i.quantity + "</td><td>Rs " + i.price.toLocaleString() + "</td><td>Rs " + itemDisc.toLocaleString() + "</td><td>Rs " + (base - itemDisc).toLocaleString() + "</td></tr>"; }).join("");
    const savedItemDiscount = s.items.reduce((sum, i) => { const base = i.price * i.quantity; return sum + Math.min(base, i.itemDiscountMode === "percentage" ? base * Math.min(100, i.itemDiscountValue || 0) / 100 : Math.max(0, i.itemDiscountValue || 0) * i.quantity); }, 0);
    const savedCartDiscount = s.cartDiscountAmount ?? Math.max(0, s.discount - savedItemDiscount);
    const html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>@page{size:" + (format === "A4" ? "A4" : width + "mm auto") + ";margin:3mm}body{font-family:Arial,sans-serif;width:" + (format === "A4" ? "190mm" : width + "mm") + ";font-size:" + (format === "A4" ? "13px" : "10px") + ";margin:auto}h2{text-align:center}img{display:block;max-width:65mm;max-height:30mm;object-fit:contain;margin:auto}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #bbb;padding:4px 2px;text-align:left}.total{font-weight:bold;text-align:right}</style></head><body>" + (state.logo ? "<img src='" + state.logo + "'>" : "") + "<h2>" + esc(storeName) + "</h2><p>Wholesale B2B receipt<br>Invoice: " + s.invoice + "<br>Date: " + new Date(s.date).toLocaleString() + "<br>Customer: " + esc(s.customer) + "</p><table><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Price</th><th>Item disc.</th><th>Net</th></tr></thead><tbody>" + rows + "</tbody></table><p>Subtotal: Rs " + s.subtotal.toLocaleString() + "<br>Item discounts: Rs " + savedItemDiscount.toLocaleString() + "<br>Cart discount: Rs " + savedCartDiscount.toLocaleString() + "<br>Total discounts: Rs " + s.discount.toLocaleString() + "</p><h3 class='total'>Net total: Rs " + s.total.toLocaleString() + "</h3><p style='text-align:center'>Thank you for your business</p></body></html>";
    try { const file = await Print.printToFileAsync({ html, width: format === "A4" ? undefined : Math.round(width * 3.7795), height: format === "A4" ? undefined : 2000 }); if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: "Wholesale receipt " + s.invoice }); else await Print.printAsync({ html }); }
    catch { try { await Print.printAsync({ html }); } catch { toast("Could not print receipt.", "error"); } }
  };
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const nav = (value: typeof tab, label: string, icon: string) => <Pressable key={value} onPress={() => setTab(value)} style={[styles.navButton, tab === value && { backgroundColor: colors.brandPrimary }]}><MaterialDesignIcons name={icon as any} size={18} color={tab === value ? colors.onBrandPrimary : colors.onSurface} /><Text style={[styles.navText, { color: tab === value ? colors.onBrandPrimary : colors.onSurface }]}>{label}</Text></Pressable>;
  const field = (label: string, value: string, change: (v: string) => void, keyboardType: "default" | "numeric" | "phone-pad" = "default") => <View style={styles.field} key={label}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={change} keyboardType={keyboardType} placeholder={label} placeholderTextColor={colors.muted} style={styles.input} /></View>;
  const button = (label: string, action: () => void, secondary = false) => <Pressable onPress={action} style={[styles.button, secondary && { backgroundColor: colors.surfaceTertiary }]}><Text style={[styles.buttonText, secondary && { color: colors.onSurface }]}>{label}</Text></Pressable>;

  return <View style={styles.root}>
    <ScreenHeader title="Wholesale Store" subtitle="Inside this app · independent wholesale business" topInset={insets.top} onBack={() => router.back()} />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.nav}>{nav("dashboard", "Overview", "view-dashboard")}{nav("products", "Stock", "package-variant")}{nav("sale", "New sale", "cart-plus")}{nav("parties", "Parties", "account-group")}{nav("history", "Sales", "receipt")}{nav("settings", "Branding", "store-cog")}</ScrollView>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {tab === "dashboard" && <>
        <Text style={styles.heading}>{storeName}</Text>
        <Text style={styles.muted}>This Wholesale Store is inside the Surgical Store app, but its stock, sales, customers, revenue, discounts and net profit are kept separate from retail features and retail reports.</Text>
        <View style={styles.grid}><View style={styles.stat}><Text style={styles.muted}>Revenue</Text><Text style={styles.statValue}>{money(revenue)}</Text></View><View style={styles.stat}><Text style={styles.muted}>Net profit</Text><Text style={styles.statValue}>{money(netProfit)}</Text></View><View style={styles.stat}><Text style={styles.muted}>Products</Text><Text style={styles.statValue}>{state.products.length}</Text></View><View style={styles.stat}><Text style={styles.muted}>Sales</Text><Text style={styles.statValue}>{salesInRange.length}</Text></View></View>
        <Text style={styles.label}>Reporting period</Text><View style={styles.chips}>{(["today", "week", "month", "year", "all"] as const).map(r => <Pressable key={r} onPress={() => setRange(r)} style={[styles.chip, range === r && { backgroundColor: colors.brandPrimary }]}><Text style={{ color: range === r ? colors.onBrandPrimary : colors.onSurface }}>{r === "all" ? "All time" : r[0].toUpperCase() + r.slice(1)}</Text></Pressable>)}</View>
        <Text style={styles.section}>Revenue vs net profit</Text><View style={styles.card}><View style={styles.graphRow}><Text style={styles.graphLabel}>Revenue</Text><View style={styles.graphTrack}><View style={[styles.graphBar, { width: (revenue > 0 ? 100 : 0) + "%", backgroundColor: colors.brandPrimary }]} /></View><Text style={styles.graphValue}>{money(revenue)}</Text></View><View style={styles.graphRow}><Text style={styles.graphLabel}>Net profit</Text><View style={styles.graphTrack}><View style={[styles.graphBar, { width: (revenue > 0 ? Math.min(100, Math.max(0, netProfit / revenue * 100)) : 0) + "%", backgroundColor: colors.success }]} /></View><Text style={styles.graphValue}>{money(netProfit)}</Text></View><Text style={styles.muted}>Bars compare wholesale revenue and profit for the selected period.</Text></View>
        <Text style={styles.section}>Recent wholesale sales</Text>{state.sales.slice(0, 5).map(s => <View key={s.id} style={styles.card}><Text style={styles.rowTitle}>{s.invoice} · {s.customer}</Text><Text style={styles.muted}>{new Date(s.date).toLocaleDateString()} · Profit {money(s.profit)}</Text><Text style={styles.amount}>{money(s.total)}</Text></View>)}
      </>}
      {tab === "products" && <>
        <Text style={styles.heading}>{editingProduct ? "Edit wholesale product" : "Add wholesale product"}</Text>
        {field("Product name", name, setName)}{field("SKU / code (optional)", sku, setSku)}{field("Available quantity", qty, setQty, "numeric")}<View style={styles.two}>{field("Purchase cost", cost, setCost, "numeric")}{field("Wholesale price", price, setPrice, "numeric")}</View>{button(editingProduct ? "Save product changes" : "Save product", saveProduct)}{editingProduct ? button("Cancel edit", () => { setEditingProduct(null); setName(""); setSku(""); setQty("1"); setCost(""); setPrice(""); }, true) : null}
        <Text style={styles.section}>Wholesale inventory ({state.products.length})</Text>{state.products.map(p => <View key={p.id} style={styles.card}><Text style={styles.rowTitle}>{p.name}</Text><Text style={styles.muted}>{p.sku || "No code"} · Stock {p.quantity}</Text><Text style={styles.muted}>Cost {money(p.cost)} · Default B2B price {money(p.price)}</Text><View style={styles.actions}>{button("Edit", () => editProduct(p), true)}{button("Delete", () => deleteProduct(p), true)}</View></View>)}
      </>}
      {tab === "sale" && <>
        <Text style={styles.heading}>{editingSale ? "Edit wholesale sale" : "New B2B sale"}</Text>{field("Customer name", customer, setCustomer)}
        {state.parties.filter(p => p.type === "customer").length > 0 && <View style={styles.chips}>{state.parties.filter(p => p.type === "customer").map(p => <Pressable key={p.id} onPress={() => setCustomer(p.name)} style={styles.chip}><Text style={{ color: colors.onSurface }}>{p.name}</Text></Pressable>)}</View>}
        <Text style={styles.label}>Choose product</Text>{state.products.map(p => <View key={p.id} style={[styles.productPick, selectedProduct === p.id && { borderColor: colors.brandPrimary, borderWidth: 2 }]}><Pressable onPress={() => setSelectedProduct(p.id)}><Text style={styles.rowTitle}>{p.name}</Text><Text style={styles.muted}>Available {p.quantity} · Default {money(p.price)}{p.quantity < 0 ? " · SHORTAGE" : ""}</Text><Text style={styles.link}>{selectedProduct === p.id ? "Selected for cart" : "Tap to select"}</Text></Pressable><Text style={styles.label}>Restock now (units)</Text><TextInput value={restockAmounts[p.id] || ""} onChangeText={v => setRestockAmounts(prev => ({ ...prev, [p.id]: v }))} keyboardType="numeric" placeholder="Quantity to add" placeholderTextColor={colors.muted} style={styles.input} /><Pressable onPress={() => restockProduct(p.id)} style={styles.secondaryAction}><Text style={styles.secondaryActionText}>Restock this item</Text></Pressable></View>)}
        {field("Quantity", qty, setQty, "numeric")}{field("Price per item for this sale (optional)", salePriceOverride, setSalePriceOverride, "numeric")}{button("Add selected item", addCartItem)}
        <Text style={styles.section}>Sale items — discount each item</Text>{cart.map((i, idx) => <View key={idx} style={styles.card}><Text style={styles.rowTitle}>{i.name}</Text><Text style={styles.muted}>{i.quantity} × {money(i.price)} (cost {money(i.cost)} each)</Text><View style={styles.chips}>{(["amount", "percentage"] as const).map(mode => <Pressable key={mode} onPress={() => setCart(old => old.map((item, x) => x === idx ? { ...item, itemDiscountMode: mode } : item))} style={[styles.chip, (i.itemDiscountMode || "amount") === mode && { backgroundColor: colors.brandPrimary }]}><Text style={{ color: (i.itemDiscountMode || "amount") === mode ? colors.onBrandPrimary : colors.onSurface }}>{mode === "amount" ? "Rs per item" : "% per item"}</Text></Pressable>)}</View><TextInput value={String(i.itemDiscountValue ?? 0)} onChangeText={v => setCart(old => old.map((item, x) => x === idx ? { ...item, itemDiscountValue: n(v) } : item))} keyboardType="numeric" placeholder="Discount per item" placeholderTextColor={colors.muted} style={styles.input} /><Text style={styles.muted}>Item discount: {money(itemDiscountAmount(i))}</Text><Text style={styles.amount}>Net item total: {money(i.price * i.quantity - itemDiscountAmount(i))}</Text><Pressable onPress={() => setCart(old => old.filter((_, x) => x !== idx))}><Text style={styles.link}>Remove item</Text></Pressable></View>)}
        <Text style={styles.muted}>Multiple products can be added to this cart. Sales are allowed when stock is zero or insufficient; stock may become negative until restocked.</Text><Text style={styles.muted}>Subtotal before discounts: {money(total)}</Text><Text style={styles.muted}>Item discounts: {money(itemDiscountTotal)}</Text><Text style={styles.label}>Additional whole-cart discount</Text><View style={styles.chips}>{(["amount", "percentage"] as const).map(mode => <Pressable key={mode} onPress={() => setDiscountMode(mode)} style={[styles.chip, discountMode === mode && { backgroundColor: colors.brandPrimary }]}><Text style={{ color: discountMode === mode ? colors.onBrandPrimary : colors.onSurface }}>{mode === "amount" ? "Fixed Rs amount" : "Percentage %"}</Text></Pressable>)}</View>{field(discountMode === "amount" ? "Cart discount (Rs)" : "Cart discount (%)", discount, setDiscount, "numeric")}<Text style={styles.muted}>Whole-cart discount: {money(discountValue)}</Text><Text style={styles.muted}>Total discounts: {money(totalDiscount)}</Text><Text style={styles.bigTotal}>Total: {money(net)}</Text><Text style={styles.muted}>Estimated net profit after all discounts: {money(profit)}</Text>{button(editingSale ? "Save sale changes" : "Save sale & reduce wholesale stock", saveSale)}{editingSale ? button("Cancel edit", () => { setEditingSale(null); setCart([]); setDiscount("0"); setDiscountMode("amount"); setTab("history"); }, true) : null}
      </>}
      {tab === "parties" && <>
        <Text style={styles.heading}>Wholesale customers & suppliers</Text><View style={styles.chips}>{(["customer", "supplier"] as const).map(t => <Pressable key={t} onPress={() => setPartyType(t)} style={[styles.chip, partyType === t && { backgroundColor: colors.brandPrimary }]}><Text style={{ color: partyType === t ? colors.onBrandPrimary : colors.onSurface }}>{t === "customer" ? "Customer" : "Supplier"}</Text></Pressable>)}</View>{field("Name", partyName, setPartyName)}{field("Phone", partyPhone, setPartyPhone, "phone-pad")}{field("Address", partyAddress, setPartyAddress)}{button("Save " + partyType, saveParty)}{state.parties.map(p => <View key={p.id} style={styles.card}><Text style={styles.rowTitle}>{p.name}</Text><Text style={styles.muted}>{p.type} · {p.phone || "No phone"}{p.address ? " · " + p.address : ""}</Text>{button("Delete", () => Alert.alert("Delete party?", p.name, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => patchState({ parties: state.parties.filter(x => x.id !== p.id) }) }]), true)}</View>)}
      </>}
      {tab === "history" && <>
        <Text style={styles.heading}>Wholesale sales history</Text>{state.sales.length === 0 && <Text style={styles.muted}>No wholesale sales saved yet.</Text>}
        {state.sales.map(s => <View key={s.id} style={styles.card}><Text style={styles.rowTitle}>{s.invoice} · {s.customer}</Text><Text style={styles.muted}>{new Date(s.date).toLocaleString()}</Text><Text style={styles.amount}>{money(s.total)}</Text><Text style={styles.muted}>Discount {money(s.discount)} · Net profit {money(s.profit)}</Text><View style={styles.actions}>{button("Edit", () => editSale(s), true)}{button("Delete", () => deleteSale(s), true)}</View><Text style={styles.label}>Receipt size</Text><View style={styles.actions}>{button("58 mm PDF", () => printSale(s, "58"), true)}{button("75 mm PDF", () => printSale(s, "75"), true)}{button("A4 PDF", () => printSale(s, "A4"), true)}</View></View>)}
      </>}
      {tab === "settings" && <>
        <Text style={styles.heading}>Wholesale branding</Text><Text style={styles.muted}>This name and logo appear only on wholesale receipts. Retail branding remains unchanged.</Text>{field("Wholesale business name", storeName, setStoreName)}{button("Choose wholesale logo", pickLogo, true)}{state.logo ? <Image source={{ uri: state.logo }} style={{ width: 140, height: 90, resizeMode: "contain", alignSelf: "center" }} /> : <Text style={styles.muted}>No separate wholesale logo set.</Text>}{button("Save branding", () => { patchState({ name: storeName }); toast("Wholesale branding saved.", "success"); })}
        <Text style={styles.section}>Data separation</Text><Text style={styles.muted}>Wholesale data is stored under its own local key inside this app. Wholesale stock, sales, discounts, revenue and net profit do not feed into retail stock, retail sales, retail expenses, retail profit or retail reports. Wholesale data is currently device-local and is not included in the retail backup/restore system.</Text>
      </>}
    </ScrollView>
  </View>;
}

const useStyles = makeStyles(colors => ({
  root: { flex: 1, backgroundColor: colors.surface },
  nav: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  navButton: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.surfaceTertiary },
  navText: { fontSize: 12, fontWeight: "700" },
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  heading: { fontSize: 22, fontWeight: "800", color: colors.onSurface },
  section: { fontSize: 16, fontWeight: "800", color: colors.onSurface, marginTop: 12 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  label: { color: colors.onSurface, fontWeight: "700", fontSize: 12, marginBottom: 5 },
  field: { flex: 1, gap: 4, marginBottom: 8 },
  input: { color: colors.onSurface, backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
  two: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  secondaryAction: { alignSelf: "stretch", borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center" },
  secondaryActionText: { color: colors.brandPrimary, fontSize: 12, fontWeight: "800" },
  button: { backgroundColor: colors.brandPrimary, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 10, alignItems: "center", justifyContent: "center", flex: 1, marginVertical: 3 },
  buttonText: { color: colors.onBrandPrimary, fontWeight: "800", fontSize: 12 },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 6, backgroundColor: colors.surface },
  rowTitle: { color: colors.onSurface, fontWeight: "800", fontSize: 14 },
  amount: { color: colors.brandPrimary, fontWeight: "800", fontSize: 17 },
  statValue: { color: colors.onSurface, fontWeight: "800", fontSize: 18, marginTop: 5 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: { width: "47%", flexGrow: 1, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  chip: { borderRadius: 18, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 11, paddingVertical: 8 },
  productPick: { borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10, gap: 4 },
  actions: { flexDirection: "row", gap: 8 },
  bigTotal: { fontSize: 22, fontWeight: "900", color: colors.brandPrimary },
  graphRow: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 6 },
  graphLabel: { width: 72, fontSize: 11, color: colors.onSurface, fontWeight: "700" },
  graphTrack: { flex: 1, height: 12, borderRadius: 8, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  graphBar: { height: "100%", borderRadius: 8 },
  graphValue: { width: 86, textAlign: "right", fontSize: 11, fontWeight: "700", color: colors.onSurface },
  link: { color: colors.brandPrimary, fontWeight: "800", paddingVertical: 4 },
}));
