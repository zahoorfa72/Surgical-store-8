import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest, Role, AppUser } from "@/src/api";
import { useUsers, qk } from "@/src/data";
import { saveOfflineCredentials, useAuth } from "@/src/auth";
import { Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { storage } from "@/src/utils/storage";

const ROLES: { key: Role; label: string; desc: string }[] = [
  { key: "admin", label: "Admin", desc: "Full access + manage users" },
  { key: "partner", label: "Partner / Seller", desc: "Sell, stock, parties, reports" },
  { key: "cashier", label: "Cashier", desc: "Sell + reprint receipts only" },
];

export default function UserForm() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = !!id;
  const { data: users } = useUsers();
  const { user: me } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (id && users) {
      const u = users.find((x) => x.id === id);
      if (u) {
        setName(u.name);
        setEmail(u.email);
        setRole(u.role);
      }
    }
  }, [id, users]);

  const save = async () => {
    if (!name.trim()) return toast("Enter a name", "error");
    if (!email.trim()) return toast("Enter an email", "error");
    if (!editing && password.length < 4) return toast("Password needs 4+ characters", "error");
    if (editing && password && password.length < 4) return toast("Password needs 4+ characters", "error");
    setBusy(true);
    try {
      if (editing) {
        const body: any = { name: name.trim(), email: email.trim(), role };
        if (password) body.password = password;
        const updated = await apiRequest<AppUser>(`/users/${id}`, { method: "PUT", body });
        if (id === me?.id) {
          const vault = await storage.getItem<Record<string, any>>("ssm.vault", {});
          const previous = vault[me.email];
          if (previous && me.email.toLowerCase() !== body.email.toLowerCase()) {
            vault[body.email.toLowerCase()] = { ...previous, user: updated };
            delete vault[me.email];
            await storage.setItem("ssm.vault", vault);
          }
          if (password) await saveOfflineCredentials(body.email, password, updated);
        }
      } else {
        const created = await apiRequest<AppUser>("/users", {
          method: "POST",
          body: { name: name.trim(), email: email.trim(), password, role },
        });
        // Keep the new account usable on this device while offline too.
        // When the create was queued, the same record will be reconciled with
        // the server after reconnect.
        await saveOfflineCredentials(email.trim(), password, created);
      }
      await queryClient.invalidateQueries({ queryKey: qk.users });
      toast(editing ? "User updated" : "User created", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title={editing ? "Edit user" : "New user"} topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 18 }} bottomOffset={20}>
        <Field label="Full name" testID="user-name-input" value={name} onChangeText={setName} placeholder="e.g. Ali Khan" />
        <Field
          label="Email"
          testID="user-email-input"
          value={email}
          onChangeText={setEmail}
          editable={true}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="user@store.com"
        />
        <Field
          label={editing ? "New password (leave blank to keep)" : "Password"}
          testID="user-password-input"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          placeholder={editing ? "••••••" : "At least 4 characters"}
        />

        <View style={{ gap: 8 }}>
          <Text style={styles.label}>Role</Text>
          {ROLES.map((r) => {
            const active = r.key === role;
            return (
              <Pressable
                key={r.key}
                testID={`role-${r.key}`}
                style={[styles.roleRow, active ? styles.roleActive : styles.roleIdle]}
                onPress={() => setRole(r.key)}
              >
                <MaterialDesignIcons
                  name={active ? "radiobox-marked" : "radiobox-blank"}
                  size={22}
                  color={active ? colors.brandPrimary : colors.muted}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.roleLabel}>{r.label}</Text>
                  <Text style={styles.roleDesc}>{r.desc}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <PrimaryButton label={editing ? "Save changes" : "Create user"} onPress={save} busy={busy} testID="save-user-button" />
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  label: { fontSize: 13, fontWeight: "600", color: colors.onSurfaceSecondary },
  roleRow: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14, borderWidth: 1.5, padding: 14 },
  roleIdle: { borderColor: colors.border, backgroundColor: colors.surface },
  roleActive: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  roleLabel: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  roleDesc: { fontSize: 12, color: colors.muted, marginTop: 2 },
}));
