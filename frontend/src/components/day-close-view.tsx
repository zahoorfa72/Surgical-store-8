import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useDayClose } from "@/src/data";
import { ChipRow, Loader, ScreenHeader, StatTile, money } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const RANGES = [
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
] as const;

// Shared day-close / end-of-shift summary used by the cashier tab and the
// staff modal.
export function DayCloseView({ onBack }: { onBack?: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<string>("today");
  const { data, isLoading } = useDayClose(range);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Day close" subtitle="End-of-shift summary" topInset={insets.top} onBack={onBack} showStatus={!onBack} />
      <ChipRow options={RANGES as any} value={range} onChange={setRange} testIDPrefix="dayclose-range" />
      {isLoading || !data ? (
        <Loader />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
          <View style={styles.hero} testID="dayclose-me">
            <View style={styles.heroTop}>
              <MaterialDesignIcons name="account-clock" size={22} color={colors.onBrandPrimary} />
              <Text style={styles.heroName}>{data.me.user_name}</Text>
            </View>
            <Text style={styles.heroTotal}>{money(data.me.gross_sales)}</Text>
            <Text style={styles.heroLabel}>Your sales this {range === "today" ? "shift" : range}</Text>
          </View>

          <View style={styles.grid}>
            <StatTile label="Transactions" value={String(data.me.transactions)} icon="receipt" tone="brand" testID="dayclose-transactions" />
            <StatTile label="Units sold" value={String(data.me.units)} icon="cube-outline" tone="info" />
            <StatTile label="Discounts given" value={money(data.me.discount)} icon="tag" tone="warning" />
            <StatTile label="Net collected" value={money(data.me.gross_sales)} icon="cash" tone="success" />
          </View>

          {data.by_user && (
            <View>
              <Text style={styles.sectionTitle}>All staff</Text>
              <View style={styles.group}>
                {data.by_user.map((u, idx) => (
                  <View key={u.user_name + idx} style={[styles.staffRow, idx > 0 && styles.staffBorder]}>
                    <View style={styles.staffAvatar}>
                      <Text style={styles.staffInitial}>{(u.user_name[0] ?? "?").toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.staffName}>{u.user_name}</Text>
                      <Text style={styles.staffMeta}>{u.transactions} sale(s) · {u.units} unit(s)</Text>
                    </View>
                    <Text style={styles.staffTotal}>{money(u.gross_sales)}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  hero: { backgroundColor: colors.brandPrimary, borderRadius: 18, padding: 20, gap: 6 },
  heroTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  heroName: { fontSize: 15, fontWeight: "700", color: colors.onBrandPrimary },
  heroTotal: { fontSize: 34, fontWeight: "800", color: colors.onBrandPrimary, marginTop: 4 },
  heroLabel: { fontSize: 13, color: colors.onBrandPrimary, opacity: 0.85 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 10 },
  group: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  staffRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  staffBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  staffAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" },
  staffInitial: { fontSize: 16, fontWeight: "800", color: colors.brandPrimary },
  staffName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  staffMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  staffTotal: { fontSize: 16, fontWeight: "800", color: colors.brandPrimary },
}));
