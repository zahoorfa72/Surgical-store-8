import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiRequest } from "@/src/api";
import { useParties, usePayments, usePurchases, usePurchaseReturns, useCustomerBalanceTransfers, useSales, useReturns, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { CustomerBalanceTransfer, Party, Payment } from "@/src/models";
import { ChipRow, ConfirmModal, EmptyState, Loader, ScreenHeader, formatDate, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { getHiddenSupplierIds, useFakeFinanceDisplay, fakePurchaseNetTotal, fakePaymentAmount, fakeDisplayAmount } from "@/src/utils/finance-display";
import { addAppNotification } from "@/src/notification-center";

function sanitizeNonNegativeAmount(value: string): string {
  const cleaned = String(value ?? "").replace(/[^0-9.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot < 0) return cleaned;
  return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "").slice(0, 2);
}

type BillOption = { id: string; ref: string; due: number; kind: "sale" | "purchase" };

const TABS = [
  { key: "supplier", label: "Suppliers" },
  { key: "customer", label: "Customers" },
] as const;

export default function Payments() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<string>("supplier");
  const isSupplier = tab === "supplier";
  const { data: parties, isLoading } = useParties(isSupplier ? "supplier" : "customer");
  const { data: payments } = usePayments();
  const { data: customerBalanceTransfers } = useCustomerBalanceTransfers();
  const { data: purchases } = usePurchases();
  const { data: purchaseReturns } = usePurchaseReturns();
  const { data: sales } = useSales();
  const { data: salesReturns } = useReturns();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const fakeFinanceDisplay = useFakeFinanceDisplay();

  // Refund total per purchase so the payable ledger shows the net amount owed
  // to a supplier after any goods were returned (offline + online).
  const safeParties = Array.isArray(parties) ? parties.filter(Boolean) : [];
  const safePayments = Array.isArray(payments) ? payments.filter(Boolean) : [];
  const safePurchases = Array.isArray(purchases) ? purchases.filter(Boolean) : [];
  const safePurchaseReturns = Array.isArray(purchaseReturns) ? purchaseReturns.filter(Boolean) : [];
  const safeSales = Array.isArray(sales) ? sales.filter(Boolean) : [];
  const safeSalesReturns = Array.isArray(salesReturns) ? salesReturns.filter(Boolean) : [];
  const safeBalanceTransfers = Array.isArray(customerBalanceTransfers)
    ? customerBalanceTransfers.filter(Boolean)
    : [];

  const refundByPurchase = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of safePurchaseReturns as any[]) {
      if (!r.purchase_id) continue;
      m[r.purchase_id] = (m[r.purchase_id] ?? 0) + Number(r.refund_total ?? 0);
    }
    return m;
  }, [safePurchaseReturns]);

  const [active, setActive] = useState<Party | null>(null);
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; party_name: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [selectedBill, setSelectedBill] = useState<BillOption | null>(null);
  const [adjustment, setAdjustment] = useState("");
  const [note, setNote] = useState("");
  const [entryKind, setEntryKind] = useState<"pay" | "receive" | "supplier_refund" | "customer_refund">("pay");
  const [busy, setBusy] = useState(false);
  const [receiptPhoto, setReceiptPhoto] = useState<string | null>(null);
  const [receiptPhotos, setReceiptPhotos] = useState<Record<string, string>>({});
  const [hiddenSupplierIds, setHiddenSupplierIds] = useState<string[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferFromId, setTransferFromId] = useState("");
  const [transferToId, setTransferToId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferPicker, setTransferPicker] = useState<"from" | "to" | null>(null);
  const [transferSearch, setTransferSearch] = useState("");
  useEffect(() => { void getHiddenSupplierIds().then(setHiddenSupplierIds).catch(() => setHiddenSupplierIds([])); }, []);
  useEffect(() => {
    void (async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        const ks = keys.filter((k) => k.startsWith("ssm.paymentReceipt."));
        if (!ks.length) return;
        const pairs = await AsyncStorage.multiGet(ks);
        const map: Record<string, string> = {};
        for (const [k, v] of pairs) if (v) map[k.replace("ssm.paymentReceipt.", "")] = v;
        setReceiptPhotos(map);
      } catch {
        setReceiptPhotos({});
      }
    })();
  }, [safePayments.length]);
  const pickReceiptPhoto = async () => { const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.55, base64: true, exif: false }); if (result.canceled) return; const asset = result.assets[0]; if (!asset?.base64) { toast("Could not read the receipt photo", "error"); return; } if (asset.base64.length > 4_000_000) { toast("Photo is too large. Please choose a smaller receipt photo.", "error"); return; } setReceiptPhoto("data:image/jpeg;base64," + asset.base64); };
  const removeReceiptPhoto = () => setReceiptPhoto(null);

  const visibleParties = useMemo(() => isSupplier ? safeParties.filter((p) => !hiddenSupplierIds.includes(p.id)) : safeParties, [parties, isSupplier, hiddenSupplierIds]);
  const visiblePartyIds = useMemo(() => new Set(visibleParties.map((p) => p.id)), [visibleParties]);
  const fakeSupplierBalanceById = useMemo(() => {
    const result: Record<string, number> = {};
    if (!fakeFinanceDisplay || !isSupplier) return result;

    for (const party of visibleParties) {
      const purchaseTotal = safePurchases
        .filter((p) => p.supplier_id === party.id)
        .reduce((sum, p) => sum + fakePurchaseNetTotal(
          Array.isArray(p.items) ? p.items : [],
          {},
          String(p.id),
          refundByPurchase[p.id] ?? 0,
        ), 0);

      const cashAndRefunds = safePayments
        .filter((p) => p.party_id === party.id && (p.kind === "pay" || p.kind === "supplier_refund"))
        .reduce((sum, p) => sum + fakePaymentAmount(p.amount, String(p.id)), 0);

      const adjustments = safePayments
        .filter((p) => p.party_id === party.id && Number(p.adjustment ?? 0) !== 0)
        .reduce((sum, p) => sum + fakeDisplayAmount(p.adjustment), 0);

      result[party.id] = Math.max(0, purchaseTotal - cashAndRefunds - adjustments);
    }
    return result;
  }, [fakeFinanceDisplay, isSupplier, visibleParties, purchases, payments, refundByPurchase]);

  const balanceForParty = (p: Party) => {
    const balance = Number(p.balance ?? 0);
    if (!fakeFinanceDisplay) return balance;
    if (isSupplier) return fakeSupplierBalanceById[p.id] ?? 0;
    // Keep customer receivables AND customer credit signed while masking display values.
    // Previously the form prefilled a masked amount but the screen showed the real balance,
    // causing the entered receipt to be converted back to a different real amount.
    return Math.round(balance * 0.825 * 100) / 100;
  };

  const totalOutstanding = useMemo(
    () => visibleParties.reduce((s, p) => s + Math.max(0, balanceForParty(p)), 0),
    [visibleParties, fakeFinanceDisplay, isSupplier, fakeSupplierBalanceById],
  );
  const totalCustomerCredit = useMemo(
    () => !isSupplier
      ? visibleParties.reduce((sum, p) => sum + Math.max(0, -balanceForParty(p)), 0)
      : 0,
    [visibleParties, isSupplier],
  );

  const openFor = (p: Party) => {
    setActive(p);
    const displayedBalance = balanceForParty(p);
    setAmount(displayedBalance > 0 ? String(Math.abs(displayedBalance)) : "");
    setSelectedBill(null);
    setAdjustment("");
    setNote("");
    setReceiptPhoto(receiptPhotos[p.id] ?? null);
    setEntryKind(isSupplier ? "pay" : "receive");
  };

  const record = async () => {
    if (!active && !editingPayment) return;
    // Cash is always non-negative. Signed corrections belong only in the
    // separate admin-only bill-adjustment field.
    const enteredAmount = Math.abs(Number.parseFloat(amount) || 0);
    const enteredAdjustment = Number.parseFloat(adjustment) || 0;
    const amt = fakeFinanceDisplay ? enteredAmount / 0.825 : enteredAmount;
    const adj = fakeFinanceDisplay ? enteredAdjustment / 0.825 : enteredAdjustment;
    if (amt < 0) {
      toast("Cash amount cannot be negative", "error");
      return;
    }
    if (adj !== 0 && !admin) {
      toast("Only an admin can make bill adjustments", "error");
      return;
    }
    if (adj < 0 && (entryKind === "customer_refund" || entryKind === "supplier_refund")) {
      toast("Use Receive Customer or Pay Supplier for a negative bill adjustment", "error");
      return;
    }
    if (amt <= 0 && adj === 0) {
      toast("Enter an amount or a non-cash adjustment", "error");
      return;
    }
    setBusy(true);
    try {
      let saved: Payment;
      if (editingPayment) {
        saved = await apiRequest<Payment>(`/payments/${editingPayment.id}`, { method: "PUT", body: {
          party_id: editingPayment.party_id, kind: editingPayment.kind, amount: amt, adjustment: adj, note: note.trim(),
          sale_id: editingPayment.sale_id ?? null, purchase_id: editingPayment.purchase_id ?? null,
        }});
      } else {
        saved = await apiRequest<Payment>("/payments", { method: "POST", body: {
          party_id: active!.id, kind: entryKind, amount: amt, adjustment: adj, note: note.trim(),
          sale_id: selectedBill?.kind === "sale" ? selectedBill.id : null,
          purchase_id: selectedBill?.kind === "purchase" ? selectedBill.id : null,
        }});
      }
      if (saved?.id) {
        if (receiptPhoto) { await AsyncStorage.setItem(`ssm.paymentReceipt.${saved.id}`, receiptPhoto); setReceiptPhotos((prev) => ({ ...prev, [saved.id]: receiptPhoto })); }
        else { await AsyncStorage.removeItem(`ssm.paymentReceipt.${saved.id}`); setReceiptPhotos((prev) => { const next = { ...prev }; delete next[saved.id]; return next; }); }
      }
      await queryClient.invalidateQueries({ queryKey: qk.parties(isSupplier ? "supplier" : "customer") });
      await queryClient.invalidateQueries({ queryKey: qk.payments() });
      if (!editingPayment) void addAppNotification(isSupplier ? "Supplier payment made" : "Customer payment received", `${active!.name}: ${money(amt)}${note.trim() ? " · " + note.trim() : ""}`, "payment");
      else void addAppNotification("Payment entry updated", `${active?.name ?? "Party"}: ${money(amt)}`, "payment-updated");
      toast(editingPayment ? "Entry updated" : (isSupplier ? "Payment recorded" : "Receipt recorded"), "success");
      setActive(null); setEditingPayment(null); setSelectedBill(null);
    } catch (e: any) {
      toast(e?.message || "Could not record", "error");
    } finally {
      setBusy(false);
    }
  };

  const openCustomerBalanceTransfer = () => {
    if (fakeFinanceDisplay) {
      toast("Turn off demo finance display before transferring real customer balances", "error");
      return;
    }
    if (safeParties.length < 2) {
      toast("Add at least two customers before transferring a balance", "error");
      return;
    }
    const sources = safeParties
      .filter((party) => Math.abs(Number(party.balance ?? 0)) >= 0.01)
      .sort((a, b) => Math.abs(Number(b.balance ?? 0)) - Math.abs(Number(a.balance ?? 0)));
    const source = sources[0];
    const destination = safeParties.find((party) => party.id !== source?.id);
    if (!source || !destination) {
      toast("No customer has a transferable remaining balance", "info");
      return;
    }
    setTransferFromId(source.id);
    setTransferToId(destination.id);
    setTransferAmount(String(Math.abs(Number(source.balance ?? 0))));
    setTransferNote("");
    setTransferPicker(null);
    setTransferSearch("");
    setTransferOpen(true);
  };

  const selectedTransferFrom = safeParties.find((party) => party.id === transferFromId);
  const selectedTransferTo = safeParties.find((party) => party.id === transferToId);
  const transferAvailable = Math.abs(Number(selectedTransferFrom?.balance ?? 0));
  const transferValue = Math.abs(Number.parseFloat(transferAmount) || 0);
  const transferSignedValue = Number(selectedTransferFrom?.balance ?? 0) < 0 ? -transferValue : transferValue;

  const recordCustomerBalanceTransfer = async () => {
    if (fakeFinanceDisplay) {
      toast("Turn off demo finance display before transferring real customer balances", "error");
      return;
    }
    if (!selectedTransferFrom || !selectedTransferTo || selectedTransferFrom.id === selectedTransferTo.id) {
      toast("Choose two different customers", "error");
      return;
    }
    if (!Number.isFinite(transferValue) || transferValue <= 0) {
      toast("Enter a transfer amount greater than zero", "error");
      return;
    }
    if (transferValue > transferAvailable + 0.004) {
      toast("Transfer amount cannot exceed the source customer's remaining balance or credit", "error");
      return;
    }
    setTransferBusy(true);
    try {
      const saved = await apiRequest<CustomerBalanceTransfer>("/customer-balance-transfers", {
        method: "POST",
        body: {
          from_party_id: selectedTransferFrom.id,
          to_party_id: selectedTransferTo.id,
          amount: transferValue,
          note: transferNote.trim(),
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.parties("customer") }),
        queryClient.invalidateQueries({ queryKey: qk.parties() }),
        queryClient.invalidateQueries({ queryKey: qk.customerBalanceTransfers }),
      ]);
      void addAppNotification(
        "Customer balance transferred",
        `${selectedTransferFrom.name} → ${selectedTransferTo.name}: ${money(saved.amount)}`,
        "customer-balance-transfer",
      );
      toast("Customer balance transferred and recorded in history", "success");
      setTransferOpen(false);
      setTransferPicker(null);
    } catch (e: any) {
      toast(e?.message || "Could not transfer customer balance", "error");
    } finally {
      setTransferBusy(false);
    }
  };

  const recentPayments = safePayments.filter((p) => visiblePartyIds.has(p.party_id) && (
    isSupplier
      ? p.kind === "pay" || p.kind === "supplier_refund"
      : p.kind === "receive" || p.kind === "customer_refund"
  ));
  // Group each party's payment history so every supplier/customer is shown
  // separately, and refunds are clearly labelled.
  const paymentsByParty = (() => {
    const groups: Record<string, { name: string; rows: Payment[] }> = {};
    for (const p of recentPayments) {
      const key = p.party_id || p.party_name || "—";
      (groups[key] ||= { name: p.party_name || "—", rows: [] }).rows.push(p);
    }
    return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
  })();
  const isRefundKind = (k: string) => k === "supplier_refund" || k === "customer_refund";
  // Supplier purchases are payable ledger entries. They create the supplier
  // balance when purchased; only a recorded Pay entry settles/cuts cash.
  const supplierPurchases = safePurchases
    .filter((p) => isSupplier && p.supplier_id && visiblePartyIds.has(p.supplier_id))
    .slice(0, 12);

  const refundBySale = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const row of safeSalesReturns) {
      if (!row.sale_id) continue;
      totals[row.sale_id] = (totals[row.sale_id] ?? 0) + Number(row.refund_total ?? 0);
    }
    return totals;
  }, [safeSalesReturns]);

  const billOptions = useMemo<BillOption[]>(() => {
    if (!active || editingPayment || fakeFinanceDisplay) return [];
    if (isSupplier) {
      return safePurchases
        .filter((purchase) => purchase.supplier_id === active.id)
        .map((purchase) => {
          const paid = safePayments
            .filter((payment) => payment.purchase_id === purchase.id && payment.kind === "pay")
            .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
          const due = Math.max(0, Number(purchase.total ?? 0) - Number(refundByPurchase[purchase.id] ?? 0) - paid);
          return { id: purchase.id, ref: purchase.ref_no, due, kind: "purchase" as const };
        })
        .filter((bill) => bill.due > 0.004)
        .sort((a, b) => a.ref.localeCompare(b.ref));
    }
    return safeSales
      .filter((sale) => sale.customer_id === active.id && !!sale.credit)
      .map((sale) => {
        const paid = safePayments
          .filter((payment) => payment.sale_id === sale.id && payment.kind === "receive")
          .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0);
        const due = Math.max(0, Number(sale.amount_due ?? sale.total ?? 0) - Number(refundBySale[sale.id] ?? 0) - paid);
        return { id: sale.id, ref: sale.invoice_no, due, kind: "sale" as const };
      })
      .filter((bill) => bill.due > 0.004)
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }, [active, editingPayment, isSupplier, fakeFinanceDisplay, safePurchases, safeSales, safePayments, refundByPurchase, refundBySale]);

  const confirmDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    try {
      await apiRequest(`/payments/${id}`, { method: "DELETE" });
      await AsyncStorage.removeItem(`ssm.paymentReceipt.${id}`);
      setReceiptPhotos((prev) => { const next = { ...prev }; delete next[id]; return next; });
      await queryClient.invalidateQueries({ queryKey: qk.parties(isSupplier ? "supplier" : "customer") });
      await queryClient.invalidateQueries({ queryKey: qk.payments() });
      void addAppNotification("Payment entry deleted", "A payment or receipt entry was removed.", "payment-deleted");
      toast("Entry deleted", "success");
    } catch (e: any) {
      toast(e?.message || "Could not delete", "error");
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Payments"
        subtitle={isSupplier ? "Money you owe suppliers" : "Money customers owe you"}
        topInset={insets.top}
        onBack={() => router.back()}
      />
      <ChipRow options={TABS as any} value={tab} onChange={setTab} testIDPrefix="payments-tab" />

      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={visibleParties}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}
          ListHeaderComponent={
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>
                {isSupplier ? "Total payable (you owe)" : "Total receivable (owed to you)"}
              </Text>
              <Text style={[styles.summaryValue, { color: isSupplier ? colors.error : colors.success }]}>
                {money(totalOutstanding)}
              </Text>
              {!isSupplier && totalCustomerCredit > 0 && (
                <Text style={{ color: colors.error, fontSize: 13, fontWeight: "700", marginTop: 6 }}>
                  Customer credit (store owes): {money(totalCustomerCredit)}
                </Text>
              )}
              {!isSupplier && admin && (
                <View style={{ marginTop: 12 }}>
                  <Pressable
                    testID="open-customer-balance-transfer"
                    style={[styles.transferButton, fakeFinanceDisplay && { opacity: 0.5 }]}
                    onPress={openCustomerBalanceTransfer}
                    disabled={fakeFinanceDisplay}
                  >
                    <MaterialDesignIcons name="swap-horizontal" size={19} color={colors.brandPrimary} />
                    <Text style={styles.transferButtonText}>Transfer balance between customers</Text>
                  </Pressable>
                  <Text style={styles.hint}>Move an outstanding balance or customer credit. No cash is recorded.</Text>
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            <EmptyState
              icon="account-cash-outline"
              title={isSupplier ? "No suppliers" : "No customers"}
              message="Add parties from the Parties screen to track balances."
              testID="payments-empty"
            />
          }
          renderItem={({ item }) => {
            const displayBalance = balanceForParty(item);
            const owes = displayBalance > 0;
            return (
              <View style={styles.row} testID={`party-balance-${item.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.balanceLabel}>
                    {owes
                      ? isSupplier ? "You owe" : "Owes you"
                      : displayBalance < 0 ? (isSupplier ? "Supplier credit" : "You owe customer") : "Settled"}
                  </Text>
                </View>
                <Text style={[styles.balance, { color: owes ? (isSupplier ? colors.error : colors.success) : colors.muted }]}>
                  {money(Math.abs(displayBalance))}
                </Text>
                <Pressable
                  testID={`record-payment-${item.id}`}
                  style={styles.recordBtn}
                  onPress={() => openFor(item)}
                >
                  <MaterialDesignIcons name={isSupplier ? "cash-minus" : "cash-plus"} size={16} color={colors.onBrandPrimary} />
                  <Text style={styles.recordText}>{isSupplier ? "Pay" : "Receive"}</Text>
                </Pressable>
              </View>
            );
          }}
          ListFooterComponent={
            <View style={{ marginTop: 20, gap: 8 }}>
              {isSupplier && supplierPurchases.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>Purchase payable ledger</Text>
                  {supplierPurchases.map((p) => {
                    const refunded = refundByPurchase[p.id] ?? 0;
                    const net = fakeFinanceDisplay
                      ? fakePurchaseNetTotal(p.items ?? [], {}, String(p.id), refunded)
                      : Math.max(0, Number(p.total ?? 0) - refunded);
                    return (
                      <View key={`purchase-payable-${p.id}`} style={styles.ledgerRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.ledgerName}>{p.supplier_name}</Text>
                          <Text style={styles.ledgerMeta}>
                            {p.ref_no} · {formatDate(p.created_at)}
                            {refunded > 0 ? ` · returned ${money(refunded)}` : " · Purchase added to supplier balance"}
                          </Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={styles.ledgerAmt}>{money(net)}</Text>
                          {refunded > 0 && (
                            <Text style={styles.ledgerStruck}>{money(p.total)}</Text>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </>
              )}
              {paymentsByParty.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Recent {isSupplier ? "payments" : "receipts"} by {isSupplier ? "supplier" : "customer"}</Text>
                {paymentsByParty.map((group) => (
                  <View key={`grp-${group.name}`} style={{ gap: 6 }} testID={`party-payments-${group.name}`}>
                    <Text style={styles.partyGroupName}>{group.name}</Text>
                    {group.rows.map((p) => {
                      const refund = isRefundKind(p.kind);
                      return (
                        <View key={p.id} style={styles.ledgerRow} testID={`payment-${p.id}`}>
                          <View style={{ flex: 1 }}>
                            <View style={styles.kindLine}>
                              <View style={[styles.kindTag, refund ? styles.kindTagRefund : styles.kindTagPay]}>
                                <Text style={[styles.kindTagText, refund ? styles.kindTagTextRefund : styles.kindTagTextPay]}>
                                  {refund ? "Refund" : isSupplier ? "Payment" : "Receipt"}
                                </Text>
                              </View>
                              <Text style={styles.ledgerMeta}>
                                {formatDate(p.created_at)}
                                {p.bill_ref ? " · Bill " + p.bill_ref : ""}
                                {p.adjustment ? ` · adj ${money(fakeFinanceDisplay ? fakePaymentAmount(p.adjustment, String(p.id) + ":adjustment") : p.adjustment)}` : ""}
                                {p.note ? ` · ${p.note}` : ""}
                              </Text>
                            </View>
                          </View>
                          <Text style={[styles.ledgerAmt, refund && { color: colors.error }]}>
                            {refund ? "-" : ""}{money(fakeFinanceDisplay ? fakePaymentAmount(p.amount, String(p.id)) : p.amount)}
                          </Text>
                          {admin && <Pressable testID={`edit-payment-${p.id}`} hitSlop={8} style={styles.deleteBtn} onPress={()=>{
                            setEditingPayment(p); setActive(null); setSelectedBill(null); setEntryKind(p.kind); setAmount(String(Math.abs(fakeFinanceDisplay ? fakeDisplayAmount(p.amount) : p.amount))); setAdjustment(String(fakeFinanceDisplay ? fakeDisplayAmount(p.adjustment || 0) : (p.adjustment || ""))); setNote(p.note||""); setReceiptPhoto(receiptPhotos[p.id] ?? null);
                          }}>
                            <MaterialDesignIcons name="pencil" size={20} color={colors.brandPrimary}/>
                          </Pressable>}
                          {admin && <Pressable
                            testID={`delete-payment-${p.id}`}
                            hitSlop={8}
                            style={styles.deleteBtn}
                            onPress={() => setDeleting({ id: p.id, party_name: p.party_name })}
                          >
                            <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} />
                          </Pressable>}
                        </View>
                      );
                    })}
                  </View>
                ))}
              </>
              )}
              {!isSupplier && safeBalanceTransfers.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>Customer balance transfer history</Text>
                  {safeBalanceTransfers.slice(0, 100).map((transfer) => (
                    <View key={transfer.id} style={styles.ledgerRow} testID={`customer-transfer-${transfer.id}`}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.ledgerName}>
                          {transfer.from_party_name} → {transfer.to_party_name}
                        </Text>
                        <Text style={styles.ledgerMeta}>
                          {transfer.balance_type === "customer_credit" ? "Customer credit moved" : "Outstanding balance moved"}
                          {" · "}{formatDate(transfer.created_at)}
                          {transfer.user_name ? ` · by ${transfer.user_name}` : ""}
                        </Text>
                        {!!transfer.note && <Text style={styles.ledgerMeta}>{transfer.note}</Text>}
                        {typeof transfer.source_balance_before === "number" && typeof transfer.source_balance_after === "number" &&
                          typeof transfer.destination_balance_before === "number" && typeof transfer.destination_balance_after === "number" && (
                          <Text style={styles.ledgerMeta}>
                            Source {money(transfer.source_balance_before)} → {money(transfer.source_balance_after)}
                            {" · "}Destination {money(transfer.destination_balance_before)} → {money(transfer.destination_balance_after)}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.ledgerAmt}>{money(transfer.amount)}</Text>
                    </View>
                  ))}
                </>
              )}
            </View>
          }
        />
      )}

      <Modal visible={!!active || !!editingPayment} transparent animationType="fade" onRequestClose={() => setActive(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {editingPayment ? "Edit payment / receipt" : (isSupplier ? "Pay supplier" : "Receive from customer")}
            </Text>
            <Text style={styles.modalSub}>{editingPayment ? editingPayment.party_name : active?.name} · {editingPayment ? "Edit existing entry" : `balance ${money(active?.balance ?? 0)}`}</Text>

            {!editingPayment && (
              <View style={styles.kindRow}>
                <Pressable testID={`payment-kind-${isSupplier ? "pay" : "receive"}`} style={[styles.kindBtn, entryKind === (isSupplier ? "pay" : "receive") && styles.kindBtnActive]} onPress={() => { setEntryKind(isSupplier ? "pay" : "receive"); setSelectedBill(null); }}}>
                  <Text style={[styles.kindText, entryKind === (isSupplier ? "pay" : "receive") && styles.kindTextActive]}>{isSupplier ? "Pay Supplier" : "Receive Customer"}</Text>
                </Pressable>
                <Pressable testID={`payment-kind-${isSupplier ? "supplier_refund" : "customer_refund"}`} style={[styles.kindBtn, entryKind === (isSupplier ? "supplier_refund" : "customer_refund") && styles.kindBtnActive]} onPress={() => { setEntryKind(isSupplier ? "supplier_refund" : "customer_refund"); setSelectedBill(null); }}}>
                  <Text style={[styles.kindText, entryKind === (isSupplier ? "supplier_refund" : "customer_refund") && styles.kindTextActive]}>{isSupplier ? "Supplier Refund" : "Customer Refund"}</Text>
                </Pressable>
              </View>
            )}
            {active && !editingPayment && (entryKind === "receive" || entryKind === "pay") && (
              <View style={{ gap: 6, marginTop: 4 }} testID="partial-bill-allocation">
                <Text style={styles.fieldLabel}>Apply this installment to a bill — optional</Text>
                {billOptions.length === 0 ? (
                  <Text style={styles.hint}>No unpaid bills are available for this account. You can still record an unallocated payment.</Text>
                ) : (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
                    {billOptions.map((bill) => (
                      <Pressable
                        key={bill.id}
                        testID={"select-open-bill-" + bill.id}
                        style={[styles.billChoice, selectedBill?.id === bill.id && styles.billChoiceActive]}
                        onPress={() => {
                          setSelectedBill(bill);
                          setAmount(String(bill.due));
                          setAdjustment("");
                        }}
                      >
                        <Text style={[styles.billChoiceTitle, selectedBill?.id === bill.id && styles.billChoiceTextActive]}>{bill.ref}</Text>
                        <Text style={[styles.billChoiceMeta, selectedBill?.id === bill.id && styles.billChoiceTextActive]}>
                          Remaining {money(bill.due)}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
                {selectedBill && (
                  <View style={styles.billSelectedRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.billSelectedText}>Installment linked to {selectedBill.ref}</Text>
                      <Text style={styles.hint}>Outstanding before payment: {money(selectedBill.due)}</Text>
                    </View>
                    <Pressable testID="clear-selected-bill" onPress={() => setSelectedBill(null)} hitSlop={8}>
                      <MaterialDesignIcons name="close-circle" size={20} color={colors.muted} />
                    </Pressable>
                  </View>
                )}
              </View>
            )}
            <Text style={styles.fieldLabel}>
              {entryKind === "supplier_refund" ? "Refund received from supplier (cash)" :
               entryKind === "customer_refund" ? "Refund paid to customer (cash)" :
               isSupplier ? "Amount paid (cash)" : "Amount received (cash)"}
            </Text>
            <TextInput
              testID="payment-amount-input"
              style={styles.modalInput}
              keyboardType="numeric"
              value={amount}
              onChangeText={(value) => setAmount(sanitizeNonNegativeAmount(value))}
              placeholder="0"
              placeholderTextColor={colors.muted}
            />

            <Text style={styles.fieldLabel}>Bill adjustment (+ reduces balance; − increases balance) — optional</Text>
            <TextInput
              testID="payment-adjustment-input"
              style={styles.modalInput}
              keyboardType="numbers-and-punctuation"
              value={adjustment}
              onChangeText={setAdjustment}
              placeholder="0"
              placeholderTextColor={colors.muted}
            />
            <Text style={styles.hint}>{isSupplier ? "Positive adjustment reduces what you owe the supplier. Negative adjustments (admin only) increase the balance without cash." : "Receipts are not capped at the bill amount. Overpayment becomes customer credit. Positive adjustment reduces the customer balance; negative adjustment (admin only) increases it without recording cash."}</Text>
            {active && <Text style={styles.hint}>
              Balance preview: {money(balanceForParty(active))} {Number(balanceForParty(active)) >= 0 ? "outstanding" : "customer credit"} → {money(balanceForParty(active) + ((entryKind === "receive" || entryKind === "pay") ? -Math.abs(Number.parseFloat(amount) || 0) - (Number.parseFloat(adjustment) || 0) : Math.abs(Number.parseFloat(amount) || 0) - (Number.parseFloat(adjustment) || 0)))} after this entry. Cash received/paid and non-cash adjustment are calculated separately.
            </Text>}

            <View style={styles.photoSection}>
              <Text style={styles.fieldLabel}>Receipt photo — optional</Text>
              {receiptPhoto ? (
                <View style={styles.photoPreviewWrap}>
                  <Image source={{ uri: receiptPhoto }} style={styles.photoPreview} contentFit="contain" />
                  <Pressable testID="remove-payment-receipt-photo" style={styles.photoRemove} onPress={removeReceiptPhoto}>
                    <MaterialDesignIcons name="close-circle" size={22} color={colors.error} />
                  </Pressable>
                </View>
              ) : (
                <Pressable testID="add-payment-receipt-photo" style={styles.photoButton} onPress={pickReceiptPhoto}>
                  <MaterialDesignIcons name="camera-plus-outline" size={21} color={colors.brandPrimary} />
                  <Text style={styles.photoButtonText}>Attach receipt photo</Text>
                </Pressable>
              )}
              <Text style={styles.photoHint}>Stored inside app data and included in backup/restore.</Text>
            </View>
            <Text style={styles.fieldLabel}>Note — optional</Text>
            <TextInput
              testID="payment-note-input"
              style={styles.modalInput}
              value={note}
              onChangeText={setNote}
              placeholder="Reference / remark"
              placeholderTextColor={colors.muted}
            />

            <View style={styles.modalActions}>
              <Pressable testID="payment-cancel" style={styles.modalBtnGhost} onPress={() => { setActive(null); setEditingPayment(null); }}>
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable testID="payment-save" style={styles.modalBtn} onPress={record} disabled={busy}>
                <Text style={styles.modalBtnText}>{busy ? "Saving…" : editingPayment ? "Save changes" : "Record"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={transferOpen}
        transparent
        animationType="fade"
        onRequestClose={() => { setTransferOpen(false); setTransferPicker(null); }}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { maxHeight: "88%" }]}>
            <Text style={styles.modalTitle}>Transfer customer balance</Text>
            <Text style={styles.modalSub}>
              Move an outstanding amount or customer credit from one customer account to another. This does not record cash.
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
              <Text style={styles.fieldLabel}>From customer</Text>
              <Pressable
                testID="transfer-from-picker"
                style={styles.transferPartySelect}
                onPress={() => { setTransferPicker("from"); setTransferSearch(""); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.transferPartyName}>{selectedTransferFrom?.name ?? "Choose source customer"}</Text>
                  {!!selectedTransferFrom && (
                    <Text style={styles.transferPartyBalance}>
                      {Number(selectedTransferFrom.balance ?? 0) < 0 ? "Customer credit" : "Owes you"} · {money(transferAvailable)}
                    </Text>
                  )}
                </View>
                <MaterialDesignIcons name="chevron-down" size={22} color={colors.muted} />
              </Pressable>

              <Text style={styles.fieldLabel}>To customer</Text>
              <Pressable
                testID="transfer-to-picker"
                style={styles.transferPartySelect}
                onPress={() => { setTransferPicker("to"); setTransferSearch(""); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.transferPartyName}>{selectedTransferTo?.name ?? "Choose destination customer"}</Text>
                  {!!selectedTransferTo && (
                    <Text style={styles.transferPartyBalance}>
                      Current balance: {money(Number(selectedTransferTo.balance ?? 0))}
                    </Text>
                  )}
                </View>
                <MaterialDesignIcons name="chevron-down" size={22} color={colors.muted} />
              </Pressable>

              {!!transferPicker && (
                <View style={styles.transferPickerPanel} testID="transfer-party-options">
                  <TextInput
                    testID="transfer-party-search"
                    style={styles.modalInput}
                    value={transferSearch}
                    onChangeText={setTransferSearch}
                    placeholder="Search customer by name or phone"
                    placeholderTextColor={colors.muted}
                  />
                  <ScrollView style={{ maxHeight: 190 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                    {safeParties
                      .filter((party) => {
                        const hasSourceBalance = Math.abs(Number(party.balance ?? 0)) >= 0.01;
                        const otherId = transferPicker === "from" ? transferToId : transferFromId;
                        const searchValue = transferSearch.trim().toLocaleLowerCase();
                        return (transferPicker === "to" || hasSourceBalance) &&
                          party.id !== otherId &&
                          (!searchValue || [party.name, party.phone, party.address].some((value) => String(value ?? "").toLocaleLowerCase().includes(searchValue)));
                      })
                      .map((party) => (
                        <Pressable
                          key={party.id}
                          testID={`transfer-select-${transferPicker}-${party.id}`}
                          style={styles.transferOption}
                          onPress={() => {
                            if (transferPicker === "from") {
                              setTransferFromId(party.id);
                              setTransferAmount(String(Math.abs(Number(party.balance ?? 0))));
                            } else {
                              setTransferToId(party.id);
                            }
                            setTransferPicker(null);
                            setTransferSearch("");
                          }}
                        >
                          <Text style={styles.transferPartyName}>{party.name}</Text>
                          <Text style={styles.transferPartyBalance}>
                            {Number(party.balance ?? 0) < 0 ? "Customer credit" : Number(party.balance ?? 0) > 0 ? "Owes you" : "Settled"}
                            {" · "}{money(Math.abs(Number(party.balance ?? 0)))}
                          </Text>
                        </Pressable>
                      ))}
                    {safeParties.filter((party) => party.id !== (transferPicker === "from" ? transferToId : transferFromId) &&
                      (transferPicker === "to" || Math.abs(Number(party.balance ?? 0)) >= 0.01)).length === 0 && (
                      <Text style={styles.hint}>No matching customers.</Text>
                    )}
                  </ScrollView>
                </View>
              )}

              <Text style={styles.fieldLabel}>Amount to transfer</Text>
              <TextInput
                testID="transfer-amount-input"
                style={styles.modalInput}
                keyboardType="decimal-pad"
                value={transferAmount}
                onChangeText={(value) => setTransferAmount(sanitizeNonNegativeAmount(value))}
                placeholder="0"
                placeholderTextColor={colors.muted}
              />
              {!!selectedTransferFrom && (
                <>
                  <Text style={styles.hint}>
                    Available: {money(transferAvailable)} · {Number(selectedTransferFrom.balance ?? 0) < 0 ? "customer credit" : "outstanding balance"}
                  </Text>
                  <Pressable
                    testID="transfer-full-balance"
                    style={styles.transferFullButton}
                    onPress={() => setTransferAmount(String(transferAvailable))}
                  >
                    <Text style={styles.transferFullButtonText}>Use full remaining balance</Text>
                  </Pressable>
                </>
              )}
              {!!selectedTransferFrom && !!selectedTransferTo && transferValue > 0 && (
                <Text style={styles.hint}>
                  Preview · Source: {money(Number(selectedTransferFrom.balance ?? 0) - transferSignedValue)}
                  {" · "}Destination: {money(Number(selectedTransferTo.balance ?? 0) + transferSignedValue)}
                </Text>
              )}
              <Text style={styles.fieldLabel}>Note — optional</Text>
              <TextInput
                testID="transfer-note-input"
                style={styles.modalInput}
                value={transferNote}
                onChangeText={setTransferNote}
                placeholder="Reason / reference"
                placeholderTextColor={colors.muted}
              />
              <View style={styles.modalActions}>
                <Pressable
                  testID="transfer-cancel"
                  style={styles.modalBtnGhost}
                  onPress={() => { setTransferOpen(false); setTransferPicker(null); }}
                >
                  <Text style={styles.modalBtnGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  testID="transfer-save"
                  style={styles.modalBtn}
                  onPress={recordCustomerBalanceTransfer}
                  disabled={transferBusy}
                >
                  <Text style={styles.modalBtnText}>{transferBusy ? "Transferring…" : "Transfer"}</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <ConfirmModal
        visible={!!deleting}
        title="Delete this entry?"
        message={`Remove this ${isSupplier ? "payment" : "receipt"} for ${deleting?.party_name ?? ""}? The balance will be adjusted back.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  summaryCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 6,
  },
  summaryLabel: { fontSize: 13, color: colors.onSurfaceSecondary, fontWeight: "600" },
  summaryValue: { fontSize: 26, fontWeight: "800", marginTop: 4 },
  transferButton: { minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: colors.brandSecondary, backgroundColor: colors.brandTertiary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 12 },
  transferButtonText: { fontSize: 13, fontWeight: "800", color: colors.brandPrimary },
  transferPartySelect: { minHeight: 54, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  transferPartyName: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  transferPartyBalance: { fontSize: 11, color: colors.muted, marginTop: 2 },
  transferPickerPanel: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 8, gap: 6, backgroundColor: colors.surfaceSecondary },
  transferOption: { paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  transferFullButton: { alignSelf: "flex-start", paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: colors.brandTertiary },
  transferFullButtonText: { color: colors.brandPrimary, fontSize: 12, fontWeight: "800" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  name: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  balanceLabel: { fontSize: 12, color: colors.muted, marginTop: 2 },
  balance: { fontSize: 16, fontWeight: "800" },
  recordBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.brandPrimary,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 38,
  },
  recordText: { color: colors.onBrandPrimary, fontSize: 13, fontWeight: "800" },
  sectionTitle: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  ledgerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    padding: 12,
  },
  ledgerName: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  ledgerMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  ledgerAmt: { fontSize: 15, fontWeight: "800", color: colors.brandPrimary },
  ledgerStruck: { fontSize: 11, color: colors.muted, textDecorationLine: "line-through", marginTop: 1 },
  partyGroupName: { fontSize: 13, fontWeight: "800", color: colors.onSurfaceSecondary, marginTop: 8 },
  kindLine: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  kindTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  kindTagPay: { backgroundColor: colors.brandSecondary },
  kindTagRefund: { backgroundColor: colors.error + "18" },
  kindTagText: { fontSize: 10, fontWeight: "800" },
  kindTagTextPay: { color: colors.onBrandSecondary },
  kindTagTextRefund: { color: colors.error },
  kindRow: { flexDirection: "row", gap: 8, marginVertical: 4 },
  kindBtn: { flex: 1, minHeight: 40, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  kindBtnActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  kindText: { fontSize: 12, fontWeight: "700", color: colors.onSurfaceSecondary, textAlign: "center" },
  kindTextActive: { color: colors.onBrandPrimary },
  billChoice: { minWidth: 112, maxWidth: 160, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  billChoiceActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  billChoiceTitle: { fontSize: 12, fontWeight: "800", color: colors.onSurface },
  billChoiceMeta: { fontSize: 10, color: colors.muted, marginTop: 3 },
  billChoiceTextActive: { color: colors.onBrandPrimary },
  billSelectedRow: { flexDirection: "row", alignItems: "center", gap: 8, padding: 9, borderRadius: 9, backgroundColor: colors.brandTertiary },
  billSelectedText: { fontSize: 11, fontWeight: "800", color: colors.brandPrimary },
  deleteBtn: { padding: 6, marginLeft: 2 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 400, backgroundColor: colors.surface, borderRadius: 18, padding: 20, gap: 8 },
  modalTitle: { fontSize: 17, fontWeight: "800", color: colors.onSurface },
  modalSub: { fontSize: 13, color: colors.onSurfaceSecondary, marginBottom: 4 },
  photoSection: { gap: 7, marginTop: 2 },
  photoPreviewWrap: { height: 150, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, overflow: "hidden", position: "relative" },
  photoPreview: { width: "100%", height: "100%" },
  photoRemove: { position: "absolute", right: 7, top: 7, backgroundColor: colors.surface, borderRadius: 20 },
  photoButton: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: colors.brandSecondary, backgroundColor: colors.brandTertiary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  photoButtonText: { fontSize: 13, fontWeight: "800", color: colors.brandPrimary },
  photoHint: { fontSize: 11, color: colors.muted },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.onSurfaceSecondary, marginTop: 4 },
  modalInput: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 16,
    color: colors.onSurface,
  },
  hint: { fontSize: 11, color: colors.muted },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 10 },
  modalBtnGhost: { flex: 1, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  modalBtnGhostText: { fontSize: 15, fontWeight: "700", color: colors.onSurfaceSecondary },
  modalBtn: { flex: 1, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandPrimary },
  modalBtnText: { fontSize: 15, fontWeight: "800", color: colors.onBrandPrimary },
}));
