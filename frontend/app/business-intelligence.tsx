import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import {
  useParties,
  usePayments,
  useProducts,
  usePurchases,
  usePurchaseReturns,
  useReport,
  useReturns,
  useSales,
} from "@/src/data";
import { getWriteQueueCount } from "@/src/api";
import { money, ScreenHeader, Card, Badge, useToast, formatDateTime } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { storage } from "@/src/utils/storage";

type Tab = "overview" | "stock" | "statements" | "audit";
type AuditRow = {
  id: string;
  method: string;
  path: string;
  status?: number;
  created_at: string;
  body?: any;
};

const fmtDate = (value?: string) => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
};

function signedAmount(kind: string, amount: number) {
  if (kind === "pay" || kind === "customer_refund") return -amount;
  return amount;
}

export default function BusinessIntelligence() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("overview");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [partySearch, setPartySearch] = useState("");
  const [partyType, setPartyType] = useState<"supplier" | "customer">("supplier");
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);

  const { data: report } = useReport("month");
  const { data: products = [] } = useProducts();
  const { data: sales = [] } = useSales();
  const { data: purchases = [] } = usePurchases();
  const { data: returns = [] } = useReturns();
  const { data: purchaseReturns = [] } = usePurchaseReturns();
  const { data: payments = [] } = usePayments();
  const { data: parties = [] } = useParties(partyType);

  const selectedProduct = products.find((p) => p.id === selectedProductId) ?? null;
  const selectedParty = parties.find((p) => p.id === selectedPartyId) ?? null;

  const loadAudit = async () => {
    const rows = (await storage.getItem<AuditRow[]>("ssm.auditlog.v1", [])) ?? [];
    setAuditRows(rows);
    toast(rows.length ? "Audit history refreshed" : "No local audit events yet", rows.length ? "success" : "error");
  };

  const reorderRows = useMemo(() => {
    const now = Date.now();
    const monthStart = new Date();
    monthStart.setDate(1);
    const usage = new Map<string, number>();
    for (const sale of sales) {
      if (new Date(sale.created_at).getTime() < monthStart.getTime()) continue;
      for (const item of sale.items ?? []) usage.set(item.product_id, (usage.get(item.product_id) ?? 0) + Number(item.quantity ?? 0));
    }
    for (const ret of returns) {
      if (new Date(ret.created_at).getTime() < monthStart.getTime()) continue;
      for (const item of ret.items ?? []) usage.set(item.product_id, Math.max(0, (usage.get(item.product_id) ?? 0) - Number(item.quantity ?? 0)));
    }
    const days = Math.max(1, new Date().getDate());
    return products
      .map((p) => {
        const sold = usage.get(p.id) ?? 0;
        const daily = sold / days;
        const daysLeft = daily > 0 ? Number(p.quantity ?? 0) / daily : Infinity;
        const targetDays = 14;
        const suggested = daily > 0 ? Math.max(0, Math.ceil(daily * targetDays - Number(p.quantity ?? 0))) : 0;
        return { p, sold, daily, daysLeft, suggested };
      })
      .filter((r) => r.suggested > 0 || Number(r.p.quantity ?? 0) <= Number(r.p.low_stock_threshold ?? 0))
      .sort((a, b) => (a.daysLeft - b.daysLeft));
  }, [products, sales, returns]);

  const topSellers = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; revenue: number }>();
    for (const sale of sales) {
      for (const item of sale.items ?? []) {
        const row = map.get(item.product_id) ?? { name: item.name, qty: 0, revenue: 0 };
        row.qty += Number(item.quantity ?? 0);
        row.revenue += Number(item.line_total ?? (Number(item.quantity ?? 0) * Number(item.unit_price ?? 0)));
        map.set(item.product_id, row);
      }
    }
    for (const ret of returns) {
      for (const item of ret.items ?? []) {
        const row = map.get(item.product_id);
        if (row) row.qty = Math.max(0, row.qty - Number(item.quantity ?? 0));
      }
    }
    return Array.from(map.values()).sort((a, b) => b.qty - a.qty).slice(0, 8);
  }, [sales, returns]);

  const stockMovements = useMemo(() => {
    if (!selectedProduct) return [];
    const rows: { date: string; type: string; quantity: number; detail: string }[] = [];
    for (const p of purchases) for (const it of p.items ?? []) if (it.product_id === selectedProduct.id)
      rows.push({ date: p.created_at, type: "Purchase", quantity: Number(it.quantity ?? 0), detail: `${p.ref_no} · ${money(Number(it.unit_cost ?? 0))}/unit · ${p.supplier_name}` });
    for (const s of sales) for (const it of s.items ?? []) if (it.product_id === selectedProduct.id)
      rows.push({ date: s.created_at, type: "Sale", quantity: -Number(it.quantity ?? 0), detail: `${s.invoice_no} · ${money(Number(it.unit_price ?? 0))}/unit · ${s.customer_name}` });
    for (const r of returns) for (const it of r.items ?? []) if (it.product_id === selectedProduct.id)
      rows.push({ date: r.created_at, type: "Sale return", quantity: Number(it.quantity ?? 0), detail: `${r.ref_no} · ${r.reason || "Customer return"}` });
    for (const r of purchaseReturns as any[]) for (const it of r.items ?? []) if (it.product_id === selectedProduct.id)
      rows.push({ date: r.created_at, type: "Purchase return", quantity: -Number(it.quantity ?? 0), detail: `${r.ref_no} · ${r.reason || "Supplier return"}` });
    return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [purchases, sales, returns, purchaseReturns, selectedProduct]);

  const costHistory = useMemo(() => {
    if (!selectedProduct) return [];
    return purchases
      .flatMap((p) => (p.items ?? []).filter((it) => it.product_id === selectedProduct.id).map((it) => ({
        date: p.created_at,
        ref: p.ref_no,
        supplier: p.supplier_name,
        qty: Number(it.quantity ?? 0),
        cost: Number(it.unit_cost ?? 0),
      })))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [purchases, selectedProduct]);

  const exportStatementPdf = async () => {
    if (!selectedParty) return;
    const title = `${selectedParty.name} Statement`;
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{font-size:22px;margin:0 0 6px}
      .muted{color:#666;font-size:12px}.bal{font-size:20px;font-weight:700;margin:14px 0}
      table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:12px}
      th:last-child,td:last-child{text-align:right}.neg{color:#b42318}.pos{color:#157347}
    </style></head><body><h1>${selectedParty.name.replace(/[<>&"]/g,"")}</h1>
      <div class="muted">${partyType === "supplier" ? "Supplier statement" : "Customer statement"}</div>
      <div class="bal">Current balance: ${money(Number(selectedParty.balance ?? 0))}</div>
      <div class="muted">Generated ${new Date().toLocaleString()}</div>
      <table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Amount</th></tr></thead><tbody>
      ${statementRows.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${r.type}</td><td>${String(r.detail).replace(/[<>&"]/g,"")}</td><td class="${r.amount < 0 ? "neg" : "pos"}">${r.amount < 0 ? "- " : "+ "}${money(Math.abs(r.amount))}</td></tr>`).join("")}
      </tbody></table></body></html>`;
    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: title });
      else toast("Statement PDF created, but sharing is not available", "error");
    } catch (e: any) {
      toast(e?.message || "Could not create statement PDF", "error");
    }
  };

  const statementRows = useMemo(() => {
    if (!selectedParty) return [];
    const rows: { date: string; type: string; amount: number; detail: string }[] = [];
    if (partyType === "supplier") {
      for (const p of purchases) if (p.supplier_id === selectedParty.id)
        rows.push({ date: p.created_at, type: "Purchase", amount: Number(p.total ?? 0), detail: p.ref_no });
      for (const r of purchaseReturns as any[]) if (r.supplier_id === selectedParty.id)
        rows.push({ date: r.created_at, type: "Purchase return", amount: -Number(r.refund_total ?? 0), detail: r.ref_no });
      for (const p of payments) if (p.party_id === selectedParty.id)
        rows.push({ date: p.created_at, type: p.kind === "supplier_refund" ? "Supplier refund" : "Payment", amount: signedAmount(p.kind, Number(p.amount ?? 0)), detail: p.note || p.kind });
    } else {
      for (const s of sales) if (s.customer_id === selectedParty.id)
        rows.push({ date: s.created_at, type: "Sale", amount: Number(s.total ?? 0), detail: s.invoice_no });
      for (const r of returns) if (r.customer_id === selectedParty.id)
        rows.push({ date: r.created_at, type: "Sale return", amount: -Number(r.refund_total ?? 0), detail: r.ref_no });
      for (const p of payments) if (p.party_id === selectedParty.id)
        rows.push({ date: p.created_at, type: p.kind === "customer_refund" ? "Customer refund" : "Receipt", amount: signedAmount(p.kind, Number(p.amount ?? 0)), detail: p.note || p.kind });
    }
    return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [selectedParty, partyType, purchases, purchaseReturns, payments, sales, returns]);

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    return products.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.barcode ?? "").toLowerCase().includes(q));
  }, [products, productSearch]);

  const filteredParties = useMemo(() => {
    const q = partySearch.trim().toLowerCase();
    return parties.filter((p) => !q || p.name.toLowerCase().includes(q) || p.phone.toLowerCase().includes(q));
  }, [parties, partySearch]);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Smart Store Center" subtitle="Inventory, statements, backup & audit tools" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 12 }}>
        <View style={styles.tabRow}>
          {([
            ["overview", "Overview", "view-dashboard-outline"],
            ["stock", "Stock", "warehouse"],
            ["statements", "Statements", "file-document-outline"],
            ["audit", "Audit", "shield-check-outline"],
          ] as const).map(([key, label, icon]) => (
            <Pressable key={key} style={[styles.tab, tab === key && { backgroundColor: colors.brandPrimary }]} onPress={() => { setTab(key); if (key === "audit") void loadAudit(); }}>
              <MaterialDesignIcons name={icon as any} size={17} color={tab === key ? colors.onBrandPrimary : colors.brandPrimary} />
              <Text style={[styles.tabText, tab === key && { color: colors.onBrandPrimary }]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {tab === "overview" && (
          <>
            <Card>
              <Text style={styles.cardTitle}>Smart dashboard</Text>
              <Text style={styles.cardHint}>Operational intelligence only — existing finance calculations are read as-is.</Text>
              <View style={styles.stats}>
                <Stat label="Monthly sales" value={money(Number(report?.revenue ?? 0))} icon="cash" />
                <Stat label="Gross profit" value={money(Number(report?.gross_profit ?? 0))} icon="chart-line" />
                <Stat label="Products" value={String(products.length)} icon="package-variant" />
                <Stat label="Low stock" value={String(reorderRows.length)} icon="alert-circle" />
              </View>
            </Card>

            <Card>
              <View style={styles.headRow}><Text style={styles.cardTitle}>Smart reorder</Text><Badge text={reorderRows.length ? `${reorderRows.length} items` : "Good"} tone={reorderRows.length ? "warning" : "success"} /></View>
              {reorderRows.slice(0, 10).map((r) => (
                <Pressable key={r.p.id} style={styles.listRow} onPress={() => { setSelectedProductId(r.p.id); setTab("stock"); }}>
                  <MaterialDesignIcons name="package-variant-closed-alert" size={20} color={colors.warning} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{r.p.name}</Text>
                    <Text style={styles.rowSub}>{r.p.quantity} in stock · {r.daily > 0 ? `${Math.max(0, Math.floor(r.daysLeft))} days estimated` : "no recent sales"} · suggest {r.suggested}</Text>
                  </View>
                </Pressable>
              ))}
              {!reorderRows.length && <Text style={styles.empty}>No reorder suggestions.</Text>}
            </Card>

            <Card>
              <Text style={styles.cardTitle}>Best sellers</Text>
              {topSellers.map((r, i) => <View key={r.name + i} style={styles.listRow}><View style={styles.rank}><Text style={styles.rankText}>{i + 1}</Text></View><View style={{ flex: 1 }}><Text style={styles.rowTitle}>{r.name}</Text><Text style={styles.rowSub}>{r.qty} units sold</Text></View><Text style={styles.value}>{money(r.revenue)}</Text></View>)}
              {!topSellers.length && <Text style={styles.empty}>No sales data yet.</Text>}
            </Card>

            <BackupHealthCard />
          </>
        )}

        {tab === "stock" && (
          <>
            <Card>
              <Text style={styles.cardTitle}>Inventory intelligence</Text>
              <TextInput value={productSearch} onChangeText={setProductSearch} placeholder="Search name or barcode" placeholderTextColor={colors.muted} style={styles.input} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
                {filteredProducts.slice(0, 30).map((p) => (
                  <Pressable key={p.id} onPress={() => setSelectedProductId(p.id)} style={[styles.pill, selectedProductId === p.id && { backgroundColor: colors.brandPrimary }]}>
                    <Text numberOfLines={1} style={[styles.pillText, selectedProductId === p.id && { color: colors.onBrandPrimary }]}>{p.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </Card>

            {selectedProduct && (
              <>
                <Card>
                  <Text style={styles.cardTitle}>{selectedProduct.name}</Text>
                  <View style={styles.stats}>
                    <Stat label="Available" value={String(selectedProduct.quantity)} icon="package-variant" />
                    <Stat label="Sell price" value={money(selectedProduct.sale_price)} icon="tag-outline" />
                    <Stat label="Min stock" value={String(selectedProduct.low_stock_threshold)} icon="bell-outline" />
                  </View>
                </Card>
                <Card>
                  <Text style={styles.cardTitle}>Purchase cost history</Text>
                  {costHistory.map((r, i) => <View key={r.ref + i} style={styles.historyRow}><View style={{ flex: 1 }}><Text style={styles.rowTitle}>{fmtDate(r.date)} · {r.ref}</Text><Text style={styles.rowSub}>{r.supplier} · {r.qty} units</Text></View><Text style={styles.value}>{money(r.cost)}/unit</Text></View>)}
                  {!costHistory.length && <Text style={styles.empty}>No purchase history.</Text>}
                </Card>
                <Card>
                  <Text style={styles.cardTitle}>Stock movement timeline</Text>
                  {stockMovements.slice(0, 60).map((r, i) => <View key={r.type + r.date + i} style={styles.historyRow}><View style={[styles.moveIcon, { backgroundColor: r.quantity >= 0 ? colors.success + "18" : colors.error + "18" }]}><MaterialDesignIcons name={r.quantity >= 0 ? "arrow-down-bold" : "arrow-up-bold"} size={17} color={r.quantity >= 0 ? colors.success : colors.error} /></View><View style={{ flex: 1 }}><Text style={styles.rowTitle}>{r.type} · {r.quantity > 0 ? "+" : ""}{r.quantity}</Text><Text style={styles.rowSub}>{fmtDate(r.date)} · {r.detail}</Text></View></View>)}
                  {!stockMovements.length && <Text style={styles.empty}>No movement history.</Text>}
                </Card>
              </>
            )}
          </>
        )}

        {tab === "statements" && (
          <>
            <Card>
              <View style={styles.toggleRow}>
                <Pressable style={[styles.smallBtn, partyType === "supplier" && { backgroundColor: colors.brandPrimary }]} onPress={() => { setPartyType("supplier"); setSelectedPartyId(null); }}><Text style={[styles.smallBtnText, partyType === "supplier" && { color: colors.onBrandPrimary }]}>Suppliers</Text></Pressable>
                <Pressable style={[styles.smallBtn, partyType === "customer" && { backgroundColor: colors.brandPrimary }]} onPress={() => { setPartyType("customer"); setSelectedPartyId(null); }}><Text style={[styles.smallBtnText, partyType === "customer" && { color: colors.onBrandPrimary }]}>Customers</Text></Pressable>
              </View>
              <TextInput value={partySearch} onChangeText={setPartySearch} placeholder="Search party" placeholderTextColor={colors.muted} style={styles.input} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 8 }}>
                {filteredParties.map((p) => <Pressable key={p.id} onPress={() => setSelectedPartyId(p.id)} style={[styles.pill, selectedPartyId === p.id && { backgroundColor: colors.brandPrimary }]}><Text style={[styles.pillText, selectedPartyId === p.id && { color: colors.onBrandPrimary }]}>{p.name}</Text></Pressable>)}
              </ScrollView>
            </Card>
            {selectedParty && (
              <Card>
                <Text style={styles.cardTitle}>{selectedParty.name} statement</Text>
                <Text style={styles.balance}>{money(Number(selectedParty.balance ?? 0))}</Text>
                <Text style={styles.cardHint}>{partyType === "supplier" ? "Current payable balance from the existing ledger" : "Current receivable balance from the existing ledger"}</Text>
                <Text style={styles.statementNote}>The balance shown above is not recalculated here; the app's existing finance engine remains the source of truth.</Text>
                <Pressable testID="export-party-statement-pdf" style={styles.exportBtn} onPress={() => void exportStatementPdf()}>
                  <MaterialDesignIcons name="file-pdf-box" size={18} color={colors.onBrandPrimary} />
                  <Text style={styles.exportText}>Export statement PDF</Text>
                </Pressable>
                {statementRows.map((r, i) => <View key={r.type + r.date + i} style={styles.historyRow}><View style={{ flex: 1 }}><Text style={styles.rowTitle}>{r.type}</Text><Text style={styles.rowSub}>{fmtDate(r.date)} · {r.detail}</Text></View><Text style={[styles.value, { color: r.amount < 0 ? colors.error : colors.onSurface }]}>{r.amount < 0 ? "- " : "+ "}{money(Math.abs(r.amount))}</Text></View>)}
                {!statementRows.length && <Text style={styles.empty}>No transactions for this party.</Text>}
              </Card>
            )}
          </>
        )}

        {tab === "audit" && (
          <Card>
            <View style={styles.headRow}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Local audit trail</Text><Text style={styles.cardHint}>Tracks business mutations made through the app, including offline queued changes.</Text></View><Pressable style={styles.refresh} onPress={loadAudit}><MaterialDesignIcons name="refresh" size={18} color={colors.brandPrimary} /></Pressable></View>
            {auditRows.map((r) => <View key={r.id} style={styles.auditRow}><View style={styles.auditIcon}><MaterialDesignIcons name="shield-check-outline" size={18} color={colors.brandPrimary} /></View><View style={{ flex: 1 }}><Text style={styles.rowTitle}>{r.method} {r.path}</Text><Text style={styles.rowSub}>{formatDateTime(r.created_at)}{r.status ? ` · HTTP ${r.status}` : " · queued/offline"}</Text></View></View>)}
            {!auditRows.length && <Text style={styles.empty}>Open this tab or tap refresh to load local history.</Text>}
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: string }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return <View style={styles.stat}><MaterialDesignIcons name={icon as any} size={19} color={colors.brandPrimary} /><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function BackupHealthCard() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [queue, setQueue] = useState<number | null>(null);
  const [phoneAt, setPhoneAt] = useState<string | null>(null);
  const [driveAt, setDriveAt] = useState<string | null>(null);

  const refresh = async () => {
    const [q, phone, phoneStamp, drive] = await Promise.all([
      getWriteQueueCount(),
      storage.getItem<string | null>("ssm.auto-backup-dir", null),
      storage.getItem<string | null>("ssm.last-phone-backup-at", null),
      storage.getItem<string | null>("ssm.last-drive-backup-at", null),
    ]);
    setQueue(q);
    setPhoneAt(phone && phoneStamp ? phoneStamp : null);
    setDriveAt(drive);
  };

  useEffect(() => { void refresh(); }, []);
  return (
    <Card>
      <View style={styles.headRow}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Backup & sync health</Text><Text style={styles.cardHint}>Device backup, Drive backup and unsynced write queue.</Text></View><Pressable onPress={() => void refresh()} style={styles.refresh}><MaterialDesignIcons name="refresh" size={18} color={colors.brandPrimary} /></Pressable></View>
      <View style={styles.healthRow}>
        <HealthItem label="Phone backup" ok={!!phoneAt} text={phoneAt ? fmtDate(phoneAt) : "Not backed up"} />
        <HealthItem label="Drive backup" ok={!!driveAt} text={driveAt ? fmtDate(driveAt) : "Not backed up"} />
        <HealthItem label="Sync queue" ok={queue === 0} text={queue === null ? "…" : String(queue)} />
      </View>
    </Card>
  );
}

function HealthItem({ label, ok, text }: { label: string; ok: boolean; text?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View style={styles.healthItem}><MaterialDesignIcons name={ok ? "check-circle" : "alert-circle-outline"} size={18} color={ok ? colors.success : colors.warning} /><Text style={styles.healthText}>{label}</Text>{text !== undefined && <Text style={styles.healthValue}>{text}</Text>}</View>;
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  tabRow: { flexDirection: "row", gap: 6 },
  tab: { flex: 1, minHeight: 42, borderRadius: 11, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center", gap: 2 },
  tabText: { fontSize: 10, fontWeight: "800", color: colors.onSurface },
  cardTitle: { fontSize: 16, fontWeight: "800", color: colors.onSurface, marginBottom: 4 },
  cardHint: { fontSize: 11, color: colors.muted, lineHeight: 16 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  stat: { flexGrow: 1, minWidth: "22%", borderRadius: 11, padding: 10, backgroundColor: colors.surfaceTertiary, gap: 4 },
  statValue: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  statLabel: { fontSize: 10, color: colors.muted },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  listRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.divider },
  rowTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  rowSub: { fontSize: 11, color: colors.muted, marginTop: 2 },
  value: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  empty: { fontSize: 12, color: colors.muted, marginTop: 4 },
  rank: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  rankText: { fontSize: 11, fontWeight: "800", color: colors.onSurface },
  input: { marginTop: 10, height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, color: colors.onSurface, backgroundColor: colors.surface },
  pill: { paddingHorizontal: 12, minHeight: 36, maxWidth: 190, borderRadius: 18, backgroundColor: colors.surfaceTertiary, justifyContent: "center" },
  pillText: { fontSize: 11, fontWeight: "700", color: colors.onSurface },
  historyRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.divider },
  moveIcon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  balance: { fontSize: 26, fontWeight: "900", color: colors.onSurface, marginTop: 6 },
  statementNote: { marginTop: 10, padding: 9, borderRadius: 9, backgroundColor: colors.surfaceTertiary, color: colors.muted, fontSize: 11, lineHeight: 16 },
  toggleRow: { flexDirection: "row", gap: 8 },
  smallBtn: { flex: 1, minHeight: 38, borderRadius: 9, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  smallBtnText: { fontSize: 12, fontWeight: "800", color: colors.onSurface },
  refresh: { width: 38, height: 38, borderRadius: 10, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  exportBtn: { marginTop: 10, minHeight: 44, borderRadius: 11, backgroundColor: colors.brandPrimary, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  exportText: { color: colors.onBrandPrimary, fontSize: 13, fontWeight: "800" },
  auditRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.divider },
  auditIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" },
  healthRow: { marginTop: 10, gap: 8 },
  healthItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 },
  healthText: { flex: 1, fontSize: 12, color: colors.onSurfaceSecondary },
  healthValue: { fontSize: 12, fontWeight: "800", color: colors.onSurface },
}));
