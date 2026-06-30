import { nanoid } from "nanoid";
import type { EditPlan, PlanSegment, SectionId, SourceClip } from "@/lib/types";

/**
 * Pure timeline edit operations for the free single-track editor.
 *
 * Model (see PRD §5):
 *  - One video track. Segments carry absolute timeline positions and may
 *    leave gaps — gaps render BLACK (no hold-fills).
 *  - True Premiere "overwrite": placing a segment over others trims/splits
 *    whatever it covers; the placed segment always wins.
 *  - The voiceover is the spine. `plan.totalDurationMs` is the voiceover
 *    floor; the effective timeline length grows if clips extend past it
 *    (silent tail) and shrinks back to the floor otherwise.
 *  - Source/timeline mapping is 1:1 (a 1s timeline span = 1s of source).
 *    Image segments carry a source range too, but the renderer/preview
 *    ignore it (images are looped/held for the timeline duration), so we
 *    can map them uniformly without special-casing.
 *
 * These functions are framework-agnostic and deterministic so the live
 * preview and the download render consume the EXACT same normalized plan.
 */

/** Smallest allowed segment; carve slivers below this are dropped. */
export const MIN_SEG_MS = 80;
/** Default duration when a library clip is dropped with no clean gap to fill. */
export const DEFAULT_ADD_MS = 3000;

/** Effective timeline length: the voiceover floor, or the last clip end if longer. */
export function effectiveDurationMs(plan: EditPlan): number {
  const lastEnd = plan.segments.reduce((m, s) => Math.max(m, s.timelineEndMs), 0);
  return Math.max(plan.totalDurationMs, lastEnd, 1);
}

/** A fully-resolved segment for playback/render: gapless, non-overlapping, blanks filled. */
export interface NormalizedSegment {
  id: string;
  kind: "clip" | "blank";
  clipId: string | null;
  sourceInMs: number;
  sourceOutMs: number;
  timelineStartMs: number;
  timelineEndMs: number;
}

/**
 * Collapse the stored plan into a gapless, non-overlapping list covering
 * [0, effectiveDuration]. Uncovered spans become black `blank` segments.
 * This is the single source of truth shared by the preview compositor and
 * the ffmpeg renderer — so what you see is what you download.
 */
export function normalizePlan(plan: EditPlan): NormalizedSegment[] {
  const total = effectiveDurationMs(plan);
  const segs = [...plan.segments]
    .filter((s) => s.timelineEndMs - s.timelineStartMs >= 1)
    .sort((a, b) => a.timelineStartMs - b.timelineStartMs);

  const out: NormalizedSegment[] = [];
  let cursor = 0;
  for (const s of segs) {
    const start = Math.max(s.timelineStartMs, cursor); // defensive overlap clamp
    if (start >= s.timelineEndMs) continue; // fully shadowed by a previous segment
    if (start > cursor) out.push(makeBlank(cursor, start));
    const trimLeft = start - s.timelineStartMs; // advancing start advances source 1:1
    out.push({
      id: s.id,
      kind: "clip",
      clipId: s.clipId,
      sourceInMs: s.sourceInMs + trimLeft,
      sourceOutMs: s.sourceOutMs,
      timelineStartMs: start,
      timelineEndMs: s.timelineEndMs,
    });
    cursor = s.timelineEndMs;
  }
  if (cursor < total) out.push(makeBlank(cursor, total));
  return out;
}

function makeBlank(startMs: number, endMs: number): NormalizedSegment {
  return {
    id: `blank-${startMs}-${endMs}`,
    kind: "blank",
    clipId: null,
    sourceInMs: 0,
    sourceOutMs: 0,
    timelineStartMs: startMs,
    timelineEndMs: endMs,
  };
}

/* ============================ core: place + carve ============================ */

/**
 * Return a copy of `seg` restricted to the timeline sub-range [start,end],
 * mapping the source range proportionally (1:1). `freshId` mints a new id —
 * used for the right-hand piece of a split so React keys stay unique.
 */
function sliceSegment(seg: PlanSegment, start: number, end: number, freshId: boolean): PlanSegment {
  const leftDelta = Math.max(0, start - seg.timelineStartMs);
  const rightDelta = Math.max(0, seg.timelineEndMs - end);
  return {
    ...seg,
    id: freshId ? nanoid(8) : seg.id,
    timelineStartMs: start,
    timelineEndMs: end,
    sourceInMs: seg.sourceInMs + leftDelta,
    sourceOutMs: seg.sourceOutMs - rightDelta,
  };
}

/**
 * Remove the region [ws,we] from every "other" segment (overwrite). Segments
 * fully covered vanish; partially covered ones are trimmed; a segment that
 * straddles the region splits into two.
 */
function carve(others: PlanSegment[], ws: number, we: number): PlanSegment[] {
  const res: PlanSegment[] = [];
  for (const o of others) {
    if (o.timelineEndMs <= ws || o.timelineStartMs >= we) {
      res.push(o); // no overlap
      continue;
    }
    const keepLeft = o.timelineStartMs < ws;
    const keepRight = o.timelineEndMs > we;
    if (keepLeft) {
      const left = sliceSegment(o, o.timelineStartMs, ws, false);
      if (left.timelineEndMs - left.timelineStartMs >= MIN_SEG_MS) res.push(left);
    }
    if (keepRight) {
      // Mint a fresh id only when the segment also kept a left piece (a true split).
      const right = sliceSegment(o, we, o.timelineEndMs, keepLeft);
      if (right.timelineEndMs - right.timelineStartMs >= MIN_SEG_MS) res.push(right);
    }
    // covered in full → dropped
  }
  return res;
}

/**
 * Place `seg` on the timeline, overwriting whatever it covers. Any prior
 * version of `seg` (same id) is removed first. totalDurationMs (the
 * voiceover floor) is left untouched.
 */
export function placeSegment(plan: EditPlan, seg: PlanSegment): EditPlan {
  const others = plan.segments.filter((s) => s.id !== seg.id);
  const carved = carve(others, seg.timelineStartMs, seg.timelineEndMs);
  const segments = [...carved, seg].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  return { segments, totalDurationMs: plan.totalDurationMs };
}

/* ============================ public edit ops ============================ */

/** Move a segment to a new start (keeps its duration); clamps to >= 0; overwrites. */
export function applyMove(plan: EditPlan, segId: string, newStartMs: number): EditPlan {
  const seg = plan.segments.find((s) => s.id === segId);
  if (!seg) return plan;
  const dur = seg.timelineEndMs - seg.timelineStartMs;
  const start = Math.max(0, Math.round(newStartMs));
  return placeSegment(plan, { ...seg, timelineStartMs: start, timelineEndMs: start + dur });
}

/**
 * Trim a segment's source in/out via the edge handles. The opposite edge
 * stays fixed; the edited edge moves in timeline space too. Extending into a
 * neighbour overwrites it (the trimmed segment wins).
 */
export function applyTrim(
  plan: EditPlan,
  segId: string,
  patch: { sourceInMs?: number; sourceOutMs?: number },
): EditPlan {
  const seg = plan.segments.find((s) => s.id === segId);
  if (!seg) return plan;
  let { timelineStartMs, timelineEndMs } = seg;
  let { sourceInMs, sourceOutMs } = seg;

  if (patch.sourceInMs != null) {
    const delta = patch.sourceInMs - sourceInMs; // +ve trims from the left
    sourceInMs = patch.sourceInMs;
    timelineStartMs = timelineStartMs + delta;
  }
  if (patch.sourceOutMs != null) {
    const delta = patch.sourceOutMs - sourceOutMs; // +ve extends to the right
    sourceOutMs = patch.sourceOutMs;
    timelineEndMs = timelineEndMs + delta;
  }
  if (timelineEndMs - timelineStartMs < MIN_SEG_MS) return plan; // ignore degenerate trims
  return placeSegment(plan, { ...seg, timelineStartMs, timelineEndMs, sourceInMs, sourceOutMs });
}

/**
 * Split the segment under `atMs` into two independent segments at that point.
 * Nothing else moves. The right piece gets a fresh id.
 */
export function applySplit(plan: EditPlan, atMs: number): EditPlan {
  const at = Math.round(atMs);
  const seg = plan.segments.find((s) => at > s.timelineStartMs && at < s.timelineEndMs);
  if (!seg) return plan;
  if (at - seg.timelineStartMs < MIN_SEG_MS || seg.timelineEndMs - at < MIN_SEG_MS) return plan;
  const left = sliceSegment(seg, seg.timelineStartMs, at, false);
  const right = sliceSegment(seg, at, seg.timelineEndMs, true);
  const others = plan.segments.filter((s) => s.id !== seg.id);
  const segments = [...others, left, right].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  return { segments, totalDurationMs: plan.totalDurationMs };
}

/** Delete a segment. The vacated span becomes black (filled at normalize time). */
export function applyDelete(plan: EditPlan, segId: string): EditPlan {
  const segments = plan.segments.filter((s) => s.id !== segId);
  return { segments, totalDurationMs: plan.totalDurationMs };
}

/**
 * Add a library clip as a new segment at `atMs`. Duration snaps to fill the
 * gap at the drop point (capped at the clip's real length); if dropped onto
 * an occupied span (no clean gap) it falls back to DEFAULT_ADD_MS and
 * overwrites. Clips can be reused any number of times.
 */
export function addFromLibrary(plan: EditPlan, clip: SourceClip, atMs: number): EditPlan {
  const at = Math.max(0, Math.round(atMs));
  const isImage = clip.kind === "image";
  const clipLen = isImage
    ? Number.POSITIVE_INFINITY
    : Math.max(MIN_SEG_MS, clip.durationMs || DEFAULT_ADD_MS);

  const nextStart = plan.segments
    .filter((s) => s.timelineStartMs > at)
    .reduce((m, s) => Math.min(m, s.timelineStartMs), Number.POSITIVE_INFINITY);
  const occupiedAt = plan.segments.some((s) => at >= s.timelineStartMs && at < s.timelineEndMs);

  let dur: number;
  if (occupiedAt) {
    dur = Math.min(clipLen, DEFAULT_ADD_MS); // dropped on a clip → overwrite a default chunk
  } else if (Number.isFinite(nextStart)) {
    dur = Math.min(clipLen, nextStart - at); // fill the gap up to the next clip
  } else {
    dur = Math.min(clipLen, DEFAULT_ADD_MS); // open timeline → default chunk
  }
  dur = Math.max(MIN_SEG_MS, dur);

  const seg: PlanSegment = {
    id: nanoid(8),
    section: clip.section as SectionId,
    clipId: clip.id,
    sourceInMs: 0,
    sourceOutMs: isImage ? dur : Math.min(clip.durationMs || dur, dur),
    timelineStartMs: at,
    timelineEndMs: at + dur,
    whyClip: `Added ${clip.filename} from the library.`,
    whyTrim: "Drag the edges to re-trim.",
  };
  return placeSegment(plan, seg);
}
