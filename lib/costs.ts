/**
 * Per-session API cost accounting.
 *
 * Sources (all confirmed via web search, May/June 2026):
 *   - Gemini 3.5 Flash: $1.50 / 1M input, $9.00 / 1M output
 *     https://ai.google.dev/gemini-api/docs/pricing
 *   - Gemini 3.1 Pro Preview: $2.00 / 1M input, $12.00 / 1M output for
 *     prompts ≤200K tokens; doubles to $4.00 / $18.00 above 200K.
 *     Same source.
 *   - ElevenLabs Forced Alignment: not explicitly published. Using the
 *     Speech-to-Text Scribe v1/v2 rate of $0.22 / hour of audio as a
 *     proxy — closest comparable audio-analysis service.
 *     https://elevenlabs.io/pricing/api
 *
 * All numbers are USD. The user reviews costs in dollars (per their ask).
 */

import { MODEL_DESCRIBE, MODEL_MATCH } from "@/lib/gemini/client";

interface GeminiPricing {
  /** USD per 1 million input tokens at the base tier. */
  inputPerMillion: number;
  /** USD per 1 million output tokens at the base tier. */
  outputPerMillion: number;
  /**
   * If set, prompt input lengths above this many tokens incur the
   * `longInputPerMillion` rate instead of `inputPerMillion`.
   * Same for output beyond this threshold.
   */
  longContextThreshold?: number;
  longInputPerMillion?: number;
  longOutputPerMillion?: number;
}

const GEMINI_PRICING: Record<string, GeminiPricing> = {
  // Whatever the SDK reports back should match one of these keys. If the
  // model id ever drifts we fail back to flash pricing (safer underestimate
  // than a divide-by-undefined).
  "gemini-3.5-flash": {
    inputPerMillion: 1.5,
    outputPerMillion: 9.0,
  },
  "gemini-3.1-pro-preview": {
    inputPerMillion: 2.0,
    outputPerMillion: 12.0,
    longContextThreshold: 200_000,
    longInputPerMillion: 4.0,
    longOutputPerMillion: 18.0,
  },
};

/** $/hour of audio for ElevenLabs forced alignment (STT v1/v2 proxy). */
const ELEVENLABS_FORCED_ALIGNMENT_USD_PER_HOUR = 0.22;

/**
 * Compute the USD cost of a single Gemini generateContent call given the
 * model id and the token counts the API reports in `usageMetadata`.
 */
export function geminiCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing =
    GEMINI_PRICING[model] ??
    GEMINI_PRICING[MODEL_DESCRIBE]; // safe default
  const isLong =
    pricing.longContextThreshold !== undefined &&
    inputTokens > pricing.longContextThreshold;
  const inputRate = isLong
    ? pricing.longInputPerMillion ?? pricing.inputPerMillion
    : pricing.inputPerMillion;
  const outputRate = isLong
    ? pricing.longOutputPerMillion ?? pricing.outputPerMillion
    : pricing.outputPerMillion;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

/** Compute the USD cost of one forced-alignment call over `audioMs`. */
export function forcedAlignmentCost(audioMs: number): number {
  const hours = audioMs / (1000 * 60 * 60);
  return hours * ELEVENLABS_FORCED_ALIGNMENT_USD_PER_HOUR;
}

/**
 * Shape persisted on the manifest. Tracks both running total and a
 * per-phase breakdown for a future tooltip; the UI today only renders
 * `totalUsd`.
 */
export interface SessionCosts {
  totalUsd: number;
  breakdown: {
    describe: { calls: number; inputTokens: number; outputTokens: number; usd: number };
    match: { calls: number; inputTokens: number; outputTokens: number; usd: number };
    align: { calls: number; audioMs: number; usd: number };
  };
}

export function emptyCosts(): SessionCosts {
  return {
    totalUsd: 0,
    breakdown: {
      describe: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      match: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
      align: { calls: 0, audioMs: 0, usd: 0 },
    },
  };
}

export function addDescribeCost(
  costs: SessionCosts,
  inputTokens: number,
  outputTokens: number,
): void {
  const usd = geminiCost(MODEL_DESCRIBE, inputTokens, outputTokens);
  costs.breakdown.describe.calls += 1;
  costs.breakdown.describe.inputTokens += inputTokens;
  costs.breakdown.describe.outputTokens += outputTokens;
  costs.breakdown.describe.usd += usd;
  costs.totalUsd += usd;
}

export function addMatchCost(
  costs: SessionCosts,
  inputTokens: number,
  outputTokens: number,
): void {
  const usd = geminiCost(MODEL_MATCH, inputTokens, outputTokens);
  costs.breakdown.match.calls += 1;
  costs.breakdown.match.inputTokens += inputTokens;
  costs.breakdown.match.outputTokens += outputTokens;
  costs.breakdown.match.usd += usd;
  costs.totalUsd += usd;
}

export function addAlignCost(costs: SessionCosts, audioMs: number): void {
  const usd = forcedAlignmentCost(audioMs);
  costs.breakdown.align.calls += 1;
  costs.breakdown.align.audioMs += audioMs;
  costs.breakdown.align.usd += usd;
  costs.totalUsd += usd;
}

/** Format USD for the UI chip. Two decimal places, always shows the $ sign. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
