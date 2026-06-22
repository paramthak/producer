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
    "RULES (read RULE 0 first and keep it active in mind for every decision):",
    "",
    "RULE 0 — HIGHEST PRIORITY: semantic word-to-frame match.",
    "  For every segment you emit, the visual content at the chosen source time-range MUST semantically match the spoken words at that segment's timeline position. This rule outranks every other rule below.",
    "  Mechanic: each section gives you (a) a `words` array — every spoken word with its timeline startMs/endMs; (b) candidate clips, each with a `frames` array — every frame description with its source timestampMs.",
    "  For each segment you plan to emit:",
    "    (i)   Identify the words spoken during this segment's timeline range (filter the section's words by the segment's timelineStartMs..timelineEndMs).",
    "    (ii)  Among the candidate clips in this section, find the clip with at least one frame description that semantically refers to what those exact words are about. If the words say 'we packed our bags', the clip must have a frame description mentioning bags, packing, suitcases, or a clearly related action — not an unrelated airport shot, even if the airport shot is the same section's other clip.",
    "    (iii) Inside that clip, choose the sourceInMs..sourceOutMs to CENTER on the timestampMs of the matching frame description. Don't default to clip start — scan ALL frame descriptions, pick the timestamp whose description matches, then trim a window around it that equals the segment's timeline duration.",
    "  If no candidate clip has a frame description matching the spoken words, do NOT force a wrong clip. Pick the loosest reasonable fit and explicitly note the gap in whyMatch.",
    "  Mandatory `whyMatch` field per segment: a single sentence quoting BOTH (a) the exact spoken words at this segment's timeline range AND (b) the exact matching frame description (or 'no exact match available') from the source slice. Example: 'Words \"packed our bags\" at 3200-3800ms ↔ frame \"hands zipping a suitcase shut\" at clip 1500ms.' If you cannot produce this match honestly, you've picked the wrong clip or wrong slice — go back and pick again.",
    "",
    "1. Section boundaries are hard. Every segment's timelineStartMs/timelineEndMs MUST fit inside its section's window. NEVER let a segment cross into the next section's window — if outro starts at 12000ms, the body section's last segment must end at or before 12000ms.",
    "2. Cut rhythm follows voiceover rhythm. Read the `words` array — when the speaker races through short words (acronyms, lists like 'SOP, LOR, passport, visa' each under 500ms), cut at that pace, ideally one visual per word or per tight group. When the speaker sustains a longer phrase, hold the visual for the phrase's duration. NO fixed cadence target. HARD FLOOR: no segment shorter than 400ms.",
    "3. Section windows may include silent lead-in or trail-out periods (compare each line's spokenStartMs/spokenEndMs to the window edges). Use those moments for establishing/atmospheric visuals that contextually set up the upcoming words or linger after the last word.",
    "4. HOOK section specifics: (a) Each hook segment MUST come from a DIFFERENT clipId — no slicing one clip into multiple hook segments. One candidate clip available → one hook segment. (b) For each hook clip used, pick the punchiest, most kinetic frames — motion, energy, surprise. Skip slow lead-ins and static shots.",
    "5. Outside the hook, you MAY reuse the same clipId across multiple segments when a section only has one strong matching clip and its source is longer than any single beat — pick distinct non-overlapping time ranges (Rule 6 below). Each reuse must STILL satisfy Rule 0's semantic match.",
    "6. When two or more segments share a clipId, their source ranges (sourceInMs..sourceOutMs) MUST NOT OVERLAP. Disjoint slices only.",
    "7. Images (kind='image') always have sourceInMs=0 and sourceOutMs=timelineEndMs-timelineStartMs.",
    "8. A clip's trim duration (sourceOutMs - sourceInMs) MUST equal its timeline duration (timelineEndMs - timelineStartMs).",
    "9. Respect the override prompt if provided.",
    "10. Return segments in order from t=0 onward, no overlaps between segments, no gaps within a section window.",
    "11. Provide all three justifications per segment: whyClip (which clip and why), whyTrim (which time range in the clip and why), whyMatch (the strict semantic-match quote per Rule 0).",
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
  }));

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
