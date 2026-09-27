import { FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest, AppUser } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useUsers, qk } from "@/src/data";
import { Badge, EmptyState, Loader, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

const ROLE_TONE: Record<string, "brand" | "success" | "muted"> = {
  admin: "brand",
  partner: "success",
  cashier: "muted",
};

export default function Users() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();

  const { data: users, isLoading } = useUsers();

  const toggleDisabled = async (u: AppUser) => {
    try {
      await apiRequest(`/users/${u.id}`, { method: "PUT", body: { disabled: !u.disabled } });
      await queryClient.invalidateQueries({ queryKey: qk.users });
      toast(u.disabled ? "User enabled" : "User disabled", "success");
    } catch (e: any) {
      toast(e?.message || "Update failed", "error");
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Manage users" subtitle="Sellers, partners & cashiers" topInset={insets.top} onBack={() => router.back()} />
      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 10 }}
          ListEmptyComponent={<EmptyState icon="account-key" title="No users" message="Add your first user." testID="users-empty" />}
          renderItem={({ item }) => {
            const isMe = item.id === me?.id;
            return (
              <Pressable
                testID={`user-row-${item.id}`}
                style={[styles.row, item.disabled && { opacity: 0.55 }]}
                onPress={() => router.push(`/user-form?id=${item.id}`)}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(item.name?.[0] ?? "?").toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>
                    {item.name} {isMe ? "(you)" : ""}
                  </Text>
                  <Text style={styles.email}>{item.email}</Text>
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
                    <Badge text={item.role} tone={ROLE_TONE[item.role] ?? "muted"} />
                    {item.pending ? (
                      <Badge text="pending approval" tone="warning" />
                    ) : item.disabled ? (
                      <Badge text="disabled" tone="error" />
                    ) : null}
                  </View>
                </View>
                {!isMe && (
                  <Pressable testID={`toggle-user-${item.id}`} hitSlop={8} onPress={() => toggleDisabled(item)} style={styles.toggleBtn}>
                    <MaterialDesignIcons
                      name={item.disabled ? "account-check" : "account-off"}
                      size={22}
                      color={item.disabled ? colors.success : colors.error}
                    />
                  </Pressable>
                )}
              </Pressable>
            );
          }}
        />
      )}

      <Pressable testID="add-user-fab" style={[styles.fab, { bottom: 16 }]} onPress={() => router.push("/user-form")}>
        <MaterialDesignIcons name="account-plus" size={26} color={colors.onBrandPrimary} />
      </Pressable>
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
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 18, fontWeight: "800", color: colors.brandPrimary },
  name: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  email: { fontSize: 13, color: colors.muted, marginTop: 2 },
  toggleBtn: { padding: 6 },
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
}));
