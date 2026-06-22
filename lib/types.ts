export const SECTIONS = ["hook", "bridge", "body", "outro", "cta"] as const;
export type SectionId = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<SectionId, string> = {
  hook: "Hook",
  bridge: "Bridge",
  body: "Body/Product",
  outro: "Outro",
  cta: "CTA",
};

export const SECTION_DOT_VAR: Record<SectionId, string> = {
  hook: "--section-hook",
  bridge: "--section-bridge",
  body: "--section-body",
  outro: "--section-outro",
  cta: "--section-cta",
};

export const VIDEO_EXTS = [".mp4", ".mov"] as const;
export const IMAGE_EXTS = [".png", ".jpg", ".jpeg"] as const;
export const AUDIO_EXTS = [".mp3", ".wav", ".m4a"] as const;

export type ClipKind = "video" | "image";

export interface SourceClip {
  id: string;
  section: SectionId;
  kind: ClipKind;
  filename: string;
  /** Path under .producer-data/{session}/sources/, relative to session root. */
  relPath: string;
  /** Public URL the browser can fetch (via /api/media). */
  url: string;
  /** Probed duration in ms (videos only; images are 0). */
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  sizeBytes: number;
  /**
   * True iff the source file actually contains an audio stream. Optional
   * for back-compat with manifests written before this field existed —
   * downstream consumers fall back to a defensive default (or re-probe
   * on the fly) when it's undefined. Required by the XMEML exporter so
   * Premiere's relink-by-name doesn't reject the file with a "type does
   * not match" error.
   */
  hasAudio?: boolean;
  /**
   * Channel count of the first audio stream when hasAudio is true (1 =
   * mono, 2 = stereo, 6 = 5.1, …). XMEML's <channelcount> MUST match
   * the actual file or Premiere refuses to relink with "channel type
   * does not match". Same class of bug as hasAudio. Undefined when the
   * clip has no audio.
   */
  audioChannels?: number;
}

export interface ScriptLine {
  id: string;
  text: string;
  section: SectionId | null;
}

export interface WordTimestamp {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SectionWindow {
  section: SectionId;
  startMs: number;
  endMs: number;
  lines: ScriptLine[];
  /**
   * Per-line spoken-word timing within the voiceover (absolute ms, not
   * relative to the section). Populated by computeSectionWindows. Used by
   * the match-phase prompt so Gemini can see exactly when in a window
   * speech happens vs. silence — enabling smart establishing/breathing
   * visuals for silent lead-ins/trails.
   */
  lineTimings?: Record<string, { startMs: number; endMs: number }>;
}

export interface FrameDescription {
  timestampMs: number;
  description: string;
}

export interface ClipAnalysis {
  clipId: string;
  frames: FrameDescription[];
  summary: string;
}

export interface PlanSegment {
  /** Unique segment id (stable across re-runs unless plan changes). */
  id: string;
  section: SectionId;
  clipId: string;
  /** In/out points into the source clip (ms). For images these are 0 and the rendered duration. */
  sourceInMs: number;
  sourceOutMs: number;
  /** Position on the final timeline (ms). */
  timelineStartMs: number;
  timelineEndMs: number;
  whyClip: string;
  whyTrim: string;
  /**
   * Mandatory semantic-match audit string the model emits under Rule 0.
   * Quotes both the spoken words at this segment's timeline range and
   * the matching frame description from the source slice. Lets the
   * editor (and humans inspecting whyMatch in the Timeline tooltip)
   * verify the visual actually matches what's being said. Empty for
   * hold-fill segments synthesized after the AI pass.
   */
  whyMatch?: string;
  /** True when this segment is a hold-fill (no clip in section, or section longer than footage). */
  hold?: boolean;
}

export interface EditPlan {
  segments: PlanSegment[];
  totalDurationMs: number;
}

export const PHASES = [
  "upload",
  "frames",
  "analyse",
  "trim",
  "align",
  "map",
  "match",
  "assemble",
  "render",
] as const;
export type PhaseId = (typeof PHASES)[number];

export const PHASE_LABEL: Record<PhaseId, string> = {
  upload: "Upload & validate",
  frames: "Extract frames",
  analyse: "Analyse frames",
  trim: "Trim voiceover silences",
  align: "Align voiceover",
  map: "Map sections to voiceover",
  match: "Match + trim clips",
  assemble: "Assemble preview",
  render: "Render preview MP4",
};

export type PhaseStatus = "pending" | "running" | "complete" | "failed" | "skipped";

export interface PhaseState {
  id: PhaseId;
  status: PhaseStatus;
  detail?: string;
  progress?: number; // 0..1
  error?: string;
}

export interface JobState {
  id: string;
  sessionId: string;
  startedAt: number;
  finishedAt?: number;
  phases: PhaseState[];
  currentPhase: PhaseId;
  status: "running" | "complete" | "failed" | "stopped";
  error?: string;
  overridePrompt?: string;
}
