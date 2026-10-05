import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useReport } from "@/src/data";
import { Card, ChipRow, Loader, ScreenHeader, StatTile, money } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay, fakeReportProfit, fakeReportNetProfit } from "@/src/utils/finance-display";

// Daily / Weekly / Monthly / Yearly. The keys map to the ranges the offline
// report engine (src/data.ts -> localReport) already understands.
const RANGES = [
  { key: "today", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "year", label: "Yearly" },
] as const;

// Human-readable label describing the period a range covers right now.
function periodLabel(range: string): string {
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
  if (range === "today") {
    return now.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "short", year: "numeric" });
  }
  if (range === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return `${d.toLocaleDateString(undefined, opts)} — ${now.toLocaleDateString(undefined, opts)}`;
  }
  if (range === "month") {
    return now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (range === "year") {
    return String(now.getFullYear());
  }
  return "";
}

export default function Reports() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const fakeFinanceDisplay = useFakeFinanceDisplay();

  const [range, setRange] = useState<string>("today");
  const [date, setDate] = useState("");
  const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? date.trim() : "";
  const selectedRange = exactDate ? `date:${exactDate}` : range;
  const { data, isLoading, refetch, isRefetching } = useReport(selectedRange);

  const label = useMemo(() => exactDate ? new Date(`${exactDate}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "short", year: "numeric" }) : periodLabel(range), [range, exactDate]);
  const netPurchases = data ? (fakeFinanceDisplay ? Number(data.purchase_total ?? 0) * 0.825 : Number(data.purchase_total ?? 0)) : 0;
  const displayGrossProfit = data ? (fakeFinanceDisplay ? fakeReportProfit(data) : Number(data.gross_profit ?? 0)) : 0;
  const displayNetProfit = data ? (fakeFinanceDisplay ? fakeReportNetProfit(data) : Number(data.net_profit ?? 0)) : 0;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="Reports"
        subtitle="Daily · Weekly · Monthly · Yearly"
        topInset={insets.top}
        onBack={() => router.back()}
      />
      <ChipRow options={RANGES as any} value={range} onChange={setRange} testIDPrefix="report-range" />
      <View style={styles.dateFilter}>
        <MaterialDesignIcons name="calendar-search" size={20} color={colors.muted} />
        <TextInput
          style={styles.dateInput}
          value={date}
          onChangeText={setDate}
          placeholder="Exact date: YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
        />
        {date.length > 0 && (
          <Pressable onPress={() => setDate("")} hitSlop={8}>
            <MaterialDesignIcons name="close-circle" size={19} color={colors.muted} />
          </Pressable>
        )}
      </View>
      <Text style={styles.dateHint}>{exactDate ? "Showing the finance statement for this exact date." : "Leave the date empty to use Daily / Weekly / Monthly / Yearly."}</Text>

      {isLoading || !data ? (
        <Loader />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 14 }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />
          }
        >
          {/* Period banner */}
          <View style={styles.periodBanner} testID="report-period">
            <MaterialDesignIcons name="calendar-range" size={18} color={colors.brandPrimary} />
            <Text style={styles.periodText}>{label}</Text>
          </View>

          {/* Headline tiles */}
          <View style={styles.grid}>
            <StatTile label="Sales (net)" value={money(data.revenue)} icon="cart" tone="brand" testID="report-sales" />
            <StatTile label="Purchases" value={money(netPurchases)} icon="truck" tone="warning" testID="report-purchases" />
            <StatTile label="Returns / refunds" value={money(data.returns_total)} icon="cash-refund" tone="error" testID="report-returns" />
            <StatTile label="Expenses" value={money(data.total_expenses)} icon="cash-multiple" tone="info" testID="report-expenses" />
          </View>

          <StatTile
            label="Net profit"
            value={money(displayNetProfit)}
            icon="trending-up"
            tone={displayNetProfit >= 0 ? "success" : "error"}
            testID="report-net-profit"
          />

          {/* Sales */}
          <Card>
            <SectionHead icon="cart" title="Sales" tone={colors.brandPrimary} />
            <Row label="Gross sales" value={money(data.gross_revenue)} />
            <Row label="Less: returns / refunds" value={"- " + money(data.returns_total)} muted />
            <Divider />
            <Row label="Net sales" value={money(data.revenue)} bold tone="brand" />
            <Row label="Transactions" value={String(data.transactions)} muted />
            <Row label="Units sold" value={String(data.units_sold)} muted />
          </Card>

          {/* Purchases */}
          <Card>
            <SectionHead icon="truck" title="Purchases" tone={colors.warning} />
            <Row label="Gross purchases" value={money(fakeFinanceDisplay ? netPurchases : Number(data.purchase_gross ?? data.purchase_total))} />
            <Row label="Less: purchase returns" value={"- " + money(data.purchase_returns_total ?? 0)} muted />
            <Divider />
            <Row label="Net purchases" value={money(netPurchases)} bold tone="warning" />
          </Card>

          {/* Returns & refunds */}
          <Card>
            <SectionHead icon="cash-refund" title="Returns & refunds" tone={colors.error} />
            <Row label="Refund amount" value={money(data.returns_total)} bold tone="error" />
            <Row label="Return transactions" value={String(data.returns_count)} muted />
            <Row label="Purchase returns" value={money(data.purchase_returns_total ?? 0)} muted />
          </Card>

          {/* Expenses */}
          <Card>
            <SectionHead icon="cash-multiple" title="Expenses" tone={colors.info} />
            <Row label="Direct / purchase expenses" value={money(data.cogs_expenses)} />
            <Row label="Operating expenses" value={money(data.operating_expenses)} />
            <Row label="Personal expenses" value={money(data.personal_expenses)} />
            <Divider />
            <Row label="Total expenses" value={money(data.total_expenses)} bold tone="info" />
          </Card>

          {/* Profit */}
          <Card>
            <SectionHead icon="chart-line" title="Profit" tone={colors.success} />
            <Row label="Gross profit" value={money(displayGrossProfit)} />
            <Row label="Less: personal expenses" value={"- " + money(data.personal_expenses)} muted />
            <Divider />
            <Row
              label="Net profit"
              value={money(displayNetProfit)}
              bold
              tone={data.net_profit >= 0 ? "success" : "error"}
            />
          </Card>
        </ScrollView>
      )}
    </View>
  );
}

function SectionHead({ icon, title, tone }: { icon: string; title: string; tone: string }) {
  const styles = useStyles();
  return (
    <View style={styles.sectionHead}>
      <View style={[styles.sectionIcon, { backgroundColor: tone + "1A" }]}>
        <MaterialDesignIcons name={icon as any} size={18} color={tone} />
      </View>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function Row({
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
  tone?: "brand" | "warning" | "info" | "success" | "error";
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const toneColor = tone
    ? { brand: colors.brandPrimary, warning: colors.warning, info: colors.info, success: colors.success, error: colors.error }[tone]
    : colors.onSurface;
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, muted && { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.rowBold, { color: bold ? toneColor : colors.onSurface }]}>{value}</Text>
    </View>
  );
}

function Divider() {
  const styles = useStyles();
  return <View style={styles.divider} />;
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  dateFilter: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 10, paddingHorizontal: 12, height: 46, borderRadius: 12, backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border },
  dateInput: { flex: 1, fontSize: 14, color: colors.onSurface },
  dateHint: { marginHorizontal: 18, marginTop: 5, fontSize: 11, color: colors.muted },
  periodBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.brandTertiary,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  periodText: { fontSize: 14, fontWeight: "700", color: colors.onBrandTertiary },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  sectionIcon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5 },
  rowLabel: { fontSize: 14, color: colors.onSurfaceSecondary, flex: 1, paddingRight: 12 },
  rowValue: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  rowBold: { fontSize: 17, fontWeight: "800" },
  divider: { height: 1, backgroundColor: colors.divider, marginVertical: 6 },
}));
