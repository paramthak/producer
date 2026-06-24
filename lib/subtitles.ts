/**
 * Subtitle domain logic — chunking, presets, defaults, hashing, and the
 * timeline helpers shared by the live overlay and the server renderer.
 *
 * This module is ISOMORPHIC: it has no Node-only imports so it can be
 * bundled into the browser (the editor uses presets/defaults/hash and the
 * "which caption/words are visible now" helpers) AND run on the server
 * (the pipeline uses the chunker; the renderer uses computeStates).
 */

import type {
  Caption,
  CaptionWord,
  SubtitleFont,
  SubtitlePreset,
  SubtitleState,
  SubtitleStyle,
  WordTimestamp,
} from "@/lib/types";

/* ------------------------------ presets ------------------------------ */

export interface PresetConfig {
  id: SubtitlePreset;
  label: string;
  description: string;
  /** Horizontal alignment of the caption block. */
  align: "center" | "left";
  /** X anchor in the 1080-wide space (centre x for "center", left pad x for "left"). */
  anchorX: number;
  /** Default vertical centre as a fraction of the 1920 height. */
  defaultPositionY: number;
  /** Base (normal-word) font family — user-overridable. */
  baseFontFamily: SubtitleFont;
  baseItalic: boolean;
  baseColor: string;
  defaultFontSize: number;
  /** Family for emphasized words; null = same family as base. */
  emphasisFontFamily: SubtitleFont | null;
  emphasisColor: string;
  baseWeight: number;
  emphasisWeight: number;
  /** Size multiplier applied to emphasized words. */
  emphasisScale: number;
  emphasisItalic: boolean;
  /** Break onto a new line whenever bold-ness flips between adjacent words. */
  twoTier: boolean;
  shadow: boolean;
}

export const PRESETS: Record<SubtitlePreset, PresetConfig> = {
  // Default — the distinctive lower-left two-tier look ("six" / "months.").
  lowerLeftDisplay: {
    id: "lowerLeftDisplay",
    label: "Lower-left display",
    description: "Big bold keyword over a serif-italic line, lower-left.",
    align: "left",
    anchorX: 72,
    defaultPositionY: 0.72,
    baseFontFamily: "Libre Caslon Text",
    baseItalic: true,
    baseColor: "#F5F0DC",
    defaultFontSize: 60,
    emphasisFontFamily: "Inter",
    emphasisColor: "#F5F0DC",
    baseWeight: 400,
    emphasisWeight: 900,
    emphasisScale: 2.1,
    emphasisItalic: false,
    twoTier: true,
    shadow: true,
  },
  // Centered serif, bright highlight on emphasized words ("the *entire* study").
  centeredSerif: {
    id: "centeredSerif",
    label: "Centered serif",
    description: "Centered serif line; emphasized words pop in a bright colour.",
    align: "center",
    anchorX: 540,
    defaultPositionY: 0.5,
    baseFontFamily: "Libre Caslon Text",
    baseItalic: false,
    baseColor: "#FFFFFF",
    defaultFontSize: 92,
    emphasisFontFamily: null,
    emphasisColor: "#E9FF12",
    baseWeight: 400,
    emphasisWeight: 700,
    emphasisScale: 1.06,
    emphasisItalic: false,
    twoTier: false,
    shadow: false,
  },
};

export const DEFAULT_PRESET: SubtitlePreset = "lowerLeftDisplay";

/** Build the default editable style for a preset (used as initial state). */
export function defaultSubtitleStyle(preset: SubtitlePreset = DEFAULT_PRESET): SubtitleStyle {
  const c = PRESETS[preset];
  return {
    enabled: true,
    preset,
    fontFamily: c.baseFontFamily,
    fontSize: c.defaultFontSize,
    color: c.baseColor,
    highlightColor: c.emphasisColor,
    highlightFontFamily: c.emphasisFontFamily ?? c.baseFontFamily,
    highlightFontSize: Math.round(c.defaultFontSize * c.emphasisScale),
    positionY: c.defaultPositionY,
  };
}

/**
 * Switching preset resets the four preset-derived defaults (font, size,
 * colours, position) to the new preset's values — matching VEED, where
 * picking a template applies its whole look. The enabled flag is preserved.
 */
export function applyPreset(style: SubtitleStyle, preset: SubtitlePreset): SubtitleStyle {
  return { ...defaultSubtitleStyle(preset), enabled: style.enabled };
}

/* ------------------------------ chunker ------------------------------ */

export interface ChunkOpts {
  /** Max characters (incl. spaces) on one caption before forcing a break. */
  maxChars: number;
  /** Max words on one caption. */
  maxWords: number;
  /** A silence gap between two words wider than this forces a break. */
  pauseMs: number;
}

/**
 * VEED-style auto-caption chunking. Greedily accumulate words into a caption
 * until any of: the char budget would overflow, the word cap is hit, a
 * sentence-ending punctuation closes the previous word, or a speech pause
 * gap exceeds the threshold. Reproduces the variable 1–5-word groups seen in
 * the reference exports ("on", "the entire study", "my own and landed").
 */
export const DEFAULT_CHUNK_OPTS: ChunkOpts = { maxChars: 22, maxWords: 5, pauseMs: 320 };

const SENTENCE_END = /[.!?]$/;

export function chunkCaptions(
  words: WordTimestamp[],
  opts: ChunkOpts = DEFAULT_CHUNK_OPTS,
): Caption[] {
  const clean = words.filter((w) => w.text && w.text.trim().length > 0);
  const captions: Caption[] = [];
  let cur: CaptionWord[] = [];
  let curChars = 0;

  const flush = () => {
    if (!cur.length) return;
    captions.push({
      id: `cap-${captions.length}`,
      startMs: cur[0].startMs,
      endMs: cur[cur.length - 1].endMs,
      words: cur,
    });
    cur = [];
    curChars = 0;
  };

  for (let i = 0; i < clean.length; i++) {
    const w = clean[i];
    const text = w.text.trim();
    const prev = cur[cur.length - 1];
    if (cur.length > 0) {
      const gap = prev ? w.startMs - prev.endMs : 0;
      const wouldChars = curChars + 1 + text.length;
      const breakBefore =
        cur.length >= opts.maxWords || wouldChars > opts.maxChars || gap > opts.pauseMs;
      if (breakBefore) flush();
    }
    cur.push({ text, startMs: w.startMs, endMs: w.endMs, bold: false });
    curChars += (curChars > 0 ? 1 : 0) + text.length;
    // Break AFTER a word that ends a sentence so the next phrase starts fresh.
    if (SENTENCE_END.test(text)) flush();
  }
  flush();
  return captions;
}

/* ------------------------- timeline helpers -------------------------- */

export function sortedCaptions(captions: Caption[]): Caption[] {
  return [...captions].sort((a, b) => a.startMs - b.startMs);
}

/**
 * The caption visible at time `ms`: the last caption whose startMs ≤ ms, held
 * until the next caption begins (so something is always on screen once
 * captions start, matching VEED). Returns the index in the sorted array.
 */
export function activeCaptionAt(
  sorted: Caption[],
  ms: number,
): { caption: Caption; index: number } | null {
  let found: { caption: Caption; index: number } | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].startMs <= ms) found = { caption: sorted[i], index: i };
    else break;
  }
  return found;
}

/** How many words of `caption` have been spoken by `ms` (≥1 once active). */
export function revealedCountAt(caption: Caption, ms: number): number {
  if (ms < caption.startMs) return 0;
  let n = 0;
  for (const w of caption.words) if (w.startMs <= ms) n++;
  return Math.max(1, n);
}

export interface SubtitleRenderState {
  startMs: number;
  endMs: number;
  /** Index into the sorted captions, or null for an empty (no-caption) span. */
  captionIndex: number | null;
  revealedCount: number;
}

/**
 * Flatten the caption timeline into contiguous render states covering
 * [0, totalMs] with no gaps — one state per word-reveal, plus empty spans
 * before the first caption and during long pauses are folded into the
 * preceding caption (held until the next one). Used by the server renderer
 * to produce one PNG per state.
 */
export function computeStates(captions: Caption[], totalMs: number): SubtitleRenderState[] {
  const sorted = sortedCaptions(captions);
  const states: SubtitleRenderState[] = [];
  if (!sorted.length) {
    return [{ startMs: 0, endMs: Math.max(1, totalMs), captionIndex: null, revealedCount: 0 }];
  }
  // Empty lead-in before the first caption.
  if (sorted[0].startMs > 0) {
    states.push({ startMs: 0, endMs: sorted[0].startMs, captionIndex: null, revealedCount: 0 });
  }
  for (let i = 0; i < sorted.length; i++) {
    const cap = sorted[i];
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].startMs : Math.max(cap.endMs, totalMs);
    // Sub-divide the caption's lifespan by word-reveal moments.
    for (let j = 0; j < cap.words.length; j++) {
      const revealAt = Math.max(cap.startMs, cap.words[j].startMs);
      const end =
        j + 1 < cap.words.length
          ? Math.max(revealAt, Math.max(cap.startMs, cap.words[j + 1].startMs))
          : nextStart;
      if (end <= revealAt) continue;
      states.push({ startMs: revealAt, endMs: end, captionIndex: i, revealedCount: j + 1 });
    }
  }
  // Merge any zero/negative spans defensively and clamp the tail.
  const merged = states.filter((s) => s.endMs > s.startMs);
  if (merged.length) merged[merged.length - 1].endMs = Math.max(merged[merged.length - 1].endMs, totalMs);
  return merged;
}

/* ------------------------------ hashing ------------------------------ */

/** FNV-1a 64-bit over a string → base36. Mirrors lib/planHash.ts. */
function fnv1a64(s: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(36);
}

/**
 * Stable hash of the full subtitle state — keys the rendered subtitle videos.
 * Any change to style or to any caption word/timing/bold flips the hash,
 * marking cached renders (subtitles.mp4 / burned MP4 / overlay.mov) stale.
 */
export function hashSubtitles(state: SubtitleState): string {
  const s = state.style;
  const parts: string[] = [
    `style:${s.enabled ? 1 : 0}|${s.preset}|${s.fontFamily}|${s.fontSize}|${s.color}|${s.highlightColor}|` +
      `${s.highlightFontFamily ?? ""}|${s.highlightFontSize ?? ""}|${s.positionY.toFixed(4)}`,
  ];
  for (const c of sortedCaptions(state.captions)) {
    parts.push(
      `${c.id}:${c.startMs}-${c.endMs}:` +
        c.words.map((w) => `${w.text}~${w.startMs}~${w.endMs}~${w.bold ? 1 : 0}`).join(","),
    );
  }
  return fnv1a64(parts.join("\n"));
}
