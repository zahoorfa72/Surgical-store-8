import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import { recognizeText, isSupported } from "expo-mlkit-ocr";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { Product } from "@/src/models";
import { makeStyles, useTheme } from "@/src/theme";
import { enhanceOrderLinesWithAI } from "@/src/utils/order-ai";

type ParsedItem = {
  key: string;
  product: Product | null;
  rawText: string;
  quantity: number;
  maxStock: number;
  selected: boolean;
  confidence: number;
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string) {
  return normalize(value).split(" ").filter((x) => x.length > 1 && !/^\d+(\.\d+)?$/.test(x));
}

function comparisonForms(value: string) {
  const base = normalize(value).replace(/\s+/g, "");
  const confused = base
    .replace(/[oO]/g, "0")
    .replace(/[iIlL]/g, "1")
    .replace(/[sS]/g, "5")
    .replace(/[bB]/g, "8")
    .replace(/[gG]/g, "6")
    .replace(/[zZ]/g, "2");
  return [base, confused];
}

function bigramScore(a: string, b: string) {
  const aa = normalize(a).replace(/\s+/g, "");
  const bb = normalize(b).replace(/\s+/g, "");
  if (aa === bb) return 1;
  if (aa.length < 2 || bb.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < aa.length - 1; i++) {
    const key = aa.slice(i, i + 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < bb.length - 1; i++) {
    const key = bb.slice(i, i + 2);
    const n = counts.get(key) ?? 0;
    if (n > 0) {
      common++;
      counts.set(key, n - 1);
    }
  }
  return (2 * common) / Math.max(1, aa.length + bb.length - 2);
}

function extractQuantity(line: string) {
  const normalized = normalize(line);
  const explicit = normalized.match(/(?:qty|quantity|pcs|pieces|pack|packs|x)\s*[:=-]?\s*(\d+)\b/i);
  if (explicit) return Math.max(1, Number(explicit[1]));
  const prefix = normalized.match(/^\s*(\d+)\s*(?:x|pcs|pieces)?\b/i);
  if (prefix) return Math.max(1, Number(prefix[1]));
  const suffix = normalized.match(/(?:x|pcs|pieces)\s*(\d+)\s*$/i);
  if (suffix) return Math.max(1, Number(suffix[1]));
  return 1;
}

function cleanItemText(line: string) {
  return normalize(line)
    .replace(/^\s*\d+(?:\.\d+)?\s*[x×*:-]?\s*/, "")
    .replace(/[x×*:-]?\s*\d+(?:\.\d+)?\s*$/, "")
    .trim();
}

function levenshtein(a: string, b: string) {
  const aa = normalize(a);
  const bb = normalize(b);
  const prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) {
    let left = i;
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, left + 1, prev[j - 1] + cost);
      prev[j - 1] = left;
      left = next;
    }
    prev[bb.length] = left;
  }
  return prev[bb.length];
}

function matchProduct(line: string, products: Product[], minimum = 0.5) {
  const source = normalize(cleanItemText(line) || line);
  const sourceTokens = tokens(source);
  const sourceSet = new Set(sourceTokens);
  let best: { product: Product; score: number } | null = null;

  for (const p of products) {
    const name = normalize(p.name);
    const nameTokens = tokens(p.name);
    if (!name) continue;

    let score = nameTokens.length
      ? nameTokens.filter((t) => sourceSet.has(t)).length / nameTokens.length
      : 0;

    if (source && (source === name || source.includes(name) || name.includes(source))) score = Math.max(score, 0.92);
    if (p.sku && normalize(String(p.sku)) === source) score = 1;
    if (p.barcode && normalize(String(p.barcode)) === source) score = 1;

    const editScore = 1 - levenshtein(source, name) / Math.max(1, source.length, name.length);
    const typoScore = bigramScore(source, name);
    const confusionScore = Math.max(
      ...comparisonForms(source).flatMap((a) => comparisonForms(name).map((b) => bigramScore(a, b))),
    );

    // Strong word-level recovery for handwriting that destroys one word but leaves
    // the other words recognizable.
    const wordScores = sourceTokens.map((sw) => {
      if (sw.length < 2) return 0;
      return Math.max(
        ...nameTokens.map((nw) => {
          const d = levenshtein(sw, nw);
          return Math.max(1 - d / Math.max(sw.length, nw.length), bigramScore(sw, nw));
        }),
      );
    });
    const wordRecovery = wordScores.length
      ? wordScores.reduce((sum, value) => sum + value, 0) / wordScores.length
      : 0;

    score = Math.max(score, editScore, typoScore, confusionScore, wordRecovery * 0.97);
    if (score > (best?.score ?? 0)) best = { product: p, score };
  }
  return best && best.score >= minimum ? best : null;
}

export function OrderImageScannerModal({
  visible,
  products,
  onClose,
  onAddItems,
}: {
  visible: boolean;
  products: Product[];
  onClose: () => void;
  onAddItems: (items: { product: Product; quantity: number }[]) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<{ line: string; product: Product; score: number; quantity: number }[]>([]);
  const [processing, setProcessing] = useState(false);
  const [aiUsed, setAiUsed] = useState(false);
  const [rawText, setRawText] = useState("");

  const selectedCount = items.filter((x) => x.selected && x.product && x.quantity > 0).length;

  const reset = () => {
    setImageUri(null);
    setItems([]);
    setUnmatched([]);
    setSuggestions([]);
    setRawText("");
  };

  const processImage = async (uri: string) => {
    if (!isSupported()) {
      Alert.alert("OCR unavailable", "On-device OCR is not supported on this device.");
      return;
    }
    setImageUri(uri);
    setProcessing(true);
    setAiUsed(false);
    try {
      const result = await recognizeText(uri);

      // Build the OCR input from BOTH ML Kit line blocks and the full OCR text.
      // This recovers lines that are occasionally missing from one representation.
      const blockLines = (result.blocks ?? [])
        .flatMap((b: any) => (b.lines ?? []).map((l: any) => String(l.text ?? "")));
      const fullTextLines = String(result.text ?? "").split(/\r?\n/);
      const sourceLines = [...blockLines, ...fullTextLines]
        .map((x: string) => x.trim())
        .filter(Boolean)
        .filter((line, index, all) => {
          const key = normalize(line);
          return key && all.findIndex((other) => normalize(other) === key) === index;
        });
      // AI is intentionally the PRIMARY recognizer. OCR remains the fallback.
      // The AI helper itself is inventory-constrained, so it can only return real products.
      const aiLines = await enhanceOrderLinesWithAI(sourceLines, products);
      const aiChanged = aiLines.some((line, index) => line !== sourceLines[index]);
      setAiUsed(aiChanged);
      setRawText(sourceLines.join("\n"));

      const grouped = new Map<string, ParsedItem>();
      const misses: string[] = [];
      const suggested: { line: string; product: Product; score: number; quantity: number }[] = [];

      // Prefer AI output whenever it identifies a real inventory product. Only use
      // OCR/fuzzy matching for lines AI could not confidently correct.
      const primaryLines = aiChanged ? aiLines : sourceLines;
      for (let index = 0; index < primaryLines.length; index++) {
        const line = primaryLines[index];
        const aiWasDifferent = aiChanged && line !== sourceLines[index];
        const match = matchProduct(line, products, aiWasDifferent ? 0.42 : 0.5);
        const quantity = extractQuantity(line);
        if (!match) {
          const suggestion = matchProduct(line, products, 0.3);
          misses.push(line);
          if (suggestion) suggested.push({ line, product: suggestion.product, score: suggestion.score, quantity });
          continue;
        }
        const existing = grouped.get(match.product.id);
        if (existing) {
          existing.quantity = Math.min(existing.maxStock, existing.quantity + quantity);
          existing.rawText = existing.rawText + " | " + line;
        } else {
          grouped.set(match.product.id, {
            key: match.product.id,
            product: match.product,
            rawText: line,
            quantity: Math.min(match.product.quantity, quantity),
            maxStock: match.product.quantity,
            selected: match.product.quantity > 0,
            confidence: match.score,
          });
        }
      }

      setItems(Array.from(grouped.values()));
      setUnmatched(misses);
      setSuggestions(suggested.filter((x) => x.product.quantity > 0).slice(0, 20));
    } catch (error: any) {
      Alert.alert("Could not read order", error?.message || "Please use a clearer image and try again.");
      reset();
    } finally {
      setProcessing(false);
    }
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    if (!result.canceled && result.assets[0]?.uri) await processImage(result.assets[0].uri);
  };

  const openCamera = async () => {
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        if (!next.canAskAgain) Linking.openSettings();
        return;
      }
    }
    setCameraOpen(true);
  };

  const takePhoto = async () => {
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) {
        setCameraOpen(false);
        await processImage(photo.uri);
      }
    } catch (error: any) {
      Alert.alert("Camera error", error?.message || "Could not take the order photo.");
    }
  };

  const updateItem = (key: string, patch: Partial<ParsedItem>) => {
    setItems((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  };

  const addConfirmed = () => {
    const confirmed = items
      .filter((x) => x.selected && x.product && x.quantity > 0)
      .map((x) => ({
        product: x.product as Product,
        quantity: Math.min(Math.max(1, Math.floor(x.quantity)), x.maxStock),
      }));
    if (!confirmed.length) {
      Alert.alert("Nothing selected", "Select at least one recognized product.");
      return;
    }
    onAddItems(confirmed);
    onClose();
    reset();
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.root}>
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Scan order image</Text>
              <Text style={styles.subtitle}>Read product names and quantities from a written or printed order</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <MaterialDesignIcons name="close" size={26} color={colors.onSurface} />
            </Pressable>
          </View>

          {!imageUri ? (
            <View style={styles.startArea}>
              <View style={styles.heroIcon}>
                <MaterialDesignIcons name="text-box-search-outline" size={48} color={colors.brandPrimary} />
              </View>
              <Text style={styles.heroTitle}>Scan an order</Text>
              <Text style={styles.heroText}>AI analyzes the order first on the device. OCR remains available as the fallback; no order image is sent to an online OCR service.</Text>
              <View style={styles.actionRow}>
                <Pressable style={styles.primaryBtn} onPress={openCamera}>
                  <MaterialDesignIcons name="camera-outline" size={22} color={colors.onBrandPrimary} />
                  <Text style={styles.primaryBtnText}>Take photo</Text>
                </Pressable>
                <Pressable style={styles.secondaryBtn} onPress={pickImage}>
                  <MaterialDesignIcons name="image-outline" size={22} color={colors.brandPrimary} />
                  <Text style={styles.secondaryBtnText}>Choose image</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="contain" />
              {processing ? (
                <View style={styles.processing}>
                  <ActivityIndicator size="small" color={colors.brandPrimary} />
                  <Text style={styles.processingText}>AI is analyzing the order on this device…</Text>
                </View>
              ) : (
                <>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Recognized products</Text>
                    <Text style={styles.sectionMeta}>{selectedCount} selected</Text>
                  </View>
                  {aiUsed && (
                    <View style={styles.aiBadge}>
                      <MaterialDesignIcons name="brain" size={17} color={colors.brandPrimary} />
                      <Text style={styles.aiBadgeText}>On-device AI corrected OCR matches</Text>
                    </View>
                  )}

                  {items.length === 0 ? (
                    <View style={styles.emptyBox}>
                      <MaterialDesignIcons name="magnify-close" size={30} color={colors.muted} />
                      <Text style={styles.emptyText}>No inventory product could be matched.</Text>
                    </View>
                  ) : (
                    items.map((item) => {
                      const product = item.product!;
                      const over = item.quantity > item.maxStock;
                      return (
                        <View key={item.key} style={[styles.itemCard, !item.selected && styles.itemCardOff]}>
                          <Pressable
                            style={styles.check}
                            onPress={() => updateItem(item.key, { selected: !item.selected })}
                            hitSlop={8}
                          >
                            <MaterialDesignIcons
                              name={item.selected ? "checkbox-marked" : "checkbox-blank-outline"}
                              size={25}
                              color={item.selected ? colors.brandPrimary : colors.muted}
                            />
                          </Pressable>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.itemName}>{product.name}</Text>
                            <Text style={styles.itemMeta}>Stock: {product.quantity} · OCR match {Math.round(item.confidence * 100)}%</Text>
                            <Text style={styles.ocrLine} numberOfLines={2}>“{item.rawText}”</Text>
                          </View>
                          <View style={styles.qtyBox}>
                            <Text style={styles.qtyLabel}>Qty</Text>
                            <TextInput
                              value={String(item.quantity)}
                              onChangeText={(text) => {
                                const n = Number(text.replace(/[^0-9]/g, ""));
                                updateItem(item.key, { quantity: Number.isFinite(n) ? n : 0 });
                              }}
                              keyboardType="number-pad"
                              style={[styles.qtyInput, over && { borderColor: colors.error }]}
                            />
                            <Text style={styles.maxText}>max {item.maxStock}</Text>
                          </View>
                        </View>
                      );
                    })
                  )}

                  {unmatched.length > 0 && (
                    <View style={styles.unmatchedBox}>
                      <View style={styles.unmatchedTitleRow}>
                        <MaterialDesignIcons name="alert-outline" size={20} color={colors.warning} />
                        <Text style={styles.unmatchedTitle}>Best matches — please confirm</Text>
                      </View>
                      {unmatched.map((line, i) => {
                        const suggestion = suggestions.find((s) => s.line === line);
                        return (
                          <View key={i} style={styles.suggestionRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.unmatchedLine}>“{line}”</Text>
                              <Text style={styles.suggestionText}>
                                {suggestion
                                  ? `Best match: ${suggestion.product.name} · ${Math.round(suggestion.score * 100)}% match`
                                  : "No close inventory product found"}
                              </Text>
                            </View>
                            {suggestion && (
                              <Pressable
                                style={styles.useSuggestionBtn}
                                onPress={() => {
                                  setItems((prev) => [...prev, {
                                    key: `suggestion-${suggestion.product.id}-${Date.now()}`,
                                    product: suggestion.product,
                                    rawText: suggestion.line,
                                    quantity: Math.min(suggestion.quantity, suggestion.product.quantity),
                                    maxStock: suggestion.product.quantity,
                                    selected: suggestion.product.quantity > 0,
                                    confidence: suggestion.score,
                                  }]);
                                  setSuggestions((prev) => prev.filter((x) => x.line !== line));
                                  setUnmatched((prev) => prev.filter((x) => x !== line));
                                }}
                              >
                                <Text style={styles.useSuggestionText}>Use</Text>
                              </Pressable>
                            )}
                          </View>
                        );
                      })}
                      <Text style={styles.unmatchedHint}>Spelling mistakes are matched automatically. Review the suggested product before adding it to the cart.</Text>
                    </View>
                  )}

                  <View style={styles.rawBox}>
                    <Text style={styles.rawTitle}>OCR text</Text>
                    <Text style={styles.rawText}>{rawText || "No text recognized."}</Text>
                  </View>

                  <View style={styles.bottomRow}>
                    <Pressable style={styles.secondaryBtn} onPress={reset}>
                      <MaterialDesignIcons name="refresh" size={20} color={colors.brandPrimary} />
                      <Text style={styles.secondaryBtnText}>Scan again</Text>
                    </Pressable>
                    <Pressable style={styles.primaryBtn} onPress={addConfirmed}>
                      <MaterialDesignIcons name="cart-plus" size={20} color={colors.onBrandPrimary} />
                      <Text style={styles.primaryBtnText}>Add selected to cart</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </ScrollView>
          )}
        </View>
      </Modal>

      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        <View style={styles.cameraRoot}>
          <CameraView ref={cameraRef} style={styles.camera} facing="back" />
          <View style={styles.cameraOverlay}>
            <View style={styles.cameraTop}>
              <Text style={styles.cameraTitle}>Take order photo</Text>
              <Pressable onPress={() => setCameraOpen(false)} hitSlop={10}>
                <MaterialDesignIcons name="close" size={28} color="#FFFFFF" />
              </Pressable>
            </View>
            <View style={styles.cameraFrame} />
            <Text style={styles.cameraHint}>Keep the whole order inside the frame and use good lighting.</Text>
            <Pressable style={styles.capture} onPress={takePhoto}>
              <View style={styles.captureInner} />
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 18, paddingTop: 22, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 21, fontWeight: "900", color: colors.onSurface },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 4, lineHeight: 17 },
  startArea: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  heroIcon: { width: 92, height: 92, borderRadius: 46, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandTertiary, marginBottom: 16 },
  heroTitle: { fontSize: 22, fontWeight: "900", color: colors.onSurface },
  heroText: { fontSize: 14, lineHeight: 21, color: colors.muted, textAlign: "center", marginTop: 8, maxWidth: 360 },
  actionRow: { width: "100%", gap: 10, marginTop: 24 },
  primaryBtn: { minHeight: 50, borderRadius: 13, paddingHorizontal: 16, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  primaryBtnText: { color: colors.onBrandPrimary, fontWeight: "900", fontSize: 14 },
  secondaryBtn: { minHeight: 50, borderRadius: 13, paddingHorizontal: 16, borderWidth: 1, borderColor: colors.brandPrimary, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  secondaryBtnText: { color: colors.brandPrimary, fontWeight: "900", fontSize: 14 },
  content: { padding: 16, paddingBottom: 28, gap: 12 },
  preview: { width: "100%", height: 190, borderRadius: 14, backgroundColor: colors.surfaceTertiary },
  processing: { minHeight: 120, alignItems: "center", justifyContent: "center", gap: 10 },
  processingText: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  sectionTitle: { fontSize: 17, fontWeight: "900", color: colors.onSurface },
  sectionMeta: { fontSize: 12, color: colors.brandPrimary, fontWeight: "800" },
  aiBadge: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 10, backgroundColor: colors.brandTertiary, borderWidth: 1, borderColor: colors.brandPrimary + "40" },
  aiBadgeText: { fontSize: 11, color: colors.brandPrimary, fontWeight: "800" },
  itemCard: { flexDirection: "row", alignItems: "center", gap: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, backgroundColor: colors.surfaceSecondary },
  itemCardOff: { opacity: 0.55 },
  check: { width: 28, alignItems: "center" },
  itemName: { fontSize: 14, fontWeight: "800", color: colors.onSurface },
  itemMeta: { fontSize: 11, color: colors.muted, marginTop: 3 },
  ocrLine: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 5 },
  qtyBox: { width: 72, alignItems: "center" },
  qtyLabel: { fontSize: 10, color: colors.muted, fontWeight: "700" },
  qtyInput: { width: 62, height: 40, borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: colors.surface, textAlign: "center", fontWeight: "800", color: colors.onSurface, marginTop: 3 },
  maxText: { fontSize: 9, color: colors.muted, marginTop: 2 },
  unmatchedBox: { borderWidth: 1, borderColor: colors.warning, borderRadius: 13, padding: 13, backgroundColor: colors.warning + "12" },
  unmatchedTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  unmatchedTitle: { fontSize: 14, fontWeight: "900", color: colors.warning },
  unmatchedLine: { fontSize: 13, color: colors.onSurface, marginTop: 4 },
  suggestionRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 7, padding: 9, borderRadius: 10, backgroundColor: colors.surface },
  suggestionText: { flex: 1, fontSize: 11, color: colors.onSurfaceSecondary, lineHeight: 16 },
  useSuggestionBtn: { minHeight: 36, paddingHorizontal: 14, borderRadius: 9, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center" },
  useSuggestionText: { color: colors.onBrandPrimary, fontSize: 12, fontWeight: "900" },
  unmatchedHint: { fontSize: 11, color: colors.muted, marginTop: 8, lineHeight: 16 },
  rawBox: { borderWidth: 1, borderColor: colors.border, borderRadius: 13, padding: 13, backgroundColor: colors.surfaceTertiary },
  rawTitle: { fontSize: 12, fontWeight: "900", color: colors.onSurface, marginBottom: 6 },
  rawText: { fontSize: 11, lineHeight: 17, color: colors.muted },
  bottomRow: { flexDirection: "row", gap: 9, marginTop: 4 },
  cameraRoot: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  cameraOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "space-between", padding: 22, paddingTop: 52, paddingBottom: 36 },
  cameraTop: { width: "100%", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cameraTitle: { color: "#FFF", fontSize: 20, fontWeight: "900" },
  cameraFrame: { width: "88%", height: 300, borderWidth: 2, borderColor: "#FFF", borderRadius: 18 },
  cameraHint: { color: "#FFF", fontSize: 13, textAlign: "center", paddingHorizontal: 20 },
  capture: { width: 78, height: 78, borderRadius: 39, borderWidth: 5, borderColor: "#FFF", alignItems: "center", justifyContent: "center" },
  captureInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFF" },
  emptyBox: { borderWidth: 1, borderColor: colors.border, borderRadius: 13, padding: 24, alignItems: "center", gap: 8 },
  emptyText: { fontSize: 13, color: colors.muted, textAlign: "center" },
}));
