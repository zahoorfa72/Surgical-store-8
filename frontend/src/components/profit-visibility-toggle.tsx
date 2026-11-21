import React, { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { makeStyles, useTheme } from "@/src/theme";
import { authenticateWithBiometric, isAdminPinConfigured, isBiometricUnlockEnabled, updateProfitVisibilityCache, useProfitVisibility, verifyAdminPin } from "@/src/security/finance-security";

export function ProfitVisibilityToggle({ kind }: { kind: "gross" | "net" }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const router = useRouter();
  const visibility = useProfitVisibility();
  const hidden = kind === "gross" ? visibility.grossHidden : visibility.netHidden;
  const label = kind === "gross" ? "Gross profit" : "Net profit";
  const [modalOpen, setModalOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (!hidden) {
      await updateProfitVisibilityCache(queryClient, kind, true);
      return;
    }
    setBusy(true);
    try {
      if (await isBiometricUnlockEnabled()) {
        try {
          const verified = await authenticateWithBiometric();
          if (verified) {
            await updateProfitVisibilityCache(queryClient, kind, false);
            setError("");
            return;
          }
        } catch {
          // A cancelled or unsuccessful fingerprint prompt falls back to the admin PIN.
        }
        setError("Fingerprint was not verified. Enter the administrator PIN to unhide this value.");
      } else {
        setError("");
      }
      const configured = await isAdminPinConfigured();
      if (!configured) {
        setError("Fingerprint was not verified. Ask the administrator to set a 6-digit app PIN in Security & Privacy.");
      }
      setPin("");
      setModalOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (busy || pin.length !== 6) return;
    setBusy(true);
    try {
      if (!(await verifyAdminPin(pin))) {
        setError("Incorrect administrator PIN.");
        setPin("");
        return;
      }
      await updateProfitVisibilityCache(queryClient, kind, false);
      setModalOpen(false);
      setError("");
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={hidden ? `Unhide ${label}` : `Hide ${label}`}
        testID={`profit-visibility-${kind}`}
        onPress={() => void toggle()}
        style={styles.iconButton}
        hitSlop={8}
      >
        <MaterialDesignIcons name={hidden ? "eye-off-outline" : "eye-outline"} size={19} color={hidden ? colors.muted : colors.brandPrimary} />
      </Pressable>
      <Modal visible={modalOpen} transparent animationType="fade" onRequestClose={() => setModalOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setModalOpen(false)}>
          <Pressable style={styles.dialog} onPress={() => {}}>
            <Text style={styles.title}>Unhide {label}</Text>
            <Text style={styles.hint}>Enter the administrator's 6-digit PIN to show this value across the app.</Text>
            <TextInput
              testID={`profit-unhide-pin-${kind}`}
              value={pin}
              onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit admin PIN"
              placeholderTextColor={colors.muted}
              secureTextEntry
              keyboardType="number-pad"
              maxLength={6}
              style={styles.input}
            />
            {!!error && <Text style={styles.error}>{error}</Text>}
            <Pressable disabled={busy || pin.length !== 6} onPress={() => void reveal()} style={[styles.primary, (busy || pin.length !== 6) && { opacity: 0.5 }]}>
              <Text style={styles.primaryText}>Verify and unhide</Text>
            </Pressable>
            <Pressable style={styles.cancel} onPress={() => setModalOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => { setModalOpen(false); router.push("/security"); }} style={styles.recovery}>
              <Text style={styles.recoveryText}>Forgot PIN? Open Security & Privacy</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  iconButton: { minWidth: 28, minHeight: 28, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.surfaceTertiary },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 22 },
  dialog: { width: "100%", maxWidth: 380, borderRadius: 18, backgroundColor: colors.surface, padding: 18, gap: 10 },
  title: { color: colors.onSurface, fontSize: 17, fontWeight: "900" },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.onSurface, backgroundColor: colors.surfaceTertiary, textAlign: "center", fontSize: 20, letterSpacing: 8 },
  error: { color: colors.error, fontSize: 12, fontWeight: "700" },
  primary: { minHeight: 44, borderRadius: 10, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center" },
  primaryText: { color: colors.onBrandPrimary, fontWeight: "900" },
  cancel: { minHeight: 38, alignItems: "center", justifyContent: "center" },
  cancelText: { color: colors.muted, fontWeight: "700" },
  recovery: { alignItems: "center", paddingTop: 2 },
  recoveryText: { color: colors.brandPrimary, fontSize: 11, fontWeight: "700" },
}));
