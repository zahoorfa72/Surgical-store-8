import React, { ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, DeviceEventEmitter, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth, verifyAdminCredentials } from "@/src/auth";
import { useTheme, makeStyles } from "@/src/theme";
import {
  authenticateWithBiometric,
  isAdminPinConfigured,
  isBiometricUnlockEnabled,
  setAdminPin,
  verifyAdminPin,
} from "@/src/security/finance-security";

export function AppLockGate({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const styles = useStyles();
  const { colors } = useTheme();
  const [ready, setReady] = useState(false);
  const [pinConfigured, setPinConfigured] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [firstPinConfirm, setFirstPinConfirm] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [showPinFallback, setShowPinFallback] = useState(false);
  const fingerprintPromptStarted = useRef(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const backgroundAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    setReady(false);
    setPin("");
    setError("");
    setRecoveryOpen(false);
    if (!user) {
      setPinConfigured(false);
      setBiometricEnabled(false);
      setUnlocked(false);
      setAttempts(0);
      setShowPinFallback(false);
      fingerprintPromptStarted.current = false;
      setReady(true);
      return;
    }
    (async () => {
      const [hasPin, hasBiometric] = await Promise.all([
        isAdminPinConfigured(),
        isBiometricUnlockEnabled(),
      ]);
      if (!active) return;
      setPinConfigured(hasPin);
      setBiometricEnabled(hasBiometric);
      setUnlocked(false);
      setReady(true);
    })().catch(() => {
      if (active) {
        setError("App security could not be loaded. Restart the app or use admin recovery.");
        setReady(true);
      }
    });
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener("ssm.admin-pin-configured", (enabled: boolean) => {
      setPinConfigured(enabled);
      if (enabled) setPin("");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!user || !pinConfigured) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        if (backgroundAt.current === null) backgroundAt.current = Date.now();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setUnlocked(false);
          fingerprintPromptStarted.current = false;
          setPin("");
          setError("");
        }, 30000);
      } else {
        if (backgroundAt.current !== null && Date.now() - backgroundAt.current >= 30000) {
          setUnlocked(false);
          fingerprintPromptStarted.current = false;
          setPin("");
          setError("");
        }
        backgroundAt.current = null;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      }
    });
    return () => {
      subscription.remove();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [user?.id, pinConfigured]);

  const createFirstPin = async () => {
    if (busy) return;
    if (user?.role !== "admin") {
      setError("Only the administrator can set the first app PIN.");
      return;
    }
    if (!/^\d{6}$/.test(firstPin) || firstPin !== firstPinConfirm) {
      setError("Enter matching 6-digit PINs.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await setAdminPin(firstPin);
      setPinConfigured(true);
      setUnlocked(true);
      setFirstPin("");
      setFirstPinConfirm("");
      setError("");
    } catch (e: any) {
      setError(e?.message || "Could not create administrator PIN.");
    } finally {
      setBusy(false);
    }
  };

  const unlockWithPin = async () => {
    if (busy) return;
    if (Date.now() < cooldownUntil) {
      setError("Too many incorrect attempts. Wait 30 seconds and try again.");
      return;
    }
    setBusy(true);
    try {
      const valid = await verifyAdminPin(pin);
      if (valid) {
        setUnlocked(true);
        setPin("");
        setError("");
        setAttempts(0);
      } else {
        const next = attempts + 1;
        setAttempts(next);
        if (next >= 5) {
          setCooldownUntil(Date.now() + 30000);
          setAttempts(0);
          setError("Five incorrect attempts. App unlock is paused for 30 seconds.");
        } else {
          setError("Incorrect PIN. Try again.");
        }
        setPin("");
      }
    } finally {
      setBusy(false);
    }
  };

  const unlockWithFingerprint = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const ok = await authenticateWithBiometric();
      if (ok) { setUnlocked(true); setAttempts(0); setShowPinFallback(false); }
      else {
        const next = attempts + 1; setAttempts(next);
        if (next >= 5) { setShowPinFallback(true); setError("Fingerprint failed five times. Enter your administrator PIN."); }
        else setError(`Fingerprint not verified (${next}/5). Try again.`);
      }
    } catch {
      const next = attempts + 1; setAttempts(next);
      if (next >= 5) { setShowPinFallback(true); setError("Fingerprint failed five times. Enter your administrator PIN."); }
      else setError(`Fingerprint attempt ${next}/5 was unsuccessful. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  const recoverPin = async () => {
    if (busy) return;
    if (!/^\d{6}$/.test(newPin) || newPin !== confirmPin) {
      setError("Enter matching 6-digit new PINs.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const validAdmin = await verifyAdminCredentials(adminEmail, adminPassword);
      if (!validAdmin) {
        setError("Admin email or password is incorrect.");
        return;
      }
      await setAdminPin(newPin);
      setPinConfigured(true);
      setUnlocked(true);
      setRecoveryOpen(false);
      setPin("");
      setNewPin("");
      setConfirmPin("");
      setAdminPassword("");
      setError("");
    } catch (e: any) {
      setError(e?.message || "PIN recovery failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pinConfigured || !biometricEnabled || unlocked || showPinFallback || fingerprintPromptStarted.current) return;
    fingerprintPromptStarted.current = true;
    void unlockWithFingerprint();
  }, [pinConfigured, biometricEnabled, unlocked, showPinFallback]);

  if (user && !ready) return <View style={{ flex: 1, backgroundColor: colors.surface }} />;
  if (!user) return <>{children}</>;
  if (!pinConfigured) {
    return (
      <SafeAreaView style={styles.overlay}>
        <KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.brandIcon}><MaterialDesignIcons name="shield-lock" size={34} color={colors.onBrandPrimary} /></View>
          <Text style={styles.title}>Secure this device</Text>
          {user.role === "admin" ? (
            <View style={styles.form}>
              <Text style={styles.subtitle}>Create the administrator's 6-digit PIN before using the store. You will need this PIN when the app starts or returns after 30 seconds in the background.</Text>
              <TextInput testID="first-app-pin" style={[styles.input, styles.pinInput]} value={firstPin} onChangeText={(v) => setFirstPin(v.replace(/\D/g, "").slice(0, 6))} placeholder="Create 6-digit PIN" placeholderTextColor={colors.muted} keyboardType="number-pad" secureTextEntry maxLength={6} />
              <TextInput testID="first-app-pin-confirm" style={[styles.input, styles.pinInput]} value={firstPinConfirm} onChangeText={(v) => setFirstPinConfirm(v.replace(/\D/g, "").slice(0, 6))} placeholder="Confirm 6-digit PIN" placeholderTextColor={colors.muted} keyboardType="number-pad" secureTextEntry maxLength={6} />
              <Pressable disabled={busy || firstPin.length !== 6 || firstPinConfirm.length !== 6} style={[styles.primaryButton, (busy || firstPin.length !== 6 || firstPinConfirm.length !== 6) && { opacity: 0.55 }]} onPress={() => void createFirstPin()}>
                {busy ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryText}>Create PIN and enter store</Text>}
              </Pressable>
            </View>
          ) : (
            <View style={styles.form}>
              <Text style={styles.subtitle}>The administrator must sign in once and create the app PIN before this device can be used.</Text>
              <Pressable style={styles.primaryButton} onPress={() => void logout()}>
                <Text style={styles.primaryText}>Sign out for administrator setup</Text>
              </Pressable>
            </View>
          )}
          {!!error && <Text style={styles.error}>{error}</Text>}
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }
  if (unlocked) return <>{children}</>;

  return (
    <View style={{ flex: 1 }}>
      <View pointerEvents="none" style={{ flex: 1, opacity: 0.03 }}>{children}</View>
      <SafeAreaView style={styles.overlay}>
        <KeyboardAvoidingView style={styles.content} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.brandIcon}>
            <MaterialDesignIcons name="shield-lock" size={34} color={colors.onBrandPrimary} />
          </View>
          <Text style={styles.title}>Surgical Store is locked</Text>
          <Text style={styles.subtitle}>Enter the administrator PIN to continue.</Text>

          {recoveryOpen ? (
            <View style={styles.form}>
              <Text style={styles.sectionTitle}>Recover administrator PIN</Text>
              <Text style={styles.help}>Verify the admin account with its email and password, then choose a new PIN.</Text>
              <TextInput style={styles.input} value={adminEmail} onChangeText={setAdminEmail} placeholder="Admin email" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardType="email-address" />
              <TextInput style={styles.input} value={adminPassword} onChangeText={setAdminPassword} placeholder="Admin account password" placeholderTextColor={colors.muted} secureTextEntry />
              <TextInput style={styles.input} value={newPin} onChangeText={(v) => setNewPin(v.replace(/\D/g, "").slice(0, 6))} placeholder="New 6-digit PIN" placeholderTextColor={colors.muted} keyboardType="number-pad" secureTextEntry maxLength={6} />
              <TextInput style={styles.input} value={confirmPin} onChangeText={(v) => setConfirmPin(v.replace(/\D/g, "").slice(0, 6))} placeholder="Confirm new PIN" placeholderTextColor={colors.muted} keyboardType="number-pad" secureTextEntry maxLength={6} />
              <Pressable disabled={busy} style={styles.primaryButton} onPress={() => void recoverPin()}>
                {busy ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryText}>Verify admin and reset PIN</Text>}
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => { setRecoveryOpen(false); setError(""); }}>
                <Text style={styles.secondaryText}>Back to unlock</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.form}>
              {biometricEnabled && !showPinFallback ? (
                <>
                  <MaterialDesignIcons name="fingerprint" size={42} color={colors.brandPrimary} />
                  <Text style={styles.help}>Verify your fingerprint to unlock the store.</Text>
                  <Pressable disabled={busy} style={styles.primaryButton} onPress={() => void unlockWithFingerprint()}>
                    {busy ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryText}>Try fingerprint again</Text>}
                  </Pressable>
                </>
              ) : (
                <>
                  <TextInput testID="app-lock-pin" style={[styles.input, styles.pinInput]} value={pin}
                    onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))}
                    placeholder="Enter 6-digit PIN" placeholderTextColor={colors.muted}
                    keyboardType="number-pad" secureTextEntry maxLength={6} autoFocus
                    onSubmitEditing={() => void unlockWithPin()} />
                  <Pressable disabled={busy || pin.length !== 6} style={[styles.primaryButton, (busy || pin.length !== 6) && { opacity: 0.55 }]} onPress={() => void unlockWithPin()}>
                    {busy ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryText}>Unlock app</Text>}
                  </Pressable>
                </>
              )}
              <Pressable style={styles.forgotButton} onPress={() => { setRecoveryOpen(true); setError(""); }}>
                <Text style={styles.forgotText}>Forgot PIN? Recover with admin account</Text>
              </Pressable>
            </View>
          )}
          {!!error && <Text style={styles.error}>{error}</Text>}
          <Text style={styles.footer}>Your session stays unlocked while the app is in use. It locks after 30 seconds in the background. Closing or restarting the app requires unlocking again.</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  overlay: { ...({ flex: 1 } as any), backgroundColor: colors.surface, justifyContent: "center" },
  content: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 26 },
  brandIcon: { width: 68, height: 68, borderRadius: 22, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", marginBottom: 18 },
  title: { color: colors.onSurface, fontSize: 21, fontWeight: "900", textAlign: "center" },
  subtitle: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 8, marginBottom: 18, maxWidth: 330 },
  form: { width: "100%", maxWidth: 350, gap: 10, alignItems: "stretch" },
  sectionTitle: { color: colors.onSurface, fontSize: 16, fontWeight: "800" },
  help: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, color: colors.onSurface, backgroundColor: colors.surfaceTertiary, fontSize: 15 },
  pinInput: { textAlign: "center", fontSize: 18, letterSpacing: 3, fontWeight: "800", minHeight: 54 },
  primaryButton: { minHeight: 48, borderRadius: 12, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, marginTop: 4 },
  primaryText: { color: colors.onBrandPrimary, fontSize: 14, fontWeight: "900" },
  secondaryButton: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 12, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  secondaryText: { color: colors.brandPrimary, fontWeight: "800", fontSize: 13 },
  forgotButton: { alignItems: "center", padding: 10 },
  forgotText: { color: colors.brandPrimary, fontWeight: "700", fontSize: 12 },
  error: { color: colors.error, marginTop: 14, fontSize: 12, fontWeight: "700", textAlign: "center" },
  footer: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 22, textAlign: "center", maxWidth: 330 },
}));
