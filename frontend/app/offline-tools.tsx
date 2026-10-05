import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import { apiRequest, getConnectionMode } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useProducts, useSales } from "@/src/data";
import { storage } from "@/src/utils/storage";
import { Badge, Card, PrimaryButton, ScreenHeader, useToast, money, formatDateTime } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay } from "@/src/utils/finance-display";

type Tool = "adjust" | "expiry" | "analytics" | "search" | "transfer" | "quick" | "reorder" | "duplicate" | "shift" | "attachments" | "security";
const ATTACH_KEY = "ssm.document-attachments.v1";
const SHIFT_KEY = "ssm.cash-shift.v1";

export default function OfflineTools() {
  const styles = useStyles();
  const { colors } = useTheme();
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const { data: products = [] } = useProducts();
  const { data: sales = [] } = useSales();
  const [tool, setTool] = useState<Tool>("adjust");
  const [productId, setProductId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [search, setSearch] = useState("");
  const [delta, setDelta] = useState("");
  const [transferQty, setTransferQty] = useState("");
  const [reason, setReason] = useState("");
  const [openingCash, setOpeningCash] = useState("");
  const [closingCash, setClosingCash] = useState("");
  const [shift, setShift] = useState<any>(null);
  const [attachments, setAttachments] = useState<any[]>([]);

  useEffect(() => {
    void (async () => {
      const [localShift, localAttachments] = await Promise.all([
        storage.getItem<any>(SHIFT_KEY, null),
        storage.getItem<any[]>(ATTACH_KEY, []),
      ]);
      setShift(localShift);
      setAttachments(localAttachments || []);
      if ((await getConnectionMode()) !== "online") return;
      try {
        const remoteShift = await apiRequest<any>("/cash-shifts/current");
        if (remoteShift) {
          await storage.setItem(SHIFT_KEY, remoteShift);
          setShift(remoteShift);
        }
      } catch {}
      try {
        const remoteAttachments = await apiRequest<any[]>("/attachments");
        if (Array.isArray(remoteAttachments)) {
          const merged = [...remoteAttachments, ...(localAttachments || []).filter((x: any) => x.pending)];
          const unique = Array.from(new Map(merged.map((x: any) => [x.client_id || x.id || x.created_at, x])).values()).slice(0, 100);
          await storage.setItem(ATTACH_KEY, unique);
          setAttachments(unique);
        }
      } catch {}
    })();
  }, []);

  const selected = products.find((p) => p.id === productId);
  const from = products.find((p) => p.id === fromId);
  const to = products.find((p) => p.id === toId);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.barcode || "").toLowerCase().includes(q)).slice(0, 50);
  }, [products, search]);

  const expiry = useMemo(() => products.filter((p) => p.expiry_date).map((p) => {
    const days = Math.ceil((new Date(String(p.expiry_date)).getTime() - Date.now()) / 86400000);
    return { p, days };
  }).sort((a, b) => a.days - b.days), [products]);

  const fastSlow = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sales) for (const i of s.items || []) map.set(i.product_id, (map.get(i.product_id) || 0) + Number(i.quantity || 0));
    const rows = products.map((p) => ({ p, sold: map.get(p.id) || 0 }));
    return { fast: [...rows].sort((a, b) => b.sold - a.sold).slice(0, 8), slow: [...rows].sort((a, b) => a.sold - b.sold).slice(0, 8) };
  }, [products, sales]);

  const reorder = useMemo(() => products.filter((p) => Number(p.quantity || 0) <= Number(p.low_stock_threshold || 0)), [products]);
  const duplicates = useMemo(() => {
    const names = new Map<string, any[]>();
    const bars = new Map<string, any[]>();
    for (const p of products) {
      const n = p.name.trim().toLowerCase();
      if (n) names.set(n, [...(names.get(n) || []), p]);
      const b = String(p.barcode || "").trim();
      if (b) bars.set(b, [...(bars.get(b) || []), p]);
    }
    return { names: [...names.values()].filter((x) => x.length > 1), bars: [...bars.values()].filter((x) => x.length > 1) };
  }, [products]);

  const adjust = async () => {
    const n = Number(delta);
    if (!selected || !Number.isFinite(n) || n === 0) return toast("Select product and enter a non-zero quantity", "error");
    if (Number(selected.quantity || 0) + n < 0) return toast("Stock cannot go below zero", "error");
    try {
      await apiRequest("/inventory-adjustments", { method: "POST", body: { product_id: selected.id, delta: n, reason } });
      setDelta(""); setReason(""); toast("Stock adjustment saved offline", "success");
    } catch (e: any) { toast(e?.message || "Adjustment failed", "error"); }
  };

  const transfer = async () => {
    const n = Number(transferQty);
    if (!from || !to || from.id === to.id || !Number.isFinite(n) || n <= 0) return toast("Select source, destination and quantity", "error");
    if (n > Number(from.quantity || 0)) return toast("Not enough source stock", "error");
    try {
      await apiRequest("/stock-transfers", { method: "POST", body: { from_product_id: from.id, to_product_id: to.id, quantity: n, reason } });
      setTransferQty(""); setReason(""); toast("Stock transfer saved offline", "success");
    } catch (e: any) { toast(e?.message || "Transfer failed", "error"); }
  };

  const startShift = async () => {
    const n = Number(openingCash);
    if (!Number.isFinite(n) || n < 0) return toast("Enter opening cash", "error");
    const next = { opened_at: new Date().toISOString(), opened_by: user?.name || "", opening_cash: n, closing_cash: null };
    await storage.setItem(SHIFT_KEY, next); setShift(next);
    try {
      const saved = await apiRequest<any>("/cash-shifts", { method: "POST", body: next });
      await storage.setItem(SHIFT_KEY, saved || next);
      setShift(saved || next);
    } catch {}
    setOpeningCash(""); toast("Shift started", "success");
  };

  const closeShift = async () => {
    const n = Number(closingCash);
    if (!shift || !Number.isFinite(n) || n < 0) return toast("Enter closing cash", "error");
    const next = { ...shift, closed_at: new Date().toISOString(), closing_cash: n };
    await storage.setItem(SHIFT_KEY, next); setShift(next);
    try {
      const saved = await apiRequest<any>("/cash-shifts", { method: "POST", body: next });
      await storage.setItem(SHIFT_KEY, saved || next);
      setShift(saved || next);
    } catch {}
    setClosingCash(""); toast("Shift closed", "success");
  };

  const addAttachment = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.7 });
    if (r.canceled || !r.assets[0]) return;
    const asset = r.assets[0];
    const mime = asset.mimeType || "image/jpeg";
    const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
    const a = {
      id: "att-" + Date.now(),
      uri: asset.uri,
      data_url: "data:" + mime + ";base64," + base64,
      name: asset.fileName || "Store photo",
      created_at: new Date().toISOString(),
      user: user?.name || "",
      pending: true,
    };
    const next = [a, ...attachments].slice(0, 100);
    await storage.setItem(ATTACH_KEY, next); setAttachments(next);
    try {
      const saved = await apiRequest<any>("/attachments", {
        method: "POST",
        body: { client_id: a.client_id, name: a.name, data_url: a.data_url, created_at: a.created_at, user: a.user },
      });
      const synced = { ...a, ...saved, pending: false, uri: saved?.data_url || a.uri };
      const finalList = [synced, ...next.filter((x) => x.id !== a.id)].slice(0, 100);
      await storage.setItem(ATTACH_KEY, finalList);
      setAttachments(finalList);
      toast("Attachment saved and queued/synced", "success");
    } catch (e: any) {
      toast(e?.message || "Attachment saved on phone; sync pending", "success");
    }
  };

  const items: Array<[Tool, string, string]> = [
    ["adjust", "Stock adjustment", "tune-vertical"], ["expiry", "Expiry", "calendar-alert"],
    ["analytics", "Analytics", "chart-line"], ["search", "Smart search", "magnify"],
    ["transfer", "Stock transfer", "swap-horizontal"], ["quick", "Quick actions", "flash"],
    ["reorder", "Reorder", "cart-arrow-down"], ["duplicate", "Duplicate guard", "content-copy"],
    ["shift", "Cash shift", "cash-register"], ["attachments", "Attachments", "paperclip"],
    ["security", "Security activity", "shield-check"],
  ];

  return <View style={styles.root}>
    <ScreenHeader title="Offline Tools" subtitle="All tools work without internet" topInset={insets.top} onBack={() => router.back()} />
    <View style={styles.statusCard}>
      <View style={styles.statusIcon}><MaterialDesignIcons name="cloud-off-outline" size={20} color={colors.brandPrimary} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.statusTitle}>Offline-first tools</Text>
        <Text style={styles.statusHint}>Changes save on this phone immediately and sync when online.</Text>
      </View>
      <Badge text={fakeFinanceDisplay ? "Private finance ON" : "Real finance"} tone={fakeFinanceDisplay ? "warning" : "success"} />
    </View>
    <View style={styles.tabs}>
      {items.map(([k, label, icon]) => (
        <Pressable key={k} onPress={() => setTool(k)} style={[styles.tab, tool === k && { backgroundColor: colors.brandPrimary }]}>
          <MaterialDesignIcons name={icon as any} size={17} color={tool === k ? colors.onBrandPrimary : colors.brandPrimary} />
          <Text style={[styles.tabText, tool === k && { color: colors.onBrandPrimary }]} numberOfLines={1}>{label}</Text>
        </Pressable>
      ))}
    </View>
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 12 }}>
      {tool === "adjust" && <Card><Text style={styles.title}>Stock Adjustment & Damage</Text><Text style={styles.hint}>Changes quantity and cost layers only. No sale, purchase or finance entry is created.</Text><TextInput style={styles.input} placeholder="Search product" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} />{filtered.slice(0, 8).map((p) => <Pressable key={p.id} onPress={() => setProductId(p.id)} style={[styles.row, productId === p.id && { backgroundColor: colors.brandTertiary }]}><Text style={styles.name}>{p.name}</Text><Text style={styles.meta}>{p.quantity} in stock</Text></Pressable>)}<TextInput style={styles.input} keyboardType="decimal-pad" placeholder="+10 or -5" placeholderTextColor={colors.muted} value={delta} onChangeText={setDelta} /><TextInput style={styles.input} placeholder="Reason" placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} /><PrimaryButton label="Save adjustment" onPress={adjust} /></Card>}

      {tool === "expiry" && <Card><Text style={styles.title}>Expiry Management</Text>{expiry.map(({ p, days }) => <View key={p.id} style={styles.row}><View style={{ flex: 1 }}><Text style={styles.name}>{p.name}</Text><Text style={styles.meta}>{p.quantity} units · {p.expiry_date}</Text></View><Badge text={days < 0 ? "Expired" : days <= 30 ? String(days) + "d left" : String(days) + "d"} tone={days < 0 ? "error" : days <= 30 ? "warning" : "success"} /></View>)}{!expiry.length && <Text style={styles.empty}>No expiry dates recorded.</Text>}</Card>}

      {tool === "analytics" && <><Card><Text style={styles.title}>Fast movers</Text>{fastSlow.fast.map((r) => <View key={r.p.id} style={styles.row}><Text style={styles.name}>{r.p.name}</Text><Text style={styles.value}>{r.sold} sold</Text></View>)}</Card><Card><Text style={styles.title}>Slow movers</Text>{fastSlow.slow.map((r) => <View key={r.p.id} style={styles.row}><Text style={styles.name}>{r.p.name}</Text><Text style={styles.value}>{r.sold} sold</Text></View>)}</Card></>}

      {tool === "search" && <Card><Text style={styles.title}>Intelligent Stock Search</Text><TextInput style={styles.input} placeholder="Name, barcode or partial text" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} />{filtered.map((p) => <View key={p.id} style={styles.row}><View style={{ flex: 1 }}><Text style={styles.name}>{p.name}</Text><Text style={styles.meta}>{p.barcode || "No barcode"} · {p.quantity} available</Text></View><Badge text={p.quantity <= p.low_stock_threshold ? "Low" : "OK"} tone={p.quantity <= p.low_stock_threshold ? "warning" : "success"} /></View>)}</Card>}

      {tool === "transfer" && <Card><Text style={styles.title}>Stock Transfer</Text><Text style={styles.hint}>Moves quantity and historical cost layers without touching finance.</Text><TextInput style={styles.input} placeholder="Search products" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch} />{filtered.slice(0, 12).map((p) => <Pressable key={p.id} onPress={() => !fromId ? setFromId(p.id) : setToId(p.id)} style={[styles.row, (fromId === p.id || toId === p.id) && { backgroundColor: colors.brandTertiary }]}><Text style={styles.name}>{p.name}</Text><Text style={styles.meta}>{fromId === p.id ? "SOURCE" : toId === p.id ? "DESTINATION" : String(p.quantity) + " available"}</Text></Pressable>)}<TextInput style={styles.input} keyboardType="decimal-pad" placeholder="Quantity" placeholderTextColor={colors.muted} value={transferQty} onChangeText={setTransferQty} /><TextInput style={styles.input} placeholder="Reason" placeholderTextColor={colors.muted} value={reason} onChangeText={setReason} /><PrimaryButton label="Transfer stock" onPress={transfer} /></Card>}

      {tool === "quick" && <Card><Text style={styles.title}>Quick Actions</Text>{[["Sell","/sell","cart"],["New purchase","/purchase","truck-plus"],["Add product","/product-form","plus-box"],["Returns","/returns","cash-refund"],["Payments","/payments","cash-sync"],["Backup & Restore","/backup-restore","backup-restore"]].map(([label, route, icon]) => <Pressable key={route} style={styles.action} onPress={() => router.push(route as any)}><MaterialDesignIcons name={icon as any} size={21} color={colors.brandPrimary} /><Text style={styles.name}>{label}</Text><MaterialDesignIcons name="chevron-right" size={20} color={colors.muted} /></Pressable>)}</Card>}

      {tool === "reorder" && <Card><Text style={styles.title}>Automatic Reorder Suggestions</Text>{reorder.map((r) => <View key={r.id} style={styles.row}><Text style={styles.name}>{r.name}</Text><Badge text={String(r.quantity) + " in stock"} tone="warning" /></View>)}{!reorder.length && <Text style={styles.empty}>No low-stock products.</Text>}</Card>}

      {tool === "duplicate" && <Card><Text style={styles.title}>Duplicate Product Protection</Text><Text style={styles.hint}>Local warnings before product creation/editing.</Text><Text style={styles.meta}>Same-name groups: {duplicates.names.length} · Same-barcode groups: {duplicates.bars.length}</Text>{duplicates.names.map((g, i) => <View key={"n" + i} style={styles.row}><Text style={styles.name}>{g.map((p: any) => p.name).join(" / ")}</Text><Badge text="Duplicate name" tone="warning" /></View>)}{duplicates.bars.map((g, i) => <View key={"b" + i} style={styles.row}><Text style={styles.name}>{g[0].barcode}</Text><Badge text="Duplicate barcode" tone="error" /></View>)}</Card>}

      {tool === "shift" && <Card><Text style={styles.title}>Cash Register / Shift</Text>{!shift || shift.closed_at ? <><TextInput style={styles.input} keyboardType="decimal-pad" placeholder="Opening cash" placeholderTextColor={colors.muted} value={openingCash} onChangeText={setOpeningCash} /><PrimaryButton label="Start shift" onPress={startShift} /></> : <><Text style={styles.name}>Opened {formatDateTime(shift.opened_at)}</Text><Text style={styles.meta}>Opening cash {money(shift.opening_cash)}</Text><TextInput style={styles.input} keyboardType="decimal-pad" placeholder="Closing cash" placeholderTextColor={colors.muted} value={closingCash} onChangeText={setClosingCash} /><PrimaryButton label="Close shift" onPress={closeShift} /></>}</Card>}

      {tool === "attachments" && <Card><Text style={styles.title}>Document Attachment Center</Text><Text style={styles.hint}>Store order/receipt photos locally. No internet is required.</Text><PrimaryButton label="Add photo" onPress={addAttachment} />{attachments.map((a) => <View key={a.id} style={styles.attachment}><Image source={{ uri: a.data_url || a.uri }} style={styles.thumb} /><View style={{ flex: 1 }}><Text style={styles.name}>{a.name}</Text><Text style={styles.meta}>{a.user} · {formatDateTime(a.created_at)}</Text></View></View>)}</Card>}

      {tool === "security" && <Card><Text style={styles.title}>Security Activity Center</Text><Text style={styles.hint}>Local audit events remain available offline; server audit remains available when online.</Text><Text style={styles.name}>{user?.name || "User"}</Text><Text style={styles.meta}>Role: {user?.role || "—"}</Text><Text style={styles.meta}>Business write actions are recorded locally by the app.</Text></Card>}
    </ScrollView>
  </View>;
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  statusCard: { marginHorizontal: 12, marginTop: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, flexDirection: "row", alignItems: "center", gap: 10 },
  statusIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" },
  statusTitle: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  statusHint: { fontSize: 10.5, color: colors.muted, marginTop: 2, lineHeight: 15 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  tab: { flexGrow: 1, flexBasis: "30%", maxWidth: "32%", minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 9, borderRadius: 12, backgroundColor: colors.surfaceTertiary },
  tabText: { fontSize: 12, fontWeight: "700", color: colors.onSurface },
  title: { fontSize: 18, fontWeight: "800", color: colors.onSurface, marginBottom: 6 },
  hint: { fontSize: 12, color: colors.muted, lineHeight: 18, marginBottom: 10 },
  input: { height: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.onSurface, marginVertical: 6, backgroundColor: colors.surface },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  name: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 12, color: colors.muted },
  value: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  empty: { fontSize: 13, color: colors.muted, paddingVertical: 12 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider },
  attachment: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
}));
