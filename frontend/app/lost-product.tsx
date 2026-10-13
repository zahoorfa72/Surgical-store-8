import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/auth";
import { useQueryClient } from "@tanstack/react-query";
import { useProducts } from "@/src/data";
import { apiRequest } from "@/src/api";
import { Product } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { Card, ScreenHeader, useToast, money, formatDateTime } from "@/src/ui";
import { useTheme } from "@/src/theme";

type LossRow = { id: string; client_id?: string; product_id: string; product_name: string; delta: number; reason: string; date: string; loss_cost: number; net_profit_adjustment?: number; remaining_balance_adjustment?: number; created_at: string; adjustment_type?: string; user_name?: string };
const HISTORY_KEY = "ssm.lost-products.v1";
const today = () => { const d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };

function fifoLossCost(product: Product | undefined, quantity: number): number {
  if (!product || quantity <= 0) return 0;
  let left = quantity, cost = 0;
  const layers = Array.isArray(product.cost_layers) ? product.cost_layers : [];
  for (const layer of layers) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, Number(layer.quantity) || 0));
    cost += take * (Number(layer.unit_cost) || 0);
    left -= take;
  }
  if (left > 0) cost += left * (Number(product.purchase_price) || 0);
  return cost;
}

export default function LostProductScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const { user } = useAuth();
  const canAdjustAccounting = user?.role === "admin";
  const { data: products = [] } = useProducts();
  const [productId, setProductId] = useState("");
  const [search, setSearch] = useState("");
  const [quantityText, setQuantityText] = useState("1");
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [accountingTarget, setAccountingTarget] = useState<"none" | "net_profit" | "remaining_balance" | "both">("none");
  const [accountingAmountText, setAccountingAmountText] = useState("0");
  const [history, setHistory] = useState<LossRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const selected = products.find((p) => p.id === productId);
  const qty = Number(quantityText);
  const costPreview = useMemo(() => fifoLossCost(selected, qty), [selected, qty]);
  const filtered = products.filter((p) => (p.name+" "+(p.barcode || "")).toLowerCase().includes(search.trim().toLowerCase())).slice(0, 80);
  const totalLost = history.reduce((sum, row) => sum + Math.max(0, Number(row.loss_cost) || 0), 0);

  useEffect(() => {
    let active = true;
    (async () => {
      const local = await storage.getItem<any>(HISTORY_KEY, []);
      let remote: LossRow[] = [];
      try { remote = await apiRequest<LossRow[]>("/inventory-adjustments?limit=500"); } catch {}
      if (!active) return;
      const productName = (id: string) => products.find((p) => p.id === id)?.name ?? "Product";
      queryClient.setQueryData(["inventory-adjustments"], [...(remote ?? []), ...(local ?? [])]);
      const rows = [...(remote ?? []).filter((r) => r.adjustment_type === "lost_product").map((r) => ({ ...r, product_name: productName(r.product_id) })), ...(local ?? [])];
      const unique = new Map<string, LossRow>();
      for (const row of rows) {
        const key = row.client_id || (row.id && !row.id.startsWith("local-") ? row.id : [row.product_id,row.date,row.delta,row.reason,Number(row.loss_cost).toFixed(2)].join("|"));
        if (!unique.has(key)) unique.set(key, row);
      }
      setHistory([...unique.values()].sort((a,b) => String(b.created_at || b.date).localeCompare(String(a.created_at || a.date))));
    })();
    return () => { active = false; };
  }, [products.length]);

  const save = async () => {
    if (!selected) { toast("Select a product first"); return; }
    if (!Number.isFinite(qty) || qty <= 0) { toast("Enter a valid lost quantity"); return; }
    const oldEdit = editingId ? history.find(row => row.id === editingId) : undefined;
    if (qty > Number(selected.quantity || 0) + (oldEdit && oldEdit.product_id === selected.id ? Math.abs(Number(oldEdit.delta)) : 0)) { toast("Lost quantity cannot exceed available stock after edit"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date+"T00:00:00").getTime())) { toast("Enter date as YYYY-MM-DD"); return; }
    if (!reason.trim()) { toast("Enter the reason for loss"); return; }
    const accountingAmount = Number(accountingAmountText);
    if (!Number.isFinite(accountingAmount) || accountingAmount < 0) { toast("Enter a valid accounting amount"); return; }
    setSaving(true);
    const lossCost = Math.round(costPreview * 100) / 100;
    const netProfitAdjustment = accountingTarget === "net_profit" || accountingTarget === "both" ? -Math.round(accountingAmount * 100) / 100 : 0;
    const remainingBalanceAdjustment = accountingTarget === "remaining_balance" || accountingTarget === "both" ? -Math.round(accountingAmount * 100) / 100 : 0;
    const clientId = editingId ? (history.find(row => row.id === editingId)?.client_id || "lost-"+Date.now()+"-"+Math.random().toString(36).slice(2,8)) : "lost-"+Date.now()+"-"+Math.random().toString(36).slice(2,8);
    const localRow: LossRow = { id: "local-"+clientId, client_id: clientId, product_id: selected.id, product_name: selected.name, delta: -qty, reason: reason.trim(), date, loss_cost: lossCost, net_profit_adjustment: netProfitAdjustment, remaining_balance_adjustment: remainingBalanceAdjustment, created_at: new Date().toISOString(), adjustment_type: "lost_product" };
    try {
      const response = await apiRequest<any>(editingId ? `/inventory-adjustments/${editingId}` : "/inventory-adjustments", { method: editingId ? "PUT" : "POST", body: { product_id: selected.id, delta: -qty, reason: reason.trim(), adjustment_type: "lost_product", date, loss_cost: lossCost, net_profit_adjustment: netProfitAdjustment, remaining_balance_adjustment: remainingBalanceAdjustment, client_id: editingId ? undefined : clientId } });
      const row: LossRow = response?.adjustment ? { ...response.adjustment, client_id: response.adjustment.client_id || clientId, product_name: selected.name } : response?.pending ? { ...localRow, id: response.id || localRow.id } : localRow;
      const next = [row, ...(await storage.getItem<any>(HISTORY_KEY, []) ?? [])];
      const dedup = next.filter((r, i, arr) => arr.findIndex(x => (x.client_id || x.id) === (r.client_id || r.id)) === i);
      await storage.setItem(HISTORY_KEY, dedup as any);
      queryClient.setQueryData(["inventory-adjustments"], (old: any[] = []) => [row, ...old.filter((x) => (x.client_id || x.id) !== (row.client_id || row.id))]);
      void queryClient.invalidateQueries({ queryKey: ["report"] });
      setHistory((old) => [row, ...old].filter((r, i, arr) => arr.findIndex(x => (x.client_id || x.id) === (r.client_id || r.id)) === i));
      toast("Lost product recorded. Stock and FIFO cost lots updated.");
      setQuantityText("1"); setReason(""); setSearch(""); setProductId(""); setAccountingTarget("none"); setAccountingAmountText("0"); setEditingId(null);
    } catch (e: any) {
      toast(e?.message || "Could not record lost product");
    } finally { setSaving(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Lost Product" subtitle="Stock loss valued at purchase cost" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 28, gap: 12 }}>
        <Card>
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "700", marginBottom: 4 }}>Record stock loss</Text>
          <Text style={{ color: colors.muted, marginBottom: 12 }}>This is not a sale or customer payment. Stock and FIFO cost lots are reduced when you save.</Text>
          <Text style={{ color: colors.onSurface, fontWeight: "600", marginBottom: 6 }}>Find product</Text>
          <TextInput value={search} onChangeText={setSearch} placeholder="Search name or barcode" placeholderTextColor={colors.muted} style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginBottom: 8 }} />
          {filtered.map((p) => <Pressable key={p.id} onPress={() => { setProductId(p.id); setSearch(p.name); }} style={{ padding: 10, borderRadius: 9, marginBottom: 5, backgroundColor: productId === p.id ? colors.brandPrimary : colors.surfaceTertiary }}><Text style={{ color: productId === p.id ? colors.onBrandPrimary : colors.onSurface, fontWeight: "600" }}>{p.name}</Text><Text style={{ color: productId === p.id ? colors.onBrandPrimary : colors.muted, fontSize: 12 }}>Stock {p.quantity} · Purchase cost {money(p.purchase_price)}</Text></Pressable>)}
          {selected && <View style={{ padding: 12, borderRadius: 10, backgroundColor: colors.surfaceTertiary, marginVertical: 8 }}><Text style={{ color: colors.onSurface }}>Available stock: {selected.quantity}</Text><Text style={{ color: colors.onSurface }}>Estimated loss value: {money(costPreview)}</Text></View>}
          <Text style={{ color: colors.onSurface, fontWeight: "600", marginTop: 8 }}>Lost quantity</Text>
          <TextInput value={quantityText} onChangeText={setQuantityText} keyboardType="decimal-pad" placeholder="Quantity" placeholderTextColor={colors.muted} style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginTop: 6 }} />
          {canAdjustAccounting && <>
          <Text style={{ color: colors.onSurface, fontWeight: "700", marginTop: 14 }}>Optional accounting impact (default: none)</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 3 }}>Stock loss always updates stock. Only apply a financial amount if you choose a destination.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 }}>
            {([{value:"none",label:"None"},{value:"net_profit",label:"Net Profit"},{value:"remaining_balance",label:"Remaining Balance"},{value:"both",label:"Both"}] as const).map(option => <Pressable key={option.value} onPress={() => setAccountingTarget(option.value)} style={{ paddingVertical: 9, paddingHorizontal: 11, borderRadius: 9, backgroundColor: accountingTarget === option.value ? colors.brandPrimary : colors.surfaceTertiary }}><Text style={{ color: accountingTarget === option.value ? colors.onBrandPrimary : colors.onSurface, fontWeight: "600" }}>{option.label}</Text></Pressable>)}
          </View>
          <Text style={{ color: colors.onSurface, fontWeight: "600", marginTop: 10 }}>Amount to deduct (PKR)</Text>
          <TextInput value={accountingAmountText} onChangeText={setAccountingAmountText} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.muted} style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginTop: 6 }} />
          </>}
          <Text style={{ color: colors.onSurface, fontWeight: "600", marginTop: 12 }}>Loss date (YYYY-MM-DD)</Text>
          <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginTop: 6 }} />
          <Text style={{ color: colors.onSurface, fontWeight: "600", marginTop: 12 }}>Reason</Text>
          <TextInput value={reason} onChangeText={setReason} placeholder="Damaged, expired, missing..." placeholderTextColor={colors.muted} multiline style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, minHeight: 72, marginTop: 6, textAlignVertical: "top" }} />
          <Pressable disabled={saving} onPress={() => void save()} style={{ padding: 14, borderRadius: 10, backgroundColor: saving ? colors.muted : colors.brandPrimary, alignItems: "center", marginTop: 14 }}><Text style={{ color: colors.onBrandPrimary, fontWeight: "700" }}>{saving ? "Saving..." : editingId ? "Save Lost Product Changes" : "Record Lost Product"}</Text></Pressable>{editingId && <Pressable disabled={saving} onPress={() => { setEditingId(null); setProductId(""); setSearch(""); setQuantityText("1"); setDate(today()); setReason(""); setAccountingTarget("none"); setAccountingAmountText("0"); }} style={{ padding: 12, borderRadius: 10, backgroundColor: colors.surfaceTertiary, alignItems: "center", marginTop: 8 }}><Text style={{ color: colors.onSurface, fontWeight: "700" }}>Cancel editing</Text></Pressable>}
        </Card>
        <Card>
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "700" }}>Lost product history</Text>
          <Text style={{ color: colors.muted, marginTop: 4, marginBottom: 10 }}>{history.length} records · Total purchase-cost loss {money(totalLost)}</Text>
          {history.length === 0 ? <Text style={{ color: colors.muted }}>No lost-product entries yet.</Text> : history.slice(0, 100).map((row) => <View key={row.id} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 10 }}><Text style={{ color: colors.onSurface, fontWeight: "600" }}>{row.product_name || products.find((p) => p.id === row.product_id)?.name || "Product"} · {Math.abs(Number(row.delta))} lost</Text><Text style={{ color: colors.muted, fontSize: 12 }}>{row.date} · {row.reason}</Text><Text style={{ color: colors.error, fontWeight: "700", marginTop: 3 }}>Loss: {money(row.loss_cost)}</Text><View style={{flexDirection:"row",alignItems:"center",flexWrap:"wrap"}}><Pressable onPress={() => { setEditingId(row.id); setProductId(row.product_id); setSearch(products.find(p => p.id === row.product_id)?.name ?? ""); setQuantityText(String(Math.abs(Number(row.delta)))); setDate(row.date); setReason(row.reason); const np = Number(row.net_profit_adjustment || 0), rb = Number(row.remaining_balance_adjustment || 0); setAccountingAmountText(String(Math.max(Math.abs(np), Math.abs(rb)))); setAccountingTarget(np && rb ? "both" : np ? "net_profit" : rb ? "remaining_balance" : "none"); }} style={{ alignSelf:"flex-start", marginTop:8, marginRight:8, paddingVertical:7, paddingHorizontal:10, borderRadius:8, backgroundColor:colors.surfaceTertiary }}><Text style={{ color:colors.onSurface, fontWeight:"700" }}>Edit</Text></Pressable><Pressable onPress={async()=>{try{await apiRequest(`/inventory-adjustments/${row.id}`,{method:"DELETE"});setHistory(old=>old.filter(item=>item.id!==row.id));await storage.setItem(HISTORY_KEY,(await storage.getItem<any>(HISTORY_KEY,[])).filter((item:any)=>item.id!==row.id));await queryClient.invalidateQueries({queryKey:["products"]});await queryClient.invalidateQueries({queryKey:["report"]});await queryClient.invalidateQueries({queryKey:["inventory-adjustments"]});toast("Entry undone and removed from active history; stock restored.");}catch(e:any){toast(e?.message||"Could not reverse entry");}}} style={{alignSelf:"flex-start",marginTop:8,paddingVertical:7,paddingHorizontal:10,borderRadius:8,backgroundColor:colors.surfaceTertiary}}><Text style={{color:colors.onSurface,fontWeight:"700"}}>Undo & return stock</Text></Pressable></View></View>)}
        </Card>
      </ScrollView>
    </View>
  );
}
