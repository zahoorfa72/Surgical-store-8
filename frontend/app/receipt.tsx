import { useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useSale } from "@/src/data";
import { Sale } from "@/src/models";
import { canManageStore, useAuth } from "@/src/auth";
import { Loader, ScreenHeader, formatDateTime, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const STORE_NAME = "Surgical Store";

function receiptHtml(sale: Sale): string {
  const rows = sale.items
    .map(
      (i) => `<tr>
        <td>${i.name}</td>
        <td style="text-align:center">${i.quantity}</td>
        <td style="text-align:right">Rs ${i.unit_price.toLocaleString()}</td>
        <td style="text-align:right">Rs ${i.line_total.toLocaleString()}</td>
      </tr>`
    )
    .join("");
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { font-family: -apple-system, Roboto, Helvetica, sans-serif; color: #0F172A; }
    body { padding: 24px; }
    h1 { font-size: 22px; margin: 0; color: #0F766E; text-align:center; }
    .muted { color: #64748B; font-size: 12px; text-align:center; }
    .meta { margin: 16px 0; font-size: 13px; }
    .meta div { margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th { text-align: left; border-bottom: 2px solid #0F766E; padding: 6px 4px; font-size: 12px; }
    td { padding: 6px 4px; border-bottom: 1px solid #E2E8F0; }
    .totals { margin-top: 16px; font-size: 14px; }
    .totals div { display:flex; justify-content: space-between; padding: 3px 0; }
    .grand { font-weight: 800; font-size: 18px; border-top: 2px solid #0F766E; padding-top: 8px; margin-top: 6px; }
    .thanks { text-align:center; margin-top: 24px; font-size: 12px; color:#64748B; }
  </style></head><body>
    <h1>${STORE_NAME}</h1>
    <div class="muted">Sales Receipt</div>
    <div class="meta">
      <div><b>Invoice:</b> ${sale.invoice_no}</div>
      <div><b>Date:</b> ${new Date(sale.created_at).toLocaleString()}</div>
      <div><b>Customer:</b> ${sale.customer_name}</div>
      <div><b>Served by:</b> ${sale.cashier_name}</div>
    </div>
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><span>Rs ${sale.subtotal.toLocaleString()}</span></div>
      <div><span>Discount</span><span>- Rs ${sale.discount.toLocaleString()}</span></div>
      <div class="grand"><span>Total</span><span>Rs ${sale.total.toLocaleString()}</span></div>
    </div>
    <div class="thanks">Thank you for your purchase!</div>
  </body></html>`;
}

export default function Receipt() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: sale, isLoading } = useSale(id ?? "");
  const { user } = useAuth();
  const staff = canManageStore(user?.role);
  const [busy, setBusy] = useState(false);

  const print = async () => {
    if (!sale) return;
    setBusy(true);
    try {
      await Print.printAsync({ html: receiptHtml(sale) });
    } catch (e: any) {
      toast("Printing not available on this device", "error");
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!sale) return;
    setBusy(true);
    try {
      const { uri } = await Print.printToFileAsync({ html: receiptHtml(sale) });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
      else toast("Sharing not available", "error");
    } catch (e: any) {
      toast("Could not create PDF", "error");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !sale) return <Loader />;

  const returnedMap: Record<string, number> = (sale as any).returned_items ?? {};
  const returnedTotal: number = (sale as any).returned_total ?? 0;

  return (
    <View style={styles.root}>
      <ScreenHeader title={sale.invoice_no} subtitle="Sale receipt" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 120, gap: 12 }}>
        <View style={styles.paper}>
          <Text style={styles.storeName}>{STORE_NAME}</Text>
          <Text style={styles.receiptLabel}>Sales Receipt</Text>

          <View style={styles.metaBox}>
            <Meta label="Invoice" value={sale.invoice_no} />
            <Meta label="Date" value={formatDateTime(sale.created_at)} />
            <Meta label="Customer" value={sale.customer_name} />
            <Meta label="Served by" value={sale.cashier_name} />
          </View>

          <View style={styles.tableHead}>
            <Text style={[styles.th, { flex: 2 }]}>Item</Text>
            <Text style={[styles.th, styles.center]}>Qty</Text>
            <Text style={[styles.th, styles.right]}>Price</Text>
            <Text style={[styles.th, styles.right]}>Total</Text>
          </View>
          {sale.items.map((i, idx) => {
            const ret = returnedMap[i.product_id] ?? 0;
            return (
              <View key={idx} style={styles.itemRow}>
                <View style={{ flex: 2 }}>
                  <Text style={styles.td}>{i.name}</Text>
                  {ret > 0 && <Text style={styles.returnedTag}>{ret} returned</Text>}
                </View>
                <Text style={[styles.td, styles.center]}>{i.quantity}</Text>
                <Text style={[styles.td, styles.right]}>{money(i.unit_price)}</Text>
                <Text style={[styles.td, styles.right]}>{money(i.line_total)}</Text>
              </View>
            );
          })}

          <View style={styles.totalsBox}>
            <TotalRow label="Subtotal" value={money(sale.subtotal)} />
            <TotalRow label="Discount" value={"- " + money(sale.discount)} />
            <View style={styles.grandRow}>
              <Text style={styles.grandLabel}>Total</Text>
              <Text style={styles.grandValue}>{money(sale.total)}</Text>
            </View>
            {returnedTotal > 0 && (
              <View style={styles.totalRow}>
                <Text style={[styles.totalLabel, { color: colors.error }]}>Returned / refunded</Text>
                <Text style={[styles.totalValue, { color: colors.error }]}>- {money(returnedTotal)}</Text>
              </View>
            )}
          </View>
          <Text style={styles.thanks}>Thank you for your purchase!</Text>
        </View>

        {staff && (
          <Pressable testID="return-items-button" style={styles.returnBtn} onPress={() => router.push(`/return-form?sale_id=${sale.id}`)}>
            <MaterialDesignIcons name="cash-refund" size={20} color={colors.error} />
            <Text style={styles.returnBtnText}>Return items from this sale</Text>
          </Pressable>
        )}
      </ScrollView>

      <View style={[styles.actions, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable testID="share-receipt-button" disabled={busy} style={styles.shareBtn} onPress={share}>
          <MaterialDesignIcons name="share-variant" size={20} color={colors.brandPrimary} />
          <Text style={styles.shareText}>Share PDF</Text>
        </Pressable>
        <Pressable testID="print-receipt-button" disabled={busy} style={[styles.printBtn, busy && { opacity: 0.6 }]} onPress={print}>
          <MaterialDesignIcons name="printer" size={20} color={colors.onBrandPrimary} />
          <Text style={styles.printText}>{busy ? "Please wait…" : "Print / Reprint"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}
function TotalRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.totalRow}>
      <Text style={styles.totalLabel}>{label}</Text>
      <Text style={styles.totalValue}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surfaceSecondary },
  paper: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 20 },
  storeName: { fontSize: 22, fontWeight: "800", color: colors.brandPrimary, textAlign: "center" },
  receiptLabel: { fontSize: 12, color: colors.muted, textAlign: "center", marginTop: 2, marginBottom: 12 },
  metaBox: { gap: 4, marginBottom: 12 },
  metaRow: { flexDirection: "row", justifyContent: "space-between" },
  metaLabel: { fontSize: 13, color: colors.muted },
  metaValue: { fontSize: 13, color: colors.onSurface, fontWeight: "600", flexShrink: 1, textAlign: "right", marginLeft: 8 },
  tableHead: { flexDirection: "row", borderBottomWidth: 2, borderBottomColor: colors.brandPrimary, paddingBottom: 6 },
  th: { flex: 1, fontSize: 12, fontWeight: "700", color: colors.onSurfaceSecondary },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
  itemRow: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.divider },
  td: { flex: 1, fontSize: 13, color: colors.onSurface },
  returnedTag: { fontSize: 11, color: colors.error, fontWeight: "700", marginTop: 2 },
  totalsBox: { marginTop: 14, gap: 4 },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { fontSize: 14, color: colors.onSurfaceSecondary },
  totalValue: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 2,
    borderTopColor: colors.brandPrimary,
    paddingTop: 8,
    marginTop: 4,
  },
  grandLabel: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  grandValue: { fontSize: 18, fontWeight: "800", color: colors.brandPrimary },
  thanks: { textAlign: "center", marginTop: 20, fontSize: 12, color: colors.muted },
  returnBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.error + "12",
    borderRadius: 14,
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.error + "40",
  },
  returnBtnText: { color: colors.error, fontSize: 15, fontWeight: "700" },
  actions: {
    flexDirection: "row",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
  },
  shareBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandTertiary,
    borderRadius: 14,
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  shareText: { color: colors.brandPrimary, fontSize: 15, fontWeight: "700" },
  printBtn: {
    flex: 1.4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    minHeight: 52,
  },
  printText: { color: colors.onBrandPrimary, fontSize: 15, fontWeight: "800" },
}));
