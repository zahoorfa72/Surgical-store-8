import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { MaterialDesignIcons } from "@react-native-vector-icons/material-design-icons";
import { useTheme } from "@/src/theme";

export function DateCalendar({ visible, initialIso, onSelect, onClose }: {
  visible: boolean; initialIso: string; onSelect: (iso: string) => void; onClose: () => void;
}) {
  const { colors } = useTheme();
  const [cursor, setCursor] = useState(new Date());
  useEffect(() => {
    if (visible) {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(initialIso) ? new Date(initialIso + "T12:00:00") : new Date();
      setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  }, [visible, initialIso]);
  const y = cursor.getFullYear(), m = cursor.getMonth();
  const days = new Date(y, m + 1, 0).getDate(), first = new Date(y, m, 1).getDay();
  const cells = Array.from({ length: first + days }, (_, i) => i < first ? null : i - first + 1);
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <Pressable onPress={onClose} style={{flex:1,backgroundColor:"rgba(0,0,0,0.45)",justifyContent:"center",padding:20}}>
      <Pressable onPress={(e)=>e.stopPropagation()} style={{backgroundColor:colors.surface,borderRadius:20,padding:18}}>
        <View style={{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <Pressable onPress={()=>setCursor(new Date(y,m-1,1))} style={{padding:8}}><MaterialDesignIcons name="chevron-left" size={26} color={colors.brandPrimary}/></Pressable>
          <Text style={{fontSize:17,fontWeight:"900",color:colors.brandPrimary}}>{cursor.toLocaleString(undefined,{month:"long"})} {y}</Text>
          <Pressable onPress={()=>setCursor(new Date(y,m+1,1))} style={{padding:8}}><MaterialDesignIcons name="chevron-right" size={26} color={colors.brandPrimary}/></Pressable>
        </View>
        <View style={{flexDirection:"row",flexWrap:"wrap"}}>
          {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d=><Text key={d} style={{width:"14.2857%",textAlign:"center",fontSize:11,fontWeight:"800",color:colors.muted,paddingVertical:6}}>{d}</Text>)}
          {cells.map((day,i)=>day==null?<View key={"b"+i} style={{width:"14.2857%",aspectRatio:1}}/>:<Pressable key={day} onPress={()=>{onSelect(y+"-"+String(m+1).padStart(2,"0")+"-"+String(day).padStart(2,"0"));onClose();}} style={{width:"14.2857%",aspectRatio:1,alignItems:"center",justifyContent:"center"}}><Text style={{fontSize:14,fontWeight:"800",color:colors.onSurface}}>{day}</Text></Pressable>)}
        </View>
      </Pressable>
    </Pressable>
  </Modal>;
}