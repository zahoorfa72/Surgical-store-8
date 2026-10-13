import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";
import { Product } from "@/src/models";
import { addAppNotification } from "@/src/notification-center";

const KEY = "ssm.lowStock.notificationSignature";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function notifyLowStock(products: Product[]): Promise<void> {
  const low = products
    .filter((p) => Number(p.quantity ?? 0) <= Number(p.low_stock_threshold ?? 0))
    .sort((a, b) => Number(a.quantity) - Number(b.quantity));

  const signature = low.map((p) => `${p.id}:${p.quantity}:${p.low_stock_threshold}`).join("|");
  const previous = await storage.getItem<string>(KEY, "");

  if (!low.length) {
    if (previous) await storage.setItem(KEY, "");
    return;
  }
  if (signature === previous) return;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("low-stock", {
      name: "Low stock alerts",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
    });
  }

  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) {
    const requested = await Notifications.requestPermissionsAsync();
    if (!requested.granted) return;
  }

  const first = low.slice(0, 3).map((p) => `${p.name} (${p.quantity} left)`).join(", ");
  const extra = low.length > 3 ? ` + ${low.length - 3} more` : "";

  await addAppNotification(`Low stock: ${low.length} item${low.length === 1 ? "" : "s"}`, first + extra, "low-stock");



  await storage.setItem(KEY, signature);
}
