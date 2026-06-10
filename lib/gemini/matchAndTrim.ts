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
} from "@/lib/types";
import { SECTION_LABEL } from "@/lib/types";

export interface MatchInput {
  windows: SectionWindow[];
  clips: SourceClip[];
  analyses: Record<string, ClipAnalysis>;
  overridePrompt: string;
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

export async function matchAndTrim(input: MatchInput, signal?: AbortSignal): Promise<EditPlan> {
  const { windows, clips, analyses, overridePrompt } = input;

  // Build the structured prompt: section windows + per-section candidate clips with descriptions.
  // Per-line spoken timings are passed so the model can tell exactly when speech happens vs.
  // silence within the window — useful for picking establishing/breathing visuals during the
  // silent lead-in of a section.
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
      candidates,
    };
  });

  const prompt = [
    "You are an expert short-form video editor. Build the edit plan for a 9:16 vertical reel.",
    "",
    "RULES:",
    "1. The voiceover is the master clock. Every segment's timelineStartMs/timelineEndMs must fit inside its section's window.",
    "2. For each section, pick the candidate clip(s) whose visuals best match the script lines in that section.",
    "3. Trim each video clip to the MEANINGFUL portion (sourceInMs..sourceOutMs). Cut dead time, glances, redundant motion.",
    "4. Images (kind='image') always have sourceInMs=0 and sourceOutMs=timelineEndMs-timelineStartMs.",
    "5. A clip's trim duration (sourceOutMs - sourceInMs) MUST equal its timeline duration (timelineEndMs - timelineStartMs).",
    "6. Fill the ENTIRE section window with cuts. If a single best clip is shorter than the section, slice it into multiple segments rather than holding one frame. Aim for 2-5 segments per section when material allows. A 9:16 reel feels alive when cuts land every 2-4 seconds.",
    "6a. Section windows may include silent lead-in or trail-out periods where no line is spoken (compare the window's startMs/endMs against each line's spokenStartMs/spokenEndMs). Use those silent moments for establishing shots, atmospheric beats, or breathing room — the visual sets up before the voiceover lands, or lingers after the last word. Don't waste silent time with a frozen frame; pick a visual that complements the upcoming/preceding speech.",
    "7. You MAY reuse the same clipId across multiple segments. This is the right move when a section only has one strong clip but its source is longer than any single beat — pick distinct 2-4 second slices from different non-overlapping time ranges (different action, framing, or moment in the clip). Diversity makes the edit feel cut, not held.",
    "8. When two or more segments share a clipId, their source ranges (sourceInMs..sourceOutMs) MUST NOT OVERLAP. Time-disjoint slices only — segment A using 0-3000ms and segment B using 5000-8000ms is fine; A=0-3000 and B=2000-5000 is forbidden.",
    "9. Respect the override prompt if provided. It overrides default choices.",
    "10. Return segments in order from t=0 onward, no overlaps, no gaps.",
    "11. Provide a one-sentence whyClip (why this clip fits this script line) and whyTrim (why this in/out point).",
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

  return { segments, totalDurationMs: total };
}
