import type {
  ScriptLine,
  SectionId,
  SectionWindow,
  WordTimestamp,
} from "@/lib/types";
import { SECTIONS } from "@/lib/types";

/**
 * Tokenize a string into lowercase alphanumeric words. Apostrophes and punctuation
 * become token boundaries — "I'm" → ["i", "m"], "Master's." → ["master", "s"].
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

interface VoToken {
  token: string;
  startMs: number;
  endMs: number;
}

/**
 * Flatten ElevenLabs word entries into a single token stream, splitting words that
 * contain apostrophes/hyphens (e.g. "I'm" → 2 tokens). Time within a multi-token
 * ElevenLabs word is split evenly. Whitespace entries produce zero tokens.
 */
function flattenVoiceover(words: WordTimestamp[]): VoToken[] {
  const out: VoToken[] = [];
  for (const w of words) {
    const toks = tokenize(w.text);
    if (!toks.length) continue;
    const totalMs = Math.max(0, w.endMs - w.startMs);
    const each = totalMs / toks.length;
    for (let i = 0; i < toks.length; i++) {
      out.push({
        token: toks[i],
        startMs: w.startMs + i * each,
        endMs: w.startMs + (i + 1) * each,
      });
    }
  }
  return out;
}

/**
 * Align each script line to a contiguous span in the voiceover token stream.
 *
 * Strategy: the voiceover is the script read verbatim, so script tokens and
 * voiceover tokens are nearly identical streams in the same order. We walk both
 * cursors in lock-step. For each line:
 *   1. Take the line's tokens.
 *   2. Slice that many tokens from the voiceover stream starting at the cursor.
 *   3. If the slice is a near-exact match (>=70% exact), accept it; otherwise
 *      try a small forward window to absorb minor drifts (added/dropped words).
 *   4. Record start = first slice token's startMs, end = last slice token's endMs.
 */
function alignLines(
  lines: ScriptLine[],
  voTokens: VoToken[],
): Map<string, { startMs: number; endMs: number }> {
  const out = new Map<string, { startMs: number; endMs: number }>();
  let cursor = 0;

  for (const line of lines) {
    const lineToks = tokenize(line.text);
    if (!lineToks.length) continue;

    // The expected start is `cursor`, but allow a small forward search window in case
    // ElevenLabs / the speaker added or dropped a token.
    const SEARCH_WINDOW = 8;
    let bestStart = cursor;
    let bestScore = -1;

    const maxStart = Math.min(voTokens.length - 1, cursor + SEARCH_WINDOW);
    for (let s = cursor; s <= maxStart; s++) {
      // Score = number of exact-token matches in the next lineToks.length positions.
      let matches = 0;
      const end = Math.min(voTokens.length, s + lineToks.length);
      for (let k = 0; k < end - s; k++) {
        if (voTokens[s + k].token === lineToks[k]) matches += 1;
      }
      if (matches > bestScore) {
        bestScore = matches;
        bestStart = s;
        if (matches === lineToks.length) break; // perfect match — stop searching
      }
    }

    // Build the slice. Default to `lineToks.length` tokens from bestStart, but absorb
    // up to a few extra ElevenLabs tokens if they look like punctuation/filler.
    const sliceEnd = Math.min(voTokens.length, bestStart + lineToks.length);
    if (bestStart >= voTokens.length) break;

    const startMs = voTokens[bestStart].startMs;
    const endMs = voTokens[Math.max(bestStart, sliceEnd - 1)].endMs;
    out.set(line.id, { startMs, endMs });
    cursor = sliceEnd;
  }

  return out;
}

/**
 * Map tagged script lines + word timestamps → 5 section windows.
 * A section's window spans from its first line's start to its last line's end.
 * Sections with no lines collapse to a zero-length boundary point.
 * The final section's end is clamped to the voiceover duration.
 */
export function computeSectionWindows(
  lines: ScriptLine[],
  words: WordTimestamp[],
  totalDurationMs: number,
): SectionWindow[] {
  const voTokens = flattenVoiceover(words);
  const lineTimes = alignLines(lines, voTokens);

  const grouped: Record<SectionId, ScriptLine[]> = {
    hook: [],
    bridge: [],
    body: [],
    outro: [],
    cta: [],
  };
  for (const l of lines) {
    if (l.section) grouped[l.section].push(l);
  }

  const windows: SectionWindow[] = SECTIONS.map((id) => ({
    section: id,
    startMs: 0,
    endMs: 0,
    lines: grouped[id],
  }));

  let lastEnd = 0;
  for (const w of windows) {
    let startMs = lastEnd;
    let endMs = lastEnd;
    const times = w.lines
      .map((l) => lineTimes.get(l.id))
      .filter((t): t is { startMs: number; endMs: number } => !!t);
    if (times.length) {
      startMs = Math.min(...times.map((t) => t.startMs));
      endMs = Math.max(...times.map((t) => t.endMs));
    }
    startMs = Math.max(startMs, lastEnd);
    endMs = Math.max(endMs, startMs);
    w.startMs = startMs;
    w.endMs = endMs;
    lastEnd = endMs;
  }

  // Extend the last non-empty section's end to cover the full voiceover.
  // Empty trailing sections stay at the boundary, but the last with content gets the tail.
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i].lines.length > 0) {
      windows[i].endMs = Math.max(windows[i].endMs, totalDurationMs);
      break;
    }
  }
  return windows;
}
