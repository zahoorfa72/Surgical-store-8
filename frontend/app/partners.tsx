import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { apiRequest } from "@/src/api";
import { isAdmin, useAuth } from "@/src/auth";
import { todayIsoDate, money, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

type Partner = { id: string; name: string; phone?: string; address?: string; note?: string; balance: number; pending?: boolean };
type PartnerTx = { id: string; partner_id: string; partner_name: string; kind: string; amount: number; transaction_date: string; note: string; pending?: boolean };
type PartnerSummary = { gross_profit: number; allocated_profit: number; available_gross_profit: number; partners: Partner[] };

const TX_TYPES = [
  { key: "cash_in", label: "Cash In", detail: "Partner adds money to the business" },
  { key: "cash_out", label: "Cash Out", detail: "Business pays or withdraws partner funds" },
  { key: "profit_allocation", label: "Profit Allocation", detail: "Allocate gross profit; not a cash payment" },
  { key: "profit_payment", label: "Pay Allocated Profit", detail: "Cash paid against already allocated profit" },
] as const;

function txLabel(kind: string) {
  return TX_TYPES.find((item) => item.key === kind)?.label ?? kind;
}
function txEffect(kind: string, amount: number) {
  return kind === "cash_in" || kind === "profit_allocation" ? amount : -amount;
}

export default function Partners() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [partnerModal, setPartnerModal] = useState(false);
  const [txModal, setTxModal] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [partnerNote, setPartnerNote] = useState("");
  const [openingBalance, setOpeningBalance] = useState("0");
  const [kind, setKind] = useState<string>("cash_in");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIsoDate());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const summaryQuery = useQuery({ queryKey: ["partners/summary"], queryFn: () => apiRequest<PartnerSummary>("/partners/summary") });
  const partnersQuery = useQuery({ queryKey: ["partners"], queryFn: () => apiRequest<Partner[]>("/partners") });
  const txQuery = useQuery({ queryKey: ["partner-transactions"], queryFn: () => apiRequest<PartnerTx[]>("/partner-transactions") });
  const partners = partnersQuery.data ?? summaryQuery.data?.partners ?? [];
  const transactions = txQuery.data ?? [];
  const selected = partners.find((p) => p.id === selectedId) ?? partners[0] ?? null;
  const statement = useMemo(() => transactions.filter((row) => !selected || row.partner_id === selected.id), [transactions, selected?.id]);
  const statementWithBalance = useMemo(() => {
    let running = 0;
    return [...statement].sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))).map((row) => {
      running += txEffect(row.kind, Number(row.amount));
      return { ...row, running_balance: Math.round(running * 100) / 100 };
    }).reverse();
  }, [statement]);
  const totals = summaryQuery.data;
  const reload = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["partners"] }),
      queryClient.invalidateQueries({ queryKey: ["partners/summary"] }),
      queryClient.invalidateQueries({ queryKey: ["partner-transactions"] }),
      queryClient.invalidateQueries({ queryKey: ["report"] }),
    ]);
  };

  const savePartner = async () => {
    if (!name.trim()) return toast("Enter partner name", "error");
    setBusy(true);
    try {
      const result = await apiRequest<Partner>("/partners", { method: "POST", body: { name: name.trim(), phone: phone.trim(), address: address.trim(), note: partnerNote.trim(), opening_balance: Number(openingBalance) || 0 } });
      setSelectedId(result.id);
      setPartnerModal(false);
      setName(""); setPhone(""); setAddress(""); setPartnerNote(""); setOpeningBalance("0");
      await reload();
      toast("Partner added", "success");
    } catch (e: any) { toast(e?.message || "Could not add partner", "error"); }
    finally { setBusy(false); }
  };

  const saveTransaction = async () => {
    if (!selected) return toast("Add or select a partner first", "error");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return toast("Enter a valid amount", "error");
    setBusy(true);
    try {
      await apiRequest("/partner-transactions", { method: "POST", body: { partner_id: selected.id, kind, amount: value, transaction_date: date, note: note.trim() } });
      setTxModal(false); setAmount(""); setNote(""); setDate(todayIsoDate());
      await reload();
      toast("Partner transaction saved", "success");
    } catch (e: any) { toast(e?.message || "Could not save transaction", "error"); }
    finally { setBusy(false); }
  };

  const exportStatement = async () => {
    if (!selected) return;
    const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
    const rows = [...statementWithBalance].reverse().map((row) => `<tr><td>${esc(row.transaction_date)}</td><td>${esc(txLabel(row.kind))}</td><td>${esc(row.note)}</td><td style="text-align:right">${Number(row.amount).toFixed(2)}</td><td style="text-align:right">${Number(row.running_balance).toFixed(2)}</td></tr>`).join("");
    const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:Arial;padding:24px;color:#172033}h1{font-size:22px}p{color:#526078}table{width:100%;border-collapse:collapse;font-size:11px;margin-top:18px}th,td{border:1px solid #d8dee9;padding:8px;text-align:left}th{background:#eef2f7} .total{font-size:18px;font-weight:bold}</style></head><body><h1>Partner Account Statement</h1><p><b>Partner:</b> ${esc(selected.name)}<br><b>Generated:</b> ${esc(todayIsoDate())}</p><p class="total">Current account balance: ${Number(selected.balance ?? 0).toFixed(2)}</p><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Amount</th><th>Running balance</th></tr></thead><tbody>${rows || "<tr><td colspan='5'>No transactions</td></tr>"}</tbody></table><p>Profit allocations are based on gross profit and are recorded separately from cash payments and operating expenses.</p></body></html>`;
    try {
      const file = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", dialogTitle: `${selected.name} statement` });
      else toast(`PDF created at ${file.uri}`, "success");
    } catch (e: any) { toast(e?.message || "Could not export statement", "error"); }
  };

  const deleteTransaction = async (row: PartnerTx) => {
    try {
      await apiRequest(`/partner-transactions/${row.id}`, { method: "DELETE" });
      await reload();
      toast("Transaction removed", "success");
    } catch (e: any) { toast(e?.message || "Could not remove transaction", "error"); }
  };

  if (!admin) {
    return <View style={styles.root}><ScreenHeader title="Partner accounts" topInset={insets.top} onBack={() => router.back()} /><View style={styles.center}><Text style={styles.muted}>Only an admin can manage partner accounts.</Text></View></View>;
  }

  return (
    <View style={styles.root}>
      <ScreenHeader title="Partner accounts" subtitle="Gross-profit allocations and partner ledger" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 14 }}>
        <View style={styles.profitCard}>
          <Text style={styles.cardEyebrow}>BUSINESS GROSS PROFIT · ALL TIME</Text>
          <Text style={styles.profitValue}>{money(totals?.gross_profit ?? 0)}</Text>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Allocated to partners</Text><Text style={styles.summaryValue}>{money(totals?.allocated_profit ?? 0)}</Text></View>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Available for allocation</Text><Text style={styles.availableValue}>{money(totals?.available_gross_profit ?? 0)}</Text></View>
          <Text style={styles.helper}>Profit allocation is based on lifetime gross profit after sales returns. It is not recorded as an operating expense and does not change gross profit.</Text>
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Partners</Text>
          <Pressable style={styles.primarySmall} onPress={() => setPartnerModal(true)}><MaterialDesignIcons name="plus" size={17} color="#FFFFFF" /><Text style={styles.primarySmallText}>Add partner</Text></Pressable>
        </View>
        {partners.length === 0 ? <View style={styles.empty}><Text style={styles.muted}>No partners added yet.</Text></View> : partners.map((p) => {
          const active = selected?.id === p.id;
          return <Pressable key={p.id} onPress={() => setSelectedId(p.id)} style={[styles.partnerRow, active && styles.partnerActive]}>
            <View style={styles.avatar}><MaterialDesignIcons name="account" size={22} color={colors.brandPrimary} /></View>
            <View style={{ flex: 1, gap: 3 }}><Text style={styles.partnerName}>{p.name}</Text><Text style={styles.muted}>{p.phone || "No phone number"}</Text></View>
            <View style={{ alignItems: "flex-end", gap: 3 }}><Text style={styles.balance}>{money(p.balance ?? 0)}</Text><Text style={styles.muted}>Account balance</Text></View>
          </Pressable>;
        })}

        {selected && <>
          <View style={styles.sectionHead}>
            <View><Text style={styles.sectionTitle}>{selected.name} statement</Text><Text style={styles.muted}>Date-wise account activity</Text></View>
            <View style={{ flexDirection: "row", gap: 7 }}><Pressable style={styles.exportSmall} onPress={exportStatement}><MaterialDesignIcons name="file-pdf-box" size={17} color={colors.brandPrimary} /><Text style={styles.exportText}>PDF</Text></Pressable>
            <Pressable style={styles.primarySmall} onPress={() => setTxModal(true)}><MaterialDesignIcons name="plus" size={17} color="#FFFFFF" /><Text style={styles.primarySmallText}>Entry</Text></Pressable></View>
          </View>
          <View style={styles.accountCard}>
            <Text style={styles.cardEyebrow}>CURRENT PARTNER ACCOUNT</Text>
            <Text style={styles.profitValue}>{money(selected.balance ?? 0)}</Text>
            <Text style={styles.helper}>Positive balance means the business owes this partner. Negative balance means the partner has withdrawn more than their recorded contributions and allocations.</Text>
          </View>
          {statementWithBalance.length === 0 ? <View style={styles.empty}><Text style={styles.muted}>No transactions for this partner.</Text></View> : statementWithBalance.map((row) => {
            const positive = txEffect(row.kind, row.amount) >= 0;
            return <View key={row.id} style={styles.txRow}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.txTitle}>{txLabel(row.kind)}</Text>
                <Text style={styles.muted}>{row.transaction_date} · {row.note || "No description"}</Text><Text style={styles.muted}>Running balance: {money(row.running_balance)}</Text>
                {row.pending ? <Text style={styles.pending}>Waiting to sync</Text> : null}
              </View>
              <View style={{ alignItems: "flex-end", gap: 5 }}>
                <Text style={[styles.txAmount, { color: positive ? colors.success : colors.error }]}>{positive ? "+" : "−"}{money(row.amount)}</Text>
                <Pressable onPress={() => deleteTransaction(row)} hitSlop={8}><Text style={styles.deleteText}>Delete</Text></Pressable>
              </View>
            </View>;
          })}
        </>}
      </ScrollView>

      <Modal visible={partnerModal} transparent animationType="slide" onRequestClose={() => setPartnerModal(false)}>
        <View style={styles.scrim}><View style={styles.modal}>
          <Text style={styles.modalTitle}>Add partner</Text>
          <TextInput style={styles.input} placeholder="Partner name *" placeholderTextColor={colors.muted} value={name} onChangeText={setName} />
          <TextInput style={styles.input} placeholder="Phone" placeholderTextColor={colors.muted} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <TextInput style={styles.input} placeholder="Address" placeholderTextColor={colors.muted} value={address} onChangeText={setAddress} />
          <TextInput style={styles.input} placeholder="Opening balance (positive = business owes partner)" placeholderTextColor={colors.muted} value={openingBalance} onChangeText={setOpeningBalance} keyboardType="decimal-pad" />
          <TextInput style={styles.input} placeholder="Notes" placeholderTextColor={colors.muted} value={partnerNote} onChangeText={setPartnerNote} />
          <View style={styles.modalActions}><Pressable style={styles.secondaryButton} onPress={() => setPartnerModal(false)}><Text style={styles.secondaryText}>Cancel</Text></Pressable><Pressable disabled={busy} style={styles.primaryButton} onPress={savePartner}><Text style={styles.primaryButtonText}>{busy ? "Saving…" : "Save partner"}</Text></Pressable></View>
        </View></View>
      </Modal>

      <Modal visible={txModal} transparent animationType="slide" onRequestClose={() => setTxModal(false)}>
        <View style={styles.scrim}><View style={styles.modal}>
          <Text style={styles.modalTitle}>New entry · {selected?.name}</Text>
          <Text style={styles.fieldLabel}>Transaction type</Text>
          <View style={styles.typeGrid}>{TX_TYPES.map((item) => <Pressable key={item.key} onPress={() => setKind(item.key)} style={[styles.typeOption, kind === item.key && styles.typeSelected]}><Text style={[styles.typeText, kind === item.key && styles.typeTextSelected]}>{item.label}</Text></Pressable>)}</View>
          <Text style={styles.helper}>{TX_TYPES.find((item) => item.key === kind)?.detail}</Text>
          <TextInput style={styles.input} placeholder="Amount *" placeholderTextColor={colors.muted} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
          <TextInput style={styles.input} placeholder="Date (YYYY-MM-DD)" placeholderTextColor={colors.muted} value={date} onChangeText={setDate} />
          <TextInput style={[styles.input, styles.noteInput]} placeholder="Description / reference" placeholderTextColor={colors.muted} value={note} onChangeText={setNote} multiline />
          <View style={styles.modalActions}><Pressable style={styles.secondaryButton} onPress={() => setTxModal(false)}><Text style={styles.secondaryText}>Cancel</Text></Pressable><Pressable disabled={busy} style={styles.primaryButton} onPress={saveTransaction}><Text style={styles.primaryButtonText}>{busy ? "Saving…" : "Save entry"}</Text></Pressable></View>
        </View></View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  profitCard: { backgroundColor: colors.brandTertiary, borderRadius: 18, padding: 17, borderWidth: 1, borderColor: colors.border, gap: 9 },
  accountCard: { backgroundColor: colors.surfaceSecondary, borderRadius: 16, padding: 16, gap: 8 },
  cardEyebrow: { color: colors.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  profitValue: { color: colors.onSurface, fontSize: 27, fontWeight: "900" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  summaryLabel: { color: colors.onSurfaceSecondary, fontSize: 13 },
  summaryValue: { color: colors.onSurface, fontSize: 13, fontWeight: "800" },
  availableValue: { color: colors.success, fontSize: 14, fontWeight: "900" },
  helper: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 5 },
  sectionTitle: { color: colors.onSurface, fontSize: 16, fontWeight: "900" },
  primarySmall: { backgroundColor: colors.brandPrimary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 4 },
  primarySmallText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  exportSmall: { borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 4 },
  exportText: { color: colors.brandPrimary, fontSize: 12, fontWeight: "800" },
  partnerRow: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  partnerActive: { borderColor: colors.brandPrimary, borderWidth: 2 },
  avatar: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" },
  partnerName: { color: colors.onSurface, fontSize: 14, fontWeight: "800" },
  balance: { color: colors.onSurface, fontSize: 14, fontWeight: "900" },
  muted: { color: colors.muted, fontSize: 11 },
  empty: { padding: 24, alignItems: "center", backgroundColor: colors.surfaceSecondary, borderRadius: 14 },
  txRow: { flexDirection: "row", alignItems: "center", padding: 13, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, gap: 10 },
  txTitle: { color: colors.onSurface, fontSize: 13, fontWeight: "800" },
  txAmount: { fontSize: 14, fontWeight: "900" },
  deleteText: { color: colors.error, fontSize: 11, fontWeight: "700" },
  pending: { color: colors.warning, fontSize: 10, fontWeight: "700" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.48)", justifyContent: "center", padding: 18 },
  modal: { backgroundColor: colors.surface, borderRadius: 20, padding: 18, gap: 11 },
  modalTitle: { color: colors.onSurface, fontSize: 18, fontWeight: "900", marginBottom: 4 },
  fieldLabel: { color: colors.onSurface, fontSize: 12, fontWeight: "800" },
  input: { backgroundColor: colors.surfaceSecondary, color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 11, minHeight: 46, paddingHorizontal: 12, fontSize: 14 },
  noteInput: { minHeight: 68, paddingTop: 12, textAlignVertical: "top" },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  typeOption: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9 },
  typeSelected: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  typeText: { color: colors.onSurfaceSecondary, fontSize: 11, fontWeight: "700" },
  typeTextSelected: { color: colors.brandPrimary },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 9, marginTop: 6 },
  secondaryButton: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 11, backgroundColor: colors.surfaceSecondary },
  secondaryText: { color: colors.onSurface, fontWeight: "800" },
  primaryButton: { paddingHorizontal: 17, paddingVertical: 12, borderRadius: 11, backgroundColor: colors.brandPrimary },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "900" },
}));
