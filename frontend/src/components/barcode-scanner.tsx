import { useRef, useState } from "react";
import { Linking, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { makeStyles, useTheme } from "@/src/theme";

// Reusable barcode scanner. Handles all camera permission states and returns
// the scanned value once via onScanned, then the parent should close it.
export function BarcodeScannerModal({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  onScanned: (value: string) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const lock = useRef(false);
  const [requesting, setRequesting] = useState(false);

  const handleScan = (value: string) => {
    if (lock.current) return;
    lock.current = true;
    onScanned(value);
    setTimeout(() => {
      lock.current = false;
    }, 1200);
  };

  const ask = async () => {
    setRequesting(true);
    await requestPermission();
    setRequesting(false);
  };

  const granted = permission?.granted;
  const canAskAgain = permission?.canAskAgain ?? true;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
          <Text style={styles.title}>Scan barcode</Text>
          <Pressable testID="close-scanner-button" onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <MaterialDesignIcons name="close" size={26} color={colors.onSurface} />
          </Pressable>
        </View>

        {granted ? (
          <View style={styles.cameraWrap}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "qr", "codabar", "itf14"],
              }}
              onBarcodeScanned={({ data }) => data && handleScan(String(data))}
            />
            <View style={styles.reticle} pointerEvents="none">
              <View style={styles.frame} />
              <Text style={styles.hint}>Point the camera at a product barcode</Text>
            </View>
          </View>
        ) : (
          <View style={styles.permBox}>
            <View style={styles.permIcon}>
              <MaterialDesignIcons name="barcode-scan" size={44} color={colors.brandPrimary} />
            </View>
            <Text style={styles.permTitle}>Camera access needed</Text>
            <Text style={styles.permMsg}>
              Allow camera so you can scan product barcodes to add items instantly.
            </Text>
            {canAskAgain ? (
              <Pressable testID="allow-camera-button" style={styles.permBtn} onPress={ask} disabled={requesting}>
                <Text style={styles.permBtnText}>{requesting ? "Requesting…" : "Allow camera"}</Text>
              </Pressable>
            ) : (
              <Pressable testID="open-settings-button" style={styles.permBtn} onPress={() => Linking.openSettings()}>
                <Text style={styles.permBtnText}>Open Settings</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: "#000000" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: colors.surface,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  closeBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  cameraWrap: { flex: 1 },
  camera: { flex: 1 },
  reticle: { ...({ position: "absolute" } as any), top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center", gap: 20 },
  frame: {
    width: 260,
    height: 160,
    borderWidth: 3,
    borderColor: colors.onBrandPrimary,
    borderRadius: 16,
  },
  hint: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  permBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12, backgroundColor: colors.surface },
  permIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  permTitle: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  permMsg: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 20 },
  permBtn: {
    marginTop: 10,
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    paddingHorizontal: 28,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  permBtnText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "700" },
}));
