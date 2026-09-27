// Currency + date formatting. Currency is PKR (Rs).

export const CURRENCY = "Rs";

export function money(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  return (
    CURRENCY +
    " " +
    v.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  );
}

export function num(n: number | undefined | null): string {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}
