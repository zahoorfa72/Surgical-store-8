import { useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { isAdmin, useAuth } from "@/src/auth";
import { useBudget, useExpenses, qk } from "@/src/data";
import { Expense, ExpenseBucket } from "@/src/models";
import { Badge, ChipRow, ConfirmModal, EmptyState, Loader, ScreenHeader, formatDate, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "operating", label: "Operating" },
  { key: "cogs", label: "Direct (COGS)" },
  { key: "personal", label: "Personal" },
] as const;

function bucketBadge(bucket: ExpenseBucket): { text: string; tone: "warning" | "muted" | "info" } {
  if (bucket === "cogs") return { text: "Direct cost", tone: "warning" };
  if (bucket === "personal") return { text: "Personal", tone: "info" };
  return { text: "Operating", tone: "muted" };
}

export default function Expenses() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth(); const admin = isAdmin(user?.role);

  const [filter, setFilter] = useState<string>("all");
  const bucket = filter === "all" ? undefined : (filter as ExpenseBucket);
  const { data: expenses, isLoading } = useExpenses(bucket);
  const { data: budget } = useBudget();
  const [toDelete, setToDelete] = useState<Expense | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [openingInput, setOpeningInput] = useState("");
  const [savingBudget, setSavingBudget] = useState(false);

  const total = (expenses ?? []).reduce((s, e) => s + e.amount, 0);

  const saveBudget = async () => {
    setSavingBudget(true);
    try {
      await apiRequest("/budget", { method: "PUT", body: { monthly_amount: parseFloat(budgetInput) || 0, opening_amount: parseFloat(openingInput) || 0 } });
      await queryClient.invalidateQueries({ queryKey: qk.budget });
      toast("Budget updated", "success");
      setBudgetOpen(false);
    } catch (e: any) {
      toast(e?.message || "Could not save budget", "error");
    } finally {
      setSavingBudget(false);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await apiRequest(`/expenses/${toDelete.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk.expenses(bucket) });
      await queryClient.invalidateQueries({ queryKey: qk.expenses(undefined) });
      toast("Expense removed", "success");
    } catch (e: any) {
      toast(e?.message || "Delete failed", "error");
    } finally {
      setToDelete(null);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Expenses" subtitle={`Total ${money(total)}`} topInset={insets.top} onBack={() => router.back()} />
      <ChipRow options={FILTERS as any} value={filter} onChange={setFilter} testIDPrefix="expense-filter" />

      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={expenses}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 10 }}
          ListHeaderComponent={
            budget ? (
              <Pressable
                testID="budget-card"
                style={styles.budgetCard}
                onPress={() => { setBudgetInput(String(budget.monthly_amount || "")); setOpeningInput(String(budget.opening_amount || "")); setBudgetOpen(true); }}
              >
                <View style={styles.budgetHead}>
                  <Text style={styles.budgetTitle}>Monthly expense budget</Text>
                  <MaterialDesignIcons name="pencil" size={16} color={colors.brandPrimary} />
                </View>
                {budget.monthly_amount > 0 ? (
                  <>
                    <Text style={styles.budgetNums}>
                      {money(budget.spent_this_month)} <Text style={styles.budgetOf}>of {money(budget.monthly_amount)}</Text>
                    </Text>
                    <View style={styles.budgetBarBg}>
                      <View
                        style={[
                          styles.budgetBarFill,
                          {
                            width: `${Math.min(100, (budget.spent_this_month / budget.monthly_amount) * 100)}%`,
                            backgroundColor: budget.spent_this_month > budget.monthly_amount ? colors.error : colors.brandPrimary,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.budgetNote}>
                      {budget.spent_this_month > budget.monthly_amount
                        ? `Over budget by ${money(budget.spent_this_month - budget.monthly_amount)}`
                        : `${money(budget.monthly_amount - budget.spent_this_month)} left this month`}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.budgetNote}>Tap to set a monthly spending target.</Text>
                )}
              </Pressable>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState icon="cash-multiple" title="No expenses" message="Track rent, salaries, supplies and more." testID="expenses-empty" />
          }
          renderItem={({ item }) => {
            const b = bucketBadge(item.bucket);
            return (
              <View style={styles.row} testID={`expense-row-${item.id}`}>
                <View style={styles.iconBox}>
                  <MaterialDesignIcons name="cash-minus" size={22} color={colors.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{item.title}</Text>
                  <Text style={styles.meta}>{item.category} · {formatDate(item.created_at)}</Text>
                  <View style={{ marginTop: 4, flexDirection: "row" }}>
                    <Badge text={b.text} tone={b.tone} />
                  </View>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.amount}>{money(item.amount)}</Text>
                  {admin && <Pressable testID={`edit-expense-${item.id}`} hitSlop={8} onPress={() => router.push(`/expense-form?id=${item.id}`)}><MaterialDesignIcons name="pencil" size={20} color={colors.brandPrimary} /></Pressable>}
                  {admin && <Pressable testID={`delete-expense-${item.id}`} hitSlop={8} onPress={() => setToDelete(item)}>
                    <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} />
                  </Pressable>}
                </View>
              </View>
            );
          }}
        />
      )}

      <Pressable testID="add-expense-fab" style={[styles.fab, { bottom: 16 }]} onPress={() => router.push("/expense-form")}>
        <MaterialDesignIcons name="plus" size={28} color={colors.onBrandPrimary} />
      </Pressable>

      <ConfirmModal
        visible={!!toDelete}
        title="Remove expense?"
        message={`"${toDelete?.title}" will be removed.`}
        confirmLabel="Remove"
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />

      <Modal visible={budgetOpen} transparent animationType="fade" onRequestClose={() => setBudgetOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Store budget</Text>
            <Text style={styles.modalSub}>Set the monthly expense target and the opening purchase budget. Purchases use the opening amount.</Text>
            <Text style={styles.inputLabel}>Opening purchase budget</Text>
            <TextInput testID="opening-budget-input" style={styles.modalInput} keyboardType="numeric" value={openingInput} onChangeText={setOpeningInput} placeholder="0" placeholderTextColor={colors.muted} />
            <Text style={styles.inputLabel}>Monthly expense budget</Text>
            <TextInput
              testID="budget-input"
              style={styles.modalInput}
              keyboardType="numeric"
              value={budgetInput}
              onChangeText={setBudgetInput}
              placeholder="0"
              placeholderTextColor={colors.muted}
            />
            <View style={styles.modalActions}>
              <Pressable testID="budget-cancel" style={styles.modalBtnGhost} onPress={() => setBudgetOpen(false)}>
                <Text style={styles.modalBtnGhostText}>Cancel</Text>
              </Pressable>
              <Pressable testID="budget-save" style={styles.modalBtn} onPress={saveBudget} disabled={savingBudget}>
                <Text style={styles.modalBtnText}>{savingBudget ? "Saving…" : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.warning + "1A",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  rowRight: { alignItems: "flex-end", gap: 8 },
  amount: { fontSize: 16, fontWeight: "800", color: colors.onSurface },
  fab: {
    position: "absolute",
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  budgetCard: {
    backgroundColor: colors.brandTertiary,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
    padding: 16,
    gap: 8,
    marginBottom: 4,
  },
  budgetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  budgetTitle: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  inputLabel: { fontSize: 12, fontWeight: "700", color: colors.onSurfaceSecondary, marginTop: 4 },
  budgetNums: { fontSize: 22, fontWeight: "800", color: colors.onSurface },
  budgetOf: { fontSize: 14, fontWeight: "600", color: colors.onSurfaceSecondary },
  budgetBarBg: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  budgetBarFill: { height: 8, borderRadius: 4 },
  budgetNote: { fontSize: 12, color: colors.onSurfaceSecondary },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 380, backgroundColor: colors.surface, borderRadius: 18, padding: 20, gap: 12 },
  modalTitle: { fontSize: 17, fontWeight: "800", color: colors.onSurface },
  modalSub: { fontSize: 13, color: colors.onSurfaceSecondary },
  modalInput: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    height: 50,
    fontSize: 18,
    fontWeight: "700",
    color: colors.onSurface,
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtnGhost: { flex: 1, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  modalBtnGhostText: { fontSize: 15, fontWeight: "700", color: colors.onSurfaceSecondary },
  modalBtn: { flex: 1, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandPrimary },
  modalBtnText: { fontSize: 15, fontWeight: "800", color: colors.onBrandPrimary },
}));
