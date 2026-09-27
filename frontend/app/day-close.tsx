import { useRouter } from "expo-router";

import { DayCloseView } from "@/src/components/day-close-view";

export default function DayCloseModal() {
  const router = useRouter();
  return <DayCloseView onBack={() => router.back()} />;
}
