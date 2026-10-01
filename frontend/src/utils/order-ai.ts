import {
  downloadModel,
  generateObject,
  getDownloadableModels,
  isAvailable,
  prepareBuiltInModel,
  setModel,
} from "expo-ai-kit";
import { Product } from "@/src/models";

type AiOrderLine = {
  ocrLine: string;
  productName: string;
  quantity: number;
};

let modelReadyPromise: Promise<boolean> | null = null;

function normalize(value: string) {
  return value.toLowerCase()
    .replace(/[×*]/g, "x")
    .replace(/[^a-z0-9\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLine(value: string) {
  return normalize(value)
    .replace(/^\s*\d+(?:\.\d+)?\s*(?:x|pcs|pieces|pack|packs)?\s*/, "")
    .replace(/\s*(?:x|pcs|pieces|pack|packs)\s*\d+\s*$/, "")
    .trim();
}

function quantityFromLine(value: string) {
  const n = normalize(value);
  const explicit = n.match(/(?:qty|quantity|pcs|pieces|pack|packs|x)\s*[:=-]?\s*(\d+)\b/i);
  if (explicit) return Math.max(1, Number(explicit[1]));
  const prefix = n.match(/^\s*(\d+)\s*(?:x|pcs|pieces|pack|packs)?\b/i);
  if (prefix) return Math.max(1, Number(prefix[1]));
  const suffix = n.match(/(?:x|pcs|pieces|pack|packs)\s*(\d+)\s*$/i);
  return suffix ? Math.max(1, Number(suffix[1])) : 1;
}

function comparisonForms(value: string) {
  const base = cleanLine(value).replace(/\s+/g, "");
  const mapped = base
    .replace(/[oOqQ]/g, "0")
    .replace(/[iIlL|]/g, "1")
    .replace(/[sS]/g, "5")
    .replace(/[bB]/g, "8")
    .replace(/[gG]/g, "6")
    .replace(/[zZ]/g, "2")
    .replace(/[eE]/g, "3");
  return [base, mapped];
}

function bigramScore(a: string, b: string) {
  const aa = cleanLine(a).replace(/\s+/g, "");
  const bb = cleanLine(b).replace(/\s+/g, "");
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.length < 2 || bb.length < 2) return aa === bb ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < aa.length - 1; i++) {
    const key = aa.slice(i, i + 2);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < bb.length - 1; i++) {
    const key = bb.slice(i, i + 2);
    const n = counts.get(key) ?? 0;
    if (n > 0) {
      common++;
      counts.set(key, n - 1);
    }
  }
  return (2 * common) / Math.max(1, aa.length + bb.length - 2);
}

function editSimilarity(a: string, b: string) {
  const aa = cleanLine(a);
  const bb = cleanLine(b);
  if (!aa || !bb) return 0;
  const prev = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) {
    let left = i;
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, left + 1, prev[j - 1] + cost);
      prev[j - 1] = left;
      left = next;
    }
    prev[bb.length] = left;
  }
  return 1 - prev[bb.length] / Math.max(1, aa.length, bb.length);
}

function candidateScore(line: string, name: string) {
  const source = cleanLine(line);
  const target = normalize(name);
  const sw = source.split(" ").filter(Boolean);
  const tw = target.split(" ").filter(Boolean);
  const sourceSet = new Set(sw);
  const overlap = tw.length ? tw.filter((x) => sourceSet.has(x)).length / tw.length : 0;
  const wordScores = sw.map((word) => {
    let best = 0;
    for (const targetWord of tw) best = Math.max(best, editSimilarity(word, targetWord), bigramScore(word, targetWord));
    return best;
  });
  const wordScore = wordScores.length ? wordScores.reduce((a, b) => a + b, 0) / wordScores.length : 0;
  const confusion = Math.max(...comparisonForms(source).flatMap((a) => comparisonForms(target).map((b) => bigramScore(a, b))));
  const edit = editSimilarity(source, target);
  return Math.max(edit, bigramScore(source, target), confusion, overlap * 0.94, wordScore * 0.96);
}
\nexport async function enhanceOrderLinesWithAI(
  lines: string[],
  products: Product[],
): Promise<string[]> {
  if (!lines.length || !products.length) return lines;

  const ready = await prepareLocalAi();
  if (!ready) return lines;

  const inventory = products.map((p) => p.name).filter(Boolean);
  const candidatesByLine = lines.map((line, lineIndex) => {
    const candidates = inventory
      .map((name) => ({ name, score: candidateScore(line, name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.name);
    return {
      lineIndex,
      ocrLine: line,
      quantityDetected: quantityFromLine(line),
      candidates,
    };
  });

  const prompt = [
    "You are the final offline correction layer for a surgical-store order.",
    "OCR has already read a handwritten or printed order and may contain severe spelling, character, spacing, or letter/number confusion.",
    "For every line, choose ONLY one exact product name from that line's candidates.",
    "Use context from the complete order when a word is ambiguous.",
    "Never invent, merge, rename, or alter an inventory product.",
    "Keep the detected quantity unless the OCR clearly wrote another quantity.",
    "If a line is not plausibly a product, omit it.",
    "Return lineIndex so corrections are applied to the correct OCR line even when text is changed.",
    "",
    JSON.stringify(candidatesByLine),
  ].join("\n");

  try {
    const { object } = await generateObject<{
      items: { lineIndex: number; productName: string; quantity: number }[];
    }>(
      [{ role: "user", content: prompt }],
      {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                lineIndex: { type: "integer" },
                productName: { type: "string" },
                quantity: { type: "integer" },
              },
              required: ["lineIndex", "productName", "quantity"],
            },
          },
        },
        required: ["items"],
      },
      {
        maxRepairAttempts: 2,
        systemPrompt:
          "Be conservative and exact. Only return product names that appear in the supplied candidate lists. Prefer the candidate supported by multiple words and handwriting/OCR confusion patterns.",
      },
    );

    const validNames = new Set(inventory);
    const corrections = new Map<number, string>();
    for (const item of object.items ?? []) {
      if (!validNames.has(item.productName)) continue;
      const index = Math.floor(Number(item.lineIndex));
      if (index < 0 || index >= lines.length) continue;
      const qty = Math.max(1, Math.floor(Number(item.quantity) || quantityFromLine(lines[index]) || 1));
      corrections.set(index, `${qty} x ${item.productName}`);
    }

    return lines.map((line, index) => corrections.get(index) ?? line);
  } catch {
    return lines;
  }
}
