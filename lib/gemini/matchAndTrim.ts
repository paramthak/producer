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
    "RULES:",
    "1. The voiceover is the master clock. Every segment's timelineStartMs/timelineEndMs MUST fit inside its section's window (between the window's startMs and endMs). NEVER let a segment cross into the next section's window — if outro starts at 12000ms, the body section's last segment must end at or before 12000ms.",
    "2. For each section, pick the candidate clip(s) whose visuals best match the script lines in that section.",
    "3. Trim each video clip to the MEANINGFUL portion (sourceInMs..sourceOutMs). Cut dead time, glances, redundant motion.",
    "4. Images (kind='image') always have sourceInMs=0 and sourceOutMs=timelineEndMs-timelineStartMs.",
    "5. A clip's trim duration (sourceOutMs - sourceInMs) MUST equal its timeline duration (timelineEndMs - timelineStartMs).",
    "6. Cut rhythm MUST follow voiceover rhythm. Read the `words` array provided for each section — each entry has the word's text plus its startMs/endMs. When the speaker races through short words in rapid succession (e.g. acronyms, lists like 'SOP, LOR, passport, visa' where each word is under 500ms), cut at that pace, ideally one visual per word or per tight group. When the speaker sustains a longer phrase, hold the visual for that phrase's duration. There is NO fixed cadence target — let the speech drive it. HARD FLOOR: no segment shorter than 400ms (anything tighter feels like a jitter, not a cut).",
    "6a. Section windows may include silent lead-in or trail-out periods where no word is spoken. Use those silent moments for establishing shots, atmospheric beats, or breathing room — the visual sets up before the voiceover lands, or lingers after the last word. Don't waste silent time with a frozen frame.",
    "7. HOOK SECTION special rules: (a) Each segment in the hook MUST come from a DIFFERENT clipId. You may NOT reuse the same clip across two hook segments — slicing one hook clip into multiple pieces is forbidden. If only ONE candidate clip is available for the hook, the hook gets exactly ONE segment from that clip. (b) For each hook clip you do use, pick the punchiest, most kinetic frames — motion, surprise, energy, visual impact. The hook is the visual hook; lean into momentum. Skip slow lead-ins, static shots, or low-energy moments inside the clip.",
    "8. Outside the hook, you MAY reuse the same clipId across multiple segments when a section only has one strong clip but its source is longer than any single beat — pick distinct slices from different non-overlapping time ranges (different action, framing, or moment in the clip).",
    "9. When two or more segments share a clipId, their source ranges (sourceInMs..sourceOutMs) MUST NOT OVERLAP. Time-disjoint slices only — segment A using 0-3000ms and segment B using 5000-8000ms is fine; A=0-3000 and B=2000-5000 is forbidden.",
    "10. Respect the override prompt if provided. It overrides default choices.",
    "11. Return segments in order from t=0 onward, no overlaps between segments, no gaps within a section window.",
    "12. Provide a one-sentence whyClip (why this clip fits this script line) and whyTrim (why this in/out point).",
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
