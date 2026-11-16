import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import { storage } from "@/src/utils/storage";
import { apiRequest } from "@/src/api";

import { useParties, useProducts, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { useOffline } from "@/src/offline";
import { Product } from "@/src/models";
import { BarcodeScannerModal } from "@/src/components/barcode-scanner";
import { OrderImageScannerModal } from "@/src/components/order-image-scanner";
import { EmptyState, Loader, ScreenHeader, money, todayIsoDate, useToast } from "@/src/ui";
import { TransactionDateField } from "@/src/components/date-calendar";
import { makeStyles, useTheme } from "@/src/theme";
import { fuzzyFilter } from "@/src/utils/fuzzy-search";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { getSafeCartQuantity, normalizeSellSearch, parseVoiceProductCommand, rankVoiceProductMatches } from "@/src/utils/sell-voice";

type CartLine = { id: string; name: string; stock: number; quantity: number; unit_price: number; threshold: number; kitNames?: string[] };
type HeldSale = { id: string; createdAt: string; cart: CartLine[]; customerId: string | null; discount: string; credit: boolean; transactionDate?: string };
type ProductKit = { id: string; name: string; components: { product_id: string; quantity: number }[] };
type VoiceDraftItem = {
  id: string;
  transcript: string;
  name: string;
  quantity: number;
  product: Product | null;
  candidates: Product[];
  needsConfirmation: boolean;
};

export default function Sell() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const { createSale } = useOffline();

  const { data: products, isLoading } = useProducts();
  const { data: customers } = useParties("customer");
  const productsRef = useRef<Product[]>(products ?? []);
  productsRef.current = products ?? [];

  const [search, setSearch] = useState("");
  const [searchQuantity, setSearchQuantity] = useState("1");
  const searchQuantityTouchedRef = useRef(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSessionOpen, setVoiceSessionOpen] = useState(false);
  const [voiceDraftItems, setVoiceDraftItems] = useState<VoiceDraftItem[]>([]);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [voiceLanguage, setVoiceLanguage] = useState<"en-US" | "ur-PK">("en-US");
  const voiceActiveRef = useRef(false);
  const voiceSessionActiveRef = useRef(false);
  const voiceSessionOpenRef = useRef(false);
  const voiceDraftItemsRef = useRef<VoiceDraftItem[]>([]);
  const pendingVoiceInterimRef = useRef<string | null>(null);
  const voicePermissionPendingRef = useRef(false);
  const voiceStartPendingRef = useRef(false);
  const voiceStartRequestIdRef = useRef(0);
  const processVoiceResultsRef = useRef<(results: { transcript: string; confidence: number }[]) => void>(() => {});
  const voiceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceFinishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFinalTranscriptRef = useRef<{ key: string; at: number } | null>(null);
  const startVoiceRecognitionRef = useRef<() => void>(() => {});
  const voiceNeedsConfirmationRef = useRef<string | null>(null);
  const handledSearchAddRef = useRef<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [transactionDate, setTransactionDate] = useState(todayIsoDate());
  const [productKits, setProductKits] = useState<ProductKit[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [custPickerOpen, setCustPickerOpen] = useState(false);
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newCustomerAddress, setNewCustomerAddress] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [discount, setDiscount] = useState("0");
  const [credit, setCredit] = useState(false);
  const [includePreviousBalance, setIncludePreviousBalance] = useState(false);
  const [pendingBalanceAdjustment, setPendingBalanceAdjustment] = useState(0);
  const [applyCustomerCredit, setApplyCustomerCredit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);
  const [activeHeldSaleId, setActiveHeldSaleId] = useState<string | null>(null);
  const [heldOpen, setHeldOpen] = useState(false);
  const [heldSearch, setHeldSearch] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [addProductOpen, setAddProductOpen] = useState(false);
  const [addProductSearch, setAddProductSearch] = useState("");
  const [orderImageScanOpen, setOrderImageScanOpen] = useState(false);
  const [showSellProfitDiscount, setShowSellProfitDiscount] = useState(true);
  const [allowNegativeStock, setAllowNegativeStock] = useState(false);
  const [sellProductCreateOpen, setSellProductCreateOpen] = useState(false);
  const [newSellProductName, setNewSellProductName] = useState("");
  const [newSellProductBarcode, setNewSellProductBarcode] = useState("");
  const [newSellProductSalePrice, setNewSellProductSalePrice] = useState("");

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void storage.getItem<boolean>("ssm.showSellProfitDiscount", true).then((value) => {
        if (active) setShowSellProfitDiscount(value !== false);
      });
      return () => { active = false; };
    }, []),
  );

  const onScanned = (value: string) => {
    setScanOpen(false);
    const match = (products ?? []).find((p) => p.barcode && p.barcode === value.trim());
    if (match) {
      addToCart(match);
      toast(`Added ${match.name}`, "success");
    } else {
      toast("No product for this barcode", "error");
    }
  };

  const filtered = useMemo(() => {
    const query = search.trim();
    if (!query) return products ?? [];
    if (normalizeSellSearch(query).length < 3) return [];
    return fuzzyFilter(
      products ?? [],
      query,
      [(p) => p.name, (p) => p.sku, (p) => p.barcode],
      { limit: 8, threshold: 0.38 },
    );
  }, [products, search]);

  const cartMap = useMemo(() => new Map(cart.map((c) => [c.id, c])), [cart]);
  const subtotal = cart.reduce((s, c) => s + c.quantity * c.unit_price, 0);
  const discountNum = Math.max(0, parseFloat(discount) || 0);
  const total = Math.max(0, subtotal - discountNum);
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0);

  const reviewedCart = useMemo(() => fuzzyFilter(
    cart,
    reviewSearch,
    [(c) => c.name],
  ), [cart, reviewSearch]);

  const reviewInventoryMatches = useMemo(() => {
    if (!reviewSearch.trim()) return [];
    return fuzzyFilter(
      (products ?? []).filter((p) => !cartMap.has(p.id)),
      reviewSearch,
      [(p) => p.name, (p) => p.sku, (p) => p.barcode],
      { limit: 30 },
    );
  }, [products, cartMap, reviewSearch]);
  const filteredHeldSales = useMemo(() => {
    if (!heldSearch.trim()) return heldSales;
    return fuzzyFilter(
      heldSales,
      heldSearch,
      [
        (h) => h.id,
        (h) => customers?.find((c) => c.id === h.customerId)?.name,
        (h) => h.cart.map((line) => line.name).join(" "),
      ],
    );
  }, [heldSales, heldSearch, customers]);

  useEffect(() => { AsyncStorage.getItem("ssm.heldSales").then((raw) => { if (!raw) return; try { setHeldSales(JSON.parse(raw)); } catch { setHeldSales([]); } }); }, []);
  const persistHeldSales = async (next: HeldSale[]) => { setHeldSales(next); await AsyncStorage.setItem("ssm.heldSales", JSON.stringify(next)); };
  const holdCurrentSale = async () => {
    // Keep zero-quantity lines too: a cleared quantity field is an unfinished
    // edit, not permission to discard that product from the held draft.
    const lines = cart;
    if (!lines.length) {
      toast("Add products before holding the sale", "error");
      return;
    }
    const held: HeldSale = {
      id: activeHeldSaleId ?? `${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      createdAt: new Date().toISOString(),
      cart: lines,
      customerId,
      discount,
      credit,
      transactionDate,
    };
    await persistHeldSales([held, ...heldSales.filter((item) => item.id !== held.id)]);
    setActiveHeldSaleId(null);
    setCart([]);
    setTransactionDate(todayIsoDate());
    setDiscount("0");
    setCustomerId(null);
    setCredit(false);
    setAllowNegativeStock(false);
    setReviewOpen(false);
    toast("Sale held with all products. You can resume it later.", "success");
  };
  const resumeHeldSale = (held: HeldSale) => {
    if (cart.length) {
      Alert.alert("Current sale", "Hold or complete the current sale before opening another held sale.");
      return;
    }
    // Restore every saved line. Out-of-stock/negative-stock items must never be
    // silently filtered out of a held sale: that can erase billable items.
    const restored = held.cart.map((line) => {
      const p = (products ?? []).find((x) => x.id === line.id);
      return {
        ...line,
        stock: Number(p?.quantity ?? line.stock ?? 0),
        threshold: p?.low_stock_threshold ?? line.threshold,
      };
    });
    if (!restored.length) {
      toast("This held sale has no items. It has been kept unchanged.", "error");
      return;
    }
    setCart(restored);
    setActiveHeldSaleId(held.id);
    setTransactionDate(held.transactionDate || todayIsoDate());
    setCustomerId(held.customerId);
    setDiscount(held.discount);
    setCredit(held.credit);
    // Do not remove the saved draft until the user completes this sale. A
    // failed checkout, app close, or further edit must not destroy the draft.
    setHeldSearch("");
    setHeldOpen(false);
    setReviewOpen(true);
    const unavailable = restored.filter((line) => line.quantity > line.stock);
    if (unavailable.length) {
      setAllowNegativeStock(false);
      toast(
        `${unavailable.length} held item(s) are now out of stock or below the requested quantity. Review the warning before checkout.`,
        "error",
      );
    }
  };
  const deleteHeldSale = (held: HeldSale) => Alert.alert("Delete held sale?", "This removes only the held draft.", [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void persistHeldSales(heldSales.filter((x) => x.id !== held.id)) }]);

  const selectedCustomer = customers?.find((c) => c.id === customerId);
  const customerName = selectedCustomer?.name ?? "Walk-in customer";
  const customerCreditAvailable = applyCustomerCredit ? Math.max(0, -Number(selectedCustomer?.balance ?? 0)) : 0;
  const customerCreditApplied = Math.min(total, customerCreditAvailable);
  const amountToCollect = Math.max(0, total - customerCreditApplied);
  const previousBalance = Math.max(0, Number(selectedCustomer?.balance ?? 0));
  const displayedDue = total + (admin && includePreviousBalance ? previousBalance : 0);

  const createCustomer = async () => {
    const name = newCustomerName.trim();
    const phone = newCustomerPhone.trim();
    if (!name) {
      toast("Enter customer name", "error");
      return;
    }
    const normalizeParty = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const nameKey = normalizeParty(name);
    const phoneKey = phone.replace(/[^0-9]/g, "");
    const possible = (customers ?? []).find((c: any) => {
      const existingName = normalizeParty(String(c.name ?? ""));
      const existingPhone = String(c.phone ?? "").replace(/[^0-9]/g, "");
      return (phoneKey && existingPhone && phoneKey === existingPhone) ||
        (nameKey && existingName === nameKey);
    });
    if (possible) {
      setCustomerId(possible.id);
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerAddress("");
      setCustomerCreateOpen(false);
      setCustPickerOpen(false);
      toast("Existing customer found and selected — no duplicate created", "info");
      return;
    }
    try {
      const created = await apiRequest<any>("/parties", {
        method: "POST",
        body: { name, type: "customer", phone, address: newCustomerAddress.trim() },
      });
      setCustomerId(created.id);
      await queryClient.invalidateQueries({ queryKey: qk.parties("customer") });
      await queryClient.invalidateQueries({ queryKey: qk.parties() });
      setNewCustomerName("");
      setNewCustomerPhone("");
      setNewCustomerAddress("");
      setCustomerCreateOpen(false);
      setCustPickerOpen(false);
      toast("Customer created and selected", "success");
    } catch (e: any) {
      toast(e?.message || "Could not create customer", "error");
    }
  };

  useFocusEffect(useCallback(() => {
    let active = true;
    const loadKits = async () => {
      const rows = await storage.getItem<any>("ssm.product-kits.v1", []);
      if (active) setProductKits(rows ?? []);
    };
    void loadKits();
    return () => { active = false; };
  }, []));

  const addKitToCart = (kit: ProductKit) => {
    const components = kit.components.map((component) => ({
      component,
      product: (products ?? []).find((p) => p.id === component.product_id),
    }));
    const missing = components.find((row) => !row.product || Number(row.component.quantity) <= 0);
    if (missing) {
      toast("This kit has a missing product or invalid quantity. Edit it in More → Product Kits.", "error");
      return;
    }
    setCart((previous) => {
      let next = [...previous];
      for (const row of components) {
        const p = row.product!;
        const qty = Number(row.component.quantity);
        const found = next.find((line) => line.id === p.id);
        if (found) {
          next = next.map((line) => line.id === p.id ? { ...line, quantity: line.quantity + qty, stock: Number(p.quantity ?? 0), kitNames: Array.from(new Set([...(line.kitNames ?? []), kit.name])) } : line);
        } else {
          next.push({ id: p.id, name: p.name, stock: Number(p.quantity ?? 0), quantity: qty, unit_price: p.sale_price, threshold: p.low_stock_threshold, kitNames: [kit.name] });
        }
      }
      return next;
    });
    toast(kit.name + " added to cart. Stock will change only after the sale is completed.", "success");
  };

  const addToCart = useCallback((p: Product, quantity = 1) => {
    // Typed, scanned, and spoken additions all update the same product line.
    const addQuantity = Number.isSafeInteger(quantity) && quantity > 0
      ? Math.min(quantity, 1_000_000)
      : 1;
    setCart((prev) => {
      const found = prev.find((c) => c.id === p.id);
      if (found) {
        return prev.map((c) => (c.id === p.id
          ? { ...c, quantity: c.quantity + addQuantity, stock: Number(p.quantity ?? 0) }
          : c));
      }
      return [...prev, {
        id: p.id,
        name: p.name,
        stock: Number(p.quantity ?? 0),
        quantity: addQuantity,
        unit_price: Number(p.sale_price ?? 0),
        threshold: p.low_stock_threshold,
      }];
    });
  }, []);

  const onSearchTextChange = (value: string) => {
    voiceNeedsConfirmationRef.current = null;
    handledSearchAddRef.current = null;
    setVoiceMessage("");
    setVoiceTranscript("");
    setSearch(value);
  };

  const addSearchSuggestion = (product: Product, quantity: number) => {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      toast("Enter a whole quantity greater than zero", "error");
      return;
    }
    const normalized = normalizeSellSearch(search);
    // If the suggestion is tapped before the exact-name debounce finishes,
    // mark it handled so the same item/quantity is never added twice.
    handledSearchAddRef.current = `${normalized}:${product.id}:${quantity}`;
    // Keep this exact/partial query from firing the auto-add timer a second time.
    voiceNeedsConfirmationRef.current = normalized;
    addToCart(product, quantity);
    setVoiceMessage(`Added ${quantity} × ${product.name} to the cart.`);
    toast(`Added ${quantity} × ${product.name}`, "success");
    setSearch("");
    setSearchQuantity("1");
    searchQuantityTouchedRef.current = false;
    voiceNeedsConfirmationRef.current = null;
  };

  const findUniqueQuickSearchMatch = (query: string) => {
    const normalized = normalizeSellSearch(query);
    if (normalized.length < 3) return null;
    const matches = (products ?? []).filter((product) => {
      const fields = [product.name, product.sku, product.barcode]
        .map((value) => normalizeSellSearch(String(value ?? "")))
        .filter(Boolean);
      return fields.some((field) =>
        field.startsWith(normalized) ||
        field.split(" ").some((word) => word.startsWith(normalized)),
      );
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const addExactSearchMatch = (query: string, quantity: number, allowSku = true) => {
    const normalized = normalizeSellSearch(query);
    if (!normalized || quantity <= 0) return false;
    const exactMatches = (products ?? []).filter((product) => {
      const values = allowSku
        ? [product.name, product.sku, product.barcode]
        : [product.name];
      return values.some((value) => normalizeSellSearch(String(value ?? "")) === normalized);
    });
    const product = exactMatches.length === 1 ? exactMatches[0] : findUniqueQuickSearchMatch(query);
    if (!product) return false;
    const addKey = `${normalized}:${product.id}:${quantity}`;
    if (handledSearchAddRef.current !== addKey) {
      handledSearchAddRef.current = addKey;
      addToCart(product, quantity);
      toast(`Added ${quantity} × ${product.name}`, "success");
    }
    setSearch("");
    setSearchQuantity("1");
    searchQuantityTouchedRef.current = false;
    voiceNeedsConfirmationRef.current = null;
    return true;
  };

  const submitProductSearch = () => {
    const query = search.trim();
    if (!query) return;
    const quantity = getSafeCartQuantity(searchQuantity);
    if (!quantity) {
      toast("Enter a whole quantity greater than zero", "error");
      return;
    }
    if (addExactSearchMatch(query, quantity)) return;
    if (filtered.length) {
      toast("Choose the correct stock suggestion below. Quantity is ready to add.", "info");
      return;
    }
    toast("No matching stock item was found. Try a longer name, SKU, or barcode.", "error");
  };

  // A unique 3+ character name/SKU prefix is quick-added after typing pauses.
  // Ambiguous searches stay visible as suggestions and are never auto-selected.
  useEffect(() => {
    const normalized = normalizeSellSearch(search);
    if (normalized.length < 3 || voiceNeedsConfirmationRef.current === normalized) return;
    const quantity = getSafeCartQuantity(searchQuantity);
    if (!quantity) return;
    const exactNameMatch = (products ?? []).filter(
      (product) => normalizeSellSearch(product.name) === normalized,
    );
    const product = findUniqueQuickSearchMatch(search);
    if (!product) return;
    // A partial prefix waits for an edited quantity or the keyboard Done action;
    // this gives the user time to enter the intended quantity instead of adding 1.
    if (exactNameMatch.length !== 1 && !searchQuantityTouchedRef.current) return;
    const addKey = `${normalized}:${product.id}:${quantity}`;
    if (handledSearchAddRef.current === addKey) return;
    const timeout = setTimeout(() => {
      if (handledSearchAddRef.current === addKey) return;
      handledSearchAddRef.current = addKey;
      addToCart(product, quantity);
      toast(`Added ${quantity} × ${product.name}`, "success");
      setSearch("");
      setSearchQuantity("1");
      searchQuantityTouchedRef.current = false;
      voiceNeedsConfirmationRef.current = null;
    }, 900);
    return () => clearTimeout(timeout);
  }, [search, searchQuantity, products, addToCart, toast]);

  const updateVoiceDraftItems = (next: VoiceDraftItem[]) => {
    voiceDraftItemsRef.current = next;
    setVoiceDraftItems(next);
  };

  const queueVoiceDraftItem = (entry: VoiceDraftItem) => {
    const current = voiceDraftItemsRef.current;
    if (entry.product && !entry.needsConfirmation) {
      const existingIndex = current.findIndex(
        (item) => item.product?.id === entry.product?.id && !item.needsConfirmation,
      );
      if (existingIndex >= 0) {
        const next = [...current];
        const existing = next[existingIndex];
        next[existingIndex] = {
          ...existing,
          quantity: Math.min(1_000_000, existing.quantity + entry.quantity),
          transcript: `${existing.transcript} · ${entry.transcript}`,
        };
        updateVoiceDraftItems(next);
        return;
      }
    }
    updateVoiceDraftItems([...current, entry]);
  };

  const processVoiceResults = (alternatives: { transcript: string; confidence: number }[]) => {
    if (!alternatives.length) return;
    const variants = alternatives.map((result) => {
      const exactNames = productsRef.current.filter(
        (product) => normalizeSellSearch(product.name) === normalizeSellSearch(result.transcript),
      );
      const parsed = exactNames.length === 1
        ? { query: result.transcript, quantity: 1 }
        : parseVoiceProductCommand(result.transcript);
      const matches = exactNames.length === 1
        ? [{ product: exactNames[0], score: 1 }]
        : rankVoiceProductMatches(parsed.query, productsRef.current);
      return { ...result, parsed, matches };
    }).sort((a, b) =>
      (b.matches[0]?.score ?? 0) - (a.matches[0]?.score ?? 0) ||
      b.confidence - a.confidence,
    );
    const selected = variants[0];
    if (!selected) return;

    const duplicateKey = normalizeSellSearch(selected.transcript);
    const previousFinal = lastFinalTranscriptRef.current;
    if (previousFinal?.key === duplicateKey && Date.now() - previousFinal.at < 1200) return;
    lastFinalTranscriptRef.current = { key: duplicateKey, at: Date.now() };

    setVoiceTranscript(selected.transcript);
    const best = selected.matches[0];
    const secondBest = selected.matches[1];
    if (!selected.parsed.query.trim()) {
      setVoiceMessage("I heard a quantity but no product name. Say the item name followed by its quantity.");
      return;
    }
    const normalizedQuery = normalizeSellSearch(selected.parsed.query);
    const exactIdentity = !!best && [
      best.product.name,
      best.product.sku,
      best.product.barcode,
    ].some((value) => normalizeSellSearch(String(value ?? "")) === normalizedQuery);
    const exactUnambiguous = exactIdentity && (!secondBest || secondBest.score < 1);
    const decisive = !!best && (
      exactUnambiguous ||
      (best.score >= 0.9 && (!secondBest || best.score - secondBest.score >= 0.1))
    );
    const candidates = selected.matches.slice(0, 4).map((match) => match.product);
    const entry: VoiceDraftItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      transcript: selected.transcript,
      name: decisive && best ? best.product.name : selected.parsed.query,
      quantity: selected.parsed.quantity,
      product: decisive && best ? best.product : null,
      candidates: decisive ? [] : candidates,
      needsConfirmation: !decisive,
    };
    queueVoiceDraftItem(entry);
    if (entry.needsConfirmation) {
      setVoiceMessage(candidates.length
        ? `Heard “${selected.transcript}”. Choose the correct stock item for this quantity in the list below.`
        : `Heard “${selected.transcript}”, but no stock match was found. Remove it or correct the product manually.`);
    } else {
      setVoiceMessage(`Recognized ${entry.name} × ${entry.quantity}. Keep speaking for the next item, or press Done.`);
    }
    setSearch("");
    setSearchQuantity("1");
  };
  processVoiceResultsRef.current = processVoiceResults;

  const startVoiceRecognitionSession = () => {
    if (!voiceSessionActiveRef.current || voiceActiveRef.current || voiceStartPendingRef.current) return;
    voiceStartPendingRef.current = true;
    try {
      const contextualStrings = Array.from(new Set(
        (products ?? [])
          .flatMap((product) => [product.name, product.sku ?? "", product.barcode ?? ""])
          .map((value) => String(value).trim())
          .filter((value) => value.length >= 2 && value.length <= 64),
      )).slice(0, 100);
      ExpoSpeechRecognitionModule.start({
        lang: voiceLanguage,
        interimResults: true,
        continuous: true,
        maxAlternatives: 5,
        addsPunctuation: false,
        contextualStrings,
        androidIntentOptions: {
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 1800,
          EXTRA_MASK_OFFENSIVE_WORDS: false,
        },
      });
    } catch (error: unknown) {
      voiceStartPendingRef.current = false;
      voiceSessionActiveRef.current = false;
      voiceActiveRef.current = false;
      setVoiceActive(false);
      const message = error instanceof Error ? error.message : "Could not continue voice recognition";
      setVoiceMessage(message);
    }
  };
  startVoiceRecognitionRef.current = startVoiceRecognitionSession;

  const handleVoiceInput = async () => {
    if (voicePermissionPendingRef.current || voiceStartPendingRef.current) return;
    if (voiceRestartTimerRef.current) {
      clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
    if (voiceSessionActiveRef.current && voiceActiveRef.current) return;
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setVoiceMessage("Speech recognition is unavailable. Enable Google Speech Services on this device.");
      toast("Speech recognition service is not available on this device", "error");
      return;
    }
    const requestId = ++voiceStartRequestIdRef.current;
    voicePermissionPendingRef.current = true;
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (requestId !== voiceStartRequestIdRef.current || !voicePermissionPendingRef.current) return;
      if (!permission.granted) {
        voicePermissionPendingRef.current = false;
        setVoiceMessage("Microphone permission is required for voice item entry.");
        toast("Allow microphone permission to use voice entry", "error");
        return;
      }
      if (!voiceSessionOpenRef.current) {
        updateVoiceDraftItems([]);
        pendingVoiceInterimRef.current = null;
        setVoiceTranscript("");
        lastFinalTranscriptRef.current = null;
      }
      voicePermissionPendingRef.current = false;
      voiceNeedsConfirmationRef.current = null;
      voiceSessionActiveRef.current = true;
      voiceSessionOpenRef.current = true;
      setVoiceSessionOpen(true);
      setVoiceMessage("Listening continuously. Say each product name and quantity; press Done when finished.");
      startVoiceRecognitionRef.current();
    } catch (error: unknown) {
      if (requestId !== voiceStartRequestIdRef.current) return;
      voicePermissionPendingRef.current = false;
      voiceSessionActiveRef.current = false;
      voiceActiveRef.current = false;
      setVoiceActive(false);
      const message = error instanceof Error ? error.message : "Could not start voice recognition";
      setVoiceMessage(message);
      toast(message, "error");
    }
  };

  const confirmVoiceDraftItem = (entryId: string, product: Product) => {
    const current = voiceDraftItemsRef.current;
    const next = current.map((item) => item.id === entryId
      ? { ...item, name: product.name, product, needsConfirmation: false }
      : item);
    updateVoiceDraftItems(next);
  };

  const removeVoiceDraftItem = (entryId: string) => {
    updateVoiceDraftItems(voiceDraftItemsRef.current.filter((item) => item.id !== entryId));
  };

  const cancelVoiceEntry = () => {
    const wasVoiceStarting = voiceStartPendingRef.current;
    voiceStartRequestIdRef.current += 1;
    voicePermissionPendingRef.current = false;
    voiceSessionActiveRef.current = false;
    voiceSessionOpenRef.current = false;
    voiceStartPendingRef.current = false;
    if (voiceRestartTimerRef.current) clearTimeout(voiceRestartTimerRef.current);
    if (voiceFinishTimerRef.current) clearTimeout(voiceFinishTimerRef.current);
    voiceRestartTimerRef.current = null;
    voiceFinishTimerRef.current = null;
    if (voiceActiveRef.current || wasVoiceStarting) {
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* Recognition may already have stopped. */ }
    }
    voiceActiveRef.current = false;
    setVoiceActive(false);
    setVoiceSessionOpen(false);
    updateVoiceDraftItems([]);
    pendingVoiceInterimRef.current = null;
    setVoiceTranscript("");
    setVoiceMessage("Voice entry cancelled. Nothing was added to the cart.");
  };

  const finishVoiceEntry = () => {
    const wasVoiceStarting = voiceStartPendingRef.current;
    voiceStartRequestIdRef.current += 1;
    voicePermissionPendingRef.current = false;
    voiceSessionActiveRef.current = false;
    voiceStartPendingRef.current = false;
    if (voiceRestartTimerRef.current) clearTimeout(voiceRestartTimerRef.current);
    voiceRestartTimerRef.current = null;
    if (voiceActiveRef.current || wasVoiceStarting) {
      try { ExpoSpeechRecognitionModule.stop(); } catch { /* Recognition may already have stopped. */ }
    }
    voiceActiveRef.current = false;
    setVoiceActive(false);

    // Android continuous recognition can sometimes drop the final result when
    // stop() is called. Preserve the latest live transcript and use it only if
    // no final result replaced it before this guarded fallback runs.
    if (voiceFinishTimerRef.current) clearTimeout(voiceFinishTimerRef.current);
    voiceFinishTimerRef.current = setTimeout(() => {
      voiceFinishTimerRef.current = null;
      const pendingInterim = pendingVoiceInterimRef.current;
      if (pendingInterim && voiceSessionOpenRef.current) {
        processVoiceResultsRef.current([{ transcript: pendingInterim, confidence: 0 }]);
        pendingVoiceInterimRef.current = null;
      }
      const draft = voiceDraftItemsRef.current;
      if (!draft.length) {
        setVoiceMessage("No products were recognized. Resume listening or cancel this session.");
        return;
      }
      const unresolved = draft.filter((item) => !item.product || item.needsConfirmation);
      if (unresolved.length) {
        setVoiceMessage(`Please confirm or remove ${unresolved.length} uncertain item(s), then press Done again. Nothing has been added yet.`);
        toast("Confirm the uncertain voice items before adding them", "error");
        return;
      }

      setCart((previous) => {
        let next = [...previous];
        for (const entry of draft) {
          if (!entry.product) continue;
          const product = entry.product;
          const found = next.find((line) => line.id === product.id);
          if (found) {
            next = next.map((line) => line.id === product.id
              ? { ...line, quantity: line.quantity + entry.quantity, stock: Number(product.quantity ?? 0) }
              : line);
          } else {
            next.push({
              id: product.id,
              name: product.name,
              stock: Number(product.quantity ?? 0),
              quantity: entry.quantity,
              unit_price: Number(product.sale_price ?? 0),
              threshold: product.low_stock_threshold,
            });
          }
        }
        return next;
      });
      const summary = draft.map((item) => `${item.name} × ${item.quantity}`).join(", ");
      updateVoiceDraftItems([]);
      pendingVoiceInterimRef.current = null;
      voiceSessionOpenRef.current = false;
      setVoiceSessionOpen(false);
      setVoiceTranscript("");
      setVoiceMessage(`Added to cart: ${summary}`);
      setSearch("");
      setSearchQuantity("1");
      searchQuantityTouchedRef.current = false;
      voiceNeedsConfirmationRef.current = null;
      handledSearchAddRef.current = null;
      toast(`Added ${draft.length} voice item(s) to cart`, "success");
    }, 900);
  };

  useEffect(() => {
    const startSubscription = ExpoSpeechRecognitionModule.addListener("start", () => {
      voiceStartPendingRef.current = false;
      if (!voiceSessionActiveRef.current || !voiceSessionOpenRef.current) {
        try { ExpoSpeechRecognitionModule.abort(); } catch { /* Session was closed before native start completed. */ }
        return;
      }
      voiceActiveRef.current = true;
      setVoiceActive(true);
      setVoiceMessage("Listening continuously. Say the next item and quantity, or press Done.");
    });
    const endSubscription = ExpoSpeechRecognitionModule.addListener("end", () => {
      voiceStartPendingRef.current = false;
      voiceActiveRef.current = false;
      setVoiceActive(false);
      if (!voiceSessionActiveRef.current) return;
      if (voiceRestartTimerRef.current) clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = setTimeout(() => {
        voiceRestartTimerRef.current = null;
        startVoiceRecognitionRef.current();
      }, 500);
    });
    const resultSubscription = ExpoSpeechRecognitionModule.addListener("result", (event) => {
      const results = (event.results ?? [])
        .map((result) => ({
          transcript: String(result.transcript ?? "").trim(),
          confidence: Number(result.confidence ?? 0),
        }))
        .filter((result) => result.transcript.length > 0);
      if (!results.length) return;
      if (!event.isFinal) {
        const transcript = results[0].transcript;
        if (voiceSessionOpenRef.current) pendingVoiceInterimRef.current = transcript;
        setVoiceTranscript(transcript);
        return;
      }
      if (!voiceSessionOpenRef.current) return;

      pendingVoiceInterimRef.current = null;
      processVoiceResultsRef.current(results);
    });
    const errorSubscription = ExpoSpeechRecognitionModule.addListener("error", (event) => {
      voiceStartPendingRef.current = false;
      voiceActiveRef.current = false;
      setVoiceActive(false);
      const code = String(event.error ?? "unknown");
      const message = code === "no-speech"
        ? "No speech detected. The voice session will continue listening."
        : code === "not-allowed"
          ? "Microphone permission was denied. Allow it in Android Settings."
          : code === "service-not-allowed" || code === "language-not-supported"
            ? "Speech service or language is unavailable. Resume listening or switch language."
            : String(event.message || "Voice recognition encountered an error. Resume listening or press Done.");
      setVoiceMessage(message);
      if (code === "not-allowed" || code === "service-not-allowed" || code === "language-not-supported") {
        voiceSessionActiveRef.current = false;
        if (voiceRestartTimerRef.current) clearTimeout(voiceRestartTimerRef.current);
        voiceRestartTimerRef.current = null;
      }
    });
    return () => {
      startSubscription.remove();
      endSubscription.remove();
      resultSubscription.remove();
      errorSubscription.remove();
      voiceSessionActiveRef.current = false;
      voiceSessionOpenRef.current = false;
      pendingVoiceInterimRef.current = null;
      voiceStartPendingRef.current = false;
      voicePermissionPendingRef.current = false;
      voiceStartRequestIdRef.current += 1;
      if (voiceRestartTimerRef.current) clearTimeout(voiceRestartTimerRef.current);
      if (voiceFinishTimerRef.current) clearTimeout(voiceFinishTimerRef.current);
      voiceRestartTimerRef.current = null;
      voiceFinishTimerRef.current = null;
      if (voiceActiveRef.current) {
        try { ExpoSpeechRecognitionModule.abort(); } catch { /* Route may already be closing. */ }
      }
    };
  }, []);

  // Checkout has its own add path: every inventory product, including zero/negative stock,
  // can be placed in the cart. The final checkout remains blocked until the below-zero box is enabled.
  const addToCheckout = (p: Product) => {
    setCart((prev) => {
      const found = prev.find((c) => c.id === p.id);
      if (found) {
        return prev.map((c) => c.id === p.id ? { ...c, quantity: c.quantity + 1, stock: Number(p.quantity ?? 0) } : c);
      }
      return [...prev, { id: p.id, name: p.name, stock: Number(p.quantity ?? 0), quantity: 1, unit_price: p.sale_price, threshold: p.low_stock_threshold }];
    });
  };

  const setQty = (id: string, qty: number) => {
    setCart((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, quantity: Math.max(0, qty) } : c))
        .filter((c) => c.quantity > 0)
    );
  };
  // Used by the editable Qty text field in the cart. Unlike the +/- steppers,
  // typing/clearing the field must NEVER remove the line (that made products
  // "vanish" while editing). The line stays; an empty field shows as 0 and is
  // simply ignored at checkout.
  const setQtyText = (id: string, text: string) => {
    const n = parseInt(text || "0", 10);
    const qty = isNaN(n) ? 0 : n;
    setCart((prev) =>
      prev.map((c) => (c.id === id ? { ...c, quantity: Math.max(0, qty) } : c))
    );
  };
  const setPrice = (id: string, price: number) =>
    setCart((prev) => prev.map((c) => (c.id === id ? { ...c, unit_price: Math.max(0, price) } : c)));
  const removeLine = (id: string) => setCart((prev) => prev.filter((c) => c.id !== id));

  const onOrderImageItems = (items: { product: Product; quantity: number }[]) => {
    let added = 0;
    let skipped = 0;
    setCart((prev) => {
      const next = [...prev];
      for (const { product, quantity } of items) {
        const index = next.findIndex((line) => line.id === product.id);
        const existingQty = index >= 0 ? next[index].quantity : 0;
        const available = Math.max(0, product.quantity - existingQty);
        const addQty = Math.min(Math.max(0, Math.floor(quantity)), available);
        if (addQty <= 0) {
          skipped += 1;
          continue;
        }
        added += addQty;
        if (index >= 0) {
          next[index] = { ...next[index], quantity: existingQty + addQty, stock: product.quantity };
        } else {
          next.push({
            id: product.id,
            name: product.name,
            stock: product.quantity,
            quantity: addQty,
            unit_price: product.sale_price,
            threshold: product.low_stock_threshold,
          });
        }
      }
      return next;
    });
    if (added > 0) {
      toast(`Added ${added} unit(s) from order image`, "success");
    }
    if (skipped > 0) {
      toast(`${skipped} item(s) could not be added because stock is unavailable`, "error");
    }
  };

  const createProductFromSell = async () => {
    const name = newSellProductName.trim();
    const barcode = newSellProductBarcode.trim();
    const salePrice = Math.max(0, parseFloat(newSellProductSalePrice) || 0);
    if (!name) { toast("Enter product name", "error"); return; }
    const normalize = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const existing = (products ?? []).find((p: any) =>
      (barcode && String(p.barcode ?? "").trim() === barcode) || normalize(p.name) === normalize(name)
    );
    if (existing) {
      if (existing.quantity <= 0 && !allowNegativeStock) {
        toast("Existing product found, but it is out of stock. Enable “Sell below zero stock” to sell it.", "error");
        return;
      }
      addToCart(existing);
      setSellProductCreateOpen(false);
      setNewSellProductName(""); setNewSellProductBarcode(""); setNewSellProductSalePrice("");
      toast("Existing product found — no duplicate created", "info");
      return;
    }
    try {
      const created = await apiRequest<any>("/products", {
        method: "POST",
        body: { name, barcode, purchase_price: 0, sale_price: salePrice, low_stock_threshold: 5, expiry_date: null },
      });
      const product: Product = { ...created, quantity: Number(created.quantity ?? 0) };
      setCart((prev) => [...prev, { id: product.id, name: product.name, stock: 0, quantity: 1, unit_price: product.sale_price, threshold: product.low_stock_threshold }]);
      await queryClient.invalidateQueries({ queryKey: qk.products });
      setSellProductCreateOpen(false);
      setNewSellProductName(""); setNewSellProductBarcode(""); setNewSellProductSalePrice("");
      toast("Product created and added — sale will put stock below zero", "success");
    } catch (e: any) {
      toast(e?.message || "Could not create product", "error");
    }
  };

  const checkout = async () => {
    if (!cart.length) return;
    const lines = cart.filter((c) => c.quantity > 0);
    if (!lines.length) {
      toast("Set a quantity to sell", "error");
      return;
    }
    const invalid = lines.find((c) => !Number.isFinite(c.quantity) || c.quantity <= 0 || !Number.isFinite(c.unit_price) || c.unit_price < 0);
    if (invalid) {
      toast("Please enter a valid quantity and unit price", "error");
      return;
    }
    const overStock = lines.find((c) => c.quantity > c.stock);
    if (overStock && !allowNegativeStock) {
      toast(`${overStock.name} has only ${overStock.stock} in stock`, "error");
      return;
    }
    setBusy(true);
    try {
      const { sale, queued } = await createSale(
        {
          transaction_date: transactionDate,
          items: lines.map((c) => ({ product_id: c.id, quantity: Math.floor(c.quantity), unit_price: Number(c.unit_price) })),
          customer_id: customerId,
          discount: Number(discountNum),
          credit,
          allow_negative_stock: allowNegativeStock,
          apply_customer_credit: applyCustomerCredit,
          include_previous_balance: includePreviousBalance,
          previous_balance: includePreviousBalance ? previousBalance : applyCustomerCredit ? Number(selectedCustomer?.balance ?? 0) : 0,
        } as any,
        user?.name || user?.email || "Staff",
      );
      let balanceAdjustmentApplied = false;
      let balanceAdjustmentFailed = false;
      if (!queued && customerId && pendingBalanceAdjustment !== 0 && admin) {
        try {
          await apiRequest("/payments", { method: "POST", body: {
            party_id: customerId, kind: "receive", amount: 0,
            adjustment: pendingBalanceAdjustment,
            note: "Customer outstanding/credit balance adjusted from sale " + sale.id,
          }});
          balanceAdjustmentApplied = true;
          await queryClient.invalidateQueries({ queryKey: qk.parties("customer") });
          await queryClient.invalidateQueries({ queryKey: qk.payments() });
        } catch (adjustError: any) {
          balanceAdjustmentFailed = true;
        }
      } else {
        await queryClient.invalidateQueries({ queryKey: qk.parties("customer") });
        await queryClient.invalidateQueries({ queryKey: qk.payments() });
      }
      await queryClient.invalidateQueries({ queryKey: qk.products });
      await queryClient.invalidateQueries({ queryKey: qk.sales });
      setPendingBalanceAdjustment(0);
      setApplyCustomerCredit(false);
      // Remove the resumed held draft only after createSale confirms success
      // (including a successfully queued offline sale). Failures keep it intact.
      if (activeHeldSaleId) {
        await persistHeldSales(heldSales.filter((item) => item.id !== activeHeldSaleId));
        setActiveHeldSaleId(null);
      }
      setCart([]);
      setTransactionDate(todayIsoDate());
      setDiscount("0");
      setCustomerId(null);
      setCredit(false);
      setAllowNegativeStock(false);
      setReviewOpen(false);
      toast(
        queued
          ? (pendingBalanceAdjustment !== 0 ? "Saved offline — balance adjustment still needs to be applied online" : "Saved offline — will sync when online")
          : balanceAdjustmentFailed
            ? "Sale completed, but the balance adjustment was not saved. Please adjust it in Payments."
            : balanceAdjustmentApplied ? "Sale completed and existing customer balance adjusted" : "Sale completed",
        queued ? "info" : balanceAdjustmentFailed ? "error" : "success",
      );
      router.push(`/receipt?id=${sale.id}`);
    } catch (e: any) {
      toast(e?.message || "Could not complete sale", "error");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Loader />;

  return (
    <View style={styles.root}>
      <ScreenHeader title="Sell" subtitle="Add items to the cart" topInset={insets.top} showStatus />

      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
          <TextInput
            testID="product-search-input"
            style={styles.searchInput}
            placeholder="Search product, SKU or barcode"
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={onSearchTextChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={submitProductSearch}
            blurOnSubmit
          />
        </View>
        <Pressable
          testID="voice-add-to-cart-button"
          style={[styles.voiceBtn, voiceActive && styles.voiceBtnActive]}
          onPress={handleVoiceInput}
          disabled={voiceActive}
          accessibilityRole="button"
          accessibilityLabel={voiceActive ? "Voice item entry is listening" : voiceSessionOpen ? "Resume voice item entry" : "Start voice item entry"}
        >
          <MaterialDesignIcons name={voiceActive ? "microphone" : "microphone"} size={22} color={colors.onBrandPrimary} />
        </Pressable>
      </View>
      <View style={styles.searchActionRow}>
        <View style={styles.searchQuantityGroup}>
          <Text style={styles.searchQuantityLabel}>ADD QTY</Text>
          <TextInput
            testID="sell-add-quantity-input"
            style={styles.searchQtyInput}
            value={searchQuantity}
            onChangeText={(value) => {
              searchQuantityTouchedRef.current = true;
              setSearchQuantity(value);
            }}
            keyboardType="number-pad"
            returnKeyType="done"
            onSubmitEditing={submitProductSearch}
            blurOnSubmit
            maxLength={7}
            selectTextOnFocus
            placeholder="1"
            placeholderTextColor={colors.muted}
          />
        </View>
        <View style={styles.searchToolsGroup}>
          <Pressable
            testID="voice-language-toggle"
            style={styles.voiceLanguageBtn}
            onPress={() => setVoiceLanguage((value) => value === "en-US" ? "ur-PK" : "en-US")}
            disabled={voiceActive}
            accessibilityLabel="Change voice recognition language"
          >
            <Text style={styles.voiceLanguageText}>{voiceLanguage === "en-US" ? "EN" : "UR"}</Text>
          </Pressable>
          <Pressable testID="scan-to-cart-button" style={styles.scanBtn} onPress={() => setScanOpen(true)}>
            <MaterialDesignIcons name="barcode-scan" size={22} color={colors.onBrandPrimary} />
          </Pressable>
          <Pressable testID="scan-order-image-sell-button" style={styles.scanOrderSellBtn} onPress={() => setOrderImageScanOpen(true)}>
            <MaterialDesignIcons name="text-box-search-outline" size={20} color={colors.onBrandPrimary} />
            <Text style={styles.scanOrderSellText}>Scan order</Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.searchHint}>Search 3+ letters, set quantity, then tap a match or press Done.</Text>
      {!!voiceMessage && (
        <View style={styles.voiceStatus} accessibilityLiveRegion="polite">
          <MaterialDesignIcons name={voiceActive ? "microphone" : "text-recognition"} size={17} color={colors.brandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.voiceStatusText}>{voiceMessage}</Text>
            {!!voiceTranscript && <Text style={styles.voiceTranscriptText}>Heard: {voiceTranscript}</Text>}
          </View>
        </View>
      )}
      {voiceSessionOpen && (
        <View style={styles.voiceSessionCard} testID="voice-session-results">
          <View style={styles.voiceSessionHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.voiceSessionTitle}>Voice item list · {voiceDraftItems.length}</Text>
              <Text style={styles.voiceSessionHint}>
                {voiceActive ? "Microphone is on. Say the next item and quantity." : "Listening is paused. Confirm matches, resume, or press Done."}
              </Text>
            </View>
            <View style={[styles.voiceListeningDot, voiceActive && styles.voiceListeningDotActive]} />
          </View>
          {voiceDraftItems.length === 0 ? (
            <Text style={styles.voiceNoItems}>No items recognized yet. Say “Special towel 2”, then continue with the next product.</Text>
          ) : (
            <ScrollView style={styles.voiceDraftList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
              {voiceDraftItems.map((entry, index) => (
                <View key={entry.id} style={styles.voiceDraftRow} testID={`voice-draft-${index}`}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.voiceDraftName} numberOfLines={2}>{entry.name}</Text>
                    <Text style={styles.voiceDraftQuantity}>Quantity: {entry.quantity}</Text>
                    {entry.needsConfirmation && (
                      <View style={styles.voiceCandidateList}>
                        {entry.candidates.map((candidate) => (
                          <Pressable
                            key={candidate.id}
                            testID={`confirm-voice-${entry.id}-${candidate.id}`}
                            style={styles.voiceCandidateButton}
                            onPress={() => confirmVoiceDraftItem(entry.id, candidate)}
                          >
                            <Text style={styles.voiceCandidateText}>{candidate.name} · Stock {candidate.quantity}</Text>
                          </Pressable>
                        ))}
                        {!entry.candidates.length && <Text style={styles.voiceUnmatchedText}>No matching stock item</Text>}
                      </View>
                    )}
                    {!!entry.transcript && <Text style={styles.voiceTranscriptText}>Heard: {entry.transcript}</Text>}
                  </View>
                  <Pressable
                    testID={`remove-voice-draft-${entry.id}`}
                    hitSlop={8}
                    onPress={() => removeVoiceDraftItem(entry.id)}
                    accessibilityLabel={`Remove ${entry.name} from voice list`}
                  >
                    <MaterialDesignIcons name="close-circle" size={20} color={colors.muted} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <View style={styles.voiceSessionActions}>
            {!voiceActive && (
              <Pressable testID="resume-voice-entry" style={styles.voiceResumeButton} onPress={handleVoiceInput}>
                <MaterialDesignIcons name="microphone" size={18} color={colors.brandPrimary} />
                <Text style={styles.voiceResumeText}>Resume</Text>
              </Pressable>
            )}
            <Pressable testID="cancel-voice-entry" style={styles.voiceCancelButton} onPress={cancelVoiceEntry}>
              <Text style={styles.voiceCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="done-voice-entry"
              style={[styles.voiceDoneButton, voiceDraftItems.length === 0 && { opacity: 0.45 }]}
              onPress={finishVoiceEntry}
              disabled={voiceDraftItems.length === 0}
            >
              <MaterialDesignIcons name="check-bold" size={18} color={colors.onBrandPrimary} />
              <Text style={styles.voiceDoneText}>Done · Add to cart</Text>
            </Pressable>
          </View>
        </View>
      )}

      {productKits.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 8, alignItems: "center" }} style={{ flexGrow: 0, minHeight: 76, maxHeight: 88, marginBottom: 6 }}>
          {productKits.map((kit) => (
            <Pressable key={kit.id} testID={"add-kit-" + kit.id} onPress={() => addKitToCart(kit)} style={{ backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, minWidth: 132, maxWidth: 190 }}>
              <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{kit.name}</Text>
              <Text style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{kit.components.length} components · Add kit</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <FlatList
        data={filtered}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: 16, paddingBottom: 140, gap: 10 }}
        ListHeaderComponent={search.trim() && normalizeSellSearch(search).length >= 3 ? (
          <Text style={styles.searchResultsHeader}>Matching stock items · {filtered.length} suggestion(s)</Text>
        ) : null}
        ListEmptyComponent={
          search.trim() && normalizeSellSearch(search).length < 3 ? (
            <Text style={styles.searchEmptyHint}>Type at least 3 letters to see stock suggestions.</Text>
          ) : (
            <EmptyState
              icon="package-variant"
              title={search.trim() ? "No matching stock item" : "No products"}
              message={search.trim() ? "Try a longer name, SKU, or barcode." : "Add products in Stock to start selling."}
              testID="sell-empty"
            />
          )
        }
        renderItem={({ item }) => {
          const line = cartMap.get(item.id);
          const out = item.quantity <= 0;
          const low = !out && item.quantity <= item.low_stock_threshold;
          const requestedQuantity = getSafeCartQuantity(searchQuantity);
          return (
            <View style={styles.prodRow} testID={`product-${item.id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.prodName}>{item.name}</Text>
                <Text style={styles.prodMeta}>
                  {money(item.sale_price)} · Stock {item.quantity} · Add {requestedQuantity}
                </Text>
                {low && (
                  <View style={styles.lowTagRow} testID={`low-stock-tag-${item.id}`}>
                    <MaterialDesignIcons name="alert-outline" size={13} color={colors.warning} />
                    <Text style={styles.lowTagText}>Low stock · reorder soon</Text>
                  </View>
                )}
              </View>
              {line ? (
                <View style={styles.stepper}>
                  <Pressable
                    testID={`dec-${item.id}`}
                    style={styles.stepBtn}
                    onPress={() => setQty(item.id, line.quantity - 1)}
                  >
                    <MaterialDesignIcons name="minus" size={18} color={colors.brandPrimary} />
                  </Pressable>
                  <TextInput testID={`qty-step-input-${item.id}`} style={styles.stepQtyInput} keyboardType="number-pad" value={String(line.quantity)} onChangeText={(t) => setQtyText(item.id, t)} selectTextOnFocus />
                  <Pressable
                    testID={`inc-${item.id}`}
                    style={styles.stepBtn}
                    onPress={() => addSearchSuggestion(item, requestedQuantity)}
                    disabled={requestedQuantity === 0}
                    accessibilityLabel={`Add ${requestedQuantity} more ${item.name}`}
                  >
                    <MaterialDesignIcons name="plus" size={18} color={colors.brandPrimary} />
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  testID={`add-${item.id}`}
                  style={[styles.addBtn, requestedQuantity === 0 && { opacity: 0.45 }]}
                  onPress={() => addSearchSuggestion(item, requestedQuantity)}
                  disabled={requestedQuantity === 0}
                  accessibilityLabel={`Add ${requestedQuantity} ${item.name} to cart`}
                >
                  <MaterialDesignIcons name="cart-plus" size={18} color={colors.onBrandPrimary} />
                  <Text style={styles.addBtnQuantity}>+{requestedQuantity}</Text>
                </Pressable>
              )}
            </View>
          );
        }}
      />

      <View style={styles.bottomActions}><Pressable testID="held-sales-button" style={styles.heldBtn} onPress={() => setHeldOpen(true)}><MaterialDesignIcons name="pause-circle-outline" size={20} color={colors.brandPrimary} /><Text style={styles.heldBtnText}>Held ({heldSales.length})</Text></Pressable>{cart.length > 0 && (
        <Pressable
          testID="open-cart-button"
          style={[styles.cartBar, { paddingBottom: 14 }]}
          onPress={() => setReviewOpen(true)}
        >
          <View style={styles.cartCountBubble}>
            <Text style={styles.cartCountText}>{cartCount}</Text>
          </View>
          <Text style={styles.cartBarText}>Review & Checkout</Text>
          <Text style={styles.cartBarTotal}>{money(subtotal)}</Text>
        </Pressable> )}</View>

      {/* Cart review modal */}
      <Modal visible={reviewOpen} animationType="slide" onRequestClose={() => setReviewOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader
            title="Cart"
            subtitle={`${cartCount} item(s)`}
            topInset={insets.top}
            onBack={() => setReviewOpen(false)}
          />
          <View style={styles.reviewActionRow}>
            <Pressable testID="create-product-from-sell" onPress={() => setSellProductCreateOpen(true)} style={styles.scanOrderBtn}>
              <MaterialDesignIcons name="package-variant-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.scanOrderText}>Add product</Text>
            </Pressable>
            <Pressable testID="scan-order-image-button" onPress={() => setOrderImageScanOpen(true)} style={styles.scanOrderBtn}>
              <MaterialDesignIcons name="text-box-search-outline" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.scanOrderText}>Scan order</Text>
            </Pressable>
          </View>
          <View style={styles.reviewSearchRow}>
            <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
            <TextInput testID="review-search-input" style={styles.searchInput} placeholder="Search cart + all inventory" placeholderTextColor={colors.muted} value={reviewSearch} onChangeText={setReviewSearch} />
            <Pressable testID="review-add-products" onPress={() => setAddProductOpen(true)} style={styles.reviewAddBtn}>
              <MaterialDesignIcons name="plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.reviewAddText}>Add</Text>
            </Pressable>
          </View>
          <KeyboardAwareScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}
            bottomOffset={20}
          >
            <Pressable testID="allow-negative-stock-toggle" style={styles.forceStockRow} onPress={() => setAllowNegativeStock((v) => !v)}>
              <MaterialDesignIcons name={allowNegativeStock ? "checkbox-marked" : "checkbox-blank-outline"} size={22} color={allowNegativeStock ? colors.warning : colors.muted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.forceStockText}>Allow out-of-stock / negative stock sale</Text>
                <Text style={styles.forceStockHint}>All products can be added above. Checkout is blocked if any line exceeds stock until this box is checked.</Text>
              </View>
            </Pressable>

            <TransactionDateField label="Sale date" value={transactionDate} onChange={setTransactionDate} testID="sale-date-input" />

            <Pressable
              testID="select-customer-button"
              style={styles.customerRow}
              onPress={() => setCustPickerOpen(true)}
            >
              <MaterialDesignIcons name="account" size={20} color={colors.brandPrimary} />
              <Text style={styles.customerText}>{customerName}</Text>
              <MaterialDesignIcons name="chevron-right" size={22} color={colors.muted} />
            </Pressable>

            {reviewedCart.map((c) => (
              <View key={c.id} style={styles.cartLine} testID={`cart-line-${c.id}`}>
                <View style={styles.cartLineHead}>
                  <View style={{ flex: 1 }}><Text style={styles.cartLineName}>{c.name}</Text>{!!c.kitNames?.length && <Text style={{ color: colors.brandPrimary, fontSize: 11, fontWeight: "700", marginTop: 2 }}>Kit component · {c.kitNames.join(", ")}</Text>}</View>
                  <Pressable testID={`remove-${c.id}`} onPress={() => removeLine(c.id)} hitSlop={8}>
                    <MaterialDesignIcons name="close" size={20} color={colors.muted} />
                  </Pressable>
                </View>
                <View style={styles.cartLineInputs}>
                  <View style={styles.miniField}>
                    <Text style={styles.miniLabel}>Qty (max {c.stock})</Text>
                    <TextInput
                      testID={`qty-input-${c.id}`}
                      style={styles.miniInput}
                      keyboardType="numeric"
                      value={c.quantity === 0 ? "" : String(c.quantity)}
                      placeholder="0"
                      placeholderTextColor={colors.muted}
                      onChangeText={(t) => setQtyText(c.id, t)}
                    />
                  </View>
                  <View style={styles.miniField}>
                    <Text style={styles.miniLabel}>Unit price</Text>
                    <TextInput
                      testID={`price-input-${c.id}`}
                      style={styles.miniInput}
                      keyboardType="numeric"
                      value={String(c.unit_price)}
                      onChangeText={(t) => setPrice(c.id, parseFloat(t || "0"))}
                    />
                  </View>
                  <View style={styles.lineTotalBox}>
                    <Text style={styles.miniLabel}>Total</Text>
                    <Text style={styles.lineTotal}>{money(c.quantity * c.unit_price)}</Text>
                  </View>
                </View>
                {c.stock - c.quantity <= c.threshold && (
                  <View style={styles.lowWarn} testID={`low-stock-warn-${c.id}`}>
                    <MaterialDesignIcons name="alert-outline" size={15} color={colors.warning} />
                    <Text style={styles.lowWarnText}>
                      {c.stock - c.quantity <= 0
                        ? "This sale uses the last of your stock"
                        : `Only ${c.stock - c.quantity} will remain — consider reordering`}
                    </Text>
                  </View>
                )}
              </View>
            ))}

            {reviewSearch.trim() && reviewInventoryMatches.length > 0 && (
              <View style={styles.reviewInventoryBox}>
                <Text style={styles.reviewInventoryTitle}>Inventory matches — tap Add</Text>
                {reviewInventoryMatches.map((p) => (
                  <View key={p.id} style={styles.reviewInventoryRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.reviewInventoryName}>{p.name}</Text>
                      <Text style={styles.reviewInventoryMeta}>
                        Stock {p.quantity} · {money(p.sale_price)}{p.sku ? ` · SKU ${p.sku}` : ""}
                      </Text>
                    </View>
                    <Pressable
                      testID={`review-add-inventory-${p.id}`}
                      onPress={() => { addToCheckout(p); setReviewSearch(""); }}
                      style={styles.reviewInventoryAdd}
                    >
                      <MaterialDesignIcons name="plus" size={18} color={colors.onBrandPrimary} />
                      <Text style={styles.reviewInventoryAddText}>Add</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            {reviewSearch.trim() && reviewedCart.length === 0 && reviewInventoryMatches.length === 0 && (
              <Text style={styles.reviewNoMatch}>No matching product in the cart or inventory.</Text>
            )}

            {showSellProfitDiscount && ( 
              <>
            <View style={styles.discountRow}>
              <Text style={styles.discountLabel}>Discount</Text>
              <TextInput
                testID="discount-input"
                style={styles.discountInput}
                keyboardType="numeric"
                value={discount}
                onChangeText={setDiscount}
              />
            </View>
              </>
            )}

            {customerId && previousBalance > 0 && (
              <View testID="customer-credit-notice" style={styles.creditRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.discountLabel}>Previous outstanding balance</Text>
                  <Text style={styles.creditHint}>{money(previousBalance)} · counted once from earlier credit sales</Text>
                  {admin && (
                    <Pressable testID="include-previous-balance-toggle" onPress={() => setIncludePreviousBalance((value) => !value)} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <MaterialDesignIcons name={includePreviousBalance ? "checkbox-marked" : "checkbox-blank-outline"} size={22} color={includePreviousBalance ? colors.brandPrimary : colors.muted} />
                      <Text style={styles.creditHint}>Include old balance on receipt (not charged to the customer twice)</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            <Pressable
              testID="credit-toggle"
              style={styles.creditRow}
              onPress={() => {
                if (!customerId) {
                  toast("Select a customer for credit sale", "error");
                  return;
                }
                setCredit((v) => !v);
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.discountLabel}>Sell on credit (pay later)</Text>
                <Text style={styles.creditHint}>Adds the total to the customer's owed balance</Text>
              </View>
              <MaterialDesignIcons
                name={credit ? "toggle-switch" : "toggle-switch-off-outline"}
                size={40}
                color={credit ? colors.brandPrimary : colors.muted}
              />
            </Pressable>

            <View style={styles.totalsCard}>
              <Row label="Subtotal" value={money(subtotal)} />
              {showSellProfitDiscount && <Row label="Discount" value={"- " + money(discountNum)} />}
              <View style={styles.totalDivider} />
              <Row label={credit ? "New sale (on credit)" : "New sale total"} value={money(total)} bold />
              {customerCreditApplied > 0 && (
                <>
                  <Row label="Existing customer credit applied" value={"- " + money(customerCreditApplied)} />
                  <View style={styles.totalDivider} />
                  <Row label={credit ? "Remaining credit-sale balance" : "Amount to collect now"} value={money(amountToCollect)} bold />
                </>
              )}
              {admin && includePreviousBalance && previousBalance > 0 && (
                <>
                  <Row label="Previous balance (display only)" value={money(previousBalance)} />
                  <View style={styles.totalDivider} />
                  <Row label="Displayed total due" value={money(displayedDue)} bold />
                </>
              )}
            </View>
          </KeyboardAwareScrollView>

          <View style={styles.reviewHoldRow}>
            <Pressable testID="hold-sale-button" disabled={busy || cart.length === 0} style={[styles.holdSaleBtn, (busy || cart.length === 0) && { opacity: 0.45 }]} onPress={holdCurrentSale}>
              <MaterialDesignIcons name="pause" size={20} color={colors.brandPrimary} />
              <Text style={styles.holdSaleText}>Hold Sale</Text>
            </Pressable>
            <Text style={styles.holdHint}>Save this cart and start a new sale</Text>
          </View>
          <View style={[styles.checkoutBar, { paddingBottom: insets.bottom + 12 }]}>
            <Pressable
              testID="checkout-button"
              disabled={busy}
              style={[styles.checkoutBtn, busy && { opacity: 0.6 }]}
              onPress={checkout}
            >
              <MaterialDesignIcons name="check-bold" size={22} color={colors.onBrandPrimary} />
              <Text style={styles.checkoutText}>{busy ? "Processing…" : `Complete Sale · ${money(customerCreditApplied > 0 ? amountToCollect : total)}`}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <OrderImageScannerModal
        visible={orderImageScanOpen}
        products={products ?? []}
        onClose={() => setOrderImageScanOpen(false)}
        onAddItems={onOrderImageItems}
      />

      <Modal visible={heldOpen} animationType="slide" onRequestClose={() => { setHeldOpen(false); setHeldSearch(""); }}>
        <View style={styles.root}>
          <ScreenHeader
            title="Held sales"
            subtitle="Find and resume a saved cart"
            topInset={insets.top}
            onBack={() => { setHeldOpen(false); setHeldSearch(""); }}
          />
          <View style={[styles.searchWrap, { margin: 16, marginBottom: 8 }]}>
            <MaterialDesignIcons name="magnify" size={20} color={colors.muted} />
            <TextInput
              testID="held-sale-search-input"
              style={styles.searchInput}
              placeholder="Search item, customer or held sale"
              placeholderTextColor={colors.muted}
              value={heldSearch}
              onChangeText={setHeldSearch}
              autoCorrect={false}
            />
            {heldSearch ? (
              <Pressable testID="clear-held-sale-search" hitSlop={8} onPress={() => setHeldSearch("")}>
                <MaterialDesignIcons name="close-circle" size={18} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: insets.bottom + 24, gap: 10 }}
            keyboardShouldPersistTaps="handled"
          >
            {heldSales.length === 0 ? (
              <EmptyState icon="pause-circle-outline" title="No held sales" message="Hold a sale to continue it later." />
            ) : filteredHeldSales.length === 0 ? (
              <EmptyState icon="magnify-close" title="No matching held sales" message="Try a product name or customer name." />
            ) : (
              filteredHeldSales.map((h) => {
                const subtotal = h.cart.reduce((n, x) => n + Number(x.quantity || 0) * Number(x.unit_price || 0), 0);
                const discountValue = Math.max(0, Number(h.discount || 0));
                const totalValue = Math.max(0, subtotal - discountValue);
                const customerName = customers?.find((c) => c.id === h.customerId)?.name ?? "Walk-in customer";
                return (
                  <View key={h.id} style={styles.heldCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.heldTitle}>{new Date(h.createdAt).toLocaleString()}</Text>
                      <Text style={styles.heldMeta}>{customerName} · {h.cart.length} product(s) · {h.cart.reduce((n, x) => n + Number(x.quantity || 0), 0)} unit(s)</Text>
                      <Text style={styles.heldProducts} numberOfLines={2}>{h.cart.map(x => x.name).join(" · ")}</Text>
                      <View style={styles.heldFinanceRow}>
                        <Text style={styles.heldFinanceText}>Subtotal {money(subtotal)}</Text>
                        {showSellProfitDiscount && <Text style={styles.heldDiscount}>Discount -{money(discountValue)}</Text>}
                        <Text style={styles.heldTotal}>Total {money(totalValue)}</Text>
                      </View>
                    </View>
                    <View style={styles.heldActions}>
                      <Pressable onPress={() => resumeHeldSale(h)} style={styles.resumeBtn}>
                        <MaterialDesignIcons name="play" size={18} color={colors.onBrandPrimary} />
                        <Text style={styles.resumeText}>Open</Text>
                      </Pressable>
                      <Pressable onPress={() => deleteHeldSale(h)} hitSlop={8}>
                        <MaterialDesignIcons name="delete-outline" size={22} color={colors.error} />
                      </Pressable>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>
      <Modal visible={addProductOpen} animationType="slide" onRequestClose={() => setAddProductOpen(false)}><View style={styles.root}><ScreenHeader title="Add products" subtitle="Search and add to this sale" topInset={insets.top} onBack={() => setAddProductOpen(false)} /><View style={[styles.searchWrap,{margin:16}]}><MaterialDesignIcons name="magnify" size={20} color={colors.muted}/><TextInput testID="review-product-search-input" style={styles.searchInput} placeholder="Search product, category or SKU" placeholderTextColor={colors.muted} value={addProductSearch} onChangeText={setAddProductSearch} autoFocus /></View><FlatList data={(products??[]).filter(p=>{const q=addProductSearch.trim().toLowerCase();return !q||p.name.toLowerCase().includes(q)||String(p.category??"").toLowerCase().includes(q)||String(p.barcode??p.sku??"").toLowerCase().includes(q)})} keyExtractor={p=>p.id} contentContainerStyle={{padding:16,gap:8}} renderItem={({item})=><Pressable style={styles.addProductOption} onPress={()=>{ addToCheckout(item); setAddProductOpen(false); }}><View style={{flex:1}}><Text style={styles.prodName}>{item.name}</Text><Text style={styles.prodMeta}>{item.quantity} in stock · {money(item.sale_price)}</Text></View><MaterialDesignIcons name="plus-circle" size={22} color={colors.brandPrimary}/></Pressable>} /></View></Modal>

      <Modal visible={sellProductCreateOpen} animationType="slide" onRequestClose={() => setSellProductCreateOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Add product" subtitle="Create it directly from Sell" topInset={insets.top} onBack={() => setSellProductCreateOpen(false)} />
          <KeyboardAwareScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
            <Text style={styles.formLabel}>Product name *</Text>
            <TextInput testID="new-sell-product-name" style={styles.formInput} placeholder="Product name" placeholderTextColor={colors.muted} value={newSellProductName} onChangeText={setNewSellProductName} />
            <Text style={styles.formLabel}>Barcode / SKU</Text>
            <TextInput testID="new-sell-product-barcode" style={styles.formInput} placeholder="Optional barcode" placeholderTextColor={colors.muted} value={newSellProductBarcode} onChangeText={setNewSellProductBarcode} />
            <Text style={styles.formLabel}>Sale price</Text>
            <TextInput testID="new-sell-product-sale-price" style={styles.formInput} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.muted} value={newSellProductSalePrice} onChangeText={setNewSellProductSalePrice} />
            <Text style={styles.hint}>If the product is new and has zero stock, enable “Sell below zero stock” before saving the sale. Existing matching products are reused.</Text>
            <Pressable testID="save-new-sell-product" style={styles.createPartySaveBtn} onPress={createProductFromSell}>
              <MaterialDesignIcons name="package-variant-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.resumeText}>Create & Add to Sale</Text>
            </Pressable>
          </KeyboardAwareScrollView>
        </View>
      </Modal>

      {/* Customer picker */}
      <Modal visible={custPickerOpen} animationType="slide" onRequestClose={() => setCustPickerOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Select customer" topInset={insets.top} onBack={() => setCustPickerOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 8 }}>
            <Pressable
              testID="create-customer-button"
              style={styles.createPartySaveBtn}
              onPress={() => setCustomerCreateOpen(true)}
            >
              <MaterialDesignIcons name="account-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.resumeText}>+ Create new customer</Text>
            </Pressable>
            <Pressable
              testID="customer-walkin"
              style={styles.custOption}
              onPress={() => {
                setCustomerId(null);
                setCustPickerOpen(false);
              }}
            >
              <Text style={styles.custOptionText}>Walk-in customer</Text>
              {!customerId && <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />}
            </Pressable>
            {(customers ?? []).map((c) => (
              <Pressable
                key={c.id}
                testID={`customer-${c.id}`}
                style={styles.custOption}
                onPress={() => {
                  setCustomerId(c.id);
                  setIncludePreviousBalance(false);
                  setPendingBalanceAdjustment(0);
                  setApplyCustomerCredit(false);
                  setCustPickerOpen(false);
                  const balance = Number(c.balance ?? 0);
                  if (admin && balance !== 0) {
                    const amount = Math.abs(balance);
                    const owesText = balance > 0
                      ? c.name + " owes the store " + money(amount) + "."
                      : "The store owes " + c.name + " " + money(amount) + " in customer credit.";
                    Alert.alert("Outstanding balance found", owesText + (balance > 0
                      ? "\n\nAdd this existing outstanding balance to the next sale receipt as a combined amount due? It will be shown on the receipt without charging the customer twice."
                      : "\n\nApply the customer's existing credit to this new bill?"), [
                      { text: "No, leave it", style: "cancel", onPress: () => { setIncludePreviousBalance(false); setPendingBalanceAdjustment(0); setApplyCustomerCredit(false); } },
                      { text: balance > 0 ? "Yes, add to receipt" : "Yes, apply credit", onPress: () => {
                        if (balance < 0) {
                          setApplyCustomerCredit(true);
                          setIncludePreviousBalance(false);
                          setPendingBalanceAdjustment(0);
                        } else {
                          setIncludePreviousBalance(true);
                          setPendingBalanceAdjustment(0);
                        }
                      } },
                    ]);
                  }
                }}
              >
                <View>
                  <Text style={styles.custOptionText}>{c.name}</Text>
                  {!!c.phone && <Text style={styles.custPhone}>{c.phone}</Text>}
                </View>
                {customerId === c.id && (
                  <MaterialDesignIcons name="check" size={20} color={colors.brandPrimary} />
                )}
              </Pressable>
            ))}
            {(!customers || customers.length === 0) && (
              <Text style={styles.custHint}>No customers yet. Add them in More → Customers.</Text>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Create customer directly from sale */}
      <Modal visible={customerCreateOpen} animationType="slide" onRequestClose={() => setCustomerCreateOpen(false)}>
        <View style={styles.root}>
          <ScreenHeader title="Create customer" subtitle="Add customer without leaving sale" topInset={insets.top} onBack={() => setCustomerCreateOpen(false)} />
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
            <Text style={styles.formLabel}>Customer name *</Text>
            <TextInput testID="new-customer-name" style={styles.formInput} placeholder="Customer name" placeholderTextColor={colors.muted} value={newCustomerName} onChangeText={setNewCustomerName} />
            <Text style={styles.formLabel}>Phone</Text>
            <TextInput testID="new-customer-phone" style={styles.formInput} placeholder="Phone number" placeholderTextColor={colors.muted} keyboardType="phone-pad" value={newCustomerPhone} onChangeText={setNewCustomerPhone} />
            <Text style={styles.formLabel}>Address</Text>
            <TextInput testID="new-customer-address" style={[styles.formInput, styles.formInputMulti]} placeholder="Address (optional)" placeholderTextColor={colors.muted} multiline value={newCustomerAddress} onChangeText={setNewCustomerAddress} />
            <Pressable testID="save-new-customer-button" style={styles.createPartySaveBtn} onPress={createCustomer}>
              <MaterialDesignIcons name="account-plus" size={20} color={colors.onBrandPrimary} />
              <Text style={styles.checkoutText}>Create & Select Customer</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      <BarcodeScannerModal visible={scanOpen} onClose={() => setScanOpen(false)} onScanned={onScanned} />
    </View>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, bold && styles.totalBold]}>{label}</Text>
      <Text style={[styles.totalValue, bold && styles.totalBold]}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 12 },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scanBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  scanOrderSellBtn: {
    height: 48,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  scanOrderSellText: { color: colors.onBrandPrimary, fontSize: 12, fontWeight: "900" },
  searchInput: { flex: 1, fontSize: 15, color: colors.onSurface },
  voiceBtn: { width: 46, height: 48, borderRadius: 12, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center" },
  voiceBtnActive: { backgroundColor: colors.error },
  voiceLanguageBtn: { width: 38, height: 42, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  voiceLanguageText: { color: colors.onSurface, fontSize: 11, fontWeight: "900" },
  searchActionRow: { marginHorizontal: 16, marginTop: 8, marginBottom: 2, minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", columnGap: 10, rowGap: 8 },
  searchQuantityGroup: { flexDirection: "row", alignItems: "center", gap: 8 },
  searchToolsGroup: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginLeft: "auto" },
  searchQuantityLabel: { color: colors.muted, fontSize: 11, fontWeight: "900" },
  searchQtyInput: { width: 58, height: 42, textAlign: "center", borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceTertiary, color: colors.onSurface, fontSize: 16, fontWeight: "900", paddingHorizontal: 6 },
  searchHint: { marginHorizontal: 18, marginTop: 1, marginBottom: 5, color: colors.muted, fontSize: 11, lineHeight: 15 },
  searchResultsHeader: { color: colors.muted, fontSize: 12, fontWeight: "800", marginBottom: 2, marginTop: 2 },
  searchEmptyHint: { color: colors.muted, fontSize: 13, textAlign: "center", paddingVertical: 20, paddingHorizontal: 24 },
  voiceStatus: { marginHorizontal: 16, marginTop: 4, marginBottom: 4, padding: 10, borderRadius: 10, backgroundColor: colors.brandTertiary, flexDirection: "row", alignItems: "center", gap: 8 },
  voiceStatusText: { color: colors.onSurface, fontSize: 12, fontWeight: "700" },
  voiceTranscriptText: { color: colors.muted, fontSize: 11, marginTop: 3 },
  voiceSessionCard: { marginHorizontal: 16, marginTop: 6, marginBottom: 4, padding: 12, borderRadius: 13, borderWidth: 1, borderColor: colors.brandPrimary, backgroundColor: colors.surfaceSecondary, gap: 9 },
  voiceSessionHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  voiceSessionTitle: { color: colors.onSurface, fontSize: 13, fontWeight: "900" },
  voiceSessionHint: { color: colors.muted, fontSize: 11, marginTop: 2 },
  voiceListeningDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.muted },
  voiceListeningDotActive: { backgroundColor: colors.error },
  voiceNoItems: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  voiceDraftList: { maxHeight: 190 },
  voiceDraftRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.border },
  voiceDraftName: { color: colors.onSurface, fontSize: 13, fontWeight: "800" },
  voiceDraftQuantity: { color: colors.brandPrimary, fontSize: 12, fontWeight: "900", marginTop: 3 },
  voiceCandidateList: { gap: 5, marginTop: 7 },
  voiceCandidateButton: { alignSelf: "flex-start", borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: colors.surface },
  voiceCandidateText: { color: colors.brandPrimary, fontSize: 11, fontWeight: "800" },
  voiceUnmatchedText: { color: colors.error, fontSize: 11, fontWeight: "700" },
  voiceSessionActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  voiceResumeButton: { minHeight: 38, paddingHorizontal: 10, borderRadius: 9, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", gap: 5 },
  voiceResumeText: { color: colors.brandPrimary, fontSize: 11, fontWeight: "900" },
  voiceCancelButton: { minHeight: 38, paddingHorizontal: 10, borderRadius: 9, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  voiceCancelText: { color: colors.muted, fontSize: 11, fontWeight: "800" },
  voiceDoneButton: { flex: 1, minHeight: 40, borderRadius: 9, paddingHorizontal: 9, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 5, backgroundColor: colors.brandPrimary },
  voiceDoneText: { color: colors.onBrandPrimary, fontSize: 11, fontWeight: "900" },
  prodRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
  prodName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  prodMeta: { fontSize: 13, color: colors.muted, marginTop: 2 },
  lowTagRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  lowTagText: { fontSize: 12, color: colors.warning, fontWeight: "700" },
  lowWarn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.warning + "18",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  lowWarnText: { flex: 1, fontSize: 12.5, color: colors.warning, fontWeight: "600" },
  addBtn: {
    minWidth: 62,
    height: 44,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: colors.brandPrimary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  addBtnQuantity: { color: colors.onBrandPrimary, fontSize: 12, fontWeight: "900" },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepQty: { minWidth: 26, textAlign: "center", fontSize: 16, fontWeight: "800", color: colors.onSurface },
  stepQtyInput: { minWidth: 48, height: 38, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, textAlign: "center", paddingHorizontal: 6, fontSize: 15, fontWeight: "900", color: colors.onSurface },
  forceStockRow: { marginHorizontal: 16, marginTop: 8, marginBottom: 4, minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.surfaceSecondary },
  forceStockText: { fontSize: 13, fontWeight: "800", color: colors.onSurface },
  forceStockHint: { fontSize: 11, color: colors.muted, marginTop: 2 },
  bottomActions: { position:"absolute", left:12, right:12, bottom:10, flexDirection:"row", alignItems:"center", gap:8 },
  reviewHoldRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, backgroundColor: colors.surface },
  holdSaleBtn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, borderWidth: 1, borderColor: colors.brandPrimary, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  holdSaleText: { color: colors.brandPrimary, fontSize: 14, fontWeight: "800" },
  holdHint: { flex: 1, fontSize: 11, color: colors.muted },
  formLabel: { fontSize: 12, fontWeight: "700", color: colors.onSurfaceSecondary, marginTop: 4 },
  formInput: { backgroundColor: colors.surfaceTertiary, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, height: 48, fontSize: 15, color: colors.onSurface },
  formInputMulti: { minHeight: 84, height: 84, paddingTop: 12, textAlignVertical: "top" },
  hint: { fontSize: 11, color: colors.muted, lineHeight: 16 },
  createPartySaveBtn: { minHeight: 50, borderRadius: 12, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  heldBtn: { minHeight:52, paddingHorizontal:14, borderRadius:14, borderWidth:1, borderColor:colors.border, backgroundColor:colors.surface, flexDirection:"row", alignItems:"center", gap:6 },
  heldBtnText: { fontSize:13, fontWeight:"800", color:colors.brandPrimary },
  holdCheckoutRow: { paddingHorizontal:16, paddingTop:8, backgroundColor:colors.surface },
  reviewActionRow: { flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 8 },
  reviewSearchRow: { marginHorizontal:16, marginBottom:4, minHeight:46, borderWidth:1, borderColor:colors.border, borderRadius:12, flexDirection:"row", alignItems:"center", paddingLeft:12, paddingRight:6, gap:7, backgroundColor:colors.surfaceSecondary },
  reviewAddBtn: { minHeight:36, paddingHorizontal:10, borderRadius:9, backgroundColor:colors.brandPrimary, flexDirection:"row", alignItems:"center", gap:4 },
  reviewAddText: { color:colors.onBrandPrimary, fontWeight:"800", fontSize:12 },
  scanOrderBtn: { flex: 1, minHeight: 46, borderRadius: 12, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 10 },
  scanOrderText: { color: colors.onBrandPrimary, fontSize: 13, fontWeight: "900" },
  reviewInventoryBox: { borderWidth:1, borderColor:colors.border, borderRadius:12, backgroundColor:colors.surfaceSecondary, overflow:"hidden" },
  reviewInventoryTitle: { fontSize:12, fontWeight:"800", color:colors.onSurface, padding:10, borderBottomWidth:1, borderBottomColor:colors.border },
  reviewInventoryRow: { minHeight:58, paddingHorizontal:10, paddingVertical:8, flexDirection:"row", alignItems:"center", gap:8, borderBottomWidth:1, borderBottomColor:colors.border },
  reviewInventoryName: { fontSize:13, fontWeight:"700", color:colors.onSurface },
  reviewInventoryMeta: { fontSize:11, color:colors.muted, marginTop:2 },
  reviewInventoryAdd: { minHeight:34, paddingHorizontal:10, borderRadius:8, backgroundColor:colors.brandPrimary, flexDirection:"row", alignItems:"center", gap:3 },
  reviewInventoryAddText: { color:colors.onBrandPrimary, fontSize:12, fontWeight:"800" },
  reviewNoMatch: { fontSize:12, color:colors.muted, paddingVertical:10, textAlign:"center" },
  heldCard: { borderWidth:1, borderColor:colors.border, borderRadius:14, padding:13, backgroundColor:colors.surface, flexDirection:"row", gap:10 },
  heldTitle: { fontSize:14, fontWeight:"800", color:colors.onSurface },
  heldMeta:{fontSize:12,color:colors.muted,marginTop:3},
  heldProducts:{fontSize:12,color:colors.onSurfaceSecondary,marginTop:6},
  heldActions:{alignItems:"center",justifyContent:"center",gap:12},
  resumeBtn:{minHeight:38,paddingHorizontal:11,borderRadius:9,backgroundColor:colors.brandPrimary,flexDirection:"row",alignItems:"center",gap:4},
  resumeText:{color:colors.onBrandPrimary,fontSize:12,fontWeight:"800"},
  heldFinanceRow:{flexDirection:"row",alignItems:"center",gap:8,marginTop:8,flexWrap:"wrap"},
  heldFinanceText:{fontSize:11,color:colors.muted},
  heldDiscount:{fontSize:11,color:colors.warning,fontWeight:"700"},
  heldTotal:{fontSize:13,color:colors.brandPrimary,fontWeight:"900"},
  addProductOption:{flexDirection:"row",alignItems:"center",gap:10,padding:13,borderRadius:12,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface},
  cartBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.brandPrimary,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  cartCountBubble: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.onBrandPrimary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  cartCountText: { color: colors.brandPrimary, fontWeight: "800", fontSize: 14 },
  cartBarText: { flex: 1, color: colors.onBrandPrimary, fontWeight: "700", fontSize: 16 },
  cartBarTotal: { color: colors.onBrandPrimary, fontWeight: "800", fontSize: 16 },
  customerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.brandTertiary,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  customerText: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.onSurface },
  cartLine: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 10,
  },
  cartLineHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cartLineName: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.onSurface },
  cartLineInputs: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  miniField: { flex: 1, gap: 4 },
  miniLabel: { fontSize: 11, color: colors.muted, fontWeight: "600" },
  miniInput: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    height: 44,
    fontSize: 15,
    color: colors.onSurface,
  },
  lineTotalBox: { flex: 1, gap: 4 },
  lineTotal: { fontSize: 15, fontWeight: "800", color: colors.brandPrimary, paddingVertical: 10 },
  saleDetailsToggleRow: { marginTop: 4, minHeight: 40, paddingHorizontal: 4, flexDirection:"row", alignItems:"center", justifyContent:"space-between" },
  saleDetailsToggleLabel: { fontSize:12, fontWeight:"700", color:colors.muted },
  detailsToggle: { width:42, height:24, borderRadius:12, backgroundColor:colors.border, padding:2, justifyContent:"center" },
  detailsToggleOn: { backgroundColor:colors.brandPrimary },
  detailsToggleThumb: { width:20, height:20, borderRadius:10, backgroundColor:colors.surface, alignSelf:"flex-start" },
  detailsToggleThumbOn: { alignSelf:"flex-end" },
  discountRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  discountLabel: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
  creditRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  creditHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
  discountInput: {
    width: 130,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    height: 46,
    fontSize: 15,
    color: colors.onSurface,
    textAlign: "right",
  },
  totalsCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 14,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { fontSize: 14, color: colors.onSurfaceSecondary },
  totalValue: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  totalBold: { fontSize: 18, fontWeight: "800", color: colors.onSurface },
  totalDivider: { height: 1, backgroundColor: colors.divider, marginVertical: 4 },
  checkoutBar: {
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: colors.surface,
  },
  checkoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: colors.brandPrimary,
    borderRadius: 14,
    minHeight: 54,
  },
  checkoutText: { color: colors.onBrandPrimary, fontSize: 16, fontWeight: "800" },
  custOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  custOptionText: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
  custPhone: { fontSize: 13, color: colors.muted, marginTop: 2 },
  custHint: { fontSize: 14, color: colors.muted, textAlign: "center", marginTop: 20 },
}));
