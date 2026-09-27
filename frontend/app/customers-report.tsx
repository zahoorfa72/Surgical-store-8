import { useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useCustomers } from "@/src/data";
import { ChipRow, EmptyState, Loader, ScreenHeader, money } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const RANGES = [
  { key: "all", label: "All Time" },
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
] as const;

export default function CustomersReport() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [range, setRange] = useState<string>("all");
  const { data: rows, isLoading } = useCustomers(range);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Customer report" subtitle="Who bought how much" topInset={insets.top} onBack={() => router.back()} />
      <ChipRow options={RANGES as any} value={range} onChange={setRange} testIDPrefix="cust-range" />
      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r, i) => (r.customer_id ?? "walkin") + i}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}
          ListEmptyComponent={<EmptyState icon="chart-donut" title="No sales yet" message="Customer spending will show here." testID="customers-report-empty" />}
          renderItem={({ item, index }) => (
            <View style={styles.row} testID={`cust-report-row-${index}`}>
              <View style={[styles.rank, index === 0 && styles.rankTop]}>
                <Text style={[styles.rankText, index === 0 && styles.rankTopText]}>{index + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  {item.orders} order(s) · {item.units} unit(s)
                </Text>
              </View>
              <View style={styles.right}>
                <Text style={styles.total}>{money(item.total)}</Text>
                {index === 0 && (
                  <View style={styles.topBadge}>
                    <MaterialDesignIcons name="crown" size={12} color={colors.onWarning} />
                    <Text style={styles.topText}>Top</Text>
                  </View>
                )}
              </View>
            </View>
          )}
        />
      )}
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
    padding: 14,
  },
  rank: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  rankTop: { backgroundColor: colors.brandPrimary },
  rankText: { fontSize: 14, fontWeight: "800", color: colors.onSurfaceSecondary },
  rankTopText: { color: colors.onBrandPrimary },
  name: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  right: { alignItems: "flex-end", gap: 4 },
  total: { fontSize: 16, fontWeight: "800", color: colors.brandPrimary },
  topBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: colors.warning, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  topText: { fontSize: 10, fontWeight: "800", color: colors.onWarning },
}));
