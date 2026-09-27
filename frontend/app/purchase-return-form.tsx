import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/src/api";
import { usePurchase, usePurchaseReturns, qk } from "@/src/data";
import { isAdmin, useAuth } from "@/src/auth";
import { Field, Loader, PrimaryButton, ScreenHeader, money, useToast } from "@/src/ui";
import { makeStyles, useTheme } from "@/src/theme";

export default function PurchaseReturnForm() {
  const styles=useStyles(); const {colors}=useTheme(); const insets=useSafeAreaInsets();
  const router=useRouter(); const queryClient=useQueryClient(); const toast=useToast();
  const {purchase_id, return_id}=useLocalSearchParams<{purchase_id:string;return_id?:string}>();
  const {user}=useAuth(); const admin=isAdmin(user?.role); const editing=!!return_id&&admin;
  const {data:purchase,isLoading}=usePurchase(purchase_id ?? "");
  const {data:returnRows=[]}=usePurchaseReturns();

  const [qtys,setQtys]=useState<Record<string,string>>({}); const [reason,setReason]=useState(""); const [busy,setBusy]=useState(false);
  const existingReturn:any=returnRows?.find((r:any)=>r.id===return_id);
  const returned=(purchase as any)?.returned_items ?? {};
  const rows=useMemo(()=>!purchase?[]:purchase.items.map(it=>{const already=Number(returned[it.product_id]??0);const own=editing?Number(existingReturn?.items?.find((x:any)=>x.product_id===it.product_id)?.quantity??0):0;return {...it,already,remaining:Math.max(0,it.quantity-already+own)}}),[purchase,returned,editing,existingReturn]);
  useEffect(()=>{if(editing&&existingReturn){const initial:any={};for(const it of existingReturn.items??[])initial[it.product_id]=String(it.quantity);setQtys(initial);setReason(existingReturn.reason??"");}},[editing,existingReturn]);
  const total=rows.reduce((s,r)=>s+Math.min(parseFloat(qtys[r.product_id]||"0")||0,r.remaining)*r.unit_cost,0);
  const submit=async()=>{
    const items=rows.map(r=>({product_id:r.product_id,quantity:Math.min(parseFloat(qtys[r.product_id]||"0")||0,r.remaining)})).filter(x=>x.quantity>0);
    if(!items.length){toast("Enter quantity to return","error");return;}
    setBusy(true);
    try{
      await apiRequest(editing?`/purchase-returns/${return_id}`:"/purchase-returns",{method:editing?"PUT":"POST",body:{purchase_id,items,reason:reason.trim()}});
      await queryClient.invalidateQueries({queryKey:qk.products});
      await queryClient.invalidateQueries({queryKey:qk.purchases});
      await queryClient.invalidateQueries({queryKey:qk.purchase(purchase_id!)});
      await queryClient.invalidateQueries({queryKey:qk.purchaseReturns});
      await queryClient.invalidateQueries({queryKey:qk.parties("supplier")});
      toast(editing?"Purchase return updated":"Purchase return processed & stock reduced","success"); router.back();
    }catch(e:any){toast(e?.message||"Purchase return failed","error")}finally{setBusy(false)}
  };
  if(isLoading||!purchase)return <Loader/>;
  return <View style={styles.root}>
    <ScreenHeader title="Return to supplier" subtitle={purchase.ref_no} topInset={insets.top} onBack={()=>router.back()}/>
    <View style={{flex:1}}>
      <View style={{padding:16,gap:12}}>
        <Text style={styles.help}>Choose quantities being returned to the supplier. Stock is reduced and the supplier amount is adjusted.</Text>
        {rows.map(r=><View key={r.product_id} style={styles.line} testID={`purchase-return-row-${r.product_id}`}>
          <View style={{flex:1}}><Text style={styles.name}>{r.name}</Text><Text style={styles.meta}>Purchased {r.quantity} · returned {r.already} · {money(r.unit_cost)} each</Text></View>
          <TextInput testID={`purchase-return-qty-${r.product_id}`} style={styles.qty} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.muted} editable={r.remaining>0} value={qtys[r.product_id]??""}
            onChangeText={t=>setQtys(p=>({...p,[r.product_id]:t===""?"":String(Math.min(parseFloat(t)||0,r.remaining))}))}/>
        </View>)}
        <Field label="Reason (optional)" value={reason} onChangeText={setReason} placeholder="e.g. damaged, wrong item" multiline/>
        <View style={styles.total}><Text style={styles.totalLabel}>Supplier refund</Text><Text style={styles.totalValue}>{money(total)}</Text></View>
        <PrimaryButton label="Process supplier return" onPress={submit} busy={busy} tone="danger" icon="undo-variant" testID="purchase-return-submit"/>
      </View>
    </View>
  </View>
}
const useStyles=makeStyles(colors=>({
 root:{flex:1,backgroundColor:colors.surface},help:{fontSize:13,color:colors.muted,lineHeight:18},
 line:{flexDirection:"row",alignItems:"center",gap:12,backgroundColor:colors.surfaceSecondary,borderRadius:14,borderWidth:1,borderColor:colors.border,padding:14},
 name:{fontSize:15,fontWeight:"700",color:colors.onSurface},meta:{fontSize:12,color:colors.muted,marginTop:2},
 qty:{width:72,height:48,borderRadius:10,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface,textAlign:"center",fontSize:16,fontWeight:"700",color:colors.onSurface},
 total:{flexDirection:"row",alignItems:"center",backgroundColor:colors.error+"12",borderRadius:14,padding:16},totalLabel:{flex:1,fontSize:15,fontWeight:"700",color:colors.onSurface},totalValue:{fontSize:18,fontWeight:"800",color:colors.error}
}));