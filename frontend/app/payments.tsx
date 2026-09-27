import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useParties, usePayments, usePurchases, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { Party, Payment } from "@/src/models";
import { ChipRow, ConfirmModal, EmptyState, Loader, ScreenHeader, formatDate, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

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
  const { user } = useAuth();
  const admin = isAdmin(user?.role);

  const [active, setActive] = useState<Party | null>(null);
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; party_name: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [adjustment, setAdjustment] = useState("");
  const [note, setNote] = useState("");
  const [entryKind, setEntryKind] = useState<"pay" | "receive" | "supplier_refund" | "customer_refund">("pay");
  const [busy, setBusy] = useState(false);

  const totalOutstanding = useMemo(
    () => (parties ?? []).reduce((s, p) => s + Math.max(0, p.balance), 0),
    [parties],
  );

  const openFor = (p: Party) => {
    setActive(p);
    setAmount(p.balance > 0 ? String(p.balance) : "");
    setAdjustment("");
    setNote("");
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
      if (editingPayment) {
        await apiRequest(`/payments/${editingPayment.id}`, { method: "PUT", body: {
          party_id: editingPayment.party_id, kind: editingPayment.kind, amount: amt, adjustment: adj, note: note.trim()
        }});
      } else {
        await apiRequest("/payments", { method: "POST", body: {
          party_id: active!.id, kind: entryKind, amount: amt, adjustment: adj, note: note.trim()
        }});
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

  const recentPayments = (payments ?? []).filter((p) =>
    isSupplier
      ? p.kind === "pay" || p.kind === "supplier_refund"
      : p.kind === "receive" || p.kind === "customer_refund",
  );
  // Supplier purchases are payable ledger entries. They create the supplier
  // balance when purchased; only a recorded Pay entry settles/cuts cash.
  const supplierPurchases = (purchases ?? [])
    .filter((p) => isSupplier && p.supplier_id)
    .slice(0, 12);

  const confirmDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    try {
      await apiRequest(`/payments/${id}`, { method: "DELETE" });
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
          data={parties}
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
            const owes = item.balance > 0;
            return (
              <View style={styles.row} testID={`party-balance-${item.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.balanceLabel}>
                    {owes
                      ? isSupplier ? "You owe" : "Owes you"
                      : item.balance < 0 ? "Advance / credit" : "Settled"}
                  </Text>
                </View>
                <Text style={[styles.balance, { color: owes ? (isSupplier ? colors.error : colors.success) : colors.muted }]}>
                  {money(Math.abs(item.balance))}
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
                  {supplierPurchases.map((p) => (
                    <View key={`purchase-payable-${p.id}`} style={styles.ledgerRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.ledgerName}>{p.supplier_name}</Text>
                        <Text style={styles.ledgerMeta}>{p.ref_no} · {formatDate(p.created_at)} · Purchase added to supplier balance</Text>
                      </View>
                      <Text style={styles.ledgerAmt}>{money(p.total)}</Text>
                    </View>
                  ))}
                </>
              )}
              {recentPayments.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Recent {isSupplier ? "payments" : "receipts"}</Text>
                {recentPayments.slice(0, 12).map((p) => (
                  <View key={p.id} style={styles.ledgerRow} testID={`payment-${p.id}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.ledgerName}>{p.party_name}</Text>
                      <Text style={styles.ledgerMeta}>
                        {formatDate(p.created_at)}
                        {p.adjustment ? ` · adj ${money(p.adjustment)}` : ""}
                        {p.note ? ` · ${p.note}` : ""}
                      </Text>
                    </View>
                    <Text style={styles.ledgerAmt}>{money(p.amount)}</Text>
                    {admin && <Pressable testID={`edit-payment-${p.id}`} hitSlop={8} style={styles.deleteBtn} onPress={()=>{
                      setEditingPayment(p); setActive(null); setEntryKind(p.kind); setAmount(String(p.amount)); setAdjustment(String(p.adjustment||"")); setNote(p.note||"");
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
