import { useEffect, useState } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth } from "@/src/auth";
import { useDayClose, useReport, useSales, usePayments, useExpenses, useReturns } from "@/src/data";
import { Badge, Card, ChipRow, IconButton, Loader, ScreenHeader, StatTile, money } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { useFakeFinanceDisplay, fakeReportProfit, fakeReportNetProfit, getFinanceDetailDrilldown } from "@/src/utils/finance-display";

const displayFinanceAmount = (value: unknown, fake: boolean) => {
  const amount = Number(value ?? 0) || 0;
  return fake ? amount * 0.825 : amount;
};


function isoToDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? m[3] + "-" + m[2] + "-" + m[1] : "";
}

function displayToIso(value: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!m) return "";
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (d.getFullYear() !== Number(m[3]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[1])) return "";
  return m[3] + "-" + m[2] + "-" + m[1];
}

function DateCalendarModal({ visible, initialIso, mode, onSelect, onClose }: { visible: boolean; initialIso: string; mode: "day" | "month" | "year"; onSelect: (iso: string) => void; onClose: () => void }) {
  const { colors } = useTheme();
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(initialIso) ? new Date(initialIso + "T12:00:00") : new Date();
  const [cursor, setCursor] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  useEffect(() => { if (visible) { const d = /^\d{4}-\d{2}-\d{2}$/.test(initialIso) ? new Date(initialIso + "T12:00:00") : new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); } }, [visible, initialIso]);
  if (!visible) return null;
  const y = cursor.getFullYear(); const m = cursor.getMonth(); const days = new Date(y, m + 1, 0).getDate(); const first = new Date(y, m, 1).getDay();
  const cells = Array.from({ length: first + days }, (_, i) => i < first ? null : i - first + 1);
  const choose = (day: number) => { const iso = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0"); onSelect(iso); onClose(); };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 20 }}>
        <Pressable onPress={(e) => e.stopPropagation()} style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 18 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <Pressable onPress={() => setCursor(new Date(y, m - 1, 1))} style={{ padding: 8 }}><MaterialDesignIcons name="chevron-left" size={26} color={colors.brandPrimary} /></Pressable>
            <Text style={{ fontSize: 18, fontWeight: "900", color: colors.onSurface }}>{cursor.toLocaleString(undefined, { month: "long", year: "numeric" })}</Text>
            <Pressable onPress={() => setCursor(new Date(y, m + 1, 1))} style={{ padding: 8 }}><MaterialDesignIcons name="chevron-right" size={26} color={colors.brandPrimary} /></Pressable>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => <Text key={d} style={{ width: "14.2857%", textAlign: "center", fontSize: 11, fontWeight: "800", color: colors.muted, paddingVertical: 6 }}>{d}</Text>)}
            {cells.map((day, i) => day == null ? <View key={"b" + i} style={{ width: "14.2857%", aspectRatio: 1 }} /> : <Pressable key={day} onPress={() => choose(day)} style={{ width: "14.2857%", aspectRatio: 1, alignItems: "center", justifyContent: "center" }}><Text style={{ fontSize: 14, fontWeight: "800", color: colors.onSurface }}>{day}</Text></Pressable>)}
          </View>
          {mode !== "day" && <Text style={{ textAlign: "center", marginTop: 10, color: colors.muted, fontSize: 11 }}>Tap any date to select the {mode}.</Text>}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
const RANGES = [
  { key: "day", label: "Day" },
  { key: "week", label: "This Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "custom", label: "From / To" },
  { key: "all", label: "All Time" },
] as const;

export default function Dashboard() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const fakeFinanceDisplay = useFakeFinanceDisplay();
  const { user } = useAuth();
  const cashier = user?.role === "cashier";

  const now = new Date();
  const localDay = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const localMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const localYear = String(now.getFullYear());
  const [range, setRange] = useState<string>("day");
  const [date, setDate] = useState(isoToDisplay(localDay));
  const [month, setMonth] = useState(String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getFullYear()));
  const [year, setYear] = useState(localYear);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [calendarTarget, setCalendarTarget] = useState<"day" | "month" | "year" | "from" | "to" | null>(null);
  const [financeDetailsOpen, setFinanceDetailsOpen] = useState<"revenue" | "net" | "balance" | null>(null);
  const [financeDetailDrilldown, setFinanceDetailDrilldown] = useState(true);
  const exactDate = displayToIso(date);
  const monthMatch = /^(\d{2})-(\d{4})$/.exec(month.trim());
  const validMonth = monthMatch && Number(monthMatch[1]) >= 1 && Number(monthMatch[1]) <= 12 ? monthMatch[2] + "-" + monthMatch[1] : "";
  const validYear = /^\d{4}$/.test(year.trim()) ? year.trim() : "";
  const validFrom = displayToIso(fromDate);
  const validTo = displayToIso(toDate);
  const reportRange = range === "day" && exactDate ? "date:" + exactDate : range === "month" && validMonth ? "month:" + validMonth : range === "year" && validYear ? "year:" + validYear : range === "custom" && validFrom && validTo ? "date-range:" + validFrom + ":" + validTo : range === "day" ? "today" : range;
  const { data, isLoading, refetch, isRefetching } = useReport(reportRange, !cashier);
  const { data: dayClose, isLoading: dayCloseLoading, refetch: refetchDayClose, isRefetching: dayCloseRefreshing } = useDayClose(range);
  const { data: sales = [] } = useSales();
  const { data: payments = [] } = usePayments();
  const { data: expenses = [] } = useExpenses();
  const { data: returns = [] } = useReturns();
  useEffect(() => { void getFinanceDetailDrilldown().then(setFinanceDetailDrilldown); }, []);

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={`Hi, ${user?.name?.split(" ")[0] ?? "there"}`}
        subtitle="Business overview"
        topInset={insets.top}
        right={<IconButton name="cog" testID="settings-button" onPress={() => router.push("/settings")} />}
      />
      <ChipRow options={RANGES as any} value={range} onChange={(value) => setRange(value)} testIDPrefix="range" />
      {range === "day" && (
        <Pressable testID="finance-day-input" style={styles.dateFilter} onPress={() => setCalendarTarget("day")}>
          <MaterialDesignIcons name="calendar" size={20} color={colors.brandPrimary} /><Text style={styles.dateValue}>{date || "DD-MM-YYYY"}</Text><MaterialDesignIcons name="chevron-down" size={20} color={colors.muted} />
        </Pressable>
      )}
      {range === "month" && (
        <Pressable testID="finance-month-input" style={styles.dateFilter} onPress={() => setCalendarTarget("month")}>
          <MaterialDesignIcons name="calendar-month" size={20} color={colors.brandPrimary} /><Text style={styles.dateValue}>{month || "MM-YYYY"}</Text><MaterialDesignIcons name="chevron-down" size={20} color={colors.muted} />
        </Pressable>
      )}
      {range === "year" && (
        <Pressable testID="finance-year-input" style={styles.dateFilter} onPress={() => setCalendarTarget("year")}>
          <MaterialDesignIcons name="calendar-range" size={20} color={colors.brandPrimary} /><Text style={styles.dateValue}>{year || "YYYY"}</Text><MaterialDesignIcons name="chevron-down" size={20} color={colors.muted} />
        </Pressable>
      )}
      {range === "custom" && (
        <View style={styles.customDateRow}>
          <View style={[styles.dateFilter, styles.customDateBox]}>
            <Pressable testID="finance-from-date" style={styles.dateFilter} onPress={() => setCalendarTarget("from")}><MaterialDesignIcons name="calendar" size={18} color={colors.brandPrimary} /><Text style={styles.dateValue}>{fromDate || "DD-MM-YYYY"}</Text></Pressable>
          </View>
          <View style={[styles.dateFilter, styles.customDateBox]}>
            <Pressable testID="finance-to-date" style={styles.dateFilter} onPress={() => setCalendarTarget("to")}><MaterialDesignIcons name="calendar" size={18} color={colors.brandPrimary} /><Text style={styles.dateValue}>{toDate || "DD-MM-YYYY"}</Text></Pressable>
          </View>
        </View>
      )}
      {range === "day" && !!date && !exactDate && <Text style={styles.dateHint}>Enter a valid day as YYYY-MM-DD.</Text>}
      {range === "month" && !!month && !validMonth && <Text style={styles.dateHint}>Select a valid month.</Text>}
      {range === "year" && !!year && !validYear && <Text style={styles.dateHint}>Select a valid year.</Text>}
      {range === "custom" && (!!fromDate || !!toDate) && (!validFrom || !validTo) && <Text style={styles.dateHint}>Select both dates from the calendar.</Text>}
      <DateCalendarModal visible={!!calendarTarget} mode={calendarTarget === "month" ? "month" : calendarTarget === "year" ? "year" : "day"} initialIso={calendarTarget === "from" ? (validFrom || exactDate || localDay) : calendarTarget === "to" ? (validTo || validFrom || exactDate || localDay) : exactDate || localDay} onClose={() => setCalendarTarget(null)} onSelect={(iso) => { if (calendarTarget === "day") setDate(isoToDisplay(iso)); else if (calendarTarget === "month") setMonth(iso.slice(5, 7) + "-" + iso.slice(0, 4)); else if (calendarTarget === "year") setYear(iso.slice(0, 4)); else if (calendarTarget === "from") setFromDate(isoToDisplay(iso)); else if (calendarTarget === "to") setToDate(isoToDisplay(iso)); }} />

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
          <View style={styles.financeGrid}>
            <Pressable disabled={!financeDetailDrilldown} onPress={() => setFinanceDetailsOpen("revenue")} style={styles.statPressable}><StatTile label="Revenue" value={money(data.revenue)} icon="cash" tone="brand" testID="stat-revenue" /></Pressable>
            <Pressable disabled={!financeDetailDrilldown} onPress={() => setFinanceDetailsOpen("net")} style={styles.statPressable}><StatTile label="Net Profit" value={money(fakeFinanceDisplay ? fakeReportNetProfit(data) : data.net_profit)} icon="trending-up" tone="success" testID="stat-net-profit" /></Pressable>
            <StatTile label="Gross Profit" value={money(fakeFinanceDisplay ? fakeReportProfit(data) : data.gross_profit)} icon="chart-line" tone="info" />
            <Pressable disabled={!financeDetailDrilldown} onPress={() => setFinanceDetailsOpen("balance")} style={styles.statPressable}><StatTile label="Remaining Balance" value={money(data.remaining_balance)} icon="wallet" tone={data.remaining_balance >= 0 ? "success" : "error"} testID="stat-remaining-balance" /></Pressable>
            <StatTile label="Transactions" value={String(data.transactions)} icon="receipt" tone="muted" />
          </View>

          <Modal visible={!!financeDetailsOpen} animationType="slide" onRequestClose={() => setFinanceDetailsOpen(null)}>
            <View style={styles.root}>
              <ScreenHeader title={financeDetailsOpen === "revenue" ? "Revenue details" : financeDetailsOpen === "net" ? "Net profit details" : "Remaining balance details"} subtitle="Complete money in / money out" topInset={insets.top} onBack={() => setFinanceDetailsOpen(null)} />
              <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, gap: 12 }}>
                {financeDetailsOpen === "revenue" && (
                  <Card>
                    <Text style={styles.detailHeader}>Revenue & returns</Text>
                    {sales.map((s: any) => (
                      <View key={s.id} style={styles.detailLine}>
                        <Text style={styles.detailLabel}>{s.invoice_no} · {s.customer_name || "Walk-in"}{"\n"}{new Date(s.created_at).toLocaleString()}</Text>
                        <Text style={styles.detailValue}>{money(displayFinanceAmount(s.total, fakeFinanceDisplay))}</Text>
                      </View>
                    ))}
                    {returns.map((r: any) => (
                      <View key={"r" + r.id} style={styles.detailLine}>
                        <Text style={styles.detailLabel}>Return · {r.invoice_no}</Text>
                        <Text style={styles.detailOut}>-{money(displayFinanceAmount(r.refund_total, fakeFinanceDisplay))}</Text>
                      </View>
                    ))}
                  </Card>
                )}
                {financeDetailsOpen === "net" && (
                  <Card>
                    <Text style={styles.detailHeader}>Profit details</Text>
                    {sales.map((s: any) => {
                      const fakeProfit = fakeReportProfit({ revenue: s.total });
                      const fakeCogs = Math.max(0, Number(s.total || 0) - fakeProfit);
                      return (
                        <View key={s.id} style={styles.detailLine}>
                          <Text style={styles.detailLabel}>{s.invoice_no} · Revenue {money(displayFinanceAmount(s.total, fakeFinanceDisplay))} · COGS {money(fakeFinanceDisplay ? fakeCogs : s.cogs)}</Text>
                          <Text style={styles.detailValue}>{money(fakeFinanceDisplay ? fakeProfit : s.profit)}</Text>
                        </View>
                      );
                    })}
                    {expenses.map((e: any) => (
                      <View key={e.id} style={styles.detailLine}>
                        <Text style={styles.detailLabel}>{e.title} · {e.bucket}</Text>
                        <Text style={styles.detailOut}>-{money(displayFinanceAmount(e.amount, fakeFinanceDisplay))}</Text>
                      </View>
                    ))}
                  </Card>
                )}
                {financeDetailsOpen === "balance" && (
                  <>
                    <Card>
                      <Text style={styles.detailHeader}>Money in</Text>
                      {sales.filter((s: any) => !s.credit).map((s: any) => (
                        <View key={s.id} style={styles.detailLine}>
                          <Text style={styles.detailLabel}>{s.invoice_no} · Customer sale</Text>
                          <Text style={styles.detailValue}>+{money(displayFinanceAmount(s.total, fakeFinanceDisplay))}</Text>
                        </View>
                      ))}
                      {payments.filter((p: any) => p.kind === "receive" || p.kind === "supplier_refund").map((p: any) => (
                        <View key={p.id} style={styles.detailLine}>
                          <Text style={styles.detailLabel}>{p.party_name} · {p.kind}</Text>
                          <Text style={styles.detailValue}>+{money(displayFinanceAmount(p.amount, fakeFinanceDisplay))}</Text>
                        </View>
                      ))}
                    </Card>
                    <Card>
                      <Text style={styles.detailHeader}>Money out</Text>
                      {payments.filter((p: any) => p.kind === "pay" || p.kind === "customer_refund").map((p: any) => (
                        <View key={p.id} style={styles.detailLine}>
                          <Text style={styles.detailLabel}>{p.party_name} · {p.kind}</Text>
                          <Text style={styles.detailOut}>-{money(displayFinanceAmount(p.amount, fakeFinanceDisplay))}</Text>
                        </View>
                      ))}
                      {expenses.filter((e: any) => e.bucket === "cogs" || e.bucket === "operating").map((e: any) => (
                        <View key={e.id} style={styles.detailLine}>
                          <Text style={styles.detailLabel}>{e.title} · {e.bucket}</Text>
                          <Text style={styles.detailOut}>-{money(displayFinanceAmount(e.amount, fakeFinanceDisplay))}</Text>
                        </View>
                      ))}
                    </Card>
                    <Card>
                      <Text style={styles.detailHeader}>Remaining balance</Text>
                      <Text style={styles.detailBig}>{money(displayFinanceAmount(data.remaining_balance, fakeFinanceDisplay))}</Text>
                    </Card>
                  </>
                )}
              </ScrollView>
            </View>
          </Modal>

          <Card>
            <View style={styles.chartHeader}>
              <View>
                <Text style={styles.cardTitle}>Finance chart</Text>
                <Text style={styles.chartSub}>Quick view for {range === "day" ? (exactDate || "selected day") : range === "month" ? (validMonth || "selected month") : range === "year" ? (validYear || "selected year") : range === "custom" ? (validFrom && validTo ? validFrom + " to " + validTo : "selected dates") : range === "all" ? "all time" : range}</Text>
              </View>
              <MaterialDesignIcons name="chart-bar" size={22} color={colors.brandPrimary} />
            </View>
            {[
              { label: "Revenue", value: Number(data.revenue ?? 0), tone: colors.brandPrimary },
              { label: "Gross Profit", value: Number(fakeFinanceDisplay ? fakeReportProfit(data) : data.gross_profit ?? 0), tone: colors.info },
              { label: "Net Profit", value: Number(fakeFinanceDisplay ? fakeReportNetProfit(data) : data.net_profit ?? 0), tone: colors.success },
              { label: "Remaining Balance", value: Number(data.remaining_balance ?? 0), tone: data.remaining_balance >= 0 ? colors.success : colors.error },
            ].map((item) => {
              const max = Math.max(1, Math.abs(Number(data.revenue ?? 0)), Math.abs(Number(data.gross_profit ?? 0)), Math.abs(Number(data.net_profit ?? 0)), Math.abs(Number(data.remaining_balance ?? 0)));
              const width = Math.max(3, Math.min(100, Math.abs(item.value) / max * 100));
              return (
                <View key={item.label} style={styles.chartRow}>
                  <View style={styles.chartLabelRow}>
                    <Text style={styles.chartLabel}>{item.label}</Text>
                    <Text style={[styles.chartValue, item.value < 0 && { color: colors.error }]}>{money(item.value)}</Text>
                  </View>
                  <View style={styles.chartTrack}>
                    <View style={[styles.chartBar, { width: `${width}%`, backgroundColor: item.tone }]} />
                  </View>
                </View>
              );
            })}
          </Card>
          {/* Profit & loss breakdown */}
          <Card>
            <Text style={styles.cardTitle}>Profit breakdown</Text>
            <PLRow label="Gross sales" value={money(data.gross_revenue)} />
            <PLRow label="Returns / refunds" value={"- " + money(data.returns_total)} muted />
            <PLRow label="Net sales" value={money(data.revenue)} />
            <PLRow label="Inventory purchase (goods sold)" value={"- " + money(data.cogs_goods)} muted />
            <View style={styles.plDivider} />
            <PLRow label="Gross profit" value={money(fakeFinanceDisplay ? fakeReportProfit(data) : data.gross_profit)} bold tone="info" />
            <PLRow label="Personal expenses" value={"- " + money(data.personal_expenses)} muted />
            <View style={styles.plDivider} />
            <PLRow label="Net profit" value={money(fakeFinanceDisplay ? fakeReportNetProfit(data) : data.net_profit)} bold tone={(fakeFinanceDisplay ? fakeReportNetProfit(data) : data.net_profit) >= 0 ? "success" : "error"} />
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
            <StatTile label="Purchases" value={money(fakeFinanceDisplay ? Number(data.purchase_total ?? 0) * 0.825 : data.purchase_total)} icon="truck" tone="warning" />
            <StatTile label="Inventory value" value={money(fakeFinanceDisplay ? Number(data.inventory_value ?? 0) * 0.825 : data.inventory_value)} icon="warehouse" tone="info" />
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
  financeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statPressable: { width: "48%", flexGrow: 0, flexShrink: 1 },
  detailHeader: { fontSize: 16, fontWeight: "900", color: colors.onSurface, marginBottom: 8 },
  detailLine: { flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.divider },
  detailLabel: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.onSurfaceSecondary },
  detailValue: { fontSize: 13, fontWeight: "800", color: colors.success },
  detailOut: { fontSize: 13, fontWeight: "800", color: colors.error },
  detailBig: { fontSize: 28, fontWeight: "900", color: colors.brandPrimary },
  dateFilter: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 14, height: 46, borderRadius: 12, backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border },
  dateInput: { flex: 1, fontSize: 14, color: colors.onSurface },
  clearDate: { color: colors.brandPrimary, fontWeight: "800", fontSize: 12 },
  dateHint: { marginHorizontal: 18, marginTop: 5, fontSize: 11, color: colors.warning },
  dateValue: { flex: 1, fontSize: 15, fontWeight: "800", color: colors.onSurface },
  customDateRow: { flexDirection: "row", gap: 8, marginHorizontal: 16 },
  customDateBox: { flex: 1, marginHorizontal: 0 },
  cardTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface, marginBottom: 10 },
  chartHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  chartSub: { fontSize: 12, color: colors.muted, marginTop: -6, marginBottom: 8 },
  chartRow: { gap: 5, marginBottom: 10 },
  chartLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  chartLabel: { fontSize: 12, fontWeight: "700", color: colors.onSurfaceSecondary },
  chartValue: { fontSize: 12, fontWeight: "800", color: colors.onSurface },
  chartTrack: { height: 9, borderRadius: 5, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  chartBar: { height: "100%", borderRadius: 5 },
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
