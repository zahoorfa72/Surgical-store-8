import { useRouter } from "expo-router";

import { SalesListView } from "@/src/components/sales-list";

export default function SalesHistory() {
  const router = useRouter();
  return <SalesListView onBack={() => router.back()} />;
}
