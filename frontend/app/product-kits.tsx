import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useProducts } from "@/src/data";
import { Product } from "@/src/models";
import { storage } from "@/src/utils/storage";
import { Card, ScreenHeader, useToast } from "@/src/ui";
import { useTheme } from "@/src/theme";

export type ProductKitComponent = { product_id: string; quantity: number };
export type ProductKit = { id: string; name: string; components: ProductKitComponent[]; updated_at: string };
export const PRODUCT_KITS_KEY = "ssm.product-kits.v1";

export default function ProductKitsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { data: products = [] } = useProducts();
  const [kits, setKits] = useState<ProductKit[]>([]);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { void storage.getItem<ProductKit[]>(PRODUCT_KITS_KEY, []).then((rows) => setKits(rows ?? [])); }, []);
  const selectedCount = Object.values(selected).filter((v) => Number(v) > 0).length;
  const filtered = products.filter((p) => (p.name+" "+(p.barcode || "")).toLowerCase().includes(search.toLowerCase())).slice(0,100);

  const reset = () => { setName(""); setEditingId(""); setSelected({}); setSearch(""); };
  const save = async () => {
    const components = Object.entries(selected).map(([product_id, value]) => ({ product_id, quantity: Number(value) })).filter((x) => Number.isFinite(x.quantity) && x.quantity > 0);
    if (!name.trim()) { toast.show("Enter a kit name"); return; }
    if (!components.length) { toast.show("Select at least one stock product and quantity"); return; }
    setSaving(true);
    try {
      const nextKit: ProductKit = { id: editingId || "kit-"+Date.now(), name: name.trim(), components, updated_at: new Date().toISOString() };
      const next = editingId ? kits.map((k) => k.id === editingId ? nextKit : k) : [nextKit, ...kits];
      await storage.setItem(PRODUCT_KITS_KEY, next as any);
      setKits(next); reset(); toast.show("Kit saved. Stock is not deducted until a sale is completed.");
    } catch { toast.show("Could not save kit"); }
    finally { setSaving(false); }
  };
  const edit = (kit: ProductKit) => {
    setEditingId(kit.id); setName(kit.name);
    setSelected(Object.fromEntries(kit.components.map((x) => [x.product_id, String(x.quantity)])));
    setSearch("");
  };
  const remove = async (id: string) => {
    const next = kits.filter((k) => k.id !== id);
    await storage.setItem(PRODUCT_KITS_KEY, next as any); setKits(next);
    if (editingId === id) reset();
    toast.show("Kit deleted");
  };

  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <ScreenHeader title="Product Kits" subtitle="Bundle products for one-tap cart entry" topInset={insets.top} onBack={() => router.back()} />
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 28, gap: 12 }}>
      <Card>
        <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}>{editingId ? "Edit kit" : "Create product kit"}</Text>
        <Text style={{ color: colors.muted, marginVertical: 6 }}>Choose components and required quantities. Saving or adding a kit to the cart never changes stock.</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Kit name (e.g. Dressing Pack)" placeholderTextColor={colors.muted} style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginTop: 8 }} />
        <TextInput value={search} onChangeText={setSearch} placeholder="Search stock products" placeholderTextColor={colors.muted} style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginTop: 8 }} />
        <Text style={{ color: colors.muted, marginTop: 8, marginBottom: 4 }}>{selectedCount} component types selected</Text>
        {filtered.map((p: Product) => {
          const active = Number(selected[p.id] ?? 0) > 0;
          return <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
            <Pressable onPress={() => setSelected((old) => { const next = { ...old }; if (Number(next[p.id] ?? 0) > 0) delete next[p.id]; else next[p.id] = "1"; return next; })} style={{ width: 28, height: 28, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: active ? colors.brandPrimary : colors.surfaceTertiary }}><Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontWeight: "700" }}>{active ? "✓" : "+"}</Text></Pressable>
            <View style={{ flex: 1 }}><Text style={{ color: colors.onSurface, fontWeight: "600" }}>{p.name}</Text><Text style={{ color: colors.muted, fontSize: 12 }}>Available {p.quantity} · {p.sale_price}</Text></View>
            {active && <TextInput value={selected[p.id]} onChangeText={(v) => setSelected((old) => ({ ...old, [p.id]: v }))} keyboardType="decimal-pad" style={{ color: colors.onSurface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 8, minWidth: 58, textAlign: "center" }} />}
          </View>;
        })}
        <Pressable disabled={saving} onPress={() => void save()} style={{ backgroundColor: colors.brandPrimary, borderRadius: 10, padding: 14, alignItems: "center", marginTop: 12 }}><Text style={{ color: colors.onBrandPrimary, fontWeight: "700" }}>{saving ? "Saving..." : editingId ? "Update Kit" : "Save Kit"}</Text></Pressable>
        {!!editingId && <Pressable onPress={reset} style={{ padding: 10, alignItems: "center" }}><Text style={{ color: colors.muted }}>Cancel edit</Text></Pressable>}
      </Card>
      <Card>
        <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: "700" }}>Saved kits ({kits.length})</Text>
        {kits.length === 0 ? <Text style={{ color: colors.muted, marginTop: 8 }}>No kits saved yet.</Text> : kits.map((kit) => <View key={kit.id} style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, marginTop: 8 }}>
          <Text style={{ color: colors.onSurface, fontWeight: "700" }}>{kit.name}</Text>
          {kit.components.map((c) => <Text key={c.product_id} style={{ color: colors.muted, fontSize: 12, marginTop: 3 }}>{products.find((p) => p.id === c.product_id)?.name ?? "Deleted product"} × {c.quantity}</Text>)}
          <View style={{ flexDirection: "row", gap: 16, marginTop: 10 }}><Pressable onPress={() => edit(kit)}><Text style={{ color: colors.brandPrimary, fontWeight: "700" }}>Edit</Text></Pressable><Pressable onPress={() => void remove(kit.id)}><Text style={{ color: colors.error, fontWeight: "700" }}>Delete</Text></Pressable></View>
        </View>)}
      </Card>
    </ScrollView>
  </View>;
}
