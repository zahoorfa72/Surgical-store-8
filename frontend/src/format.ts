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

export function localDateIso(value?: string | null): string {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = raw ? new Date(raw) : new Date();
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export function todayIsoDate(): string {
  return localDateIso();
}

export function transactionDateIso(transactionDate?: string | null, createdAt?: string | null): string {
  const value = String(transactionDate ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localDateIso(createdAt);
}

export function formatTransactionDate(transactionDate?: string | null, createdAt?: string | null): string {
  return formatDate(transactionDateIso(transactionDate, createdAt) + "T12:00:00");
}

export function formatTransactionDateTime(transactionDate?: string | null, createdAt?: string | null): string {
  const businessDate = transactionDateIso(transactionDate, createdAt);
  const source = createdAt ? new Date(createdAt) : new Date();
  const time = Number.isNaN(source.getTime()) ? new Date(businessDate + "T12:00:00") : source;
  const parts = businessDate.split("-").map(Number);
  const displayed = new Date(parts[0], parts[1] - 1, parts[2], time.getHours(), time.getMinutes(), time.getSeconds());
  return displayed.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) + " · " + time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
