import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth } from "@/src/auth";
import { useDayClose, useReport } from "@/src/data";
import { Badge, Card, ChipRow, IconButton, Loader, ScreenHeader, StatTile, money } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "all", label: "All Time" },
] as const;

export default function Dashboard() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const cashier = user?.role === "cashier";

  const [range, setRange] = useState<string>("today");
  const { data, isLoading, refetch, isRefetching } = useReport(range, !cashier);
  const { data: dayClose, isLoading: dayCloseLoading, refetch: refetchDayClose, isRefetching: dayCloseRefreshing } = useDayClose(range);

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={`Hi, ${user?.name?.split(" ")[0] ?? "there"}`}
        subtitle="Business overview"
        topInset={insets.top}
        right={<IconButton name="cog" testID="settings-button" onPress={() => router.push("/settings")} />}
      />
      <ChipRow options={RANGES as any} value={range} onChange={setRange} testIDPrefix="range" />

      {cashier ? (
        dayCloseLoading || !dayClose ? <Loader /> : (
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
            refreshControl={<RefreshControl refreshing={dayCloseRefreshing} onRefresh={refetchDayClose} tintColor={colors.brandPrimary} />}
          >
            <Card>
              <Text style={styles.cardTitle}>Cashier overview</Text>
              <Text style={styles.cashierGreeting}>Your {range === "today" ? "today" : range} activity</Text>
              <View style={styles.grid}>
                <StatTile label="Sales" value={String(dayClose.me.transactions)} icon="receipt" tone="brand" />
                <StatTile label="Units" value={String(dayClose.me.units)} icon="cube-outline" tone="info" />
                <StatTile label="Sales total" value={money(dayClose.me.gross_sales)} icon="cash" tone="success" />
                <StatTile label="Discount" value={money(dayClose.me.discount)} icon="tag-outline" tone="muted" />
              </View>
            </Card>
            <View style={styles.quickGrid}>
              <Pressable style={styles.quickBtn} onPress={() => router.push("/(tabs)/sell")}><MaterialDesignIcons name="cart-plus" size={22} color={colors.brandPrimary} /><Text style={styles.quickText}>New sale</Text></Pressable>
              <Pressable style={styles.quickBtn} onPress={() => router.push("/sales-history")}><MaterialDesignIcons name="receipt-text" size={22} color={colors.brandPrimary} /><Text style={styles.quickText}>My receipts</Text></Pressable>
              <Pressable style={styles.quickBtn} onPress={() => router.push("/backup-restore")}><MaterialDesignIcons name="backup-restore" size={22} color={colors.brandPrimary} /><Text style={styles.quickText}>Backup / Restore</Text></Pressable>
              <Pressable style={styles.quickBtn} onPress={() => router.push("/day-close")}><MaterialDesignIcons name="chart-box-outline" size={22} color={colors.brandPrimary} /><Text style={styles.quickText}>My day close</Text></Pressable>
            </View>
            <Card>
              <Text style={styles.cardTitle}>Cashier permissions</Text>
              <Text style={styles.permissionText}>You can create sales, reprint receipts, edit your own sales, and use backup/restore. Store-wide finance and other cashiers' records remain protected.</Text>
            </Card>
          </ScrollView>
        )
      ) : isLoading || !data ? (
        <Loader />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />}
        >
          <View style={styles.grid}>
            <StatTile label="Revenue" value={money(data.revenue)} icon="cash" tone="brand" testID="stat-revenue" />
            <StatTile label="Net Profit" value={money(data.net_profit)} icon="trending-up" tone="success" testID="stat-net-profit" />
            <StatTile label="Gross Profit" value={money(data.gross_profit)} icon="chart-line" tone="info" />
            <StatTile
              label="Remaining Balance"
              value={money(data.remaining_balance)}
              icon="wallet"
              tone={data.remaining_balance >= 0 ? "success" : "error"}
              testID="stat-remaining-balance"
            />
            <StatTile label="Transactions" value={String(data.transactions)} icon="receipt" tone="muted" />
          </View>

          {/* Profit & loss breakdown */}
          <Card>
            <Text style={styles.cardTitle}>Profit breakdown</Text>
            <PLRow label="Gross sales" value={money(data.gross_revenue)} />
            <PLRow label="Returns / refunds" value={"- " + money(data.returns_total)} muted />
            <PLRow label="Net sales" value={money(data.revenue)} />
            <PLRow label="Inventory purchase (goods sold)" value={"- " + money(data.cogs_goods)} muted />
            <View style={styles.plDivider} />
            <PLRow label="Gross profit" value={money(data.gross_profit)} bold tone="info" />
            <PLRow label="Personal expenses" value={"- " + money(data.personal_expenses)} muted />
            <View style={styles.plDivider} />
            <PLRow label="Net profit" value={money(data.net_profit)} bold tone={data.net_profit >= 0 ? "success" : "error"} />
          </Card>

          {/* Remaining balance (cash) */}
          <Card>
            <Text style={styles.cardTitle}>Remaining balance</Text>
            <PLRow label="Net sales" value={money(data.revenue)} />
            <PLRow label="Supplier payments (paid out)" value={"- " + money(data.supplier_payments)} muted />
            <PLRow label="Operating expenses" value={"- " + money(data.operating_expenses)} muted />
            <PLRow label="Direct / purchase expenses" value={"- " + money(data.cogs_expenses)} muted />
            <View style={styles.plDivider} />
            <PLRow
              label="Remaining balance"
              value={money(data.remaining_balance)}
              bold
              tone={data.remaining_balance >= 0 ? "success" : "error"}
            />
            <Text style={styles.balanceHint}>Personal expenses are not deducted from balance.</Text>
          </Card>

          {/* Cash & payments */}
          <Card>
            <Text style={styles.cardTitle}>Cash & payments</Text>
            <PLRow label="Cash received from customers" value={money(data.customer_receipts)} />
            <PLRow label="Paid to suppliers" value={"- " + money(data.supplier_payments)} muted />
          </Card>

          <View style={styles.grid}>
            <StatTile label="Units sold" value={String(data.units_sold)} icon="cube-outline" tone="brand" />
            <StatTile label="Purchases" value={money(data.purchase_total)} icon="truck" tone="warning" />
            <StatTile label="Inventory value" value={money(data.inventory_value)} icon="warehouse" tone="info" />
            <StatTile label="Products" value={String(data.product_count)} icon="package-variant-closed" tone="muted" />
          </View>

          {/* Low stock */}
          <Card>
            <View style={styles.lowHead}>
              <Text style={styles.cardTitle}>Low stock alerts</Text>
              <Badge text={`${data.low_stock.length}`} tone={data.low_stock.length ? "warning" : "success"} />
            </View>
            {data.low_stock.length === 0 ? (
              <Text style={styles.okText}>All products are well stocked.</Text>
            ) : (
              data.low_stock.map((p) => (
                <View key={p.id} style={styles.lowRow}>
                  <MaterialDesignIcons name="alert-circle" size={18} color={colors.warning} />
                  <Text style={styles.lowName}>{p.name}</Text>
                  <Text style={styles.lowQty}>{p.quantity} left</Text>
                </View>
              ))
            )}
          </Card>
        </ScrollView>
      )}
    </View>
  );
}

function PLRow({
  label,
  value,
  bold,
  muted,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  tone?: "info" | "success" | "error";
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color = tone ? { info: colors.info, success: colors.success, error: colors.error }[tone] : colors.onSurface;
  return (
    <View style={styles.plRow}>
      <Text style={[styles.plLabel, muted && { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.plValue, bold && styles.plBold, { color: bold ? color : colors.onSurface }]}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cardTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface, marginBottom: 10 },
  cashierGreeting: { fontSize: 13, color: colors.muted, marginBottom: 12 },
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  quickBtn: { width: "48%", minHeight: 78, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, justifyContent: "center", gap: 7 },
  quickText: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  permissionText: { fontSize: 13, lineHeight: 19, color: colors.onSurfaceSecondary },
  plRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  plLabel: { fontSize: 14, color: colors.onSurfaceSecondary },
  plValue: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  plBold: { fontSize: 17, fontWeight: "800" },
  plDivider: { height: 1, backgroundColor: colors.divider, marginVertical: 6 },
  lowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  okText: { fontSize: 14, color: colors.muted },
  balanceHint: { fontSize: 12, color: colors.muted, marginTop: 8, fontStyle: "italic" },
  lowRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  lowName: { flex: 1, fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  lowQty: { fontSize: 13, color: colors.warning, fontWeight: "700" },
}));
