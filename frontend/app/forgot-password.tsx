import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { ApiError, forgotPasswordRequest, resetPasswordRequest } from "@/src/api";
import { Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles } from "@/src/theme";

export default function ForgotPassword() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const sendCode = async () => {
    if (!email.trim()) return toast("Enter your email", "error");
    setBusy(true);
    try {
      await forgotPasswordRequest(email.trim());
      toast("If that account exists, a code was emailed", "success");
      setStep(2);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : "Can't reach the server. Try again when online.";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!code.trim()) return toast("Enter the code from your email", "error");
    if (password.length < 4) return toast("Password needs 4+ characters", "error");
    setBusy(true);
    try {
      await resetPasswordRequest(email.trim(), code.trim(), password);
      toast("Password updated — sign in now", "success");
      router.replace("/login");
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : "Can't reach the server. Try again when online.";
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Reset password" topInset={insets.top} onBack={() => router.back()} />
      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 16 }}
        bottomOffset={20}
      >
        {step === 1 ? (
          <>
            <Text style={styles.intro}>Enter your email and we'll send a 6-digit reset code.</Text>
            <Field
              label="Email"
              testID="forgot-email-input"
              value={email}
              onChangeText={setEmail}
              placeholder="you@store.com"
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
            />
            <PrimaryButton label="Send reset code" onPress={sendCode} busy={busy} testID="send-code-button" />
            <Text style={styles.note}>No email? Ask an admin to reset your password from Manage users.</Text>
          </>
        ) : (
          <>
            <Text style={styles.intro}>Enter the code sent to {email} and choose a new password.</Text>
            <Field
              label="Reset code"
              testID="reset-code-input"
              value={code}
              onChangeText={setCode}
              placeholder="6-digit code"
              keyboardType="number-pad"
            />
            <Field
              label="New password"
              testID="new-password-input"
              value={password}
              onChangeText={setPassword}
              placeholder="At least 4 characters"
              secureTextEntry
              autoCapitalize="none"
            />
            <PrimaryButton label="Update password" onPress={reset} busy={busy} testID="reset-submit-button" />
            <Pressable testID="resend-code" onPress={sendCode} hitSlop={8} style={styles.center}>
              <Text style={styles.link}>Resend code</Text>
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
  note: { fontSize: 13, color: colors.muted, textAlign: "center", marginTop: 4 },
  center: { alignItems: "center", marginTop: 4 },
  link: { fontSize: 14, color: colors.brandPrimary, fontWeight: "700" },
}));
