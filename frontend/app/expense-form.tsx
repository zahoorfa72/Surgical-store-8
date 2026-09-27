import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useExpenses, qk } from "@/src/data";
import { EXPENSE_CATEGORIES, ExpenseBucket } from "@/src/models";
import { Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function ExpenseForm() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = !!id;
  const { data: expenses } = useExpenses();

  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [bucket, setBucket] = useState<ExpenseBucket>("operating");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing && expenses) {
      const e = expenses.find(x => x.id === id);
      if (e) { setTitle(e.title); setAmount(String(e.amount)); setCategory(e.category); setBucket(e.bucket); setNote(e.note); }
    }
  }, [editing, id, expenses]);

  const save = async () => {
    if (!title.trim()) return toast("Enter a title", "error");
    if (!(parseFloat(amount) > 0)) return toast("Enter a valid amount", "error");
    setBusy(true);
    try {
      await apiRequest(editing ? `/expenses/${id}` : "/expenses", {
        method: editing ? "PUT" : "POST",
        body: { title: title.trim(), category, bucket, amount: parseFloat(amount), note: note.trim() },
      });
      await queryClient.invalidateQueries({ queryKey: qk.expenses(undefined) });
      await queryClient.invalidateQueries({ queryKey: qk.expenses(bucket) });
      toast(editing ? "Expense updated" : "Expense added", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title={editing ? "Edit expense" : "New expense"} topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 18 }} bottomOffset={20}>
        <Field label="Title" testID="expense-title-input" value={title} onChangeText={setTitle} placeholder="e.g. Monthly rent" />
        <Field label="Amount" testID="expense-amount-input" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="0" />

        <View style={{ gap: 8 }}>
          <Text style={styles.label}>Expense type</Text>
          <View style={styles.bucketRow}>
            <BucketOption
              active={bucket === "operating"}
              title="Operating"
              desc="Cut from net profit"
              onPress={() => setBucket("operating")}
              testID="bucket-operating"
            />
            <BucketOption
              active={bucket === "cogs"}
              title="Direct (COGS)"
              desc="Cut from net profit"
              onPress={() => setBucket("cogs")}
              testID="bucket-cogs"
            />
            <BucketOption
              active={bucket === "personal"}
              title="Personal exp"
              desc="Cut from gross profit"
              onPress={() => setBucket("personal")}
              testID="bucket-personal"
            />
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={styles.label}>Category</Text>
          <View style={styles.catWrap}>
            {EXPENSE_CATEGORIES.map((c) => {
              const active = c === category;
              return (
                <Pressable
                  key={c}
                  testID={`category-${c}`}
                  style={[styles.cat, active ? styles.catActive : styles.catIdle]}
                  onPress={() => setCategory(c)}
                >
                  <Text style={active ? styles.catTextActive : styles.catText}>{c}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Field label="Note" testID="expense-note-input" value={note} onChangeText={setNote} placeholder="Optional" multiline />
        <PrimaryButton label={editing ? "Save changes" : "Add expense"} onPress={save} busy={busy} testID="save-expense-button" />
      </KeyboardAwareScrollView>
    </View>
  );
}

function BucketOption({
  active,
  title,
  desc,
  onPress,
  testID,
}: {
  active: boolean;
  title: string;
  desc: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} style={[styles.bucket, active ? styles.bucketActive : styles.bucketIdle]} onPress={onPress}>
      <View style={styles.bucketHead}>
        <MaterialDesignIcons
          name={active ? "radiobox-marked" : "radiobox-blank"}
          size={20}
          color={active ? colors.brandPrimary : colors.muted}
        />
        <Text style={styles.bucketTitle}>{title}</Text>
      </View>
      <Text style={styles.bucketDesc}>{desc}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  label: { fontSize: 13, fontWeight: "600", color: colors.onSurfaceSecondary },
  bucketRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  bucket: { flexGrow: 1, flexBasis: "30%", minWidth: 100, borderRadius: 14, borderWidth: 1.5, padding: 12, gap: 6 },
  bucketIdle: { borderColor: colors.border, backgroundColor: colors.surface },
  bucketActive: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  bucketHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  bucketTitle: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  bucketDesc: { fontSize: 12, color: colors.muted, lineHeight: 16 },
  catWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cat: { paddingHorizontal: 14, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  catIdle: { backgroundColor: colors.surface, borderColor: colors.border },
  catActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  catText: { fontSize: 13, fontWeight: "600", color: colors.onSurfaceSecondary },
  catTextActive: { fontSize: 13, fontWeight: "700", color: colors.onBrandPrimary },
}));
