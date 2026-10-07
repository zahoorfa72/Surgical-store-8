export type FuzzyField<T> = (item: T) => string | number | null | undefined;

function normalize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, left + 1, prev[j - 1] + cost);
      prev[j - 1] = left;
      left = next;
    }
    prev[b.length] = left;
  }
  return prev[b.length];
}

function similarity(query: string, value: string): number {
  if (!query || !value) return 0;
  if (value.includes(query)) return 1;
  const words = value.split(" ").filter(Boolean);
  const candidates = [value, ...words];
  return Math.max(
    ...candidates.map((candidate) => {
      const d = distance(query, candidate);
      return 1 - d / Math.max(query.length, candidate.length, 1);
    }),
  );
}

export function fuzzyScore<T>(query: string, item: T, fields: FuzzyField<T>[]): number {
  const q = normalize(query);
  if (!q) return 1;
  return Math.max(
    ...fields.flatMap((field) => {
      const value = normalize(field(item));
      return value ? [similarity(q, value)] : [];
    }),
    0,
  );
}

export function fuzzyFilter<T>(
  items: T[],
  query: string,
  fields: FuzzyField<T>[],
  options: { limit?: number; threshold?: number } = {},
): T[] {
  const q = normalize(query);
  if (!q) return items;
  const limit = options.limit ?? 50;
  const threshold = options.threshold ?? 0.42;
  const scored = items
    .map((item, index) => ({ item, index, score: fuzzyScore(q, item, fields) }))
    .filter((row) => row.score >= threshold)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length) return scored.slice(0, limit).map((row) => row.item);

  // A typo can be quite different from the stored spelling. If nothing
  // clears the normal threshold, still show the closest few matches rather
  // than returning an empty list.
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(q, item, fields) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(5, limit))
    .map((row) => row.item);
}
