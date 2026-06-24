import { ThinkingLevel, Type } from "@google/genai";
import { gemini, MODEL_DESCRIBE } from "@/lib/gemini/client";
import { withBackoff } from "@/lib/concurrency";
import type { Caption } from "@/lib/types";

/**
 * Decide which word(s) in each caption to emphasize (bold/highlight).
 *
 * The reference VEED captions emphasize the single punchiest word per phrase
 * ("the *entire* study", "*six* months"); occasionally two; sometimes none
 * for purely functional chunks ("on", "and"). This runs once in the pipeline
 * (Gemini 3.5 Flash, cheap) and the user can re-bold/un-bold any word after.
 */

const responseSchema = {
  type: Type.OBJECT,
  required: ["captions"],
  properties: {
    captions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["captionIndex", "boldWordIndices"],
        properties: {
          captionIndex: { type: Type.INTEGER },
          boldWordIndices: { type: Type.ARRAY, items: { type: Type.INTEGER } },
        },
      },
    },
  },
} as const;

export interface HighlightUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface HighlightResult {
  /** New captions with `bold` flags applied (input is not mutated). */
  captions: Caption[];
  usage: HighlightUsage;
}

export async function highlightWords(
  captions: Caption[],
  signal?: AbortSignal,
): Promise<HighlightResult> {
  if (!captions.length) {
    return { captions, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  // Compact, index-addressable representation for the model.
  const listing = captions
    .map(
      (c, ci) =>
        `#${ci}: [${c.words.map((w, wi) => `${wi}:"${w.text}"`).join(" ")}]`,
    )
    .join("\n");

  const prompt =
    `You are styling short-form social video captions. Below are caption chunks; ` +
    `each line is "#<captionIndex>: [<wordIndex>:\"word\" ...]".\n\n` +
    `For EACH caption, choose the word(s) to EMPHASIZE — the punchy, meaning-carrying ` +
    `word a viewer's eye should land on: numbers/quantities, outcomes, names, strong ` +
    `verbs, emotional or surprising words. Usually exactly ONE word per caption; pick TWO ` +
    `only when two words are equally pivotal; pick NONE for purely functional chunks ` +
    `(e.g. "and", "on", "in the"). Never emphasize articles, prepositions, or filler. ` +
    `Return zero-based wordIndices into that caption's word list.\n\n` +
    `Captions:\n${listing}`;

  const result = await withBackoff(
    () =>
      gemini().models.generateContent({
        model: MODEL_DESCRIBE,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    { signal },
  );

  const text = result.text ?? "";
  let parsed: { captions?: Array<{ captionIndex?: number; boldWordIndices?: number[] }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-fatal: captions still work, just with no emphasis. Don't break the
    // pipeline over a styling nicety.
    console.warn(`[highlightWords] invalid JSON from ${MODEL_DESCRIBE}: ${text.slice(0, 200)}`);
    parsed = { captions: [] };
  }

  const boldByCaption = new Map<number, Set<number>>();
  for (const c of parsed.captions ?? []) {
    if (typeof c.captionIndex !== "number") continue;
    boldByCaption.set(c.captionIndex, new Set((c.boldWordIndices ?? []).filter((n) => Number.isInteger(n))));
  }

  const out: Caption[] = captions.map((c, ci) => {
    const bolds = boldByCaption.get(ci) ?? new Set<number>();
    return { ...c, words: c.words.map((w, wi) => ({ ...w, bold: bolds.has(wi) })) };
  });

  const usageMetadata = (result as unknown as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }).usageMetadata;
  const reportedIn = usageMetadata?.promptTokenCount;
  const reportedOut = usageMetadata?.candidatesTokenCount;
  const usage: HighlightUsage = {
    inputTokens: typeof reportedIn === "number" && reportedIn > 0 ? reportedIn : Math.ceil(prompt.length / 4),
    outputTokens: typeof reportedOut === "number" && reportedOut > 0 ? reportedOut : Math.ceil(text.length / 4),
  };

  return { captions: out, usage };
}
