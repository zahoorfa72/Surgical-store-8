import React, { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import { useRouter } from "expo-router";

import { useAuth, isAdmin, verifyAdminCredentials } from "@/src/auth";
import { ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { ProfitVisibilityToggle } from "@/src/components/profit-visibility-toggle";
import {
  disableBiometricUnlock,
  enableBiometricUnlock,
  isAdminPinConfigured,
  isBiometricUnlockEnabled,
  setAdminPin,
  verifyAdminPin,
} from "@/src/security/finance-security";

export default function SecuritySettings() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const router = useRouter();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);

  const [pinConfigured, setPinConfigured] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [adminEmail, setAdminEmail] = useState(user?.role === "admin" ? user.email : "");
  const [adminPassword, setAdminPassword] = useState("");
  const [recoverMode, setRecoverMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fingerprintModal, setFingerprintModal] = useState(false);
  const [fingerprintPin, setFingerprintPin] = useState("");

  const refreshSecurity = async () => {
    const [hasPin, biometric] = await Promise.all([isAdminPinConfigured(), isBiometricUnlockEnabled()]);
    setPinConfigured(hasPin);
    setBiometricEnabled(biometric);
  };
  useEffect(() => { void refreshSecurity(); }, []);

  const savePin = async () => {
    if (busy) return;
    if (!/^\d{6}$/.test(newPin) || newPin !== confirmPin) {
      setError("Enter matching 6-digit PINs.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!admin) throw new Error("Only the administrator can set or change the app PIN.");
      if (pinConfigured && !recoverMode) {
        if (!(await verifyAdminPin(currentPin))) throw new Error("Current administrator PIN is incorrect.");
      }
      if (recoverMode) {
        const verified = await verifyAdminCredentials(adminEmail, adminPassword);
        if (!verified) throw new Error("Admin email or password is incorrect.");
      }
      await setAdminPin(newPin);
      setCurrentPin("");
      setNewPin("");
      setConfirmPin("");
      setAdminPassword("");
      setRecoverMode(false);
      await refreshSecurity();
      toast(pinConfigured ? "Administrator PIN changed securely." : "Administrator PIN created.", "success");
    } catch (e: any) {
      setError(e?.message || "Could not save administrator PIN.");
    } finally {
      setBusy(false);
    }
  };

  const changeFingerprint = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!(await verifyAdminPin(fingerprintPin))) throw new Error("Administrator PIN is incorrect.");
      if (biometricEnabled) {
        await disableBiometricUnlock();
        toast("Fingerprint unlock disabled.", "success");
      } else {
        await enableBiometricUnlock();
        toast("Fingerprint unlock enabled.", "success");
      }
      setFingerprintModal(false);
      setFingerprintPin("");
      await refreshSecurity();
    } catch (e: any) {
      setError(e?.message || "Fingerprint setting could not be changed. Make sure a fingerprint is enrolled on this device.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Security & Privacy" subtitle="App lock and private financial display" topInset={insets.top} onBack={() => router.back()} />
      {!admin ? (
        <View style={{ padding: 20 }}>
          <Text style={styles.error}>Only the administrator can configure app security. Ask your administrator to set the PIN on this device.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 30, gap: 14 }}>
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <MaterialDesignIcons name="shield-lock-outline" size={22} color={colors.brandPrimary} />
              <Text style={styles.cardTitle}>App lock PIN</Text>
              <View style={{ flex: 1 }} />
              <View style={styles.status}><Text style={styles.statusText}>{pinConfigured ? "Enabled" : "Not set"}</Text></View>
            </View>
            <Text style={styles.cardHint}>Set a 6-digit administrator PIN. The PIN is stored as a salted hash in Android/iOS secure storage, not as plain text. A configured PIN locks the app at launch and after 30 seconds in the background.</Text>
            {pinConfigured && !recoverMode && (
              <TextInput
                testID="security-current-pin"
                style={styles.input}
                value={currentPin}
                onChangeText={(v) => setCurrentPin(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="Current 6-digit PIN"
                placeholderTextColor={colors.muted}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={6}
              />
            )}
            {recoverMode && (
              <>
                <TextInput style={styles.input} value={adminEmail} onChangeText={setAdminEmail} placeholder="Admin email" placeholderTextColor={colors.muted} autoCapitalize="none" keyboardType="email-address" />
                <TextInput style={styles.input} value={adminPassword} onChangeText={setAdminPassword} placeholder="Admin account password" placeholderTextColor={colors.muted} secureTextEntry />
                <Text style={styles.cardHint}>Use the administrator account password to recover a forgotten PIN. This verification does not sign out or change the active account.</Text>
              </>
            )}
            <TextInput
              testID="security-new-pin"
              style={styles.input}
              value={newPin}
              onChangeText={(v) => setNewPin(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="New 6-digit PIN"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
            />
            <TextInput
              testID="security-confirm-pin"
              style={styles.input}
              value={confirmPin}
              onChangeText={(v) => setConfirmPin(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="Confirm new PIN"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
            />
            {!!error && !fingerprintModal && <Text style={styles.error}>{error}</Text>}
            <Pressable testID="save-admin-app-pin" disabled={busy} style={styles.primary} onPress={() => void savePin()}>
              <Text style={styles.primaryText}>{busy ? "Saving..." : pinConfigured && !recoverMode ? "Change administrator PIN" : recoverMode ? "Verify admin and reset PIN" : "Set administrator PIN"}</Text>
            </Pressable>
            {pinConfigured && (
              <Pressable style={styles.linkButton} onPress={() => { setRecoverMode(!recoverMode); setCurrentPin(""); setError(""); }}>
                <Text style={styles.linkText}>{recoverMode ? "I know my current PIN" : "Forgot PIN? Recover using admin account"}</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <MaterialDesignIcons name="fingerprint" size={24} color={colors.brandPrimary} />
              <Text style={styles.cardTitle}>Fingerprint unlock</Text>
              <View style={{ flex: 1 }} />
              <Text style={styles.statusText}>{biometricEnabled ? "Enabled" : "Disabled"}</Text>
            </View>
            <Text style={styles.cardHint}>Fingerprint unlock is optional. Enabling or disabling it always requires the administrator PIN. The phone's secure biometric prompt performs the fingerprint check; the app never reads or stores fingerprint data.</Text>
            <Pressable
              testID="configure-fingerprint-unlock"
              disabled={!pinConfigured}
              style={[styles.secondaryButton, !pinConfigured && { opacity: 0.45 }]}
              onPress={() => { setFingerprintPin(""); setError(""); setFingerprintModal(true); }}
            >
              <MaterialDesignIcons name={biometricEnabled ? "fingerprint-off" : "fingerprint"} size={20} color={colors.brandPrimary} />
              <Text style={styles.secondaryText}>{biometricEnabled ? "Disable fingerprint unlock" : "Enable fingerprint unlock"}</Text>
            </Pressable>
            {!pinConfigured && <Text style={styles.cardHint}>Set the administrator PIN first.</Text>}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <MaterialDesignIcons name="eye-off-outline" size={22} color={colors.brandPrimary} />
              <Text style={styles.cardTitle}>Profit visibility</Text>
            </View>
            <Text style={styles.cardHint}>Hide either figure from dashboard, reports, charts and product profitability screens. Hiding is immediate. Showing it again always requires the administrator PIN.</Text>
            <View style={styles.visibilityRow}>
              <Text style={styles.visibilityLabel}>Gross profit</Text>
              <ProfitVisibilityToggle kind="gross" />
            </View>
            <View style={styles.visibilityRow}>
              <Text style={styles.visibilityLabel}>Net profit</Text>
              <ProfitVisibilityToggle kind="net" />
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Lock behaviour</Text>
            <Text style={styles.cardHint}>The app remains unlocked while it is actively being used. After 30 seconds in the background it locks automatically. If Android removes the app from Recents or the process is closed, the next launch starts locked. Unlock with PIN or enabled device biometrics.</Text>
          </View>
        </ScrollView>
      )}

      <Modal visible={fingerprintModal} transparent animationType="fade" onRequestClose={() => setFingerprintModal(false)}>
        <Pressable style={styles.backdrop} onPress={() => setFingerprintModal(false)}>
          <Pressable style={styles.dialog} onPress={() => {}}>
            <Text style={styles.cardTitle}>{biometricEnabled ? "Disable" : "Enable"} fingerprint unlock</Text>
            <Text style={styles.cardHint}>Confirm with the administrator PIN to continue.</Text>
            <TextInput
              testID="fingerprint-setting-pin"
              style={[styles.input, { textAlign: "center", letterSpacing: 8, fontSize: 20 }]}
              value={fingerprintPin}
              onChangeText={(v) => setFingerprintPin(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit PIN"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
            />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <Pressable disabled={busy || fingerprintPin.length !== 6} style={[styles.primary, (busy || fingerprintPin.length !== 6) && { opacity: 0.5 }]} onPress={() => void changeFingerprint()}>
              <Text style={styles.primaryText}>Verify PIN and continue</Text>
            </Pressable>
            <Pressable style={styles.linkButton} onPress={() => setFingerprintModal(false)}><Text style={styles.linkText}>Cancel</Text></Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 15, backgroundColor: colors.surface, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { color: colors.onSurface, fontSize: 16, fontWeight: "900" },
  cardHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  status: { borderRadius: 20, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.brandTertiary },
  statusText: { color: colors.brandPrimary, fontSize: 11, fontWeight: "800" },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, backgroundColor: colors.surfaceTertiary, color: colors.onSurface, fontSize: 14 },
  primary: { minHeight: 46, borderRadius: 11, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  primaryText: { color: colors.onBrandPrimary, fontSize: 13, fontWeight: "900" },
  linkButton: { minHeight: 34, alignItems: "center", justifyContent: "center" },
  linkText: { color: colors.brandPrimary, fontWeight: "800", fontSize: 12 },
  secondaryButton: { flexDirection: "row", minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: 11, alignItems: "center", justifyContent: "center", gap: 8 },
  secondaryText: { color: colors.brandPrimary, fontWeight: "800", fontSize: 13 },
  visibilityRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 40, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 6 },
  visibilityLabel: { color: colors.onSurface, fontSize: 14, fontWeight: "700" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", alignItems: "center", padding: 24 },
  dialog: { width: "100%", maxWidth: 370, borderRadius: 16, backgroundColor: colors.surface, padding: 18, gap: 10 },
  error: { color: colors.error, fontWeight: "700", fontSize: 12 },
}));
