export type VoiceCatalogItem = {
  id: string;
  name: string;
  barcode?: string | null;
  sku?: string | null;
};

export type ParsedVoiceProductCommand = {
  query: string;
  quantity: number;
};

export type RankedVoiceProductMatch<T extends VoiceCatalogItem> = {
  product: T;
  score: number;
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
  aik: 1, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5,
  paanch: 5, chhay: 6, chhe: 6, chay: 6, saat: 7, sat: 7,
  aath: 8, ath: 8, nau: 9, nao: 9, das: 10, gyarah: 11,
  barah: 12, baarah: 12, terah: 13, chaudah: 14, pandrah: 15,
  solah: 16, satrah: 17, atharah: 18, unnis: 19, unais: 19,
  bees: 20, bis: 20,
  "ایک": 1, "دو": 2, "تین": 3, "چار": 4, "پانچ": 5,
  "چھ": 6, "سات": 7, "آٹھ": 8, "نو": 9, "دس": 10,
  "گیارہ": 11, "بارہ": 12, "تیرہ": 13, "چودہ": 14,
  "پندرہ": 15, "سولہ": 16, "سترہ": 17, "اٹھارہ": 18,
  "انیس": 19, "بیس": 20,
};

const COMMAND_WORDS = new Set([
  "add", "please", "put", "need", "want", "give", "show", "to",
  "in", "into", "the", "cart", "product", "products", "for", "me",
  "now", "and",
]);
const QUANTITY_MARKERS = new Set(["q", "qty", "quantity", "qnty", "amount", "number"]);
const UNIT_WORDS = new Set(["pc", "pcs", "piece", "pieces", "unit", "units", "item", "items"]);

function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

export function normalizeSellSearch(value: unknown): string {
  return normalizeDigits(String(value ?? ""))
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type ParsedSellSearchEntry = {
  query: string;
  quantity: number;
  hasQuantity: boolean;
  invalidQuantity: boolean;
};

// Parse a trailing numeric quantity from a single typed Sell command.
// Example: "S tow 2" becomes query "s tow" and quantity 2.
export function parseSellSearchEntry(value: string): ParsedSellSearchEntry {
  const normalized = normalizeDigits(String(value ?? ""))
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  const match = normalized.match(/^(.*?)\s+([0-9]+)$/u);
  if (!match) {
    return {
      query: normalizeSellSearch(normalized),
      quantity: 1,
      hasQuantity: false,
      invalidQuantity: false,
    };
  }

  const quantity = Number(match[2]);
  const invalidQuantity = !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000;
  return {
    query: normalizeSellSearch(match[1]),
    quantity: invalidQuantity ? 0 : quantity,
    hasQuantity: true,
    invalidQuantity,
  };
}

function readQuantityAt(tokens: string[], index: number): { value: number; end: number } | null {
  const token = tokens[index];
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return Number.isSafeInteger(value) && value >= 0
      ? { value: Math.min(value, 1_000_000), end: index }
      : null;
  }
  const first = NUMBER_WORDS[token];
  if (first === undefined) return null;
  if (first >= 20 && first % 10 === 0 && NUMBER_WORDS[tokens[index + 1]] !== undefined) {
    const ones = NUMBER_WORDS[tokens[index + 1]];
    if (ones > 0 && ones < 10) return { value: first + ones, end: index + 1 };
  }
  if (first > 0 && first < 10 && tokens[index + 1] === "hundred") {
    return { value: Math.min(first * 100, 1_000_000), end: index + 1 };
  }
  if (first > 0 && first < 10 && tokens[index + 1] === "thousand") {
    return { value: Math.min(first * 1000, 1_000_000), end: index + 1 };
  }
  return { value: first, end: index };
}

export function getSafeCartQuantity(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 1;
  const quantity = Number(trimmed);
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000) return 0;
  return quantity;
}

export function parseVoiceProductCommand(transcript: string): ParsedVoiceProductCommand {
  const tokens = normalizeSellSearch(transcript).split(" ").filter(Boolean);
  if (!tokens.length) return { query: "", quantity: 1 };

  let quantityRange: { start: number; end: number; value: number } | null = null;
  const markerIndex = tokens.findIndex((token) => QUANTITY_MARKERS.has(token));
  if (markerIndex >= 0) {
    for (let index = markerIndex + 1; index < Math.min(tokens.length, markerIndex + 4); index += 1) {
      const parsed = readQuantityAt(tokens, index);
      if (parsed && parsed.value > 0) {
        quantityRange = { start: index, end: parsed.end, value: parsed.value };
        break;
      }
    }
    if (!quantityRange) {
      for (let index = markerIndex - 1; index >= Math.max(0, markerIndex - 2); index -= 1) {
        const parsed = readQuantityAt(tokens, index);
        if (parsed && parsed.value > 0) {
          quantityRange = { start: index, end: parsed.end, value: parsed.value };
          break;
        }
      }
    }
  }

  if (!quantityRange) {
    const last = tokens.length - 1;
    if (UNIT_WORDS.has(tokens[last])) {
      const parsed = readQuantityAt(tokens, last - 1);
      if (parsed && parsed.value > 0) {
        quantityRange = { start: last - 1, end: last, value: parsed.value };
      }
    }
  }

  if (!quantityRange) {
    const candidateIndexes = Array.from(new Set([0, tokens.length - 1]));
    for (const index of candidateIndexes) {
      const parsed = readQuantityAt(tokens, index);
      if (parsed && parsed.value > 0) {
        quantityRange = { start: index, end: parsed.end, value: parsed.value };
        break;
      }
    }
  }

  const removed = new Set<number>();
  if (quantityRange) {
    for (let index = quantityRange.start; index <= quantityRange.end; index += 1) removed.add(index);
  }
  tokens.forEach((token, index) => {
    if (QUANTITY_MARKERS.has(token) || UNIT_WORDS.has(token) || COMMAND_WORDS.has(token)) removed.add(index);
  });
  const query = tokens.filter((_, index) => !removed.has(index)).join(" ").trim();
  const quantity = quantityRange?.value && quantityRange.value > 0
    ? Math.min(quantityRange.value, 1_000_000)
    : 1;
  return { query, quantity };
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length, 1);
}

function tokenMatchScore(query: string, name: string): number {
  const queryTokens = query.split(" ").filter(Boolean);
  const nameTokens = name.split(" ").filter(Boolean);
  if (!queryTokens.length || !nameTokens.length) return 0;
  const available = new Set(nameTokens.map((_, index) => index));
  let score = 0;
  for (const queryToken of queryTokens) {
    let bestIndex = -1;
    let bestScore = 0;
    for (const index of available) {
      const candidateToken = nameTokens[index];
      const candidateScore = candidateToken.startsWith(queryToken)
        ? 0.72 + 0.28 * (queryToken.length / candidateToken.length)
        : textSimilarity(queryToken, candidateToken);
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestScore < 0.62) return 0;
    score += bestScore;
    available.delete(bestIndex);
  }
  return score / Math.max(queryTokens.length, nameTokens.length);
}

export function rankVoiceProductMatches<T extends VoiceCatalogItem>(
  query: string,
  products: T[],
): RankedVoiceProductMatch<T>[] {
  const normalizedQuery = normalizeSellSearch(query);
  if (normalizedQuery.length < 2) return [];
  return products
    .map((product, index) => {
      const name = normalizeSellSearch(product.name);
      const sku = normalizeSellSearch(product.sku);
      const barcode = normalizeSellSearch(product.barcode);
      const exactIdentity = normalizedQuery === name ||
        (sku.length > 0 && normalizedQuery === sku) ||
        (barcode.length > 0 && normalizedQuery === barcode);
      const score = exactIdentity
        ? 1
        : Math.max(
          tokenMatchScore(normalizedQuery, name),
          tokenMatchScore(normalizedQuery, sku),
          tokenMatchScore(normalizedQuery, barcode),
        );
      return { product, score, index };
    })
    .filter((row) => row.score >= 0.34)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map(({ product, score }) => ({ product, score }));
}
