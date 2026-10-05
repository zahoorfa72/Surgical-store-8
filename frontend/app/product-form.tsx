import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { useProducts, qk } from "@/src/data";
import { BarcodeScannerModal } from "@/src/components/barcode-scanner";
import { Field, PrimaryButton, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function ProductForm() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { data: products } = useProducts();
  const editing = !!id;

  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [purchase, setPurchase] = useState("0");
  const [sale, setSale] = useState("0");
  const [threshold, setThreshold] = useState("5");
  const [expiryDate, setExpiryDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  useEffect(() => {
    if (id && products) {
      const p = products.find((x) => x.id === id);
      if (p) {
        setName(p.name);
        setBarcode(p.barcode ?? "");
        setExpiryDate(p.expiry_date ?? "");
        setPurchase(String(p.purchase_price));
        setSale(String(p.sale_price));
        setThreshold(String(p.low_stock_threshold));
      }
    }
  }, [id, products]);

  const save = async () => {
    if (!name.trim()) {
      toast("Enter a product name", "error");
      return;
    }
    const normalizedName = name.trim().toLowerCase();
    const normalizedBarcode = barcode.trim();
    const duplicate = (products ?? []).find((p) =>
      p.id !== id &&
      ((normalizedBarcode && String(p.barcode ?? "").trim() === normalizedBarcode) ||
       p.name.trim().toLowerCase() === normalizedName)
    );
    if (duplicate) {
      toast(
        normalizedBarcode && String(duplicate.barcode ?? "").trim() === normalizedBarcode
          ? "Duplicate barcode: this product already exists"
          : "Duplicate product name: check the existing item before creating another",
        "error",
      );
      return;
    }
    if (expiryDate.trim() && Number.isNaN(new Date(expiryDate.trim()).getTime())) {
      toast("Use a valid expiry date such as 2027-12-31", "error");
      return;
    }
    setBusy(true);
    const body = {
      name: name.trim(),
      barcode: barcode.trim(),
      purchase_price: parseFloat(purchase) || 0,
      sale_price: parseFloat(sale) || 0,
      low_stock_threshold: parseFloat(threshold) || 0,
      expiry_date: expiryDate.trim() || null,
    };
    try {
      if (editing) await apiRequest(`/products/${id}`, { method: "PUT", body });
      else await apiRequest("/products", { method: "POST", body });
      await queryClient.invalidateQueries({ queryKey: qk.products });
      toast(editing ? "Product updated" : "Product added", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={editing ? "Edit product" : "New product"}
        topInset={insets.top}
        onBack={() => router.back()}
      />
      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}
        bottomOffset={20}
      >
        <Field label="Product name" testID="product-name-input" value={name} onChangeText={setName} placeholder="e.g. Surgical gloves (box)" />
        <View style={styles.barcodeRow}>
          <View style={{ flex: 1 }}>
            <Field label="Barcode" testID="product-barcode-input" value={barcode} onChangeText={setBarcode} placeholder="Scan or type" autoCapitalize="none" />
          </View>
          <Pressable testID="scan-barcode-button" style={styles.scanBtn} onPress={() => setScanOpen(true)}>
            <MaterialDesignIcons name="barcode-scan" size={24} color={colors.onBrandPrimary} />
          </Pressable>
        </View>
        <Field label="Purchase price (per unit)" testID="product-purchase-input" value={purchase} onChangeText={setPurchase} keyboardType="numeric" />
        <Field label="Sale price (per unit)" testID="product-sale-input" value={sale} onChangeText={setSale} keyboardType="numeric" />
        <Field label="Expiry date" hint="Optional · use YYYY-MM-DD" testID="product-expiry-input" value={expiryDate} onChangeText={setExpiryDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />
        <Field label="Low-stock alert at" hint="Warn when quantity falls to this level" testID="product-threshold-input" value={threshold} onChangeText={setThreshold} keyboardType="numeric" />
        <PrimaryButton label={editing ? "Save changes" : "Add product"} onPress={save} busy={busy} testID="save-product-button" />
      </KeyboardAwareScrollView>

      <BarcodeScannerModal
        visible={scanOpen}
        onClose={() => setScanOpen(false)}
        onScanned={(value) => {
          setBarcode(value);
          setScanOpen(false);
          toast("Barcode captured", "success");
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  barcodeRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  scanBtn: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
}));
