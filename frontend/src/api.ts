// Thin fetch wrapper around the FastAPI backend. Attaches the JWT bearer token
// (kept in a module variable, mirrored to persistent storage by auth.tsx).
//
// Offline-first writes: when a create/update/delete for a supported entity fails
// because the device is offline, the request is queued and the React Query cache
// is optimistically patched so the change shows immediately. The queue is
// replayed by offline.tsx when connectivity returns.

import NetInfo from "@react-native-community/netinfo";
import { Platform } from "react-native";

import { storage } from "@/src/utils/storage";
import { queryClient } from "@/src/query-client";

const RAW_BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export type ConnectionMode = "offline" | "online";
const CONNECTION_MODE_KEY = "ssm.connectionmode.v2";

export async function getConnectionMode(): Promise<ConnectionMode> {
  // Default to OFFLINE so the app is fully usable on-device with no server.
  // Switch to Online in More → Data mode once a backend/Supabase URL is set.
  return (await storage.getItem<ConnectionMode>(CONNECTION_MODE_KEY, "offline")) ?? "offline";
}

export async function setConnectionMode(mode: ConnectionMode): Promise<void> {
  await storage.setItem(CONNECTION_MODE_KEY, mode);
  if (mode === "online") {
    try { await flushWriteQueue(); } catch { /* keep the queue */ }
  }
  // Immediately refresh screens so switching modes takes effect without
  // restarting the app.
  await queryClient.invalidateQueries();
}

// Optional user-set server URL (Settings → "Server URL"). Overrides the build-time
// backend URL when present. Loaded from storage at startup by loadBaseOverride().
let baseOverride: string | null = null;
export function setApiBaseOverride(url: string | null) {
  const clean = (url ?? "").trim().replace(/\/+$/, "");
  baseOverride = clean ? clean : null;
}
export function getApiBaseOverride(): string | null {
  return baseOverride;
}
export async function loadBaseOverride() {
  const saved = await storage.getItem<string>("ssm.serverurl", "");
  if (saved) setApiBaseOverride(saved);
}
function base(): string {
  const b = baseOverride ?? RAW_BASE;
  return b ? `${b}/api` : "/api";
}
export function backendRoot(): string {
  return baseOverride ?? RAW_BASE ?? "";
}

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}
export function getAuthToken(): string | null {
  return authToken;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail) && data.detail[0]?.msg) return data.detail[0].msg;
    return "Something went wrong";
  } catch {
    return "Something went wrong";
  }
}

// ---------------------------------------------------------------------------
// Offline write queue (products / parties / expenses / payments)
// ---------------------------------------------------------------------------
const WRITE_OUTBOX = "ssm.writeq.v1";
const WRITE_SEQ = "ssm.writeseq.v1";

type WriteOp = { id: string; method: string; path: string; body: any };

const QUEUEABLE = ["/products", "/parties", "/expenses", "/payments", "/returns", "/purchase-returns", "/budget", "/sales", "/purchases", "/users", "/settings"];
function isQueueable(path: string): boolean {
  return QUEUEABLE.some((p) => path === p || path.startsWith(p + "/"));
}
function entityOf(path: string): "products" | "parties" | "expenses" | "payments" | "returns" | "purchase-returns" | "budget" | "sales" | "purchases" | "users" | "settings" | null {
  if (path.startsWith("/products")) return "products";
  if (path.startsWith("/parties")) return "parties";
  if (path.startsWith("/expenses")) return "expenses";
  if (path.startsWith("/payments")) return "payments";
  if (path.startsWith("/returns")) return "returns";
  if (path.startsWith("/purchase-returns")) return "purchase-returns";
  if (path.startsWith("/budget")) return "budget";
  if (path.startsWith("/sales")) return "sales";
  if (path.startsWith("/purchases")) return "purchases";
  if (path.startsWith("/users")) return "users";
  if (path.startsWith("/settings")) return "settings";
  return null;
}
function idFromPath(path: string): string | null {
  const m = path.match(/^\/[a-z-]+\/(.+)$/);
  return m ? m[1] : null;
}

async function nextSeq(): Promise<number> {
  const n = ((await storage.getItem<number>(WRITE_SEQ, 0)) ?? 0) + 1;
  await storage.setItem(WRITE_SEQ, n);
  return n;
}
async function getWriteQueue(): Promise<WriteOp[]> {
  return (await storage.getItem<WriteOp[]>(WRITE_OUTBOX, [])) ?? [];
}
async function setWriteQueue(list: WriteOp[]) {
  await storage.setItem(WRITE_OUTBOX, list as any);
}
export async function getWriteQueueCount(): Promise<number> {
  return (await getWriteQueue()).length;
}

function now() {
  return new Date().toISOString();
}

// Report/customers/day-close are derived from the base collections by data.ts.
// After any local write we must mark them stale so the dashboard recomputes.
function invalidateDerivedReports() {
  queryClient.invalidateQueries({ queryKey: ["report"] });
  queryClient.invalidateQueries({ queryKey: ["customers"] });
  queryClient.invalidateQueries({ queryKey: ["day-close"] });
}

// Optimistically patch the cache so offline changes appear right away.
function applyOptimistic(method: string, path: string, body: any, tempId: string) {
  const entity = entityOf(path);
  const id = idFromPath(path);

  if (entity === "products") {
    if (method === "POST") {
      const rec = { id: tempId, ...body, quantity: 0, created_at: now(), updated_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["products"], (old) => [rec, ...(old ?? [])]);
    } else if (method === "PUT" && id) {
      queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => p.id === id ? { ...p, ...body, updated_at: now(), pending: true } : p));
    } else if (method === "DELETE" && id) {
      queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).filter((p) => p.id !== id));
    }
  } else if (entity === "parties") {
    if (method === "POST") {
      const rec = { id: tempId, name: body.name, type: body.type, phone: body.phone ?? "", address: body.address ?? "", created_at: now(), balance: 0, pending: true };
      queryClient.setQueryData<any[]>(["parties", body.type], (old) => [rec, ...(old ?? [])]);
    } else if (method === "PUT" && id) {
      ["customer", "supplier", "all"].forEach((t) => queryClient.setQueryData<any[]>(["parties", t], (old) => (old ?? []).map((p) => p.id === id ? { ...p, ...body, pending: true } : p)));
    } else if (method === "DELETE" && id) {
      ["customer", "supplier", "all"].forEach((t) => queryClient.setQueryData<any[]>(["parties", t], (old) => (old ?? []).filter((p) => p.id !== id)));
    }
  } else if (entity === "expenses") {
    const keys = [["expenses", "all"], ["expenses", "cogs"], ["expenses", "operating"], ["expenses", "personal"]];
    if (method === "POST") {
      const rec = { id: tempId, title: body.title, category: body.category ?? "Other", bucket: body.bucket ?? "operating", amount: body.amount ?? 0, note: body.note ?? "", user_name: "", created_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["expenses", "all"], (old) => [rec, ...(old ?? [])]);
      queryClient.setQueryData<any[]>(["expenses", rec.bucket], (old) => [rec, ...(old ?? [])]);
    } else if (method === "PUT" && id) {
      keys.forEach((k) => queryClient.setQueryData<any[]>(k, (old) => (old ?? []).map((e) => e.id === id ? { ...e, ...body, pending: true } : e)));
    } else if (method === "DELETE" && id) {
      keys.forEach((k) => queryClient.setQueryData<any[]>(k, (old) => (old ?? []).filter((e) => e.id !== id)));
    }
  } else if (entity === "returns") {
    if (method === "PUT" && id) {
      const old = (queryClient.getQueryData<any[]>(["returns"]) ?? []).find((r) => r.id === id);
      const sale = body.sale_id ? queryClient.getQueryData<any>(["sale", body.sale_id]) : null;
      if (old) {
        queryClient.setQueryData<any[]>(["products"], (list) => (list ?? []).map((p) => {
          const oldIt = (old.items ?? []).find((x:any) => x.product_id === p.id);
          const newIt = (body.items ?? []).find((x:any) => x.product_id === p.id);
          const undo = Number(oldIt?.quantity ?? 0);
          const add = Number(newIt?.quantity ?? 0);
          return (oldIt || newIt) ? { ...p, quantity: Number(p.quantity ?? 0) - undo + add } : p;
        }));
      }
      const refund_total = (body.items ?? []).reduce((sum:number,it:any) => {
        const si = sale?.items?.find((x:any) => x.product_id === it.product_id);
        return sum + Number(si?.unit_price ?? it.unit_price ?? 0) * Number(it.quantity ?? 0);
      },0);
      const next = {
        ...(old ?? {}), ...body, id, refund_total,
        customer_id: sale?.customer_id ?? old?.customer_id ?? null,
        credit: !!(sale?.credit ?? old?.credit),
        items: body.items ?? old?.items ?? [], pending: true
      };
      queryClient.setQueryData<any[]>(["returns"], (oldRows) => (oldRows ?? []).map((r) => r.id === id ? next : r));
      if (next.credit && next.customer_id) {
        const delta = refund_total - Number(old?.refund_total ?? 0);
        queryClient.setQueryData<any[]>(["parties","customer"], (oldRows) => (oldRows ?? []).map((p) =>
          p.id === next.customer_id ? { ...p, balance: Number(p.balance ?? 0) - delta } : p
        ));
      }
    } else if (method === "POST") {
      const sale = body.sale_id ? queryClient.getQueryData<any>(["sale", body.sale_id]) : null;
      const items = (body.items ?? []).map((it: any) => {
        const si = sale?.items?.find((x: any) => x.product_id === it.product_id);
        const qty = Number(it.quantity ?? 0);
        const unitPrice = Number(si?.unit_price ?? it.unit_price ?? 0);
        const purchasePrice = Number(si?.purchase_price ?? 0);
        return { ...it, name: si?.name ?? "Item", unit_price: unitPrice, purchase_price: purchasePrice, line_total: Math.round(qty * unitPrice * 100) / 100 };
      });
      const refund_total = items.reduce((sum: number, it: any) => sum + Number(it.line_total ?? 0), 0);
      const refund_cogs = items.reduce((sum: number, it: any) => sum + Number(it.quantity ?? 0) * Number(it.purchase_price ?? 0), 0);
      const rec = { id: tempId, ref_no: `OFFLINE-RET-${tempId.split("-").pop()}`, sale_id: body.sale_id, customer_id: sale?.customer_id ?? null, credit: !!sale?.credit, invoice_no: sale?.invoice_no ?? "—", customer_name: sale?.customer_name ?? "Walk-in", items, refund_total, refund_cogs, refund_profit: refund_total - refund_cogs, reason: body.reason ?? "", user_name: "", created_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["returns"], (old) => [rec, ...(old ?? [])]);
      queryClient.setQueryData<any>(["sale", body.sale_id], (old) => {
        if (!old) return old;
        const returned_items = { ...(old.returned_items ?? {}) };
        for (const it of items) returned_items[it.product_id] = Number(returned_items[it.product_id] ?? 0) + Number(it.quantity ?? 0);
        return { ...old, returned_items, returned_total: Number(old.returned_total ?? 0) + refund_total };
      });
      queryClient.setQueryData<any[]>(["sales"], (old) => (old ?? []).map((s) => {
        if (s.id !== body.sale_id) return s;
        const returned_items = { ...(s.returned_items ?? {}) };
        for (const it of items) returned_items[it.product_id] = Number(returned_items[it.product_id] ?? 0) + Number(it.quantity ?? 0);
        return { ...s, returned_items, returned_total: Number(s.returned_total ?? 0) + refund_total };
      }));
      if (sale?.customer_id && sale?.credit) {
        queryClient.setQueryData<any[]>(["parties", "customer"], (old) => (old ?? []).map((p) =>
          p.id === sale.customer_id ? { ...p, balance: Number(p.balance ?? 0) - refund_total } : p
        ));
      }
      queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => {
        const it = items.find((x: any) => x.product_id === p.id);
        return it ? { ...p, quantity: p.quantity + Number(it.quantity || 0) } : p;
      }));
    } else if (method === "DELETE" && id) {
      const row = (queryClient.getQueryData<any[]>(["returns"]) ?? []).find((r) => r.id === id);
      queryClient.setQueryData<any[]>(["returns"], (old) => (old ?? []).filter((r) => r.id !== id));
      if (row) {
        queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => {
          const it = (row.items ?? []).find((x: any) => x.product_id === p.id);
          return it ? { ...p, quantity: p.quantity - Number(it.quantity || 0) } : p;
        }));
        if (row.customer_id && row.credit) {
          queryClient.setQueryData<any[]>(["parties", "customer"], (old) => (old ?? []).map((p) =>
            p.id === row.customer_id ? { ...p, balance: Number(p.balance ?? 0) + Number(row.refund_total ?? 0) } : p
          ));
        }
      }
    }
  } else if (entity === "purchase-returns") {
    if (method === "PUT" && id) {
      const old = (queryClient.getQueryData<any[]>(["purchase-returns"]) ?? []).find((r) => r.id === id);
      const purchase = body.purchase_id ? queryClient.getQueryData<any>(["purchase", body.purchase_id]) : null;
      if (old) {
        queryClient.setQueryData<any[]>(["products"], (list) => (list ?? []).map((p) => {
          const oldIt = (old.items ?? []).find((x:any) => x.product_id === p.id);
          const newIt = (body.items ?? []).find((x:any) => x.product_id === p.id);
          const undo = Number(oldIt?.quantity ?? 0);
          const remove = Number(newIt?.quantity ?? 0);
          return (oldIt || newIt) ? { ...p, quantity: Number(p.quantity ?? 0) + undo - remove } : p;
        }));
      }
      const refund_total = (body.items ?? []).reduce((sum:number,it:any) => {
        const pi = purchase?.items?.find((x:any) => x.product_id === it.product_id);
        return sum + Number(pi?.unit_cost ?? it.unit_cost ?? 0) * Number(it.quantity ?? 0);
      },0);
      const next = { ...(old ?? {}), ...body, id, refund_total,
        supplier_id: purchase?.supplier_id ?? old?.supplier_id ?? null,
        supplier_name: purchase?.supplier_name ?? old?.supplier_name ?? "—",
        items: body.items ?? old?.items ?? [], pending: true };
      queryClient.setQueryData<any[]>(["purchase-returns"], (rows) => (rows ?? []).map((r) => r.id === id ? next : r));
      if (next.supplier_id) {
        const delta = refund_total - Number(old?.refund_total ?? 0);
        queryClient.setQueryData<any[]>(["parties","supplier"], (rows) => (rows ?? []).map((p) =>
          p.id === next.supplier_id ? { ...p, balance: Number(p.balance ?? 0) - delta } : p
        ));
      }
    } else if (method === "POST") {
      const purchase = body.purchase_id ? queryClient.getQueryData<any>(["purchase", body.purchase_id]) : null;
      const items = body.items ?? [];
      const refund_total = items.reduce((sum: number, it: any) => {
        const row = purchase?.items?.find((x: any) => x.product_id === it.product_id);
        return sum + Number(row?.unit_cost ?? 0) * Number(it.quantity ?? 0);
      }, 0);
      const rec = { id: tempId, ref_no: `OFFLINE-PRET-${tempId.split("-").pop()}`, purchase_id: body.purchase_id, po_ref: purchase?.ref_no ?? "—", supplier_id: purchase?.supplier_id ?? null, supplier_name: purchase?.supplier_name ?? "—", items, refund_total, reason: body.reason ?? "", user_name: "", created_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["purchase-returns"], (old) => [rec, ...(old ?? [])]);
      queryClient.setQueryData<any>(["purchase", body.purchase_id], (old) => {
        if (!old) return old;
        const returned_items = { ...(old.returned_items ?? {}) };
        for (const it of items) returned_items[it.product_id] = Number(returned_items[it.product_id] ?? 0) + Number(it.quantity ?? 0);
        return { ...old, returned_items };
      });
      queryClient.setQueryData<any[]>(["purchases"], (old) => (old ?? []).map((p) => {
        if (p.id !== body.purchase_id) return p;
        const returned_items = { ...(p.returned_items ?? {}) };
        for (const it of items) returned_items[it.product_id] = Number(returned_items[it.product_id] ?? 0) + Number(it.quantity ?? 0);
        return { ...p, returned_items };
      }));
      queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => {
        const it = items.find((x: any) => x.product_id === p.id);
        return it ? { ...p, quantity: p.quantity - Number(it.quantity || 0) } : p;
      }));
      if (purchase?.supplier_id) {
        queryClient.setQueryData<any[]>(["parties", "supplier"], (old) => (old ?? []).map((p) =>
          p.id === purchase.supplier_id ? { ...p, balance: Number(p.balance ?? 0) - refund_total } : p
        ));
      }
    } else if (method === "DELETE" && id) {
      const row = (queryClient.getQueryData<any[]>(["purchase-returns"]) ?? []).find((r) => r.id === id);
      queryClient.setQueryData<any[]>(["purchase-returns"], (old) => (old ?? []).filter((r) => r.id !== id));
      if (row) {
        queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => {
          const it = (row.items ?? []).find((x: any) => x.product_id === p.id);
          return it ? { ...p, quantity: p.quantity + Number(it.quantity || 0) } : p;
        }));
        const supplierId = row.supplier_id;
        const refund = Number(row.refund_total ?? 0);
        if (supplierId) queryClient.setQueryData<any[]>(["parties", "supplier"], (old) => (old ?? []).map((p) =>
          p.id === supplierId ? { ...p, balance: Number(p.balance ?? 0) + refund } : p
        ));
      }
    }
  } else if (entity === "budget") {
    if (method === "PUT") {
      const old = queryClient.getQueryData<any>(["budget"]) ?? {};
      queryClient.setQueryData(["budget"], { ...old, monthly_amount: Number(body.monthly_amount ?? 0), opening_amount: Number(body.opening_amount ?? 0), pending: true });
    }
  } else if (entity === "sales") {
    if (method === "POST") {
      const products = queryClient.getQueryData<any[]>(["products"]) ?? [];
      const items = (body.items ?? []).map((it: any) => {
        const product = products.find((p: any) => p.id === it.product_id);
        const qty = Number(it.quantity ?? 0);
        const unitPrice = Number(it.unit_price ?? 0);
        const purchasePrice = Number(product?.purchase_price ?? 0);
        return { ...it, name: product?.name ?? "Item", purchase_price: purchasePrice,
          line_total: Math.round(qty * unitPrice * 100) / 100 };
      });
      const subtotal = items.reduce((s: number, it: any) => s + Number(it.line_total ?? 0), 0);
      const discount = Math.max(0, Number(body.discount ?? 0));
      const total = Math.max(0, subtotal - discount);
      const cogs = items.reduce((s: number, it: any) => s + Number(it.quantity ?? 0) * Number(it.purchase_price ?? 0), 0);
      const customer = body.customer_id ? (queryClient.getQueryData<any[]>(["parties", "customer"]) ?? []).find((p: any) => p.id === body.customer_id) : null;
      const rec = { id: tempId, invoice_no: `OFFLINE-INV-${tempId.split("-").pop()}`, items,
        customer_id: body.customer_id ?? null, customer_name: customer?.name ?? "Walk-in",
        subtotal, discount, total, cogs, profit: total - cogs, note: body.note ?? "",
        credit: !!(body.credit && body.customer_id), cashier_name: "", created_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["sales"], (old) => [rec, ...(old ?? [])]);
      queryClient.setQueryData<any>(["sale", tempId], rec);
      queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p: any) => {
        const it = items.find((x: any) => x.product_id === p.id);
        return it ? { ...p, quantity: Number(p.quantity ?? 0) - Number(it.quantity ?? 0) } : p;
      }));
      if (rec.credit && rec.customer_id) {
        queryClient.setQueryData<any[]>(["parties", "customer"], (old) => (old ?? []).map((p: any) =>
          p.id === rec.customer_id ? { ...p, balance: Number(p.balance ?? 0) + total } : p));
      }
    } else if (method === "PUT" && id) {
      const oldSale = (queryClient.getQueryData<any[]>(["sales"]) ?? []).find((x) => x.id === id);
      const products = queryClient.getQueryData<any[]>(["products"]) ?? [];
      if (oldSale) {
        const oldItems = oldSale.items ?? [];
        const newItems = (body.items ?? []).map((it:any) => {
          const p = products.find((x:any) => x.id === it.product_id);
          const qty = Number(it.quantity ?? 0), price = Number(it.unit_price ?? 0);
          return { ...it, name:p?.name ?? "Item", purchase_price:Number(p?.purchase_price ?? 0), line_total:qty*price };
        });
        queryClient.setQueryData<any[]>(["products"], (rows) => (rows ?? []).map((p:any) => {
          const oldQty = oldItems.filter((x:any)=>x.product_id===p.id).reduce((a:number,x:any)=>a+Number(x.quantity||0),0);
          const newQty = newItems.filter((x:any)=>x.product_id===p.id).reduce((a:number,x:any)=>a+Number(x.quantity||0),0);
          const d = oldQty - newQty;
          return d ? {...p, quantity:Number(p.quantity??0)+d} : p;
        }));
        const subtotal = newItems.reduce((a:number,x:any)=>a+Number(x.line_total||0),0);
        const discount = Math.max(0,Number(body.discount??0));
        const total = Math.max(0,subtotal-discount);
        const credit = !!(body.credit && body.customer_id);
        const oldCredit = !!oldSale.credit;
        const oldCustomer = oldSale.customer_id;
        const newCustomer = body.customer_id;
        if (oldCredit && oldCustomer) queryClient.setQueryData<any[]>(["parties","customer"], rows => (rows??[]).map((p:any)=>p.id===oldCustomer?{...p,balance:Number(p.balance??0)-Number(oldSale.total??0)}:p));
        if (credit && newCustomer) queryClient.setQueryData<any[]>(["parties","customer"], rows => (rows??[]).map((p:any)=>p.id===newCustomer?{...p,balance:Number(p.balance??0)+total}:p));
        const updated={...oldSale,...body,items:newItems,subtotal,discount,total,cogs:newItems.reduce((a:number,x:any)=>a+Number(x.quantity||0)*Number(x.purchase_price||0),0),profit:total-newItems.reduce((a:number,x:any)=>a+Number(x.quantity||0)*Number(x.purchase_price||0),0),credit,pending:true};
        queryClient.setQueryData<any[]>(["sales"], rows => (rows??[]).map((x:any)=>x.id===id?updated:x));
        queryClient.setQueryData<any>(["sale",id],updated);
      }
    } else if (method === "DELETE" && id) {
      const sale = (queryClient.getQueryData<any[]>(["sales"]) ?? []).find((s) => s.id === id);
      queryClient.setQueryData<any[]>(["sales"], (old) => (old ?? []).filter((s) => s.id !== id));
      queryClient.removeQueries({ queryKey: ["sale", id] });
      if (sale) {
        queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => {
          const qty=(sale.items??[]).filter((x:any)=>x.product_id===p.id).reduce((a:number,x:any)=>a+Number(x.quantity||0),0);
          return qty ? {...p,quantity:Number(p.quantity??0)+qty}:p;
        }));
        if (sale.credit && sale.customer_id) queryClient.setQueryData<any[]>(["parties","customer"], rows => (rows??[]).map((p:any)=>p.id===sale.customer_id?{...p,balance:Number(p.balance??0)-Number(sale.total??0)}:p));
      }
    }
  } else if (entity === "purchases") {
    if (method === "POST") {
      const supplierId = body.supplier_id ?? null;
      const products = queryClient.getQueryData<any[]>(["products"]) ?? [];
      const items = (body.items ?? []).map((it: any) => {
        const product = products.find((p: any) => p.id === it.product_id);
        const qty = Number(it.quantity ?? 0);
        const unitCost = Number(it.unit_cost ?? 0);
        return { ...it, name: product?.name ?? "Item", line_total: Math.round(qty * unitCost * 100) / 100 };
      });
      const total = items.reduce((s: number, it: any) => s + Number(it.line_total ?? 0), 0);
      const supplier = supplierId ? (queryClient.getQueryData<any[]>(["parties", "supplier"]) ?? []).find((p: any) => p.id === supplierId) : null;
      const rec = { id: tempId, ref_no: `OFFLINE-PO-${tempId.split("-").pop()}`,
        items, supplier_id: supplierId, supplier_name: supplier?.name ?? "—",
        total, note: body.note ?? "", user_name: "", created_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["purchases"], (old) => [rec, ...(old ?? [])]);
      queryClient.setQueryData<any>(["purchase", tempId], rec);
      queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p: any) => {
        const it = items.find((x: any) => x.product_id === p.id);
        return it ? { ...p, quantity: Number(p.quantity ?? 0) + Number(it.quantity ?? 0),
          purchase_price: Number(it.unit_cost ?? p.purchase_price ?? 0), updated_at: now() } : p;
      }));
      if (supplierId) {
        queryClient.setQueryData<any[]>(["parties", "supplier"], (old) => (old ?? []).map((p: any) =>
          p.id === supplierId ? { ...p, balance: Number(p.balance ?? 0) + total } : p));
      }
    } else if (method === "PUT" && id) {
      const oldPurchase = (queryClient.getQueryData<any[]>(["purchases"]) ?? []).find((x)=>x.id===id);
      const products = queryClient.getQueryData<any[]>(["products"]) ?? [];
      if (oldPurchase) {
        const oldItems=oldPurchase.items??[];
        const newItems=(body.items??[]).map((it:any)=>{const p=products.find((x:any)=>x.id===it.product_id); const qty=Number(it.quantity??0),cost=Number(it.unit_cost??0); return {...it,name:p?.name??"Item",line_total:qty*cost};});
        queryClient.setQueryData<any[]>(["products"],rows=>(rows??[]).map((p:any)=>{
          const oldQty=oldItems.filter((x:any)=>x.product_id===p.id).reduce((a:number,x:any)=>a+Number(x.quantity||0),0);
          const newQty=newItems.filter((x:any)=>x.product_id===p.id).reduce((a:number,x:any)=>a+Number(x.quantity||0),0);
          const d=newQty-oldQty; const ni=newItems.find((x:any)=>x.product_id===p.id);
          return d||ni?{...p,quantity:Number(p.quantity??0)+d,purchase_price:ni?Number(ni.unit_cost):p.purchase_price}:p;
        }));
        const total=newItems.reduce((a:number,x:any)=>a+Number(x.line_total||0),0);
        if(oldPurchase.supplier_id) queryClient.setQueryData<any[]>(["parties","supplier"],rows=>(rows??[]).map((p:any)=>p.id===oldPurchase.supplier_id?{...p,balance:Number(p.balance??0)-Number(oldPurchase.total??0)}:p));
        if(body.supplier_id) queryClient.setQueryData<any[]>(["parties","supplier"],rows=>(rows??[]).map((p:any)=>p.id===body.supplier_id?{...p,balance:Number(p.balance??0)+total}:p));
        const updated={...oldPurchase,...body,items:newItems,total,pending:true};
        queryClient.setQueryData<any[]>(["purchases"],rows=>(rows??[]).map((x:any)=>x.id===id?updated:x));
        queryClient.setQueryData<any>(["purchase",id],updated);
      }
    } else if (method === "DELETE" && id) {
      const purchase = (queryClient.getQueryData<any[]>(["purchases"]) ?? []).find((p) => p.id === id);
      queryClient.setQueryData<any[]>(["purchases"], (old) => (old ?? []).filter((p) => p.id !== id));
      queryClient.removeQueries({ queryKey: ["purchase", id] });
      if (purchase) {
        if (purchase.supplier_id) queryClient.setQueryData<any[]>(["parties","supplier"], (old) => (old ?? []).map((p) => p.id === purchase.supplier_id ? { ...p, balance: Number(p.balance ?? 0) - Number(purchase.total ?? 0) } : p));
        queryClient.setQueryData<any[]>(["products"], (old) => (old ?? []).map((p) => {
        const it = (purchase.items ?? []).find((x: any) => x.product_id === p.id);
        return it ? { ...p, quantity: p.quantity - Number(it.quantity || 0) } : p;
        }));
      }
    }
  } else if (entity === "payments") {
    // How a payment shifts a party balance:
    //   pay / receive     -> settles what is owed        => balance decreases
    //   supplier_refund /  -> cash that clears the credit a return created
    //   customer_refund       (balance was negative)     => balance increases
    const balanceEffect = (kind: string, amount: number, adjustment: number) => {
      if (kind === "pay" || kind === "receive") return -(Number(amount || 0) + Number(adjustment || 0));
      if (kind === "supplier_refund" || kind === "customer_refund") return Number(amount || 0);
      return 0;
    };
    const applyBalance = (type: string, partyId: string, delta: number) => {
      if (!delta || !partyId) return;
      queryClient.setQueryData<any[]>(["parties", type], (old) => (old ?? []).map((p) =>
        p.id === partyId ? { ...p, balance: Number(p.balance ?? 0) + delta } : p));
    };
    if (method === "PUT" && id) {
      const existing = (queryClient.getQueryData<any[]>(["payments", "all"]) ?? []).find((p) => p.id === id);
      queryClient.setQueryData<any[]>(["payments", "all"], (old) => (old ?? []).map((p) => p.id === id ? { ...p, ...body, pending: true } : p));
      if (existing) {
        queryClient.setQueryData<any[]>(["payments", existing.party_id], (old) => (old ?? []).map((p) => p.id === id ? { ...p, ...body, pending: true } : p));
        if (body.party_id === existing.party_id) {
          const oldEffect = balanceEffect(existing.kind, existing.amount, existing.adjustment);
          const newEffect = balanceEffect(existing.kind, body.amount, body.adjustment);
          applyBalance(existing.party_type, existing.party_id, newEffect - oldEffect);
        }
      }
    } else if (method === "POST") {
      const type = (body.kind === "pay" || body.kind === "supplier_refund") ? "supplier" : "customer";
      const list = (queryClient.getQueryData<any[]>(["parties", type]) ?? []) as any[];
      const party = list.find((p) => p.id === body.party_id);
      const rec = { id: tempId, party_id: body.party_id, party_name: party?.name ?? "", party_type: type, kind: body.kind, amount: body.amount ?? 0, adjustment: body.adjustment ?? 0, note: body.note ?? "", user_name: "", created_at: now(), pending: true };
      queryClient.setQueryData<any[]>(["payments", "all"], (old) => [rec, ...(old ?? [])]);
      queryClient.setQueryData<any[]>(["payments", body.party_id], (old) => [rec, ...(old ?? [])]);
      applyBalance(type, body.party_id, balanceEffect(body.kind, body.amount, body.adjustment));
    } else if (method === "DELETE" && id) {
      const list = (queryClient.getQueryData<any[]>(["payments", "all"]) ?? []) as any[];
      const pay = list.find((p) => p.id === id);
      queryClient.setQueryData<any[]>(["payments", "all"], (old) => (old ?? []).filter((p) => p.id !== id));
      if (pay) {
        queryClient.setQueryData<any[]>(["payments", pay.party_id], (old) => (old ?? []).filter((p) => p.id !== id));
        // Removing a payment reverses its balance effect.
        applyBalance(pay.party_type, pay.party_id, -balanceEffect(pay.kind, pay.amount, pay.adjustment));
      }
    }
  } else if (entity === "users") {
    if (method === "POST") {
      const rec = {
        id: tempId, email: String(body.email ?? "").toLowerCase(), name: body.name ?? "",
        role: body.role ?? "cashier", disabled: false, pending: true, created_at: now()
      };
      queryClient.setQueryData<any[]>(["users"], (old) => [rec, ...(old ?? [])]);
    } else if (method === "PUT" && id) {
      queryClient.setQueryData<any[]>(["users"], (old) => (old ?? []).map((u) => u.id === id ? { ...u, ...body, pending: true } : u));
    } else if (method === "DELETE" && id) {
      queryClient.setQueryData<any[]>(["users"], (old) => (old ?? []).filter((u) => u.id !== id));
    }
  } else if (entity === "settings") {
    if (method === "PUT") {
      const old = queryClient.getQueryData<any>(["settings"]) ?? {};
      queryClient.setQueryData(["settings"], { ...old, ...body, pending: true });
    }
  }
}

async function persistLiveCache() {
  try {
    const { dehydrate } = await import("@tanstack/react-query");
    const dumped = dehydrate(queryClient, { shouldDehydrateQuery: (q) => q.state.status === "success" });
    await storage.setItem("ssm.qcache.v1", dumped as any);
  } catch {
    // Cache persistence is best-effort and must never block a write.
  }
}

async function queueWrite(method: string, path: string, body: any): Promise<any> {
  const seq = await nextSeq();
  const tempId = `local-${entityOf(path)}-${seq}`;
  applyOptimistic(method, path, body, tempId);
  invalidateDerivedReports();
  const queue = await getWriteQueue();
  const targetId = idFromPath(path);
  if (method !== "POST" && targetId?.startsWith("local-")) {
    const postIndex = queue.findIndex((op) => op.method === "POST" && op.path === path.split("/").slice(0, 2).join("/") && op.id === targetId);
    if (postIndex >= 0) {
      if (method === "PUT") {
        queue[postIndex] = { ...queue[postIndex], body: { ...(queue[postIndex].body ?? {}), ...(body ?? {}) } };
      } else if (method === "DELETE") {
        queue.splice(postIndex, 1);
      }
      await setWriteQueue(queue);
      await persistLiveCache();
      return { id: targetId, ...(body ?? {}), pending: true };
    }
  }
  queue.push({ id: tempId, method, path, body });
  await setWriteQueue(queue);
  await persistLiveCache();
  return { id: tempId, ...(body ?? {}), pending: true };
}

// Replay queued writes when back online. Returns how many synced / were dropped.
export async function flushWriteQueue(idMap: Record<string, string> = {}): Promise<{ synced: number; dropped: number }> {
  const state = await NetInfo.fetch();
  if (!(state.isConnected && state.isInternetReachable !== false)) return { synced: 0, dropped: 0 };
  let queue = await getWriteQueue();
  if (!queue.length) return { synced: 0, dropped: 0 };
  let synced = 0;
  let dropped = 0;
  let i = 0;
  for (; i < queue.length; i++) {
    const op = queue[i];
    // Skip edits/deletes that target a record still only living locally.
    const targetId = idFromPath(op.path);
    if (op.method !== "POST" && targetId && targetId.startsWith("local-")) {
      dropped++;
      continue;
    }
    try {
      const resolveRefs = (value: any): any => {
        if (typeof value === "string") return idMap[value] ?? value;
        if (Array.isArray(value)) return value.map(resolveRefs);
        if (value && typeof value === "object") {
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v)]));
        }
        return value;
      };
      const resolvedPath = resolveRefs(op.path);
      const resolvedBody = resolveRefs(op.body);
      const result = await rawRequest<any>(resolvedPath, { method: op.method, body: resolvedBody });
      // Keep a local->server ID map for every generic POST. This is important
      // when an offline record is created and then edited/deleted before sync.
      if (op.method === "POST" && op.id?.startsWith("local-") && result?.id) {
        idMap[op.id] = result.id;
      }
      synced++;
    } catch (e) {
      // Never silently delete a queued business transaction. Validation,
      // authorization, duplicate, and server errors remain queued so the user
      // can retry after the underlying problem is fixed.
      await setWriteQueue(queue.slice(i));
      if (synced || dropped) await queryClient.invalidateQueries();
      return { synced, dropped };
    }
  }
  await setWriteQueue([]);
  await queryClient.invalidateQueries();
  return { synced, dropped };
}

// A fetch that never queues (used for reads, auth, and queue replay).
export async function rawRequest<T = any>(
  path: string,
  options: { method?: string; body?: any } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${base()}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function apiRequest<T = any>(
  path: string,
  options: { method?: string; body?: any } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const mode = await getConnectionMode();

  // Manual Offline mode: never touch the server. Writes are queued locally;
  // reads are served from the React Query cache populated by local persistence.
  if (mode === "offline") {
    if (method !== "GET" && isQueueable(path)) {
      return (await queueWrite(method, path, options.body)) as T;
    }
    if (method === "GET") {
      const local = localCacheForPath(path);
      if (local !== undefined) return local as T;
      throw new Error("Offline mode: this data is not available locally yet.");
    }
  }

  try {
    return await rawRequest<T>(path, options);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (method !== "GET" && isQueueable(path)) {
      return (await queueWrite(method, path, options.body)) as T;
    }
    throw e;
  }
}

function localCacheForPath(path: string): any {
  if (path === "/products") return queryClient.getQueryData(["products"]);
  if (path.startsWith("/parties")) {
    const type = new URLSearchParams(path.split("?")[1] ?? "").get("type");
    return queryClient.getQueryData(["parties", type ?? "all"]);
  }
  if (path === "/sales") return queryClient.getQueryData(["sales"]);
  if (path === "/purchases") return queryClient.getQueryData(["purchases"]);
  if (path === "/returns") return queryClient.getQueryData(["returns"]);
  if (path === "/purchase-returns") return queryClient.getQueryData(["purchase-returns"]);
  if (path === "/expenses") return queryClient.getQueryData(["expenses", "all"]);
  if (path.startsWith("/payments")) return queryClient.getQueryData(["payments", "all"]);
  if (path === "/budget") return queryClient.getQueryData(["budget"]);
  if (path === "/users") return queryClient.getQueryData(["users"]);
  if (path === "/settings") return queryClient.getQueryData(["settings"]);
  if (path.startsWith("/sales/")) return queryClient.getQueryData(["sale", path.split("/")[2]]);
  if (path.startsWith("/purchases/")) return queryClient.getQueryData(["purchase", path.split("/")[2]]);
  if (path.startsWith("/expenses")) {
    const bucket = new URLSearchParams(path.split("?")[1] ?? "").get("bucket");
    return queryClient.getQueryData(["expenses", bucket ?? "all"]);
  }
  if (path.startsWith("/payments/")) return queryClient.getQueryData(["payments", path.split("/")[2]]);
  if (path.startsWith("/reports/summary")) return queryClient.getQueryData(["report", new URLSearchParams(path.split("?")[1] ?? "").get("range") ?? "month"]);
  if (path.startsWith("/reports/customers")) return queryClient.getQueryData(["customers", new URLSearchParams(path.split("?")[1] ?? "").get("range") ?? "month"]);
  if (path.startsWith("/reports/day-close")) return queryClient.getQueryData(["day-close", new URLSearchParams(path.split("?")[1] ?? "").get("range") ?? "today"]);
  return undefined;
}

export async function loginRequest(email: string, password: string) {
  const body = new URLSearchParams({ username: email, password });
  const res = await fetch(`${base()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  return (await res.json()) as {
    access_token: string;
    token_type: string;
    user: AppUser;
  };
}

// ---------------------------------------------------------------------------
// Auth self-service + store settings
// ---------------------------------------------------------------------------
export function signupRequest(email: string, name: string, password: string) {
  return rawRequest("/auth/signup", { method: "POST", body: { email, name, password } });
}
export function forgotPasswordRequest(email: string) {
  return rawRequest("/auth/forgot-password", { method: "POST", body: { email } });
}
export function resetPasswordRequest(email: string, code: string, new_password: string) {
  return rawRequest("/auth/reset-password", { method: "POST", body: { email, code, new_password } });
}

export type StoreSettings = { store_name: string; has_logo: boolean; logo_version: number; pending_logo_uri?: string | null };

export function getSettings() {
  return apiRequest<StoreSettings>("/settings");
}
export function updateSettingsRequest(store_name: string) {
  return apiRequest<StoreSettings>("/settings", { method: "PUT", body: { store_name } });
}
export function logoUrl(version: number): string {
  return `${base()}/settings/logo?v=${version}`;
}
const PENDING_LOGO_KEY = "ssm.pending-logo.v1";

export async function uploadLogo(uri: string, name: string, type: string) {
  const queueLocal = async () => {
    await storage.setItem(PENDING_LOGO_KEY, { uri, name, type } as any);
    const old = queryClient.getQueryData<StoreSettings>(["settings"]) ?? { store_name: "Surgical Store", has_logo: false, logo_version: 0 };
    queryClient.setQueryData(["settings"], { ...old, has_logo: true, logo_version: Date.now(), pending_logo_uri: uri, pending: true });
    await persistLiveCache();
    return { ok: true, logo_version: Date.now(), queued: true };
  };

  const mode = await getConnectionMode();
  const state = await NetInfo.fetch();
  const reachable = !!(state.isConnected && state.isInternetReachable !== false);
  if (mode === "offline" || !reachable) return queueLocal();

  try {
    const result = await uploadLogoOnline(uri, name, type);
    const old = queryClient.getQueryData<StoreSettings>(["settings"]) ?? { store_name: "Surgical Store", has_logo: false, logo_version: 0 };
    queryClient.setQueryData(["settings"], { ...old, has_logo: true, logo_version: result.logo_version, pending_logo_uri: uri });
    await storage.removeItem(PENDING_LOGO_KEY);
    await persistLiveCache();
    return result;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return queueLocal();
  }
}

export async function flushOfflineLogo() {
  const pending = await storage.getItem<{ uri: string; name: string; type: string } | null>(PENDING_LOGO_KEY, null);
  if (!pending) return false;
  try {
    await uploadLogoOnline(pending.uri, pending.name, pending.type);
    await storage.removeItem(PENDING_LOGO_KEY);
    queryClient.setQueryData<StoreSettings>(["settings"], (old) => old ? { ...old, pending_logo_uri: null, has_logo: true } : old);
    await queryClient.invalidateQueries({ queryKey: ["settings"] });
    return true;
  } catch {
    return false;
  }
}

async function uploadLogoOnline(uri: string, name: string, type: string) {
  const form = new FormData();
  if (Platform.OS === "web") {
    const blob = await (await fetch(uri)).blob();
    form.append("file", blob, name);
  } else {
    form.append("file", { uri, name, type } as any);
  }
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${base()}/settings/logo`, { method: "POST", headers, body: form as any });
  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  return (await res.json()) as { ok: boolean; logo_version: number };
}

export type Role = "admin" | "partner" | "cashier";

export type AppUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  pending?: boolean;
  created_at?: string;
};
