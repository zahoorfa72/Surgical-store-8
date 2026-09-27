import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

import { useAuth } from "@/src/auth";
import { Loader } from "@/src/ui";
import { useTheme } from "@/src/theme";

// Auth gate: send to login or into the app once bootstrap finishes.
export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (user.role === "cashier") router.replace("/(tabs)/sell");
    else router.replace("/(tabs)");
  }, [user, loading, router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <Loader />
    </View>
  );
}
