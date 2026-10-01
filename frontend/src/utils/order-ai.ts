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
  return value.toLowerCase().replace(/[^a-z0-9\s.-]/g, " ").replace(/\s+/g, " ").trim();
}

function editSimilarity(a: string, b: string) {
  const aa = normalize(a);
  const bb = normalize(b);
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

async function prepareLocalAi() {
  if (!modelReadyPromise) {
    modelReadyPromise = (async () => {
      try {
        if (await isAvailable()) {
          await prepareBuiltInModel();
          return true;
        }

        const models = await getDownloadableModels();
        const small = models.find(
          (m) => m.id === "qwen3-0.6b" && m.meetsRequirements,
        );
        if (!small) return false;

        if (small.status !== "downloaded" && small.status !== "ready") {
          await downloadModel(small.id);
        }
        await setModel(small.id, {
          backend: "cpu",
          generation: { temperature: 0.1, topK: 20 },
        });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return modelReadyPromise;
}

export async function enhanceOrderLinesWithAI(
  lines: string[],
  products: Product[],
): Promise<string[]> {
  if (!lines.length || !products.length) return lines;

  const ready = await prepareLocalAi();
  if (!ready) return lines;

  const inventory = products
    .map((p) => p.name)
    .filter(Boolean);

  const candidatesByLine = lines.map((line) => {
    const candidates = inventory
      .map((name) => ({ name, score: editSimilarity(line, name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.name);
    return { line, candidates };
  });

  const prompt = [
    "You are an offline surgical-store order recognition assistant.",
    "The first OCR pass has already read a handwritten or printed order, but spelling can be badly wrong.",
    "Choose only exact product names from the supplied inventory candidates.",
    "Do not invent products. Preserve the requested quantity. If no candidate is plausible, omit that line.",
    "Return only the structured result requested by the schema.",
    "",
    "OCR lines and candidate inventory products:",
    JSON.stringify(candidatesByLine),
  ].join("\n");

  try {
    const { object } = await generateObject<{
      items: AiOrderLine[];
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
                ocrLine: { type: "string" },
                productName: { type: "string" },
                quantity: { type: "integer" },
              },
              required: ["ocrLine", "productName", "quantity"],
            },
          },
        },
        required: ["items"],
      },
      {
        maxRepairAttempts: 1,
        systemPrompt:
          "You correct OCR mistakes using only the candidate inventory names. Never create or rename an inventory product.",
      },
    );

    const validNames = new Set(products.map((p) => p.name));
    const corrections = new Map(
      (object.items ?? [])
        .filter((x) => validNames.has(x.productName) && x.ocrLine)
        .map((x) => [normalize(x.ocrLine), x.productName]),
    );

    return lines.map((line) => corrections.get(normalize(line)) ?? line);
  } catch {
    return lines;
  }
}
