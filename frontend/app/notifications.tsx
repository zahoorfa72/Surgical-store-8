import {useCallback,useState} from "react";
import {ScrollView,Text,View} from "react-native";
import {useFocusEffect,useRouter} from "expo-router";
import {useSafeAreaInsets} from "react-native-safe-area-context";
import {MaterialDesignIcons} from "@react-native-vector-icons/material-design-icons";
import {AppNotification,getAppNotifications,markAppNotificationsRead} from "@/src/notification-center";
import {ScreenHeader,Card} from "@/src/ui";
import {useTheme} from "@/src/theme";
export default function NotificationsScreen(){
 const router=useRouter(),insets=useSafeAreaInsets(),{colors}=useTheme();const[rows,setRows]=useState<AppNotification[]>([]);
 const load=useCallback(async()=>{await markAppNotificationsRead();setRows(await getAppNotifications());},[]);
 useFocusEffect(useCallback(()=>{void load();},[load]));
 return <View style={{flex:1,backgroundColor:colors.background}}><ScreenHeader title="Notifications" subtitle="Payments, stock and store activity" topInset={insets.top} onBack={()=>router.back()}/>
 <ScrollView contentContainerStyle={{padding:16,paddingBottom:insets.bottom+24,gap:10}}>{!rows.length?<Card><Text style={{color:colors.muted}}>No notifications yet. Payment, receipt and stock alerts will appear here.</Text></Card>:rows.map(row=><Card key={row.id}><View style={{flexDirection:"row",gap:10,alignItems:"flex-start"}}><MaterialDesignIcons name={row.type.includes("stock")?"package-variant":row.type.includes("payment")?"cash-multiple":"bell-outline"} size={23} color={colors.brandPrimary}/><View style={{flex:1}}><Text style={{color:colors.onSurface,fontWeight:"700",fontSize:15}}>{row.title}</Text><Text style={{color:colors.onSurface,marginTop:4}}>{row.body}</Text><Text style={{color:colors.muted,fontSize:11,marginTop:7}}>{new Date(row.created_at).toLocaleString()}</Text></View></View></Card>)}</ScrollView></View>;
}