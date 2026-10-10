import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth, isAdmin } from "@/src/auth";
import { apiRequest } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { OpeningBudgetTransaction } from "@/src/models";
import { money, ScreenHeader, useToast } from "@/src/ui";
import { useTheme } from "@/src/theme";

const STORAGE_KEY = "ssm.openingBudgetTransactions";
const todayIso = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

export default function OpeningBudgetLedger() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors } = useTheme();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<OpeningBudgetTransaction[]>([]);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const applyItems = async (next: OpeningBudgetTransaction[]) => {
    const ordered = [...next].sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
    setItems(ordered);
    await storage.setItem(STORAGE_KEY, ordered);
    const total = ordered.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    queryClient.setQueryData<any>(["budget"], (old: any) => ({
      ...(old ?? { monthly_amount: 0, spent_this_month: 0 }),
      opening_amount: total,
      opening_transactions: ordered,
    }));
    await queryClient.invalidateQueries({ queryKey: ["report"] });
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const cached = await storage.getItem<OpeningBudgetTransaction[]>(STORAGE_KEY, []);
      if (active) {
        setItems(cached ?? []);
        queryClient.setQueryData(["opening-budget-transactions"], cached ?? []);
        const cachedTotal = (cached ?? []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
        queryClient.setQueryData<any>(["budget"], (old: any) => ({
          ...(old ?? { monthly_amount: 0, spent_this_month: 0 }),
          opening_amount: cachedTotal,
          opening_transactions: cached ?? [],
        }));
      }
      try {
        const latest = await apiRequest<OpeningBudgetTransaction[]>("/opening-budget-transactions");
        if (active) {
          await applyItems(latest ?? []);
          queryClient.setQueryData(["opening-budget-transactions"], latest ?? []);
        }
      } catch {
        // Keep the saved local ledger available when the app is offline.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const resetForm = () => {
    setAmount("");
    setDate(todayIso());
    setNote("");
    setEditingId(null);
  };

  const save = async () => {
    const value = Number(amount.replace(/,/g, "").trim());
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(date + "T12:00:00").getTime()) &&
      new Date(date + "T12:00:00").toISOString().slice(0, 10) === date;
    if (!(value > 0) || !Number.isFinite(value)) return toast("Enter an amount greater than zero", "error");
    if (!validDate) return toast("Enter the date as YYYY-MM-DD", "error");
    setSaving(true);
    try {
      const body = { amount: Math.round(value * 100) / 100, date, note: note.trim() };
      if (editingId) {
        const updated = await apiRequest<OpeningBudgetTransaction>(`/opening-budget-transactions/${editingId}`, { method: "PUT", body });
        const next = items.map((item) => item.id === editingId ? { ...item, ...body, ...updated } : item);
        await applyItems(next);
        queryClient.setQueryData(["opening-budget-transactions"], next);
        toast("Opening budget transaction updated", "success");
      } else {
        const created = await apiRequest<OpeningBudgetTransaction>("/opening-budget-transactions", { method: "POST", body });
        const next = [{ ...created, ...body, id: created?.id || `local-opening-budget-${Date.now()}`, created_at: created?.created_at || new Date().toISOString(), pending: created?.pending || false }, ...items];
        await applyItems(next);
        queryClient.setQueryData(["opening-budget-transactions"], next);
        toast(created?.pending ? "Saved offline; will sync when connected" : "Opening budget added", "success");
      }
      resetForm();
    } catch (error: any) {
      toast(error?.message || "Could not save opening budget", "error");
    } finally {
      setSaving(false);
    }
  };

  const edit = (item: OpeningBudgetTransaction) => {
    setEditingId(item.id);
    setAmount(String(item.amount));
    setDate(item.date);
    setNote(item.note || "");
  };

  const remove = (item: OpeningBudgetTransaction) => {
    Alert.alert("Delete opening budget entry?", `${money(item.amount)} dated ${item.date} will be removed from the budget total. Purchases will not be changed.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try {
          await apiRequest(`/opening-budget-transactions/${item.id}`, { method: "DELETE" });
          const next = items.filter((row) => row.id !== item.id);
          await applyItems(next);
          queryClient.setQueryData(["opening-budget-transactions"], next);
          if (editingId === item.id) resetForm();
          toast("Opening budget entry deleted", "success");
        } catch (error: any) {
          toast(error?.message || "Could not delete entry", "error");
        }
      } },
    ]);
  };

  const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const fieldStyle = { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 13, color: colors.onSurface, backgroundColor: colors.surface, fontSize: 15 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Opening Purchase Budget" subtitle="Dated transaction history" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 28, gap: 16 }}>
        <View style={{ padding: 18, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 13, fontWeight: "700" }}>Current opening budget total</Text>
          <Text style={{ color: colors.onSurface, fontSize: 28, fontWeight: "900" }}>{money(total)}</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>Each entry adds to All-time Remaining Balance and is counted in a period only when its date falls inside that period.</Text>
        </View>
        {admin && <View style={{ padding: 16, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 12 }}>
          <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "900" }}>{editingId ? "Edit budget transaction" : "Add opening budget"}</Text>
          <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount (Rs.)" placeholderTextColor={colors.muted} style={fieldStyle} />
          <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} autoCapitalize="none" style={fieldStyle} />
          <TextInput value={note} onChangeText={setNote} placeholder="Note (optional)" placeholderTextColor={colors.muted} style={[fieldStyle, { minHeight: 48 }]} />
          <Pressable disabled={saving} onPress={save} style={{ minHeight: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandPrimary, opacity: saving ? 0.6 : 1 }}>
            <Text style={{ color: colors.onBrandPrimary, fontWeight: "900" }}>{saving ? "Saving…" : editingId ? "Save changes" : "Add transaction"}</Text>
          </Pressable>
          {!!editingId && <Pressable onPress={resetForm} style={{ alignItems: "center", padding: 8 }}><Text style={{ color: colors.muted, fontWeight: "700" }}>Cancel editing</Text></Pressable>}
        </View>}
        <View style={{ gap: 10 }}>
          <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "900" }}>Transaction history ({items.length})</Text>
          {loading && <Text style={{ color: colors.muted }}>Loading history…</Text>}
          {!loading && items.length === 0 && <Text style={{ color: colors.muted, paddingVertical: 18 }}>No opening budget entries yet. Add your first amount above.</Text>}
          {items.map((item) => <View key={item.id} style={{ padding: 14, borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 7 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: colors.onSurface, fontSize: 17, fontWeight: "900" }}>{money(item.amount)}</Text>
                <Text style={{ color: colors.muted, fontSize: 12 }}>{item.date}{item.pending ? " · Pending sync" : ""}</Text>
              </View>
              {admin && <Pressable onPress={() => edit(item)} accessibilityLabel="Edit opening budget entry" style={{ padding: 9 }}><MaterialDesignIcons name="pencil" size={20} color={colors.brandPrimary} /></Pressable>}
              {admin && <Pressable onPress={() => remove(item)} accessibilityLabel="Delete opening budget entry" style={{ padding: 9 }}><MaterialDesignIcons name="delete-outline" size={21} color={colors.danger} /></Pressable>}
            </View>
            {!!item.note && <Text style={{ color: colors.onSurface, fontSize: 13 }}>{item.note}</Text>}
          </View>)}
        </View>
      </ScrollView>
    </View>
  );
}
