import { QueryClientProvider, hydrate } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Stack } from "expo-router";
import React from "react";
import { LogBox } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/src/components/error-boundary";
import { queryClient } from "@/src/query-client";
import { AuthProvider } from "@/src/auth";
import { OfflineProvider } from "@/src/offline";
import { ToastProvider } from "@/src/ui";
import { startDailyAutoBackup, scheduleAutomaticGoogleDriveBackup } from "@/src/auto-backup";
import { registerDailyBackupTask } from "@/src/daily-backup-task";

LogBox.ignoreAllLogs(true);

export default function RootLayout() {
  const [cacheReady, setCacheReady] = React.useState(false);
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem("ssm.qcache.v1");
        if (raw) hydrate(queryClient, JSON.parse(raw));
      } catch {}
      if (mounted) setCacheReady(true);
    })();
    return () => { mounted = false; };
  }, []);

  React.useEffect(() => {
    if (!cacheReady) return;
    void registerDailyBackupTask();
    // If Drive is already connected, refresh the single cloud backup on app start.
    scheduleAutomaticGoogleDriveBackup(2500);
    return startDailyAutoBackup();
  }, [cacheReady]);

  if (!cacheReady) return null;
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <KeyboardProvider>
            <AuthProvider>
              <ToastProvider>
                <OfflineProvider>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="index" />
                  <Stack.Screen name="login" />
                  <Stack.Screen name="signup" />
                  <Stack.Screen name="forgot-password" />
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen name="product-form" options={{ presentation: "modal" }} />
                  <Stack.Screen name="purchase" options={{ presentation: "modal" }} />
                  <Stack.Screen name="purchases-history" options={{ presentation: "modal" }} />
                  <Stack.Screen name="sale-edit" options={{ presentation: "modal" }} />
                  <Stack.Screen name="payments" options={{ presentation: "modal" }} />
                  <Stack.Screen name="parties" options={{ presentation: "modal" }} />
                  <Stack.Screen name="party-form" options={{ presentation: "modal" }} />
                  <Stack.Screen name="expenses" options={{ presentation: "modal" }} />
                  <Stack.Screen name="expense-form" options={{ presentation: "modal" }} />
                  <Stack.Screen name="users" options={{ presentation: "modal" }} />
                  <Stack.Screen name="user-form" options={{ presentation: "modal" }} />
                  <Stack.Screen name="sales-history" options={{ presentation: "modal" }} />
                  <Stack.Screen name="receipt" options={{ presentation: "modal" }} />
                  <Stack.Screen name="return-form" options={{ presentation: "modal" }} />
                  <Stack.Screen name="purchase-return-form" options={{ presentation: "modal" }} />
                  <Stack.Screen name="returns" options={{ presentation: "modal" }} />
                  <Stack.Screen name="day-close" options={{ presentation: "modal" }} />
                  <Stack.Screen name="reports" options={{ presentation: "modal" }} />
                  <Stack.Screen name="customers-report" options={{ presentation: "modal" }} />
                  <Stack.Screen name="settings" options={{ presentation: "modal" }} />
                  <Stack.Screen name="backup-restore" options={{ presentation: "modal" }} />
                </Stack>
                </OfflineProvider>
              </ToastProvider>
            </AuthProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
