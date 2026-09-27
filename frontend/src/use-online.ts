// Lightweight connectivity hook used by the header status chip.
// Kept dependency-free (only NetInfo) so shared UI can read it without coupling
// to the OfflineProvider and risking a circular import.

import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

export function useIsOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const unsub = NetInfo.addEventListener((s) => {
      setOnline(!!(s.isConnected && s.isInternetReachable !== false));
    });
    NetInfo.fetch().then((s) =>
      setOnline(!!(s.isConnected && s.isInternetReachable !== false)),
    );
    return () => unsub();
  }, []);
  return online;
}
