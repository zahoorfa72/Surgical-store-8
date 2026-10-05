import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useAuth, isAdmin } from "@/src/auth";
import { useSettings, useParties, qk } from "@/src/data";
import {
  getApiBaseOverride,
  logoUrl,
  setApiBaseOverride,
  updateSettingsRequest,
  uploadLogo,
} from "@/src/api";
import { storage } from "@/src/utils/storage";
import { Badge, ConfirmModal, Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { getFakeFinanceDisplay, setFakeFinanceDisplay, notifyFakeFinanceDisplay, getSecretControlsUnlocked, setSecretControlsUnlocked, getHiddenSupplierIds, setSupplierHidden } from "@/src/utils/finance-display";

export default function Settings() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user, logout } = useAuth();
  const admin = isAdmin(user?.role);
  const { data: settings } = useSettings();
  const { data: suppliers = [] } = useParties("supplier");

  const [confirm, setConfirm] = useState(false);
  const [storeName, setStoreName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [receiptFormat, setReceiptFormat] = useState<"thermal" | "a4">("thermal");
  const [receiptWidth, setReceiptWidth] = useState<56 | 72>(72);
  const [showSellProfitDiscount, setShowSellProfitDiscount] = useState(true);
  const [showInventoryProfitMargin, setShowInventoryProfitMargin] = useState(true);
  const [saleEditLockHours, setSaleEditLockHours] = useState("0");
  const [fakeFinanceDisplay, setFakeFinanceDisplayState] = useState(false);
  const [secretControlsUnlocked, setSecretControlsUnlockedState] = useState(false);
  const [adminNameTaps, setAdminNameTaps] = useState(0);
  const [hiddenSupplierIds, setHiddenSupplierIds] = useState<string[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);

  useEffect(() => {
    if (settings?.store_name) setStoreName(settings.store_name);
  }, [settings?.store_name]);
  useEffect(() => {
    setServerUrl(getApiBaseOverride() ?? "");
    void Promise.all([
      storage.getItem<string>("ssm.receiptFormat", "thermal"),
      storage.getItem<string>("ssm.receiptWidth", "72"),
      storage.getItem<boolean>("ssm.showSellProfitDiscount", true),
      storage.getItem<boolean>("ssm.showInventoryProfitMargin", true),
      storage.getItem<number>("ssm.saleEditLockHours", 0),
      getFakeFinanceDisplay(),
      getHiddenSupplierIds(),
    ]).then(async ([format, width, sellDetails, inventoryMargin, lockHours, fakeFinance, hiddenIds]) => {
      setReceiptFormat(format === "a4" ? "a4" : "thermal");
      setReceiptWidth(width === "56" ? 56 : 72);
      setShowSellProfitDiscount(sellDetails !== false);
      setShowInventoryProfitMargin(inventoryMargin !== false);
      setSaleEditLockHours(String(Math.max(0, Number(lockHours ?? 0))));
      setFakeFinanceDisplayState(fakeFinance === true);
      setSecretControlsUnlockedState(await getSecretControlsUnlocked());
      setHiddenSupplierIds(hiddenIds);
    });
  }, []);

  const doLogout = async () => {
    setConfirm(false);
    await logout();
    router.replace("/login");
  };

  const saveName = async () => {
    if (!storeName.trim()) return toast("Enter a store name", "error");
    setSavingName(true);
    try {
      await updateSettingsRequest(storeName.trim());
      await queryClient.invalidateQueries({ queryKey: qk.settings });
      toast("Store name updated", "success");
    } catch (e: any) {
      toast(e?.message || "Could not save", "error");
    } finally {
      setSavingName(false);
    }
  };

  const pickLogo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) {
        toast("Enable photo access in Settings to upload a logo", "error");
        Linking.openSettings();
      } else {
        toast("Photo access is needed to upload a logo", "error");
      }
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    setUploading(true);
    try {
      const name = asset.fileName || `logo.${(asset.uri.split(".").pop() || "png").split("?")[0]}`;
      const type = asset.mimeType || "image/png";
      await uploadLogo(asset.uri, name, type);
      await queryClient.invalidateQueries({ queryKey: qk.settings });
      toast("Logo updated", "success");
    } catch (e: any) {
      toast(e?.message || "Could not upload logo", "error");
    } finally {
      setUploading(false);
    }
  };

  const saveServerUrl = async () => {
    const clean = serverUrl.trim().replace(/\/+$/, "");
    if (clean && !/^https?:\/\//i.test(clean)) {
      return toast("URL must start with http:// or https://", "error");
    }
    await storage.setItem("ssm.serverurl", clean);
    setApiBaseOverride(clean || null);
    await queryClient.invalidateQueries();
    toast(clean ? "Server URL saved" : "Using default server", "success");
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="Settings" topInset={insets.top} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(user?.name?.[0] ?? "?").toUpperCase()}</Text>
          </View>
          <Pressable
            testID="administrator-name-secret"
            onPress={async () => {
              if (!admin) return;
              const next = adminNameTaps + 1;
              if (next >= 5) {
                setAdminNameTaps(0);
                const nextUnlocked = !secretControlsUnlocked;
                setSecretControlsUnlockedState(nextUnlocked);
                await setSecretControlsUnlocked(nextUnlocked);
                toast(nextUnlocked ? "Private controls unlocked" : "Private controls hidden", "success");
              } else {
                setAdminNameTaps(next);
              }
            }}
          >
            <Text style={styles.name}>{user?.name}</Text>
          </Pressable>
          <Text style={styles.email}>{user?.email}</Text>
          <Badge text={user?.role ?? ""} tone="brand" />
        </View>

        {admin && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Store branding</Text>
            <View style={styles.logoRow}>
              <View style={styles.logoBox}>
                {settings?.has_logo ? (
                  <Image
                    testID="settings-logo-preview"
                    source={{ uri: settings.pending_logo_uri || logoUrl(settings.logo_version) }}
                    style={styles.logoImg}
                    contentFit="contain"
                  />
                ) : (
                  <MaterialDesignIcons name="storefront-outline" size={30} color={colors.muted} />
                )}
              </View>
              <Pressable testID="upload-logo-button" style={styles.uploadBtn} onPress={pickLogo} disabled={uploading}>
                <MaterialDesignIcons name="image-plus" size={18} color={colors.brandPrimary} />
                <Text style={styles.uploadText}>{uploading ? "Uploading…" : settings?.has_logo ? "Change logo" : "Upload logo"}</Text>
              </Pressable>
            </View>
            <View style={{ height: 12 }} />
            <Field label="Store name" testID="store-name-input" value={storeName} onChangeText={setStoreName} placeholder="Surgical Store" />
            <View style={{ height: 12 }} />
            <PrimaryButton label="Save store name" onPress={saveName} busy={savingName} testID="save-store-name" />
          </View>
        )}

        {admin && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Server URL</Text>
            <Text style={styles.cardHint}>
              Leave blank to use the built-in server. Enter a URL to point the app at your own server.
            </Text>
            <View style={{ height: 10 }} />
            <Field
              label="Backend URL"
              testID="server-url-input"
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="https://your-server.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <View style={{ height: 12 }} />
            <PrimaryButton label="Save server URL" onPress={saveServerUrl} testID="save-server-url" />
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Bill / receipt format</Text>
          <Text style={styles.cardHint}>Choose the default format used when printing or creating a receipt PDF.</Text>
          <View style={styles.formatRow}>
            <Pressable
              testID="receipt-format-thermal"
              onPress={async () => { setReceiptFormat("thermal"); await storage.setItem("ssm.receiptFormat", "thermal"); toast("Thermal receipt selected", "success"); }}
              style={[styles.formatBtn, receiptFormat === "thermal" && styles.formatBtnActive]}
            >
              <MaterialDesignIcons name="printer" size={20} color={receiptFormat === "thermal" ? colors.onBrandPrimary : colors.brandPrimary} />
              <Text style={[styles.formatText, receiptFormat === "thermal" && styles.formatTextActive]}>Thermal</Text>
            </Pressable>
            <Pressable
              testID="receipt-format-a4"
              onPress={async () => { setReceiptFormat("a4"); await storage.setItem("ssm.receiptFormat", "a4"); toast("A4 bill selected", "success"); }}
              style={[styles.formatBtn, receiptFormat === "a4" && styles.formatBtnActive]}
            >
              <MaterialDesignIcons name="file-document-outline" size={20} color={receiptFormat === "a4" ? colors.onBrandPrimary : colors.brandPrimary} />
              <Text style={[styles.formatText, receiptFormat === "a4" && styles.formatTextActive]}>A4 Bill</Text>
            </Pressable>
          </View>
          {receiptFormat === "thermal" && (
            <View style={{ marginTop: 12 }}>
              <Text style={styles.cardHint}>Thermal paper width</Text>
              <View style={styles.widthRow}>
                {[72, 56].map((w) => (
                  <Pressable key={w} testID={"receipt-width-" + w} onPress={async () => { setReceiptWidth(w as 56 | 72); await storage.setItem("ssm.receiptWidth", String(w)); }} style={[styles.widthBtn, receiptWidth === w && styles.widthBtnActive]}>
                    <Text style={[styles.widthText, receiptWidth === w && styles.widthTextActive]}>{w} mm</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>

        {admin && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Financial visibility</Text>
            <Text style={styles.cardHint}>Control whether staff see sale discount/profit details and the inventory profit margin panel.</Text>
            <View style={styles.visibilityRow}>
              <View style={styles.visibilityText}>
                <Text style={styles.visibilityLabel}>Show discount & profit in Sell</Text>
                <Text style={styles.visibilityHint}>Applies to every sale screen on this device.</Text>
              </View>
              <Pressable
                testID="show-sell-profit-discount-toggle"
                accessibilityRole="switch"
                accessibilityState={{ checked: showSellProfitDiscount }}
                onPress={async () => {
                  const next = !showSellProfitDiscount;
                  setShowSellProfitDiscount(next);
                  await storage.setItem("ssm.showSellProfitDiscount", next);
                  toast(next ? "Sell discount & profit shown" : "Sell discount & profit hidden", "success");
                }}
                style={[styles.visibilityToggle, showSellProfitDiscount && styles.visibilityToggleOn]}
              >
                <View style={[styles.visibilityThumb, showSellProfitDiscount && styles.visibilityThumbOn]} />
              </Pressable>
            </View>
            <View style={styles.visibilityRow}>
              <View style={styles.visibilityText}>
                <Text style={styles.visibilityLabel}>Show inventory profit margin</Text>
                <Text style={styles.visibilityHint}>Controls the Inventory finance / margin panel.</Text>
              </View>
              <Pressable
                testID="show-inventory-profit-margin-toggle"
                accessibilityRole="switch"
                accessibilityState={{ checked: showInventoryProfitMargin }}
                onPress={async () => {
                  const next = !showInventoryProfitMargin;
                  setShowInventoryProfitMargin(next);
                  await storage.setItem("ssm.showInventoryProfitMargin", next);
                  toast(next ? "Inventory profit margin shown" : "Inventory profit margin hidden", "success");
                }}
                style={[styles.visibilityToggle, showInventoryProfitMargin && styles.visibilityToggleOn]}
              >
                <View style={[styles.visibilityThumb, showInventoryProfitMargin && styles.visibilityThumbOn]} />
              </Pressable>
            </View>
          </View>
        )}

        {admin && secretControlsUnlocked && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Private financial display</Text>
            <Text style={styles.cardHint}>
              When enabled, screens show display-only purchase costs and profit. Real purchase prices, profit, stock costs and finance calculations are never changed.
              Fake margin is deterministic between 15% and 20% and works offline and online.
            </Text>
            <View style={styles.visibilityRow}>
              <View style={styles.visibilityText}>
                <Text style={styles.visibilityLabel}>Hide real purchase & profit</Text>
                <Text style={styles.visibilityHint}>ON = real purchase/profit values are hidden in display screens. OFF = real values are shown.</Text>
              </View>
              <Pressable
                testID="fake-finance-display-toggle"
                accessibilityRole="switch"
                accessibilityState={{ checked: fakeFinanceDisplay }}
                onPress={async () => {
                  const next = !fakeFinanceDisplay;
                  await setFakeFinanceDisplay(next);
                  setFakeFinanceDisplayState(next);
                  notifyFakeFinanceDisplay(queryClient, next);
                  toast(next ? "Private financial display ON" : "Real purchase & profit display restored", "success");
                }}
                style={[styles.visibilityToggle, fakeFinanceDisplay && styles.visibilityToggleOn]}
              >
                <View style={[styles.visibilityThumb, fakeFinanceDisplay && styles.visibilityThumbOn]} />
              </Pressable>
            </View>
          </View>
          {suppliers.length > 0 && (
            <View style={{ marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.divider }}>
              <Text style={styles.cardTitle}>Hide supplier from financial screens</Text>
              <Text style={styles.cardHint}>Select a supplier, then use Hide supplier. Hidden suppliers disappear from supplier financial, purchase-history and payment-history screens. Their data is not deleted.</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 10 }}>
                {suppliers.map((s) => (
                  <Pressable key={s.id} testID={`select-hide-supplier-${s.id}`} onPress={() => setSelectedSupplierId(s.id)} style={[styles.supplierChip, selectedSupplierId === s.id && styles.supplierChipActive]}>
                    <Text style={[styles.supplierChipText, selectedSupplierId === s.id && styles.supplierChipTextActive]}>{s.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              {selectedSupplierId && (
                <Pressable
                  testID="hide-selected-supplier"
                  style={styles.hideSupplierButton}
                  onPress={async () => {
                    const hidden = !hiddenSupplierIds.includes(selectedSupplierId);
                    await setSupplierHidden(selectedSupplierId, hidden);
                    const next = hidden ? [...hiddenSupplierIds, selectedSupplierId] : hiddenSupplierIds.filter((id) => id !== selectedSupplierId);
                    setHiddenSupplierIds(next);
                  }}
                >
                  <MaterialDesignIcons name={hiddenSupplierIds.includes(selectedSupplierId) ? "eye-off" : "eye-off-outline"} size={19} color={colors.onBrandPrimary} />
                  <Text style={styles.hideSupplierText}>{hiddenSupplierIds.includes(selectedSupplierId) ? "Unhide selected supplier" : "Hide selected supplier"}</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
        )}

        {admin && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sale edit protection</Text>
            <Text style={styles.cardHint}>Optional safety lock for old sales. Enter 0 to keep unlimited editing. This changes only editing access, not finance calculations.</Text>
            <View style={{ height: 10 }} />
            <Field
              label="Lock sales older than (hours)"
              testID="sale-edit-lock-hours"
              value={saleEditLockHours}
              onChangeText={setSaleEditLockHours}
              keyboardType="numeric"
              placeholder="0"
            />
            <View style={{ height: 10 }} />
            <PrimaryButton
              label="Save edit protection"
              onPress={async () => {
                const hours = Math.max(0, Math.floor(Number(saleEditLockHours) || 0));
                setSaleEditLockHours(String(hours));
                await storage.setItem("ssm.saleEditLockHours", hours);
                toast(hours ? `Sales older than ${hours} hours will be locked` : "Sale editing is unlocked", "success");
              }}
              testID="save-sale-edit-lock"
            />
          </View>
        )}

        <View style={styles.infoCard}>
          <InfoRow icon="store" label="Store" value={settings?.store_name ?? "Surgical Store"} />
          <InfoRow icon="cash" label="Currency" value="Rs (PKR)" />
          <InfoRow icon="shield-check" label="Access level" value={user?.role ?? ""} />
        </View>

        <PrimaryButton label="Backup & Restore" icon="cloud-upload-outline" tone="brand" onPress={() => router.push("/backup-restore")} testID="backup-restore-button" />
        <PrimaryButton label="Sign out" icon="logout" tone="danger" onPress={() => setConfirm(true)} testID="logout-button" />
      </ScrollView>

      <ConfirmModal
        visible={confirm}
        title="Sign out?"
        message="You will need to log in again to continue."
        confirmLabel="Sign out"
        onConfirm={doLogout}
        onCancel={() => setConfirm(false)}
      />
    </View>
  );
}

function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.infoRow}>
      <MaterialDesignIcons name={icon as any} size={20} color={colors.brandPrimary} />
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  profileCard: {
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brandTertiary,
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  avatarText: { color: colors.onBrandPrimary, fontSize: 28, fontWeight: "800" },
  name: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  email: { fontSize: 14, color: colors.onSurfaceSecondary, marginBottom: 6 },
  card: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: "800", color: colors.onSurface, marginBottom: 6 },
  cardHint: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 8 },
  logoBox: {
    width: 64,
    height: 64,
    borderRadius: 14,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoImg: { width: "100%", height: "100%" },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.brandTertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
    paddingHorizontal: 16,
    height: 44,
  },
  uploadText: { fontSize: 14, fontWeight: "700", color: colors.brandPrimary },
  formatRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  formatBtn: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  formatBtnActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  formatText: { fontSize: 14, fontWeight: "800", color: colors.brandPrimary },
  formatTextActive: { color: colors.onBrandPrimary },
  widthRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  widthBtn: { flex: 1, minHeight: 42, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  widthBtnActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  widthText: { fontSize: 13, fontWeight: "800", color: colors.brandPrimary },
  widthTextActive: { color: colors.onBrandPrimary },
  supplierChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary },
  supplierChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  supplierChipText: { fontSize: 12, fontWeight: "700", color: colors.onSurface },
  supplierChipTextActive: { color: colors.onBrandPrimary },
  hideSupplierButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 44, borderRadius: 11, paddingHorizontal: 14, backgroundColor: colors.brandPrimary },
  hideSupplierText: { color: colors.onBrandPrimary, fontWeight: "800" },
  visibilityRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.divider },
  visibilityText: { flex: 1, gap: 3 },
  visibilityLabel: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  visibilityHint: { fontSize: 11, color: colors.muted, lineHeight: 16 },
  visibilityToggle: { width: 46, height: 26, borderRadius: 13, backgroundColor: colors.border, padding: 3, justifyContent: "center" },
  visibilityToggleOn: { backgroundColor: colors.brandPrimary },
  visibilityThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.surface, alignSelf: "flex-start" },
  visibilityThumbOn: { alignSelf: "flex-end" },
  infoCard: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: colors.divider },
  infoLabel: { flex: 1, fontSize: 15, color: colors.onSurface },
  infoValue: { fontSize: 14, color: colors.muted, fontWeight: "600", textTransform: "capitalize" },
}));
