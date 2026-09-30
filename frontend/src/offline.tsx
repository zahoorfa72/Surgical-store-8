// Offline-first layer for the Surgical Store app.
//
// Three responsibilities:
//   1. Persist the React Query cache to storage so all screens keep working
//      (read) with no connection, using the last data we saw online.
//   2. Detect connectivity (NetInfo) and expose it to the whole app.
//   3. An "outbox" that queues sales & purchases created while offline and
//      replays them against the backend the moment we are back online.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import NetInfo from "@react-native-community/netinfo";
import { dehydrate, hydrate } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { ApiError, apiRequest, rawRequest, flushWriteQueue, flushOfflineLogo, getConnectionMode, getWriteQueueCount } from "@/src/api";
import { queryClient } from "@/src/query-client";
import { qk } from "@/src/data";
import { Product, Purchase, Sale } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { useToast } from "@/src/ui";
import { money } from "@/src/format";
import { makeStyles, useTheme } from "@/src/theme";

const CACHE_KEY = "ssm.qcache.v1";
const OUTBOX_KEY = "ssm.outbox.v1";
const LOCAL_SEQ_KEY = "ssm.localseq.v1";

export type OutboxKind = "sale" | "purchase";
type OutboxItem = { local_id: string; kind: OutboxKind; body: any; created_at: string };

// ---------------------------------------------------------------------------
// Cache persistence (read offline)
// ---------------------------------------------------------------------------
async function restoreCache() {
  const dumped = await storage.getItem<any>(CACHE_KEY, null);
  if (dumped) {
    try {
      hydrate(queryClient, dumped);
    } catch {
      /* ignore malformed cache */
    }
  }
}

function startCachePersistence() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const dumped = dehydrate(queryClient, {
        shouldDehydrateQuery: (q) => q.state.status === "success",
      });
      storage.setItem(CACHE_KEY, dumped as any);
    }, 800);
  };
  return queryClient.getQueryCache().subscribe(save);
}

// ---------------------------------------------------------------------------
// Outbox helpers
// ---------------------------------------------------------------------------
async function getOutbox(): Promise<OutboxItem[]> {
  return (await storage.getItem<OutboxItem[]>(OUTBOX_KEY, [])) ?? [];
}
async function setOutbox(list: OutboxItem[]): Promise<void> {
  await storage.setItem(OUTBOX_KEY, list as any);
}
async function nextLocalSeq(): Promise<number> {
  const n = ((await storage.getItem<number>(LOCAL_SEQ_KEY, 0)) ?? 0) + 1;
  await storage.setItem(LOCAL_SEQ_KEY, n);
  return n;
}

// ---------------------------------------------------------------------------
// Build optimistic local records from cached products / parties
// ---------------------------------------------------------------------------
function products(): Product[] {
  return (queryClient.getQueryData<Product[]>(qk.products) ?? []) as Product[];
}
function partyName(id: string | null | undefined, type: "customer" | "supplier"): string {
  if (!id) return type === "customer" ? "Walk-in" : "—";
  const list = (queryClient.getQueryData(qk.parties(type)) as any[]) ?? [];
  return list.find((p) => p.id === id)?.name ?? (type === "customer" ? "Walk-in" : "—");
}

async function buildLocalSale(body: any, cashierName: string): Promise<Sale> {
  const prods = products();
  const items = (body.items ?? []).map((it: any) => {
    const p = prods.find((x) => x.id === it.product_id);
    const purchase_price = p?.purchase_price ?? 0;
    return {
      product_id: it.product_id,
      name: p?.name ?? "Item",
      quantity: it.quantity,
      unit_price: it.unit_price,
      purchase_price,
      line_total: Math.round(it.quantity * it.unit_price * 100) / 100,
    };
  });
  const subtotal = items.reduce((s: number, i: any) => s + i.line_total, 0);
  const discount = Math.max(0, body.discount ?? 0);
  const total = Math.max(0, subtotal - discount);
  const cogs = items.reduce((s: number, i: any) => s + i.quantity * i.purchase_price, 0);
  const seq = await nextLocalSeq();
  return {
    id: `local-sale-${seq}`,
    invoice_no: `OFFLINE-${String(seq).padStart(4, "0")}`,
    items,
    customer_id: body.customer_id ?? null,
    customer_name: partyName(body.customer_id, "customer"),
    subtotal: Math.round(subtotal * 100) / 100,
    discount,
    total: Math.round(total * 100) / 100,
    cogs: Math.round(cogs * 100) / 100,
    profit: Math.round((total - cogs) * 100) / 100,
    note: body.note ?? "",
    cashier_name: cashierName,
    credit: !!body.credit,
    created_at: new Date().toISOString(),
    pending: true,
  } as Sale;
}

async function buildLocalPurchase(body: any, userName: string): Promise<Purchase> {
  const prods = products();
  const items = (body.items ?? []).map((it: any) => {
    const p = prods.find((x) => x.id === it.product_id);
    return {
      product_id: it.product_id,
      name: p?.name ?? "Item",
      quantity: it.quantity,
      unit_cost: it.unit_cost,
      line_total: Math.round(it.quantity * it.unit_cost * 100) / 100,
    };
  });
  const total = items.reduce((s: number, i: any) => s + i.line_total, 0);
  const seq = await nextLocalSeq();
  return {
    id: `local-purchase-${seq}`,
    ref_no: `OFFLINE-PO-${String(seq).padStart(4, "0")}`,
    items,
    supplier_id: body.supplier_id ?? null,
    supplier_name: partyName(body.supplier_id, "supplier"),
    total: Math.round(total * 100) / 100,
    note: body.note ?? "",
    user_name: userName,
    created_at: new Date().toISOString(),
    pending: true,
  } as Purchase;
}

function applyStockDelta(items: any[], sign: 1 | -1) {
  queryClient.setQueryData<Product[]>(qk.products, (old) =>
    (old ?? []).map((p) => {
      const line = items.find((i) => i.product_id === p.id);
      if (!line) return p;
      return { ...p, quantity: p.quantity + sign * line.quantity };
    }),
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
type OfflineState = {
  online: boolean;
  pending: number;
  // Create a sale: try the network, otherwise queue it. Returns the sale
  // (real or optimistic) plus whether it was queued for later.
  createSale: (body: any, cashierName: string) => Promise<{ sale: Sale; queued: boolean }>;
  createPurchase: (body: any, userName: string) => Promise<{ purchase: Purchase; queued: boolean }>;
  flush: () => Promise<void>;
};

const OfflineContext = createContext<OfflineState | undefined>(undefined);

type SyncedRow = { no: string; total: number };
type SyncSummary = { sales: SyncedRow[]; purchases: SyncedRow[]; others: number; dropped: number };

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const flushing = useRef(false);
  const wasOnline = useRef(true);

  const refreshPending = useCallback(async () => {
    const box = await getOutbox();
    const writes = await getWriteQueueCount();
    setPending(box.length + writes);
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    const state = await NetInfo.fetch();
    if (!(state.isConnected && state.isInternetReachable !== false)) return;
    flushing.current = true;
    try {
      // Sales/purchases are synced first because returns can reference them.
      // We then pass the local->server ID map to the generic write queue so
      // offline returns can safely reference a sale/purchase created offline.
      const box = await getOutbox();
      const idMap: Record<string, string> = {};
      let dropped = 0;
      const syncedSales: SyncedRow[] = [];
      const syncedPurchases: SyncedRow[] = [];
      if (box.length) {
        let i = 0;
        for (; i < box.length; i++) {
          const item = box[i];
          const path = item.kind === "sale" ? "/sales" : "/purchases";
          try {
            const res = await rawRequest<any>(path, { method: "POST", body: item.body });
            if (res?.id && item.local_id) idMap[item.local_id] = res.id;
            if (item.kind === "sale") {
              syncedSales.push({ no: res?.invoice_no ?? "—", total: res?.total ?? 0 });
              queryClient.setQueryData(qk.sale(item.local_id), res);
              queryClient.setQueryData<Sale[]>(qk.sales, (old) => [
                res,
                ...(old ?? []).filter((row) => row.id !== item.local_id),
              ]);
            } else {
              syncedPurchases.push({ no: res?.ref_no ?? "—", total: res?.total ?? 0 });
              queryClient.setQueryData(qk.purchase(item.local_id), res);
              queryClient.setQueryData<Purchase[]>(qk.purchases, (old) => [
                res,
                ...(old ?? []).filter((row) => row.id !== item.local_id),
              ]);
            }
          } catch (e) {
            if (e instanceof ApiError) {
              // Keep failed operations instead of silently deleting them.
              await setOutbox(box.slice(i));
              await refreshPending();
              return;
            }
            await setOutbox(box.slice(i));
            await refreshPending();
            return;
          }
        }
        await setOutbox([]);
      }
      await queryClient.invalidateQueries({ queryKey: qk.products });
      const writeRes = await flushWriteQueue(idMap);
      dropped = writeRes.dropped;
      // Settings logo uploads use multipart/form-data and therefore have their
      // own small offline queue. Flush it after normal JSON writes.
      await flushOfflineLogo();
      if (!box.length && writeRes.synced === 0 && writeRes.dropped === 0) {
        await refreshPending();
        return;
      }
      if (!box.length) {
        await refreshPending();
        if (writeRes.synced > 0 || writeRes.dropped > 0) {
          setSyncSummary({ sales: [], purchases: [], others: writeRes.synced, dropped: writeRes.dropped });
        }
        return;
      }

      await refreshPending();
      await queryClient.invalidateQueries();
      const synced = syncedSales.length + syncedPurchases.length + writeRes.synced;
      if (synced > 0 || dropped > 0) {
        setSyncSummary({ sales: syncedSales, purchases: syncedPurchases, others: writeRes.synced, dropped });
      }
    } finally {
      flushing.current = false;
    }
  }, [refreshPending]);

  // Boot: restore cache + outbox count, then subscribe to persistence & network.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      await restoreCache();
      await refreshPending();
      unsub = startCachePersistence();
      setHydrated(true);
    })();
    return () => unsub?.();
  }, [refreshPending]);

  useEffect(() => {
    if (hydrated) {
      void flush();
    }
  }, [hydrated, flush]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const isUp = !!(state.isConnected && state.isInternetReachable !== false);
      setOnline(isUp);
      if (isUp && !wasOnline.current) {
        // Just came back online -> sync the outbox.
        flush();
      }
      wasOnline.current = isUp;
    });
    return () => unsubscribe();
  }, [flush]);

  const createSale = useCallback<OfflineState["createSale"]>(async (body, cashierName) => {
    const state = await NetInfo.fetch();
    const mode = await getConnectionMode();
    const isUp = mode === "online" && !!(state.isConnected && state.isInternetReachable !== false);
    if (isUp) {
      try {
        const sale = await apiRequest<Sale>("/sales", { method: "POST", body });
        return { sale, queued: false };
      } catch (e) {
        if (e instanceof ApiError) throw e; // real validation error -> surface
        // otherwise network dropped -> fall through and queue
      }
    }
    const local = await buildLocalSale(body, cashierName);
    applyStockDelta(local.items, -1);
    queryClient.setQueryData<Sale[]>(qk.sales, (old) => [local, ...(old ?? [])]);
    queryClient.setQueryData(qk.sale(local.id), local);
    if (local.customer_id && local.credit) {
      queryClient.setQueryData<any[]>(qk.parties("customer"), (old) => (old ?? []).map((p) =>
        p.id === local.customer_id ? { ...p, balance: Number(p.balance ?? 0) + Number(local.total ?? 0) } : p
      ));
    }
    const box = await getOutbox();
    await setOutbox([...box, { local_id: local.id, kind: "sale", body, created_at: local.created_at }]);
    await refreshPending();
    queryClient.invalidateQueries({ queryKey: ["report"] });
    queryClient.invalidateQueries({ queryKey: ["customers"] });
    queryClient.invalidateQueries({ queryKey: ["day-close"] });
    return { sale: local, queued: true };
  }, [refreshPending]);

  const createPurchase = useCallback<OfflineState["createPurchase"]>(async (body, userName) => {
    const state = await NetInfo.fetch();
    const mode = await getConnectionMode();
    const isUp = mode === "online" && !!(state.isConnected && state.isInternetReachable !== false);
    if (isUp) {
      try {
        const purchase = await apiRequest<Purchase>("/purchases", { method: "POST", body });
        return { purchase, queued: false };
      } catch (e) {
        if (e instanceof ApiError) throw e;
      }
    }
    const local = await buildLocalPurchase(body, userName);
    applyStockDelta(local.items, 1);
    queryClient.setQueryData<Purchase[]>(qk.purchases, (old) => [local, ...(old ?? [])]);
    queryClient.setQueryData(qk.purchase(local.id), local);
    if (local.supplier_id) {
      queryClient.setQueryData<any[]>(qk.parties("supplier"), (old) => (old ?? []).map((p) =>
        p.id === local.supplier_id ? { ...p, balance: Number(p.balance ?? 0) + Number(local.total ?? 0) } : p
      ));
    }
    const box = await getOutbox();
    await setOutbox([...box, { local_id: local.id, kind: "purchase", body, created_at: local.created_at }]);
    await refreshPending();
    queryClient.invalidateQueries({ queryKey: ["report"] });
    queryClient.invalidateQueries({ queryKey: ["customers"] });
    queryClient.invalidateQueries({ queryKey: ["day-close"] });
    return { purchase: local, queued: true };
  }, [refreshPending]);

  const value = useMemo(
    () => ({ online, pending, createSale, createPurchase, flush }),
    [online, pending, createSale, createPurchase, flush],
  );

  if (!hydrated) return null;

  return (
    <OfflineContext.Provider value={value}>
      {children}
      <OfflineBanner online={online} pending={pending} />
      <SyncSummaryModal summary={syncSummary} onClose={() => setSyncSummary(null)} />
    </OfflineContext.Provider>
  );
}

export function useOffline(): OfflineState {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error("useOffline must be used within OfflineProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Banner shown when offline or when changes are waiting to sync.
// ---------------------------------------------------------------------------
function OfflineBanner({ online, pending }: { online: boolean; pending: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (online && pending === 0) return null;
  const offlineMode = !online;
  return (
    <View
      testID="offline-banner"
      pointerEvents="none"
      style={[
        styles.banner,
        {
          bottom: insets.bottom + 8,
          right: 8,
          left: undefined,
          alignSelf: "flex-end",
          paddingHorizontal: 6,
          paddingVertical: 3,
          borderRadius: 999,
          maxWidth: 120,
          minHeight: 22,
          opacity: 0.88,
        },
        offlineMode ? styles.bannerOffline : styles.bannerPending,
      ]}
    >
      <MaterialDesignIcons
        name={offlineMode ? "cloud-off-outline" : "cloud-sync-outline"}
        size={13}
        color={colors.onSurfaceInverse}
      />
      <Text style={styles.bannerText} testID="offline-banner-text">
        {offlineMode
          ? pending > 0
            ? `Offline · ${pending} change${pending > 1 ? "s" : ""} will sync`
            : "Offline · data may be out of date"
          : `Syncing ${pending} change${pending > 1 ? "s" : ""}…`}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sync summary: a note shown after reconnecting listing exactly what synced.
// ---------------------------------------------------------------------------
function SyncSummaryModal({
  summary,
  onClose,
}: {
  summary: SyncSummary | null;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const visible = !!summary;
  const sales = summary?.sales ?? [];
  const purchases = summary?.purchases ?? [];
  const others = summary?.others ?? 0;
  const dropped = summary?.dropped ?? 0;
  const count = sales.length + purchases.length + others;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.summaryScrim}>
        <View style={[styles.summaryCard, { paddingBottom: insets.bottom + 16 }]} testID="sync-summary-modal">
          <View style={styles.summaryHead}>
            <View style={styles.summaryIcon}>
              <MaterialDesignIcons name="cloud-check-outline" size={24} color={colors.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.summaryTitle}>Back online — synced</Text>
              <Text style={styles.summarySubtitle}>
                {count} offline change{count === 1 ? "" : "s"} saved to the server
              </Text>
            </View>
          </View>

          <ScrollView style={styles.summaryList} contentContainerStyle={{ gap: 8 }}>
            {sales.length > 0 && <Text style={styles.summarySection}>Sales ({sales.length})</Text>}
            {sales.map((r, idx) => (
              <View key={`s-${idx}`} style={styles.summaryRow} testID={`sync-sale-${idx}`}>
                <MaterialDesignIcons name="receipt-text-outline" size={18} color={colors.brandPrimary} />
                <Text style={styles.summaryRowNo}>{r.no}</Text>
                <Text style={styles.summaryRowAmt}>{money(r.total)}</Text>
              </View>
            ))}

            {purchases.length > 0 && (
              <Text style={styles.summarySection}>Purchases ({purchases.length})</Text>
            )}
            {purchases.map((r, idx) => (
              <View key={`p-${idx}`} style={styles.summaryRow} testID={`sync-purchase-${idx}`}>
                <MaterialDesignIcons name="truck-outline" size={18} color={colors.warning} />
                <Text style={styles.summaryRowNo}>{r.no}</Text>
                <Text style={styles.summaryRowAmt}>{money(r.total)}</Text>
              </View>
            ))}

            {others > 0 && (
              <View style={styles.summaryRow} testID="sync-others">
                <MaterialDesignIcons name="database-sync-outline" size={18} color={colors.info} />
                <Text style={styles.summaryRowNo}>Other updates</Text>
                <Text style={styles.summaryRowAmt}>{others}</Text>
              </View>
            )}

            {dropped > 0 && (
              <View style={styles.summaryDropped} testID="sync-dropped-note">
                <MaterialDesignIcons name="alert-circle-outline" size={18} color={colors.error} />
                <Text style={styles.summaryDroppedText}>
                  {dropped} change{dropped === 1 ? "" : "s"} could not sync (stock may have changed).
                </Text>
              </View>
            )}
          </ScrollView>

          <Pressable testID="sync-summary-done" style={styles.summaryDone} onPress={onClose}>
            <Text style={styles.summaryDoneText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((colors) => ({
  banner: {
    position: "absolute",
    zIndex: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 9,
  },
  bannerOffline: { backgroundColor: colors.surfaceInverse },
  bannerPending: { backgroundColor: colors.brandPrimary },
  bannerText: { color: colors.onSurfaceInverse, fontSize: 9, fontWeight: "700", flexShrink: 1, textAlign: "center" },
  summaryScrim: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  summaryCard: {
    width: "100%",
    maxHeight: "80%",
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 20,
    gap: 14,
  },
  summaryHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  summaryIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.success + "1A",
    alignItems: "center",
    justifyContent: "center",
  },
  summaryTitle: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  summarySubtitle: { fontSize: 13, color: colors.muted, marginTop: 2 },
  summaryList: { flexGrow: 0 },
  summarySection: {
    fontSize: 12,
    fontWeight: "800",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: 6,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summaryRowNo: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.onSurface },
  summaryRowAmt: { fontSize: 14, fontWeight: "800", color: colors.brandPrimary },
  summaryDropped: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.error + "12",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
  },
  summaryDroppedText: { flex: 1, fontSize: 13, color: colors.error, fontWeight: "600" },
  summaryDone: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryDoneText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "800" },
}));
