import { ScrollView, Text, View } from "react-native";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { isAdmin, useAuth } from "@/src/auth";
import { Badge, ConnectionModeSelector, ScreenHeader } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

type Item = { label: string; sub: string; icon: string; route: string; testID: string; adminOnly?: boolean };

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Operations",
    items: [
      { label: "Purchases", sub: "Restock history, edit & delete", icon: "truck", route: "/purchases-history", testID: "more-purchases" },
      { label: "Sales & Receipts", sub: "History and reprint", icon: "receipt", route: "/sales-history", testID: "more-sales" },
      { label: "Returns & refunds", sub: "Return items, adjust stock", icon: "cash-refund", route: "/returns", testID: "more-returns" },
    ],
  },
  {
    title: "Parties",
    items: [
      { label: "Suppliers", sub: "Who you buy from", icon: "domain", route: "/parties?type=supplier", testID: "more-suppliers" },
      { label: "Customers", sub: "Who you sell to", icon: "account-group", route: "/parties?type=customer", testID: "more-customers" },
    ],
  },
  {
    title: "Accounts",
    items: [
      { label: "Reports", sub: "Daily, weekly, monthly & yearly", icon: "chart-box", route: "/reports", testID: "more-reports" },
      { label: "Smart Store Center", sub: "Reorder, stock movement, statements & audit", icon: "brain", route: "/business-intelligence", testID: "more-smart-center" },
      { label: "Expenses", sub: "Operating, direct & personal", icon: "cash-multiple", route: "/expenses", testID: "more-expenses" },
      { label: "Payments", sub: "Pay suppliers, receive from customers", icon: "cash-sync", route: "/payments", testID: "more-payments" },
      { label: "Customer report", sub: "Who bought how much", icon: "chart-donut", route: "/customers-report", testID: "more-customer-report" },
      { label: "Day close", sub: "Sales per cashier & shift", icon: "account-clock", route: "/day-close", testID: "more-day-close" },
    ],
  },
  {
    title: "Administration",
    items: [
      { label: "Manage users", sub: "Add sellers & cashiers", icon: "account-key", route: "/users", testID: "more-users", adminOnly: true },
      { label: "Backup & Restore", sub: "Save or restore all local store data", icon: "backup-restore", route: "/backup-restore", testID: "more-backup-restore" },
      { label: "Settings", sub: "Profile & sign out", icon: "cog", route: "/settings", testID: "more-settings" },
    ],
  },
];

export default function More() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);

  return (
    <View style={styles.root}>
      <ScreenHeader title="More" subtitle="Manage your store" topInset={insets.top} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}>
        <ConnectionModeSelector />
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(user?.name?.[0] ?? "?").toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{user?.name}</Text>
            <Text style={styles.profileEmail}>{user?.email}</Text>
          </View>
          <Badge text={user?.role ?? ""} tone="brand" />
        </View>

        {SECTIONS.map((section) => {
          const items = section.items.filter((i) => !i.adminOnly || admin);
          if (!items.length) return null;
          return (
            <View key={section.title} style={{ gap: 10 }}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <View style={styles.group}>
                {items.map((item, idx) => (
                  <Pressable
                    key={item.route}
                    testID={item.testID}
                    style={[styles.item, idx > 0 && styles.itemBorder]}
                    onPress={() => router.push(item.route as any)}
                  >
                    <View style={styles.itemIcon}>
                      <MaterialDesignIcons name={item.icon as any} size={22} color={colors.brandPrimary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemLabel}>{item.label}</Text>
                      <Text style={styles.itemSub}>{item.sub}</Text>
                    </View>
                    <MaterialDesignIcons name="chevron-right" size={22} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.brandTertiary,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.onBrandPrimary, fontSize: 20, fontWeight: "800" },
  profileName: { fontSize: 16, fontWeight: "800", color: colors.onSurface },
  profileEmail: { fontSize: 13, color: colors.onSurfaceSecondary, marginTop: 2 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  group: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  itemBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  itemIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  itemLabel: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  itemSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
}));
