import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Image } from "expo-image";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth } from "@/src/auth";
import { useSettings } from "@/src/data";
import { logoUrl } from "@/src/api";
import { Field, PrimaryButton, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function Login() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login } = useAuth();
  const toast = useToast();
  const { data: settings } = useSettings();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) {
      toast("Enter email and password", "error");
      return;
    }
    setBusy(true);
    try {
      await login(email, password);
      router.replace("/(tabs)");
    } catch (e: any) {
      toast(e?.message || "Login failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 },
        ]}
        bottomOffset={20}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brandMark}>
          {settings?.has_logo ? (
            <Image
              testID="login-logo"
              source={{ uri: logoUrl(settings.logo_version) }}
              style={styles.brandLogo}
              contentFit="cover"
            />
          ) : (
            <MaterialDesignIcons name="medical-bag" size={40} color={colors.onBrandPrimary} />
          )}
        </View>
        <Text style={styles.title}>{settings?.store_name ?? "Surgical Store"}</Text>
        <Text style={styles.subtitle}>Point of sale, inventory & accounts</Text>

        <View style={styles.form}>
          <Field
            label="Email"
            testID="login-email-input"
            value={email}
            onChangeText={setEmail}
            placeholder="you@store.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoCorrect={false}
          />
          <View style={styles.passWrap}>
            <Field
              label="Password"
              testID="login-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              secureTextEntry={!showPass}
              autoCapitalize="none"
            />
            <Pressable
              testID="toggle-password-visibility"
              style={styles.eye}
              onPress={() => setShowPass((s) => !s)}
              hitSlop={10}
            >
              <MaterialDesignIcons
                name={showPass ? "eye-off" : "eye"}
                size={22}
                color={colors.muted}
              />
            </Pressable>
          </View>

          <PrimaryButton label="Sign In" onPress={submit} busy={busy} testID="login-submit-button" />

          <View style={styles.linksRow}>
            <Pressable testID="forgot-password-link" onPress={() => router.push("/forgot-password")} hitSlop={8}>
              <Text style={styles.linkText}>Forgot password?</Text>
            </Pressable>
            <Pressable testID="signup-link" onPress={() => router.push("/signup")} hitSlop={8}>
              <Text style={styles.linkTextStrong}>Create account</Text>
            </Pressable>
          </View>
        </View>


      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: 24, gap: 6, alignItems: "center" },
  brandMark: {
    width: 84,
    height: 84,
    borderRadius: 24,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
    overflow: "hidden",
  },
  brandLogo: { width: "100%", height: "100%" },
  linksRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  linkText: { fontSize: 14, color: colors.muted, fontWeight: "600" },
  linkTextStrong: { fontSize: 14, color: colors.brandPrimary, fontWeight: "800" },
  title: { fontSize: 28, fontWeight: "800", color: colors.onSurface },
  subtitle: { fontSize: 14, color: colors.muted, marginBottom: 24 },
  form: { width: "100%", gap: 16 },
  passWrap: { position: "relative", justifyContent: "center" },
  eye: { position: "absolute", right: 14, top: 34, height: 44, width: 44, alignItems: "center", justifyContent: "center" },
  hintCard: {
    marginTop: 28,
    width: "100%",
    backgroundColor: colors.brandTertiary,
    borderRadius: 14,
    padding: 16,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  hintTitle: { fontSize: 13, fontWeight: "700", color: colors.onBrandTertiary, marginBottom: 4 },
  hintLine: { fontSize: 13, color: colors.onBrandTertiary },
}));
