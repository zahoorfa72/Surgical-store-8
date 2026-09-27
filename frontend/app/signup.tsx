import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { ApiError, getConnectionMode, signupRequest } from "@/src/api";
import { signupOffline } from "@/src/auth";
import { Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function Signup() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [localAccount, setLocalAccount] = useState(false);

  const submit = async () => {
    if (!name.trim()) return toast("Enter your name", "error");
    if (!email.trim()) return toast("Enter your email", "error");
    if (password.length < 4) return toast("Password needs 4+ characters", "error");
    setBusy(true);
    try {
      // Offline mode (default): create the account on this device directly.
      if ((await getConnectionMode()) === "offline") {
        await signupOffline(email.trim(), name.trim(), password);
        setLocalAccount(true);
        setDone(true);
        return;
      }
      await signupRequest(email.trim(), name.trim(), password);
      setLocalAccount(false);
      setDone(true);
    } catch (e: any) {
      // A real server response (e.g. email already exists) -> surface it.
      if (e instanceof ApiError) {
        toast(e.message, "error");
        setBusy(false);
        return;
      }
      // No server reachable -> create the account on this device so the user
      // can sign in and work fully offline.
      try {
        await signupOffline(email.trim(), name.trim(), password);
        setLocalAccount(true);
        setDone(true);
      } catch (localErr: any) {
        toast(localErr?.message || "Could not create account", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Create account" topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 16 }}
        bottomOffset={20}
      >
        {done ? (
          <View style={styles.doneCard} testID="signup-done">
            <MaterialDesignIcons name={localAccount ? "check-circle-outline" : "account-clock-outline"} size={40} color={colors.brandPrimary} />
            <Text style={styles.doneTitle}>Account created</Text>
            <Text style={styles.doneText}>
              {localAccount
                ? "Your account was created on this device. You can sign in now and start working offline."
                : "Your account is waiting for an admin to approve it. You'll be able to sign in once it's approved."}
            </Text>
            <PrimaryButton label="Back to sign in" onPress={() => router.replace("/login")} testID="signup-back-login" />
          </View>
        ) : (
          <>
            <Text style={styles.intro}>Register a new staff account. An admin approves it before first sign in.</Text>
            <Field label="Full name" testID="signup-name-input" value={name} onChangeText={setName} placeholder="e.g. Ali Khan" />
            <Field
              label="Email"
              testID="signup-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder="you@store.com"
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />
            <Field
              label="Password"
              testID="signup-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="At least 4 characters"
              secureTextEntry
              autoCapitalize="none"
            />
            <PrimaryButton label="Create account" onPress={submit} busy={busy} testID="signup-submit-button" />
            <Pressable testID="go-login" onPress={() => router.replace("/login")} hitSlop={8} style={styles.center}>
              <Text style={styles.link}>I already have an account</Text>
            </Pressable>
          </>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  intro: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  center: { alignItems: "center", marginTop: 4 },
  link: { fontSize: 14, color: colors.brandPrimary, fontWeight: "700" },
  doneCard: {
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.brandTertiary,
    borderRadius: 18,
    padding: 28,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  doneTitle: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  doneText: { fontSize: 14, color: colors.onSurfaceSecondary, textAlign: "center", lineHeight: 20, marginBottom: 8 },
}));
