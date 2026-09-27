import { FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";

import { useReturns, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { apiRequest } from "@/src/api";
import { ConfirmModal, EmptyState, Loader, ScreenHeader, formatDateTime, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function Returns() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: returns, isLoading } = useReturns();
  const { user } = useAuth(); const admin = isAdmin(user?.role); const queryClient = useQueryClient(); const toast = useToast();
  const [toDelete,setToDelete]=useState<any>(null);

  return (
    <View style={styles.root}>
      <ScreenHeader title="Returns & refunds" subtitle={`${returns?.length ?? 0} return(s)`} topInset={insets.top} onBack={() => router.back()} />
      {isLoading ? (
        <Loader />
      ) : (
        <FlatList
          data={returns}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 10 }}
          ListEmptyComponent={<EmptyState icon="cash-refund" title="No returns" message="Processed returns will appear here." testID="returns-empty" />}
          renderItem={({ item }) => (
            <View style={styles.row} testID={`return-row-${item.id}`}>
              <View style={styles.iconBox}>
                <MaterialDesignIcons name="undo-variant" size={22} color={colors.error} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.ref}>{item.ref_no} · {item.invoice_no}</Text>
                <Text style={styles.meta}>{item.customer_name} · {formatDateTime(item.created_at)}</Text>
                <Text style={styles.sub}>
                  {item.items.reduce((s, i) => s + i.quantity, 0)} item(s){item.reason ? ` · ${item.reason}` : ""}
                </Text>
              </View>
              <Text style={styles.amount}>-{money(item.refund_total)}</Text>{admin && <View style={{flexDirection:"row",gap:8}}><Pressable onPress={()=>router.push(`/return-form?return_id=${item.id}&sale_id=${item.sale_id}`)} hitSlop={8}><MaterialDesignIcons name="pencil" size={20} color={colors.brandPrimary}/></Pressable><Pressable onPress={()=>setToDelete(item)} hitSlop={8}><MaterialDesignIcons name="trash-can-outline" size={20} color={colors.error}/></Pressable></View>}
            </View>
          )}
        />
      )}
      <ConfirmModal visible={!!toDelete} title="Delete return?" message={`Delete ${toDelete?.ref_no ?? ""} and reverse its stock adjustment?`} confirmLabel="Delete" onConfirm={async()=>{try{await apiRequest(`/returns/${toDelete.id}`,{method:"DELETE"});await queryClient.invalidateQueries({queryKey:qk.returns});await queryClient.invalidateQueries({queryKey:qk.products});toast("Return deleted","success")}catch(e:any){toast(e?.message||"Delete failed","error")}finally{setToDelete(null)}}} onCancel={()=>setToDelete(null)}/>
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
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.error + "1A",
    alignItems: "center",
    justifyContent: "center",
  },
  ref: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  meta: { fontSize: 13, color: colors.onSurfaceSecondary, marginTop: 2 },
  sub: { fontSize: 12, color: colors.muted, marginTop: 1 },
  amount: { fontSize: 16, fontWeight: "800", color: colors.error },
}));
