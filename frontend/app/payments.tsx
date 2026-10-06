import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiRequest } from "@/src/api";
import { useParties, usePayments, usePurchases, usePurchaseReturns, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { Party, Payment } from "@/src/models";
import { ChipRow, ConfirmModal, EmptyState, Loader, ScreenHeader, formatDate, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { getHiddenSupplierIds, useFakeFinanceDisplay, fakePurchaseNetTotal, fakePaymentAmount, fakeDisplayAmount } from "@/src/utils/finance-display";

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
  const { data: purchases } = usePurchases();
  const { data: purchaseReturns } = usePurchaseReturns();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const fakeFinanceDisplay = useFakeFinanceDisplay();

  // Refund total per purchase so the payable ledger shows the net amount owed
  // to a supplier after any goods were returned (offline + online).
  const refundByPurchase = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of (purchaseReturns ?? []) as any[]) {
      if (!r.purchase_id) continue;
      m[r.purchase_id] = (m[r.purchase_id] ?? 0) + Number(r.refund_total ?? 0);
    }
    return m;
  }, [purchaseReturns]);

  const [active, setActive] = useState<Party | null>(null);
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; party_name: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [adjustment, setAdjustment] = useState("");
  const [note, setNote] = useState("");
  const [entryKind, setEntryKind] = useState<"pay" | "receive" | "supplier_refund" | "customer_refund">("pay");
  const [busy, setBusy] = useState(false);
  const [receiptPhoto, setReceiptPhoto] = useState<string | null>(null);
  const [receiptPhotos, setReceiptPhotos] = useState<Record<string, string>>({});
  const [hiddenSupplierIds, setHiddenSupplierIds] = useState<string[]>([]);
  useEffect(() => { void getHiddenSupplierIds().then(setHiddenSupplierIds); }, []);
  useEffect(() => { void AsyncStorage.getAllKeys().then(async (keys) => { const ks = keys.filter((k) => k.startsWith("ssm.paymentReceipt.")); if (!ks.length) return; const pairs = await AsyncStorage.multiGet(ks); const map: Record<string,string> = {}; for (const [k,v] of pairs) if (v) map[k.replace("ssm.paymentReceipt.","")] = v; setReceiptPhotos(map); }); }, [payments?.length]);
  const pickReceiptPhoto = async () => { const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.55, base64: true, exif: false }); if (result.canceled) return; const asset = result.assets[0]; if (!asset?.base64) { toast("Could not read the receipt photo", "error"); return; } if (asset.base64.length > 4_000_000) { toast("Photo is too large. Please choose a smaller receipt photo.", "error"); return; } setReceiptPhoto("data:image/jpeg;base64," + asset.base64); };
  const removeReceiptPhoto = () => setReceiptPhoto(null);

  const visibleParties = useMemo(() => isSupplier ? (parties ?? []).filter((p) => !hiddenSupplierIds.includes(p.id)) : (parties ?? []), [parties, isSupplier, hiddenSupplierIds]);
  const visiblePartyIds = useMemo(() => new Set(visibleParties.map((p) => p.id)), [visibleParties]);
  const fakeSupplierBalanceById = useMemo(() => {
    const result: Record<string, number> = {};
    if (!fakeFinanceDisplay || !isSupplier) return result;

    for (const party of visibleParties) {
      const purchaseTotal = (purchases ?? [])
        .filter((p) => p.supplier_id === party.id)
        .reduce((sum, p) => sum + fakePurchaseNetTotal(
          p.items ?? [],
          {},
          String(p.id),
          refundByPurchase[p.id] ?? 0,
        ), 0);

      const cashAndRefunds = (payments ?? [])
        .filter((p) => p.party_id === party.id && (p.kind === "pay" || p.kind === "supplier_refund"))
        .reduce((sum, p) => sum + fakePaymentAmount(p.amount, String(p.id)), 0);

      const adjustments = (payments ?? [])
        .filter((p) => p.party_id === party.id && Number(p.adjustment ?? 0) !== 0)
        .reduce((sum, p) => sum + fakeDisplayAmount(p.adjustment), 0);

      result[party.id] = Math.max(0, purchaseTotal - cashAndRefunds - adjustments);
    }
    return result;
  }, [fakeFinanceDisplay, isSupplier, visibleParties, purchases, payments, refundByPurchase]);

  const totalOutstanding = useMemo(
    () => visibleParties.reduce(
      (s, p) => s + Math.max(0, fakeFinanceDisplay && isSupplier ? (fakeSupplierBalanceById[p.id] ?? 0) : p.balance),
      0,
    ),
    [visibleParties, fakeFinanceDisplay, isSupplier, fakeSupplierBalanceById],
  );

  const openFor = (p: Party) => {
    setActive(p);
    setAmount(p.balance > 0 ? String(p.balance) : "");
    setAdjustment("");
    setNote("");
    setReceiptPhoto(receiptPhotos[p.id] ?? null);
    setEntryKind(isSupplier ? "pay" : "receive");
  };

  const record = async () => {
    if (!active && !editingPayment) return;
    const amt = parseFloat(amount) || 0;
    const adj = parseFloat(adjustment) || 0;
    if (amt < 0 || adj < 0) {
      toast("Amount and adjustment cannot be negative", "error");
      return;
    }
    if (amt <= 0 && adj <= 0) {
      toast("Enter an amount", "error");
      return;
    }
    setBusy(true);
    try {
      let saved: Payment;
      if (editingPayment) {
        saved = await apiRequest<Payment>(`/payments/${editingPayment.id}`, { method: "PUT", body: {
          party_id: editingPayment.party_id, kind: editingPayment.kind, amount: amt, adjustment: adj, note: note.trim()
        }});
      } else {
        saved = await apiRequest<Payment>("/payments", { method: "POST", body: {
          party_id: active!.id, kind: entryKind, amount: amt, adjustment: adj, note: note.trim()
        }});
      }
      if (saved?.id) {
        if (receiptPhoto) { await AsyncStorage.setItem(`ssm.paymentReceipt.${saved.id}`, receiptPhoto); setReceiptPhotos((prev) => ({ ...prev, [saved.id]: receiptPhoto })); }
        else { await AsyncStorage.removeItem(`ssm.paymentReceipt.${saved.id}`); setReceiptPhotos((prev) => { const next = { ...prev }; delete next[saved.id]; return next; }); }
      }
      await queryClient.invalidateQueries({ queryKey: qk.parties(isSupplier ? "supplier" : "customer") });
      await queryClient.invalidateQueries({ queryKey: qk.payments() });
      toast(editingPayment ? "Entry updated" : (isSupplier ? "Payment recorded" : "Receipt recorded"), "success");
      setActive(null); setEditingPayment(null);
    } catch (e: any) {
      toast(e?.message || "Could not record", "error");
    } finally {
      setBusy(false);
    }
  };

  const recentPayments = (payments ?? []).filter((p) => visiblePartyIds.has(p.party_id) && (
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
  const supplierPurchases = (purchases ?? [])
    .filter((p) => isSupplier && p.supplier_id && visiblePartyIds.has(p.supplier_id))
    .slice(0, 12);

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
            const displayBalance = fakeFinanceDisplay && isSupplier ? (fakeSupplierBalanceById[item.id] ?? 0) : item.balance;
            const owes = displayBalance > 0;
            return (
              <View style={styles.row} testID={`party-balance-${item.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.balanceLabel}>
                    {owes
                      ? isSupplier ? "You owe" : "Owes you"
                      : displayBalance < 0 ? "Advance / credit" : "Settled"}
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
                                {p.adjustment ? ` · adj ${money(fakeFinanceDisplay ? fakePaymentAmount(p.adjustment, String(p.id) + ":adjustment") : p.adjustment)}` : ""}
                                {p.note ? ` · ${p.note}` : ""}
                              </Text>
                            </View>
                          </View>
                          <Text style={[styles.ledgerAmt, refund && { color: colors.error }]}>
                            {refund ? "-" : ""}{money(fakeFinanceDisplay ? fakePaymentAmount(p.amount, String(p.id)) : p.amount)}
                          </Text>
                          {admin && <Pressable testID={`edit-payment-${p.id}`} hitSlop={8} style={styles.deleteBtn} onPress={()=>{
                            setEditingPayment(p); setActive(null); setEntryKind(p.kind); setAmount(String(p.amount)); setAdjustment(String(p.adjustment||"")); setNote(p.note||""); setReceiptPhoto(receiptPhotos[p.id] ?? null);
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
                <Pressable testID={`payment-kind-${isSupplier ? "pay" : "receive"}`} style={[styles.kindBtn, entryKind === (isSupplier ? "pay" : "receive") && styles.kindBtnActive]} onPress={() => setEntryKind(isSupplier ? "pay" : "receive")}>
                  <Text style={[styles.kindText, entryKind === (isSupplier ? "pay" : "receive") && styles.kindTextActive]}>{isSupplier ? "Pay Supplier" : "Receive Customer"}</Text>
                </Pressable>
                <Pressable testID={`payment-kind-${isSupplier ? "supplier_refund" : "customer_refund"}`} style={[styles.kindBtn, entryKind === (isSupplier ? "supplier_refund" : "customer_refund") && styles.kindBtnActive]} onPress={() => setEntryKind(isSupplier ? "supplier_refund" : "customer_refund")}>
                  <Text style={[styles.kindText, entryKind === (isSupplier ? "supplier_refund" : "customer_refund") && styles.kindTextActive]}>{isSupplier ? "Supplier Refund" : "Customer Refund"}</Text>
                </Pressable>
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
              onChangeText={setAmount}
              placeholder="0"
              placeholderTextColor={colors.muted}
            />

            <Text style={styles.fieldLabel}>Adjustment (discount / extra) — optional</Text>
            <TextInput
              testID="payment-adjustment-input"
              style={styles.modalInput}
              keyboardType="numeric"
              value={adjustment}
              onChangeText={setAdjustment}
              placeholder="0"
              placeholderTextColor={colors.muted}
            />
            <Text style={styles.hint}>Adjustment also reduces the balance without cash (e.g. discount).</Text>

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
