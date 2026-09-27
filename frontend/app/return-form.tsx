import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useSale, useReturns, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { Field, Loader, PrimaryButton, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function ReturnForm() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { sale_id, return_id } = useLocalSearchParams<{ sale_id: string; return_id?: string }>();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const { data: returnRows } = useReturns();
  const editing = !!return_id && admin;
  const resolvedSaleId = sale_id ?? returnRows?.find((r: any) => r.id === return_id)?.sale_id ?? "";
  const { data: sale, isLoading } = useSale(resolvedSaleId);

  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const existingReturn: any = returnRows?.find((r: any) => r.id === return_id);
  const returnedMap: Record<string, number> = (sale as any)?.returned_items ?? {};

  const rows = useMemo(() => {
    if (!sale) return [];
    return sale.items.map((it) => {
      const already = returnedMap[it.product_id] ?? 0;
      const own = editing ? Number(existingReturn?.items?.find((x: any) => x.product_id === it.product_id)?.quantity ?? 0) : 0;
      const remaining = it.quantity - already + own;
      return { ...it, already, remaining };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale]);

  const refundTotal = rows.reduce((s, r) => {
    const q = Math.min(parseFloat(qtys[r.product_id] || "0") || 0, r.remaining);
    return s + q * r.unit_price;
  }, 0);

  useEffect(() => {
    if (editing && existingReturn) {
      const initial: Record<string,string> = {};
      for (const it of existingReturn.items ?? []) initial[it.product_id] = String(it.quantity);
      setQtys(initial); setReason(existingReturn.reason ?? "");
    }
  }, [editing, existingReturn]);

  const submit = async () => {
    const items = rows
      .map((r) => ({ product_id: r.product_id, quantity: Math.min(parseFloat(qtys[r.product_id] || "0") || 0, r.remaining) }))
      .filter((i) => i.quantity > 0);
    if (!items.length) {
      toast("Enter quantity to return", "error");
      return;
    }
    setBusy(true);
    try {
      await apiRequest(editing ? `/returns/${return_id}` : "/returns", { method: editing ? "PUT" : "POST", body: { sale_id: resolvedSaleId, items, reason: reason.trim() } });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      await queryClient.invalidateQueries({ queryKey: qk.sales });
      await queryClient.invalidateQueries({ queryKey: qk.returns });
      await queryClient.invalidateQueries({ queryKey: qk.sale(resolvedSaleId) });
      toast(editing ? "Return updated" : "Return processed & stock restored", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Return failed", "error");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !sale) return <Loader />;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Return items" subtitle={sale.invoice_no} topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }} bottomOffset={20}>
        <Text style={styles.help}>Choose how many of each item to return. Stock is restored and profit is adjusted automatically.</Text>
        {rows.map((r) => {
          const fullyReturned = r.remaining <= 0;
          return (
            <View key={r.product_id} style={styles.line} testID={`return-line-${r.product_id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{r.name}</Text>
                <Text style={styles.meta}>
                  Sold {r.quantity} · returned {r.already} · {money(r.unit_price)} each
                </Text>
                {fullyReturned && <Text style={styles.done}>Fully returned</Text>}
              </View>
              <TextInput
                testID={`return-qty-${r.product_id}`}
                style={[styles.qtyInput, fullyReturned && { opacity: 0.4 }]}
                editable={!fullyReturned}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor={colors.muted}
                value={qtys[r.product_id] ?? ""}
                onChangeText={(t) => {
                  const v = Math.min(parseFloat(t || "0") || 0, r.remaining);
                  setQtys((prev) => ({ ...prev, [r.product_id]: t === "" ? "" : String(v) }));
                }}
              />
            </View>
          );
        })}

        <Field label="Reason (optional)" testID="return-reason-input" value={reason} onChangeText={setReason} placeholder="e.g. damaged, wrong item" multiline />

        <View style={styles.refundCard}>
          <MaterialDesignIcons name="cash-refund" size={22} color={colors.error} />
          <Text style={styles.refundLabel}>Refund amount</Text>
          <Text style={styles.refundValue}>{money(refundTotal)}</Text>
        </View>

        <PrimaryButton label="Process return" onPress={submit} busy={busy} tone="danger" icon="undo-variant" testID="submit-return-button" />
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  help: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  name: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  done: { fontSize: 12, color: colors.success, fontWeight: "700", marginTop: 2 },
  qtyInput: {
    width: 72,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
    color: colors.onSurface,
  },
  refundCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.error + "12",
    borderRadius: 14,
    padding: 16,
  },
  refundLabel: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.onSurface },
  refundValue: { fontSize: 18, fontWeight: "800", color: colors.error },
}));
