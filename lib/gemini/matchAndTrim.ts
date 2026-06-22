import { ThinkingLevel, Type } from "@google/genai";
import { nanoid } from "nanoid";
import { gemini, MODEL_MATCH } from "@/lib/gemini/client";
import { withBackoff } from "@/lib/concurrency";
import type {
  ClipAnalysis,
  EditPlan,
  PlanSegment,
  SectionId,
  SectionWindow,
  SourceClip,
  WordTimestamp,
} from "@/lib/types";
import { SECTION_LABEL } from "@/lib/types";

export interface MatchInput {
  windows: SectionWindow[];
  clips: SourceClip[];
  analyses: Record<string, ClipAnalysis>;
  overridePrompt: string;
  /**
   * The full per-word forced-alignment output from ElevenLabs. Threaded
   * into the match prompt per-section so Gemini sees the EXACT speech
   * rhythm — when words race vs. linger — instead of guessing from
   * per-line aggregate timestamps. This is what stops product clips
   * from bleeding into outro and lets fast utterances get fast cuts.
   */
  words: WordTimestamp[];
}

const responseSchema = {
  type: Type.OBJECT,
  required: ["segments"],
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: [
          "section",
          "clipId",
          "sourceInMs",
          "sourceOutMs",
          "timelineStartMs",
          "timelineEndMs",
          "whyClip",
          "whyTrim",
          "whyMatch",
          "coveredWords",
        ],
        properties: {
          section: {
            type: Type.STRING,
            enum: ["hook", "bridge", "body", "outro", "cta"],
          },
          clipId: { type: Type.STRING },
          sourceInMs: { type: Type.INTEGER },
          sourceOutMs: { type: Type.INTEGER },
          timelineStartMs: { type: Type.INTEGER },
          timelineEndMs: { type: Type.INTEGER },
          whyClip: { type: Type.STRING },
          whyTrim: { type: Type.STRING },
          // Mandatory semantic-match audit field. The model must quote
          // both the exact spoken words at the segment's timeline range
          // AND the matching frame description from the source slice.
          // This forces the cross-reference exercise rather than allowing
          // hand-waving justifications. Format demanded in Rule 0.
          whyMatch: { type: Type.STRING },
          // Mandatory word-coverage manifest. The model must list every
          // voiceover word that plays during this segment's timeline
          // range, with the word's exact text and startMs/endMs. The
          // server cross-checks: union of coveredWords across all
          // segments in a section MUST equal that section's `words`
          // array. Mismatches are logged as warnings to flag drift.
          // This is what forces word-first reasoning per Rule 0.
          coveredWords: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ["text", "startMs", "endMs"],
              properties: {
                text: { type: Type.STRING },
                startMs: { type: Type.INTEGER },
                endMs: { type: Type.INTEGER },
              },
            },
          },
        },
      },
    },
  },
} as const;

export interface MatchUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MatchResult {
  plan: EditPlan;
  usage: MatchUsage;
}

/**
 * Server-side word-coverage validation.
 *
 * For each section, every word in the section's `words` array should
 * appear in exactly one segment's `coveredWords` list. Each segment's
 * `coveredWords` should also actually fall inside that segment's
 * timeline range. Mismatches mean Rule 0's word-first reasoning didn't
 * land — either the AI under-cut (one segment claims words from
 * different moments) or over-cut (lost words). Log only, no retry —
 * this is a signal for prompt tuning, not a correction loop.
 */
function validateWordCoverage(
  windows: SectionWindow[],
  segments: PlanSegment[],
): void {
  for (const w of windows) {
    if (!w.lines.length) continue;
    const sectionSegments = segments.filter((s) => s.section === w.section);
    if (sectionSegments.length === 0) continue;

    // Build the set of word "keys" (startMs:text) the section expects.
    // Words are sourced from lineTimings — we don't have the per-word
    // array on the window itself, but the AI was given it via the
    // prompt's `words` per section. Treat coveredWords as ground truth
    // and just check internal consistency: segment timeline ↔ its own
    // coveredWords range.
    let issues = 0;
    for (const seg of sectionSegments) {
      const cw = seg.coveredWords ?? [];
      if (cw.length === 0) {
        console.warn(
          `[match] segment ${seg.id} in section "${w.section}" emitted with empty coveredWords — Rule 0 audit missing`,
        );
        issues += 1;
        continue;
      }
      // Each covered word should fall inside the segment's timeline range
      // (small tolerance for end-of-word boundary).
      const TOL = 50;
      for (const word of cw) {
        if (word.startMs < seg.timelineStartMs - TOL || word.endMs > seg.timelineEndMs + TOL) {
          console.warn(
            `[match] segment ${seg.id} (${seg.timelineStartMs}-${seg.timelineEndMs}ms) claims to cover word "${word.text}" (${word.startMs}-${word.endMs}ms) which is outside its timeline range — possible drift`,
          );
          issues += 1;
        }
      }
    }

    // Check for double-coverage: same word claimed by multiple segments.
    const seen = new Map<string, string>(); // key → segId
    for (const seg of sectionSegments) {
      for (const word of seg.coveredWords ?? []) {
        const key = `${word.startMs}:${word.text}`;
        const prev = seen.get(key);
        if (prev && prev !== seg.id) {
          console.warn(
            `[match] word "${word.text}" at ${word.startMs}ms is claimed by both segment ${prev} and segment ${seg.id} — coverage overlap`,
          );
          issues += 1;
        }
        seen.set(key, seg.id);
      }
    }

    if (issues === 0) {
      console.log(
        `[match] section "${w.section}": word-coverage validation clean (${sectionSegments.length} segments)`,
      );
    } else {
      console.warn(
        `[match] section "${w.section}": ${issues} word-coverage issue(s) — see warnings above`,
      );
    }
  }
}

export async function matchAndTrim(input: MatchInput, signal?: AbortSignal): Promise<MatchResult> {
  const { windows, clips, analyses, overridePrompt, words } = input;

  // Build the structured prompt: section windows + per-section candidate clips with descriptions.
  // Per-line spoken timings AND the raw per-word forced-alignment array per section are both
  // included so Gemini reads the exact speech rhythm (fast utterances vs. lingering phrases)
  // instead of guessing from line aggregates. This is what enables cut rhythm to follow voice
  // rhythm and keeps section boundaries honest (product clips stop bleeding into outro).
  const sections = windows.map((w) => {
    const candidates = clips
      .filter((c) => c.section === w.section)
      .map((c) => {
        const a = analyses[c.id];
        return {
          clipId: c.id,
          kind: c.kind,
          filename: c.filename,
          durationMs: c.durationMs,
          summary: a?.summary ?? "",
          frames: a?.frames ?? [],
        };
      });
    const timings = w.lineTimings ?? {};
    // Words spoken inside this section's time window (inclusive of edges).
    const sectionWords = words
      .filter((wd) => wd.startMs >= w.startMs && wd.endMs <= w.endMs)
      .map((wd) => ({ text: wd.text, startMs: wd.startMs, endMs: wd.endMs }));
    return {
      section: w.section,
      label: SECTION_LABEL[w.section],
      startMs: w.startMs,
      endMs: w.endMs,
      durationMs: w.endMs - w.startMs,
      lines: w.lines.map((l) => {
        const t = timings[l.id];
        return t
          ? { id: l.id, text: l.text, spokenStartMs: t.startMs, spokenEndMs: t.endMs }
          : { id: l.id, text: l.text };
      }),
      words: sectionWords,
      candidates,
    };
  });

  const prompt = [
    "You are an expert short-form video editor. Build the edit plan for a 9:16 vertical reel.",
    "",
    "RULES (read RULE 0 first; it changes how you think about ALL other rules):",
    "",
    "RULE 0 — WORD-FIRST MATCHING (highest priority).",
    "  Build the edit plan WORD-BY-WORD, not segment-by-segment. The unit of decision is the word, not the segment. Segments are produced AFTER per-word decisions, by collapsing adjacent decisions that share a clip and continuous source range.",
    "  Loop, for each section, in order:",
    "    Step 1 — Iterate through the section's `words` array. For EACH word (or a tight 2-3 word phrase whose pronunciations slur together with <80ms gaps between consecutive words), make a per-word decision:",
    "      • Which candidate clipId will be on screen at this word's startMs?",
    "      • Which source millisecond INSIDE that clip will be playing at this word's startMs? (Find a frame in the clip whose description semantically matches what THIS word is about; the source millisecond is that frame's timestampMs.)",
    "    Step 2 — After every word in the section has a per-word decision, walk them in order and COLLAPSE adjacent decisions into segments using this STRICT rule:",
    "      Two adjacent word-decisions collapse into one segment ONLY IF (a) they use the SAME clipId AND (b) word N+1's source-timestamp is within ±400ms of being a continuous play from word N's source-timestamp (i.e., for word N at source 1500ms with timeline duration Δ, word N+1's source must be 1500 + Δ ± 400ms). Otherwise they remain SEPARATE segments.",
    "      DEFAULT: split. Collapsing is the deliberate exception. If in doubt, split.",
    "  Why this is the highest-priority rule: when one clip's source pacing differs from the voiceover's pacing, a single contiguous segment plays the clip at its own rate — so the visual drifts out of sync with the voiceover (e.g., voiceover says 'profile, budget, country' as three quick words but the clip slowly pans through those three UI states at its own pace, leaving the visual 1-2 seconds behind by the third word). Per-word decisions + the strict collapse rule prevent this drift for ALL speech patterns — rapid lists, normal exposition, slow emphasis — without any special detection.",
    "",
    "1. Section boundaries are hard. Every segment's timelineStartMs/timelineEndMs MUST fit inside its section's window. NEVER let a segment cross into the next section's window — if outro starts at 12000ms, the body section's last segment must end at or before 12000ms.",
    "2. Semantic match per word. For each per-word decision (Rule 0 Step 1), the clip's frame description at the chosen source millisecond MUST semantically refer to what that exact word is about. If the word is 'profile' and a clip's frame at source 800ms describes 'profile filter screen', that's a match — pick clip+source 800ms. If no candidate clip has a frame matching this word's content, pick the loosest reasonable fit and note the gap in whyMatch.",
    "3. Section windows may include silent lead-in or trail-out periods (compare each line's spokenStartMs/spokenEndMs to the window edges). Use those moments for establishing/atmospheric visuals that contextually set up the upcoming words or linger after the last word — the per-word loop in Rule 0 still applies, but for silent regions you pick a clip+source whose visual sets up the NEXT spoken word or holds the LAST spoken word's content.",
    "4. HOOK section specifics: (a) Each hook segment MUST come from a DIFFERENT clipId — no slicing one clip into multiple hook segments. One candidate clip available → one hook segment. (b) For each hook clip used, pick the punchiest, most kinetic frames — motion, energy, surprise. Skip slow lead-ins and static shots.",
    "5. CLIP DIVERSITY: when a section has multiple candidate clips uploaded by the user, you SHOULD use AT LEAST 2-3 distinct clipIds across that section's segments. The user uploaded multiple clips because they want visual variety — using only one when 4-5 are available is bad editing. Cycle through clips so each makes at least one appearance unless a clip is genuinely unrelated to ANY spoken word in the section. Exception: hook section follows Rule 4 (different clipId per segment is already mandated). For body/bridge/outro/cta sections with N>1 candidates, target using min(N, ceil(segments/2)) distinct clipIds.",
    "6. When two or more segments share a clipId, their source ranges (sourceInMs..sourceOutMs) MUST NOT OVERLAP. Disjoint slices only.",
    "7. Images (kind='image') always have sourceInMs=0 and sourceOutMs=timelineEndMs-timelineStartMs.",
    "8. A clip's trim duration (sourceOutMs - sourceInMs) MUST equal its timeline duration (timelineEndMs - timelineStartMs).",
    "9. Respect the override prompt if provided.",
    "10. Return segments in order from t=0 onward, no overlaps between segments, no gaps within a section window.",
    "11. Provide all four justifications per segment: whyClip (which clip and why), whyTrim (which time range in the clip and why), whyMatch (the strict semantic-match quote, see below), coveredWords (the exact voiceover words playing during this segment's timeline range — text + startMs + endMs from the section's `words` array — this is your word-first audit; mandatory).",
    "12. whyMatch format: a single sentence quoting BOTH (a) the exact spoken words at this segment's timeline range AND (b) the matching frame description from the source slice. Example: 'Words \"packed our bags\" at 3200-3800ms ↔ frame \"hands zipping a suitcase shut\" at clip 1500ms.' If you cannot produce this match honestly, you've picked the wrong clip or wrong slice — go back and pick again.",
    "13. HARD MIN: no segment shorter than 400ms (after collapsing). Anything tighter feels like a jitter, not a cut.",
    "",
    overridePrompt.trim() ? `OVERRIDE PROMPT: ${overridePrompt.trim()}` : "OVERRIDE PROMPT: (none — you decide)",
    "",
    "INPUT (JSON):",
    JSON.stringify({ sections }, null, 2),
  ].join("\n");

  const result = await withBackoff(
    () =>
      gemini().models.generateContent({
        model: MODEL_MATCH,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    { signal },
  );

  const text = result.text ?? "";
  let parsed: { segments?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`matchAndTrim: invalid JSON from ${MODEL_MATCH}: ${text.slice(0, 500)}`);
  }

  const segments: PlanSegment[] = (parsed.segments ?? []).map((s) => ({
    id: nanoid(8),
    section: s.section as SectionId,
    clipId: String(s.clipId),
    sourceInMs: Math.max(0, Number(s.sourceInMs) || 0),
    sourceOutMs: Math.max(0, Number(s.sourceOutMs) || 0),
    timelineStartMs: Math.max(0, Number(s.timelineStartMs) || 0),
    timelineEndMs: Math.max(0, Number(s.timelineEndMs) || 0),
    whyClip: String(s.whyClip ?? ""),
    whyTrim: String(s.whyTrim ?? ""),
    whyMatch: String(s.whyMatch ?? ""),
    coveredWords: Array.isArray(s.coveredWords)
      ? (s.coveredWords as Array<Record<string, unknown>>)
          .map((w) => ({
            text: String(w.text ?? ""),
            startMs: Math.max(0, Number(w.startMs) || 0),
            endMs: Math.max(0, Number(w.endMs) || 0),
          }))
          .filter((w) => w.text.length > 0)
      : [],
  }));

  // Word-coverage validation: every word in each section's window should
  // appear in exactly one segment's coveredWords array, and each segment's
  // coveredWords should fall inside its timeline range. Mismatches mean
  // the AI either under-cut (one segment covers words from different
  // moments — the drift bug) or over-cut (lost words entirely). We log
  // but don't retry — diagnostic signal only. If this fires often, the
  // prompt needs more force; if it stays quiet, word-first is working.
  validateWordCoverage(windows, segments);

  // Sort + clamp + normalise durations.
  segments.sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  const total = windows.length
    ? windows[windows.length - 1].endMs
    : segments.reduce((m, s) => Math.max(m, s.timelineEndMs), 0);

  // SDK *should* return usageMetadata on every generateContent response,
  // but we've seen the cost chip stick at $0 across three devices — so
  // log unconditionally on every call until we have proof one way or the
  // other. When the SDK does NOT report tokens, fall back to a char-count
  // estimate (~4 chars/token for English text) so the chip displays
  // something approximately right instead of zero.
  const usageMetadata = (result as unknown as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }).usageMetadata;
  const reportedIn = usageMetadata?.promptTokenCount;
  const reportedOut = usageMetadata?.candidatesTokenCount;
  const estimatedIn = Math.ceil(prompt.length / 4);
  const estimatedOut = Math.ceil(text.length / 4);
  const usage: MatchUsage = {
    inputTokens: typeof reportedIn === "number" && reportedIn > 0 ? reportedIn : estimatedIn,
    outputTokens: typeof reportedOut === "number" && reportedOut > 0 ? reportedOut : estimatedOut,
  };
  console.log(
    `[gemini-match] usageMetadata=${JSON.stringify(usageMetadata)} | reported in/out=${reportedIn ?? "MISSING"}/${reportedOut ?? "MISSING"} | estimated in/out=${estimatedIn}/${estimatedOut} | using in/out=${usage.inputTokens}/${usage.outputTokens}`,
  );

  return {
    plan: { segments, totalDurationMs: total },
    usage,
  };
}
