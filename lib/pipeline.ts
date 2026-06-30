import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { paths, readJson, writeJson } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { jobStore } from "@/lib/jobStore";
import { extractFrames } from "@/lib/ffmpeg";
import { describeClip } from "@/lib/gemini/describeFrames";
import { forcedAlign } from "@/lib/elevenlabs/forcedAlign";
import { computeSectionWindows } from "@/lib/sections";
import { matchAndTrim } from "@/lib/gemini/matchAndTrim";
import { trimSilences } from "@/lib/silenceTrim";
import { invalidateVoiceoverDownstream } from "@/lib/cacheInvalidate";
import {
  addAlignCost,
  addDescribeCost,
  addMatchCost,
  emptyCosts,
  type SessionCosts,
} from "@/lib/costs";
import type {
  ClipAnalysis,
  EditPlan,
  PhaseId,
  SectionWindow,
  WordTimestamp,
} from "@/lib/types";
import { PHASES } from "@/lib/types";

// 5fps gives Gemini frame descriptions at ~200ms resolution — the same
// scale as a single spoken word. This is required for Rule 0's per-word
// reasoning to find the exact source millisecond where each word's
// content is visible (rather than interpolating between 500ms-apart
// frames at the old 2fps). Cost is ~2.5× more describe-phase input
// tokens; ~$0.08 extra per Generate at current Gemini Flash rates.
const FRAME_FPS = 5;
const CLIP_CONCURRENCY = 4;

interface RunOpts {
  jobId: string;
  sessionId: string;
  overridePrompt?: string;
  /** Only re-run match + assemble. Skips phases 1-5 if their outputs already exist. */
  rerunMatchOnly?: boolean;
}

function aborted(jobId: string): boolean {
  return jobStore.signal(jobId)?.aborted ?? false;
}

function setPhase(jobId: string, id: PhaseId, status: "running" | "complete" | "failed" | "skipped", detail?: string, progress?: number) {
  jobStore.updatePhase(jobId, id, { status, detail, progress });
}

function fail(jobId: string, id: PhaseId, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  jobStore.updatePhase(jobId, id, { status: "failed", error: msg, detail: msg });
  jobStore.finish(jobId, "failed", msg);
  throw err;
}

export async function runPipeline(opts: RunOpts): Promise<void> {
  const { jobId, sessionId } = opts;
  const sigGetter = () => jobStore.signal(jobId);
  const p = paths(sessionId);

  const manifest = await loadManifest(sessionId);
  if (!manifest) {
    jobStore.finish(jobId, "failed", "Unknown session");
    return;
  }

  // --- Phase 1: Upload & validate -------------------------------------------------------------
  try {
    setPhase(jobId, "upload", "running", "Validating uploads…");
    if (manifest.clips.length === 0) throw new Error("Add at least one clip or image before generating.");
    if (!manifest.voiceover) throw new Error("Upload a voiceover before generating.");
    const tagged = manifest.script.filter((l) => l.text.trim().length > 0);
    if (!tagged.length) throw new Error("Paste your script before generating.");
    if (tagged.some((l) => !l.section)) throw new Error("Tag every line to a section before generating.");
    setPhase(jobId, "upload", "complete", `${manifest.clips.length} files queued`);
  } catch (err) {
    fail(jobId, "upload", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 2: Extract frames ----------------------------------------------------------------
  const framesByClip = new Map<string, { paths: string[]; timestamps: number[] }>();
  try {
    setPhase(jobId, "frames", "running", "Extracting frames at 2fps…");
    let done = 0;
    for (const clip of manifest.clips) {
      if (aborted(jobId)) return finishStopped(jobId);
      const outDir = path.join(p.frames, clip.id);
      if (clip.kind === "image") {
        framesByClip.set(clip.id, {
          paths: [path.join(p.base, clip.relPath)],
          timestamps: [0],
        });
      } else {
        // Reuse cached frames if directory exists with files.
        let cached: string[] = [];
        try {
          cached = (await fs.readdir(outDir)).filter((n) => n.endsWith(".jpg")).sort();
        } catch {
          /* no cache */
        }
        let framePaths: string[];
        if (cached.length > 0) {
          framePaths = cached.map((n) => path.join(outDir, n));
        } else {
          framePaths = await extractFrames(
            path.join(p.base, clip.relPath),
            outDir,
            FRAME_FPS,
            sigGetter(),
          );
        }
        const timestamps = framePaths.map((_, i) => Math.round(((i + 0.5) / FRAME_FPS) * 1000));
        framesByClip.set(clip.id, { paths: framePaths, timestamps });
      }
      done += 1;
      setPhase(jobId, "frames", "running", `${done} of ${manifest.clips.length} clips`, done / manifest.clips.length);
    }
    setPhase(jobId, "frames", "complete", `${manifest.clips.length} clips frame-extracted`);
  } catch (err) {
    fail(jobId, "frames", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 3: Analyse frames ----------------------------------------------------------------
  // Token usage from each parallel describe call is accumulated locally
  // (avoids manifest-write races under pLimit concurrency) and rolled
  // into the session costs once the phase finishes.
  const analyses: Record<string, ClipAnalysis> = {};
  const describeUsages: Array<{ inputTokens: number; outputTokens: number }> = [];
  try {
    setPhase(jobId, "analyse", "running", "Analysing clips with Gemini 3.5 Flash…");
    const limit = pLimit(CLIP_CONCURRENCY);
    let done = 0;
    const total = manifest.clips.length;
    await Promise.all(
      manifest.clips.map((clip) =>
        limit(async () => {
          if (aborted(jobId)) return;
          // Reuse cached description if present.
          const cachePath = path.join(p.descriptions, `${clip.id}.json`);
          const cached = await readJson<ClipAnalysis>(cachePath);
          if (cached) {
            analyses[clip.id] = cached;
            done += 1;
            setPhase(jobId, "analyse", "running", `${done} of ${total} analysed`, done / total);
            return;
          }
          const fr = framesByClip.get(clip.id)!;
          const r = await describeClip(
            {
              clipId: clip.id,
              section: clip.section,
              framePaths: fr.paths,
              timestamps: fr.timestamps,
              highRes: clip.section === "body",
            },
            sigGetter(),
          );
          analyses[clip.id] = r.analysis;
          describeUsages.push(r.usage);
          await writeJson(cachePath, r.analysis);
          done += 1;
          setPhase(jobId, "analyse", "running", `${done} of ${total} analysed`, done / total);
        }),
      ),
    );
    if (aborted(jobId)) return finishStopped(jobId);
    if (describeUsages.length) {
      await updateSessionCosts(sessionId, (c) => {
        for (const u of describeUsages) addDescribeCost(c, u.inputTokens, u.outputTokens);
      });
    }
    setPhase(jobId, "analyse", "complete", `${Object.keys(analyses).length} clips analysed`);
  } catch (err) {
    fail(jobId, "analyse", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 3.5: Trim long silences from the voiceover ----------------------------------------
  // Runs BEFORE align so every downstream phase (align, map, match,
  // assemble, render) works against a tight, silence-free timeline.
  // Idempotent — if no silences ≥ 800ms exist (already-trimmed file on
  // re-run, or recording with no dead air), this is effectively a no-op.
  try {
    setPhase(jobId, "trim", "running", "Trimming silences > 800ms…");
    const voPath = path.join(p.base, manifest.voiceover!.relPath);
    const trim = await trimSilences(voPath, {
      silenceDb: -30,
      minSilenceMs: 800,
      signal: sigGetter(),
    });
    if (trim.silencesRemoved > 0) {
      // Voiceover content changed on disk → any cached alignment/sections/
      // edit-plan/preview are now stale. Delete them so the rest of the
      // pipeline (and any subsequent re-runs) re-computes against the
      // trimmed audio.
      await invalidateVoiceoverDownstream(sessionId).catch(() => {});
      setPhase(
        jobId,
        "trim",
        "complete",
        `Removed ${trim.silencesRemoved} silence${trim.silencesRemoved === 1 ? "" : "s"} (${(trim.msRemoved / 1000).toFixed(1)}s cut)`,
      );
    } else {
      setPhase(jobId, "trim", "complete", "No long silences found");
    }
  } catch (err) {
    fail(jobId, "trim", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 4: Align voiceover ---------------------------------------------------------------
  let words: WordTimestamp[];
  let voDurationMs: number;
  try {
    setPhase(jobId, "align", "running", "Aligning voiceover words…");
    const cached = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
    if (cached?.words?.length) {
      words = cached.words;
      voDurationMs = cached.durationMs;
    } else {
      const scriptText = manifest.script
        .map((l) => l.text)
        .filter((t) => t.trim())
        .join(" ");
      const voPath = path.join(p.base, manifest.voiceover!.relPath);
      words = await forcedAlign(voPath, scriptText, sigGetter());
      voDurationMs = words.length ? Math.max(...words.map((w) => w.endMs)) : 0;
      await writeJson(p.alignment, { words, durationMs: voDurationMs });
      // Cost is per audio-minute of the voiceover; only count it when we
      // actually hit ElevenLabs (cache hits are free).
      await updateSessionCosts(sessionId, (c) => addAlignCost(c, voDurationMs));
    }
    setPhase(jobId, "align", "complete", `${words.length} words aligned`);
  } catch (err) {
    fail(jobId, "align", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // Captions are no longer built here — subtitles are generated on demand
  // from the cached alignment when the user clicks "Generate subtitles" in
  // the editor (see /api/subtitles/generate). Keeps Generate fast/cheap.

  // --- Phase 5: Map sections ------------------------------------------------------------------
  let windows: SectionWindow[];
  try {
    setPhase(jobId, "map", "running", "Mapping sections to voiceover time…");
    windows = computeSectionWindows(manifest.script, words, voDurationMs);
    await writeJson(p.sections, { windows, totalDurationMs: voDurationMs });
    setPhase(jobId, "map", "complete", `${windows.length} sections mapped`);
  } catch (err) {
    fail(jobId, "map", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 6: Match + trim ------------------------------------------------------------------
  let plan: EditPlan;
  try {
    setPhase(jobId, "match", "running", "Matching + trimming with Gemini 3.1 Pro…");
    const matchResult = await matchAndTrim(
      {
        windows,
        clips: manifest.clips,
        analyses,
        overridePrompt: opts.overridePrompt ?? manifest.overridePrompt ?? "",
        // Per-word forced-alignment timing — Gemini reads speech rhythm
        // directly and matches cut pace to it (fixes the "SOP/LOR shown
        // for full second" issue and the section-bleed problem).
        words,
      },
      sigGetter(),
    );
    plan = matchResult.plan;
    await updateSessionCosts(sessionId, (c) =>
      addMatchCost(c, matchResult.usage.inputTokens, matchResult.usage.outputTokens),
    );
    setPhase(jobId, "match", "complete", `${plan.segments.length} segments`);
  } catch (err) {
    fail(jobId, "match", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 7: Assemble cut ------------------------------------------------------------------
  // No hold-fills: any gap the AI leaves (or the user later creates) renders
  // as black in both the live preview and the download (see lib/planEdit
  // normalizePlan). We just persist the AI's segments in timeline order.
  try {
    setPhase(jobId, "assemble", "running", "Assembling cut…");
    const ordered = [...plan.segments].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
    const assembledPlan: EditPlan = { segments: ordered, totalDurationMs: plan.totalDurationMs };
    await writeJson(p.editPlan, assembledPlan);
    setPhase(jobId, "assemble", "complete", "Ready to edit");
  } catch (err) {
    fail(jobId, "assemble", err);
  }

  // No render phase: the editor opens straight into the live proxy preview.
  // A full-quality MP4 is rendered on demand when the user clicks Download.
  jobStore.finish(jobId, "complete");
}

function finishStopped(jobId: string) {
  const job = jobStore.get(jobId);
  if (job && job.status === "running") jobStore.finish(jobId, "failed", "Stopped by user");
}

/**
 * Read-modify-write the session's costs counter. The mutator runs against
 * a freshly-loaded SessionCosts (existing or empty) so callers don't need
 * to think about defaults. Single-process app + per-phase serialization
 * means no concurrent writer races us in practice; the brief read-modify-
 * write window is tighter than any phase's other I/O.
 */
async function updateSessionCosts(
  sessionId: string,
  mutate: (c: SessionCosts) => void,
): Promise<void> {
  const m = await loadManifest(sessionId);
  if (!m) return;
  const costs = m.costs ?? emptyCosts();
  mutate(costs);
  m.costs = costs;
  await saveManifest(m);
}
