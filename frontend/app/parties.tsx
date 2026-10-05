import { FlatList, Pressable, Text, View } from "react-native";
import { useEffect, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { apiRequest } from "@/src/api";
import { isAdmin, useAuth } from "@/src/auth";
import { useParties, qk } from "@/src/data";
import { Party, PartyType } from "@/src/models";
import { ConfirmModal, EmptyState, Loader, ScreenHeader, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { getHiddenSupplierIds } from "@/src/utils/finance-display";

export default function Parties() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth(); const admin = isAdmin(user?.role);
  const { type } = useLocalSearchParams<{ type: PartyType }>();
  const partyType: PartyType = type === "supplier" ? "supplier" : "customer";
  const isSupplier = partyType === "supplier";

  const { data: parties, isLoading } = useParties(partyType);
  const [toDelete, setToDelete] = useState<Party | null>(null);
  const [hiddenSupplierIds, setHiddenSupplierIds] = useState<string[]>([]);

  useEffect(() => {
    if (!isSupplier) return;
    void getHiddenSupplierIds().then(setHiddenSupplierIds);
  }, [isSupplier]);

  const visibleParties = isSupplier
    ? (parties ?? []).filter((party) => !hiddenSupplierIds.includes(party.id))
    : (parties ?? []);

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await apiRequest(`/parties/${toDelete.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: qk.parties(partyType) });
      toast("Removed", "success");
    } catch (e: any) {
      toast(e?.message || "Delete failed", "error");
    } finally {
      setToDelete(null);
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={isSupplier ? "Suppliers" : "Customers"}
        subtitle={`${parties?.length ?? 0} ${isSupplier ? "supplier(s)" : "customer(s)"}`}
        topInset={insets.top}
        onBack={() => router.back()}
      />
      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={visibleParties}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 10 }}
          ListEmptyComponent={
            <EmptyState
              icon={isSupplier ? "domain" : "account-group"}
              title={isSupplier ? "No suppliers" : "No customers"}
              message="Tap + to add one."
              testID="parties-empty"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`party-row-${item.id}`}
              style={styles.row}
              onPress={() => { if (admin) router.push(`/party-form?id=${item.id}&type=${partyType}`); }}
            >
              <View style={styles.avatar}>
                <MaterialDesignIcons name={isSupplier ? "domain" : "account"} size={22} color={colors.brandPrimary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                {!!item.phone && <Text style={styles.meta}>{item.phone}</Text>}
                {!!item.address && <Text style={styles.sub}>{item.address}</Text>}
              </View>
              {admin && <Pressable testID={`delete-party-${item.id}`} hitSlop={8} onPress={() => setToDelete(item)} style={styles.delBtn}>
                <MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error} />
              </Pressable>}
            </Pressable>
          )}
        />
      )}

      <Pressable
        testID="add-party-fab"
        style={[styles.fab, { bottom: 16 }]}
        onPress={() => router.push(`/party-form?type=${partyType}`)}
      >
        <MaterialDesignIcons name="plus" size={28} color={colors.onBrandPrimary} />
      </Pressable>

      <ConfirmModal
        visible={!!toDelete}
        title="Remove?"
        message={`"${toDelete?.name}" will be removed.`}
        confirmLabel="Remove"
        onConfirm={confirmDelete}
        onCancel={() => setToDelete(null)}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.surface },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: 13, color: colors.onSurfaceSecondary, marginTop: 2 },
  sub: { fontSize: 12, color: colors.muted, marginTop: 1 },
  delBtn: { padding: 4 },
  fab: {
    position: "absolute",
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
}));
