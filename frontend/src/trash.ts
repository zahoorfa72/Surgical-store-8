import AsyncStorage from "@react-native-async-storage/async-storage";

export const TRASH_KEY = "ssm.trash.entries.v1";
export type TrashEntry = {
  id: string;
  path: string;
  recordId: string;
  label: string;
  record: any;
  deletedAt: string;
  expiresAt: string;
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function purgeExpiredTrash(): Promise<TrashEntry[]> {
  let entries: TrashEntry[] = [];
  try {
    const raw = await AsyncStorage.getItem(TRASH_KEY);
    const parsed = JSON.parse(raw || "[]");
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {}
  const now = Date.now();
  const keep = entries.filter((entry) => Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) > now);
  if (keep.length !== entries.length) await AsyncStorage.setItem(TRASH_KEY, JSON.stringify(keep));
  return keep.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
}

export async function addToTrash(path: string, record: any): Promise<TrashEntry | null> {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id ?? "");
  if (!id) return null;
  const now = new Date();
  const entry: TrashEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    path,
    recordId: id,
    label: String(record.name ?? record.title ?? record.receipt_no ?? record.invoice_no ?? record.number ?? `${path.replace(/^\//, "")} ${id}`),
    record: JSON.parse(JSON.stringify(record)),
    deletedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
  };
  const existing = await purgeExpiredTrash();
  await AsyncStorage.setItem(TRASH_KEY, JSON.stringify([entry, ...existing]));
  return entry;
}

export async function getTrashEntries(): Promise<TrashEntry[]> {
  return purgeExpiredTrash();
}

export async function removeTrashEntry(id: string): Promise<void> {
  const entries = await purgeExpiredTrash();
  await AsyncStorage.setItem(TRASH_KEY, JSON.stringify(entries.filter((entry) => entry.id !== id)));
}
