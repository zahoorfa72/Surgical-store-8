import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";
export type AppNotification = { id:string; title:string; body:string; type:string; created_at:string; read:boolean };
const KEY="ssm.notifications.v1";
export async function getAppNotifications():Promise<AppNotification[]>{return (await storage.getItem<AppNotification[]>(KEY,[]))??[];}
export async function addAppNotification(title:string,body:string,type:string):Promise<void>{
 const rows=await getAppNotifications(); const row={id:"notice-"+Date.now()+"-"+Math.random().toString(36).slice(2,7),title,body,type,created_at:new Date().toISOString(),read:false};
 await storage.setItem(KEY,[row,...rows].slice(0,100));
 try{if(Platform.OS==="android")await Notifications.setNotificationChannelAsync("store-updates",{name:"Store updates",importance:Notifications.AndroidImportance.DEFAULT,sound:"default"});
 let p=await Notifications.getPermissionsAsync();if(!p.granted)p=await Notifications.requestPermissionsAsync();
 if(p.granted)await Notifications.scheduleNotificationAsync({content:{title,body,sound:"default",data:{type}},trigger:null});}catch{/* In-app history remains available if OS alerts are disabled. */}
}
export async function markAppNotificationsRead():Promise<void>{const rows=await getAppNotifications();await storage.setItem(KEY,rows.map(row=>({...row,read:true})));}
