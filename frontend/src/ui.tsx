import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TextInputProps,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { makeStyles, useTheme } from "@/src/theme";
import { useIsOnline } from "@/src/use-online";
import { getConnectionMode, setConnectionMode } from "@/src/api";
import type { ConnectionMode } from "@/src/api";

export { money, num, formatDate, formatDateTime, CURRENCY } from "@/src/format";

// ---------------------------------------------------------------------------
// Manual connection mode
// ---------------------------------------------------------------------------
export function ConnectionModeSelector() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [mode, setMode] = useState<ConnectionMode>("offline");

  useEffect(() => {
    getConnectionMode().then(setMode);
  }, []);

  const choose = async (next: ConnectionMode) => {
    setMode(next);
    await setConnectionMode(next);
  };

  return (
    <View style={styles.modeCard} testID="connection-mode-selector">
      <View style={styles.modeTitleRow}>
        <MaterialDesignIcons name={mode === "online" ? "cloud-check" : "cloud-off-outline"} size={20} color={mode === "online" ? colors.success : colors.muted} />
        <View style={{ flex: 1 }}>
          <Text style={styles.modeTitle}>Data mode</Text>
          <Text style={styles.modeHint}>
            {mode === "online" ? "Use the server for live data" : "Use phone storage; changes sync later"}
          </Text>
        </View>
      </View>
      <View style={styles.modeButtons}>
        {(["offline", "online"] as ConnectionMode[]).map((value) => (
          <Pressable
            key={value}
            testID={`connection-mode-${value}`}
            onPress={() => choose(value)}
            style={[styles.modeButton, mode === value && styles.modeButtonActive]}
          >
            <MaterialDesignIcons
              name={value === "online" ? "cloud" : "cloud-off-outline"}
              size={18}
              color={mode === value ? colors.onBrandPrimary : colors.onSurface}
            />
            <Text style={[styles.modeButtonText, mode === value && styles.modeButtonTextActive]}>
              {value === "online" ? "Online" : "Offline"}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Server status chip (Live / Offline) shown on top-level screens
// ---------------------------------------------------------------------------
export function ServerStatusChip() {
  const styles = useStyles();
  const { colors } = useTheme();
  const online = useIsOnline();
  return (
    <View
      testID="server-status-chip"
      style={[
        styles.statusChip,
        { backgroundColor: online ? colors.success + "1A" : colors.surfaceTertiary },
      ]}
    >
      <View style={[styles.statusDot, { backgroundColor: online ? colors.success : colors.muted }]} />
      <Text
        testID="server-status-text"
        style={[styles.statusText, { color: online ? colors.success : colors.muted }]}
      >
        {online ? "Live" : "Offline"}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
export function ScreenHeader({
  title,
  subtitle,
  topInset,
  right,
  onBack,
  showStatus,
}: {
  title: string;
  subtitle?: string;
  topInset: number;
  right?: React.ReactNode;
  onBack?: () => void;
  showStatus?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.header, { paddingTop: topInset + 10 }]}>
      {onBack && (
        <Pressable testID="header-back-button" onPress={onBack} style={styles.backBtn} hitSlop={10}>
          <MaterialDesignIcons name="chevron-left" size={28} color={colors.onSurface} />
        </Pressable>
      )}
      <View style={styles.headerText}>
        <Text style={styles.headerTitle} testID="screen-title" numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
      </View>
      <View style={styles.headerRight}>
        {showStatus && <ServerStatusChip />}
        {right}
      </View>
    </View>
  );
}

export function IconButton({
  name,
  onPress,
  testID,
  tone = "default",
}: {
  name: string;
  onPress: () => void;
  testID?: string;
  tone?: "default" | "brand";
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        tone === "brand" && styles.iconButtonBrand,
        pressed && styles.pressed,
      ]}
    >
      <MaterialDesignIcons
        name={name as any}
        size={22}
        color={tone === "brand" ? colors.onBrandPrimary : colors.onSurface}
      />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
export function PrimaryButton({
  label,
  onPress,
  busy,
  disabled,
  testID,
  icon,
  tone = "brand",
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
  icon?: string;
  tone?: "brand" | "danger";
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={busy || disabled}
      style={({ pressed }) => [
        styles.primaryButton,
        tone === "danger" && styles.dangerButton,
        (busy || disabled) && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.onBrandPrimary} />
      ) : (
        <View style={styles.btnRow}>
          {icon && (
            <MaterialDesignIcons name={icon as any} size={20} color={colors.onBrandPrimary} />
          )}
          <Text style={styles.primaryButtonText}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  testID,
  icon,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  icon?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
    >
      <View style={styles.btnRow}>
        {icon && <MaterialDesignIcons name={icon as any} size={20} color={colors.brandPrimary} />}
        <Text style={styles.secondaryButtonText}>{label}</Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
export function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & TextInputProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.muted} {...props} />
      {!!hint && <Text style={styles.fieldHint}>{hint}</Text>}
    </View>
  );
}

// Horizontal chip row (single-line, scrolls). Selected changes color only.
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testIDPrefix?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.chipRowWrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRowContent}
      >
        {options.map((o) => {
          const active = o.key === value;
          return (
            <Pressable
              key={o.key}
              testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
              onPress={() => onChange(o.key)}
              style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}
            >
              <Text style={active ? styles.chipTextActive : styles.chipText}>{o.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  const styles = useStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}

export function StatTile({
  label,
  value,
  icon,
  tone = "brand",
  testID,
}: {
  label: string;
  value: string;
  icon: string;
  tone?: "brand" | "success" | "warning" | "error" | "info" | "muted";
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const toneColor = {
    brand: colors.brandPrimary,
    success: colors.success,
    warning: colors.warning,
    error: colors.error,
    info: colors.info,
    muted: colors.muted,
  }[tone];
  return (
    <View style={styles.statTile} testID={testID}>
      <View style={[styles.statIcon, { backgroundColor: toneColor + "1A" }]}>
        <MaterialDesignIcons name={icon as any} size={20} color={toneColor} />
      </View>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function Badge({ text, tone = "brand" }: { text: string; tone?: "brand" | "success" | "warning" | "error" | "muted" }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const bg = {
    brand: colors.brandSecondary,
    success: colors.success + "22",
    warning: colors.warning + "22",
    error: colors.error + "22",
    muted: colors.surfaceTertiary,
  }[tone];
  const fg = {
    brand: colors.onBrandSecondary,
    success: colors.success,
    warning: colors.warning,
    error: colors.error,
    muted: colors.onSurfaceTertiary,
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{text}</Text>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  testID,
}: {
  icon: string;
  title: string;
  message: string;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.empty} testID={testID}>
      <View style={styles.emptyIcon}>
        <MaterialDesignIcons name={icon as any} size={40} color={colors.brandPrimary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
    </View>
  );
}

export function Loader() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40 }}>
      <ActivityIndicator size="large" color={colors.brandPrimary} />
    </View>
  );
}

export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalScrim} onPress={onCancel}>
        <Pressable style={styles.modalCard} onPress={() => {}}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalMessage}>{message}</Text>
          <View style={styles.modalActions}>
            <Pressable
              testID="confirm-cancel-button"
              style={({ pressed }) => [styles.modalCancel, pressed && styles.pressed]}
              onPress={onCancel}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="confirm-ok-button"
              style={({ pressed }) => [styles.modalConfirm, pressed && styles.pressed]}
              onPress={onConfirm}
            >
              <Text style={styles.modalConfirmText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
type ToastKind = "success" | "error" | "info";
type ToastState = { message: string; kind: ToastKind } | null;
const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  const styles = useStyles();
  const { colors } = useTheme();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (message: string, kind: ToastKind = "success") => {
      setToast({ message, kind });
      if (timer.current) clearTimeout(timer.current);
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 8 }).start();
      timer.current = setTimeout(() => {
        Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true }).start(() =>
          setToast(null)
        );
      }, 2600);
    },
    [anim]
  );

  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  const kindColor = toast
    ? { success: colors.success, error: colors.error, info: colors.info }[toast.kind]
    : colors.success;
  const kindIcon = toast
    ? { success: "check-circle", error: "alert-circle", info: "information" }[toast.kind]
    : "check-circle";

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Animated.View
          pointerEvents="none"
          testID="app-toast"
          style={[
            styles.toast,
            {
              top: insets.top + 8,
              opacity: anim,
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) },
              ],
            },
          ]}
        >
          <MaterialDesignIcons name={kindIcon as any} size={20} color={kindColor} />
          <Text style={styles.toastText}>{toast.message}</Text>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

const useStyles = makeStyles((colors) => ({
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: 10,
  },
  backBtn: { paddingBottom: 2, marginLeft: -8 },
  headerText: { flex: 1, gap: 2 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { fontSize: 24, fontWeight: "800", color: colors.onSurface },
  headerSubtitle: { fontSize: 13, color: colors.muted },
  modeCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    gap: 10,
  },
  modeTitleRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  modeTitle: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  modeHint: { fontSize: 11, color: colors.muted, marginTop: 2 },
  modeButtons: { flexDirection: "row", gap: 8 },
  modeButton: {
    flex: 1, minHeight: 42, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, alignItems: "center", justifyContent: "center",
    flexDirection: "row", gap: 6,
  },
  modeButtonActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  modeButtonText: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  modeButtonTextActive: { color: colors.onBrandPrimary },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    height: 28,
    borderRadius: 14,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: "700" },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceTertiary,
  },
  iconButtonBrand: { backgroundColor: colors.brandPrimary },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  primaryButton: {
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  dangerButton: { backgroundColor: colors.error },
  primaryButtonText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "700" },
  secondaryButton: {
    backgroundColor: colors.brandTertiary,
    borderRadius: 14,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  secondaryButtonText: { color: colors.brandPrimary, fontSize: 16, fontWeight: "700" },
  buttonDisabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.onSurfaceSecondary },
  fieldHint: { fontSize: 12, color: colors.muted },
  input: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.onSurface,
    minHeight: 52,
  },
  chipRowWrap: { height: 56, justifyContent: "center" },
  chipRowContent: { paddingHorizontal: 20, gap: 8, alignItems: "center" },
  chip: {
    height: 36,
    flexShrink: 0,
    paddingHorizontal: 16,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  chipIdle: { backgroundColor: colors.surface, borderColor: colors.border },
  chipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  chipText: { fontSize: 14, fontWeight: "600", color: colors.onSurfaceSecondary },
  chipTextActive: { fontSize: 14, fontWeight: "700", color: colors.onBrandPrimary },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  statTile: {
    flex: 1,
    minWidth: "44%",
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statValue: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  statLabel: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, alignSelf: "flex-start" },
  badgeText: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.3 },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 56, paddingHorizontal: 32, gap: 10 },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.onSurface },
  emptyMessage: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 20 },
  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  modalCard: { width: "100%", backgroundColor: colors.surface, borderRadius: 18, padding: 22, gap: 10 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  modalMessage: { fontSize: 14, color: colors.onSurfaceSecondary, lineHeight: 20 },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 12 },
  modalCancel: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceTertiary,
  },
  modalCancelText: { fontSize: 15, fontWeight: "600", color: colors.onSurfaceSecondary },
  modalConfirm: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.error,
  },
  modalConfirmText: { fontSize: 15, fontWeight: "700", color: colors.onError },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surfaceInverse,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
  },
  toastText: { flex: 1, color: colors.onSurfaceInverse, fontSize: 14, fontWeight: "600" },
}));
