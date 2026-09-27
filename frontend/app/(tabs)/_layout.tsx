import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth, canManageStore } from "@/src/auth";
import { useTheme } from "@/src/theme";

const ALL_TABS = [
  { name: "index", label: "Home", icon: "view-dashboard" },
  { name: "sell", label: "Sell", icon: "cart" },
  { name: "products", label: "Stock", icon: "package-variant-closed" },
  { name: "receipts", label: "Receipts", icon: "receipt" },
  { name: "day", label: "Day", icon: "account-clock" },
  { name: "more", label: "More", icon: "dots-horizontal" },
];

export default function TabsLayout() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const staff = canManageStore(user?.role);

  // Which tabs each role sees in the bar.
  const visible = staff
    ? ["index", "sell", "products", "more"]
    : ["sell", "receipts", "day"];

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.divider,
          ...(Platform.OS === "web" ? { height: 64 } : {}),
        },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      {ALL_TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.label,
            href: visible.includes(t.name) ? undefined : null,
            tabBarButtonTestID: `tab-${t.name}`,
            tabBarIcon: ({ color, size }) => (
              <MaterialDesignIcons name={t.icon as any} size={size ?? 24} color={color} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
