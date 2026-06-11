import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { paths, readJson, writeJson } from "@/lib/session";
import { loadManifest, saveManifest, type SessionManifest } from "@/lib/manifest";
import { jobStore } from "@/lib/jobStore";
import { extractFrames, renderFinalMp4 } from "@/lib/ffmpeg";
import { describeClip } from "@/lib/gemini/describeFrames";
import { forcedAlign } from "@/lib/elevenlabs/forcedAlign";
import { computeSectionWindows } from "@/lib/sections";
import { matchAndTrim } from "@/lib/gemini/matchAndTrim";
import { hashPlan } from "@/lib/planHash";
import type {
  ClipAnalysis,
  EditPlan,
  PhaseId,
  SectionWindow,
  WordTimestamp,
} from "@/lib/types";
import { PHASES } from "@/lib/types";

const FRAME_FPS = 2;
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
  const analyses: Record<string, ClipAnalysis> = {};
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
          const a = await describeClip(
            {
              clipId: clip.id,
              section: clip.section,
              framePaths: fr.paths,
              timestamps: fr.timestamps,
              highRes: clip.section === "body",
            },
            sigGetter(),
          );
          analyses[clip.id] = a;
          await writeJson(cachePath, a);
          done += 1;
          setPhase(jobId, "analyse", "running", `${done} of ${total} analysed`, done / total);
        }),
      ),
    );
    if (aborted(jobId)) return finishStopped(jobId);
    setPhase(jobId, "analyse", "complete", `${Object.keys(analyses).length} clips analysed`);
  } catch (err) {
    fail(jobId, "analyse", err);
  }

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
    }
    setPhase(jobId, "align", "complete", `${words.length} words aligned`);
  } catch (err) {
    fail(jobId, "align", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

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
    plan = await matchAndTrim(
      {
        windows,
        clips: manifest.clips,
        analyses,
        overridePrompt: opts.overridePrompt ?? manifest.overridePrompt ?? "",
      },
      sigGetter(),
    );
    setPhase(jobId, "match", "complete", `${plan.segments.length} segments`);
  } catch (err) {
    fail(jobId, "match", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 7: Assemble preview --------------------------------------------------------------
  let assembledPlan: EditPlan | null = null;
  try {
    setPhase(jobId, "assemble", "running", "Filling gaps + holds…");
    assembledPlan = applyHoldFills(plan, windows, manifest.clips);
    await writeJson(p.editPlan, assembledPlan);
    setPhase(jobId, "assemble", "complete", "Ready");
  } catch (err) {
    fail(jobId, "assemble", err);
  }
  if (aborted(jobId)) return finishStopped(jobId);

  // --- Phase 8: Render preview MP4 ------------------------------------------------------------
  // Rendering at pipeline-end (rather than on demand at download time) means
  // the editor's Preview can play ONE small MP4 instead of streaming N raw
  // source clips in parallel — which is the difference between "works" and
  // "unusable" once this is deployed behind a public network.
  try {
    setPhase(jobId, "render", "running", "Rendering preview MP4…");
    await renderPreviewForSession({
      sessionId,
      plan: assembledPlan!,
      manifest,
      signal: sigGetter(),
    });
    setPhase(jobId, "render", "complete", "Preview rendered");
  } catch (err) {
    fail(jobId, "render", err);
  }

  jobStore.finish(jobId, "complete");
}

/**
 * Render the final MP4 from the session's current edit plan and persist
 * the result on the manifest (`manifest.preview`). Used by both the main
 * pipeline (final phase) and the standalone /api/render endpoint that the
 * editor calls when the user clicks "Re-render preview" after editing.
 *
 * The output filename embeds the plan hash, so the cached MP4 is naturally
 * keyed by what plan produced it — the frontend's stale check is just a
 * hash comparison.
 */
export async function renderPreviewForSession(opts: {
  sessionId: string;
  plan: EditPlan;
  manifest: SessionManifest;
  signal?: AbortSignal;
}): Promise<{ filename: string; planHash: string }> {
  const { sessionId, plan, manifest, signal } = opts;
  const p = paths(sessionId);
  if (!manifest.voiceover) {
    throw new Error("renderPreviewForSession: voiceover missing");
  }

  const clipsById = Object.fromEntries(manifest.clips.map((c) => [c.id, c]));
  const segments: import("@/lib/ffmpeg").RenderSegment[] = plan.segments
    .map((seg) => {
      const clip = clipsById[seg.clipId];
      if (!clip) return null;
      const dur = (seg.timelineEndMs - seg.timelineStartMs) / 1000;
      if (dur <= 0) return null;
      return {
        inputPath: path.join(p.base, clip.relPath),
        isImage: clip.kind === "image",
        startSec: clip.kind === "image" ? 0 : seg.sourceInMs / 1000,
        durationSec: dur,
      };
    })
    .filter((x): x is import("@/lib/ffmpeg").RenderSegment => !!x);

  if (!segments.length) throw new Error("renderPreviewForSession: no segments to render");

  const planHash = hashPlan(plan);
  const filename = `preview-${planHash}.mp4`;
  const outPath = path.join(p.output, filename);
  await renderFinalMp4({
    segments,
    voiceoverPath: path.join(p.base, manifest.voiceover.relPath),
    outPath,
    signal,
  });

  // Persist on the manifest so the editor can compare hashes for staleness.
  const updated: SessionManifest = {
    ...manifest,
    preview: { filename, planHash, renderedAt: Date.now() },
  };
  await saveManifest(updated);

  return { filename, planHash };
}

/**
 * Run ONLY the render phase for an existing session whose edit plan is
 * already on disk. Fired by the /api/render endpoint when the user
 * clicks "Re-render preview" after editing the plan in the editor.
 */
export async function runRenderOnly(opts: {
  jobId: string;
  sessionId: string;
}): Promise<void> {
  const { jobId, sessionId } = opts;
  const p = paths(sessionId);
  const manifest = await loadManifest(sessionId);
  if (!manifest) {
    jobStore.finish(jobId, "failed", "Unknown session");
    return;
  }
  const plan = await readJson<EditPlan>(p.editPlan);
  if (!plan) {
    jobStore.finish(jobId, "failed", "No edit plan to render");
    return;
  }
  try {
    setPhase(jobId, "render", "running", "Rendering preview MP4…");
    await renderPreviewForSession({
      sessionId,
      plan,
      manifest,
      signal: jobStore.signal(jobId),
    });
    setPhase(jobId, "render", "complete", "Preview rendered");
    jobStore.finish(jobId, "complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobStore.updatePhase(jobId, "render", { status: "failed", error: msg, detail: msg });
    jobStore.finish(jobId, "failed", msg);
  }
}

function finishStopped(jobId: string) {
  const job = jobStore.get(jobId);
  if (job && job.status === "running") jobStore.finish(jobId, "failed", "Stopped by user");
}

/**
 * Apply the PRD's hold rules:
 *  - Section voiceover longer than its footage → hold the last good clip/image to fill.
 *  - Section has script lines but no clips uploaded → hold the previous section's last visual.
 */
function applyHoldFills(plan: EditPlan, windows: SectionWindow[], clips: { id: string; section: string }[]): EditPlan {
  const segments = [...plan.segments].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const out: typeof segments = [];
  let lastSeg: (typeof segments)[number] | null = null;

  for (const w of windows) {
    if (w.endMs <= w.startMs) continue;
    const inSection = segments.filter((s) => s.section === w.section);
    const hasClips = clips.some((c) => c.section === w.section);

    if (inSection.length === 0) {
      // Hold-previous-section's last visual across this window.
      if (lastSeg) {
        out.push({
          ...lastSeg,
          id: `${lastSeg.id}-hold-${w.section}`,
          section: w.section,
          timelineStartMs: w.startMs,
          timelineEndMs: w.endMs,
          // Freeze on the last frame: image-style hold (sourceIn=sourceOut clamps to source end)
          sourceInMs: lastSeg.sourceOutMs - 1,
          sourceOutMs: lastSeg.sourceOutMs,
          whyClip: `Hold: section "${w.section}" had no clips, holding previous visual.`,
          whyTrim: "Hold-fill on last frame of the previous segment.",
          hold: true,
        });
        // Note: lastSeg remains the previous real segment, not the hold.
      }
      if (!hasClips) continue;
    } else {
      for (const s of inSection) out.push(s);
      lastSeg = inSection[inSection.length - 1];
      // If the section's last segment ends before the window ends → extend with a hold.
      if (lastSeg.timelineEndMs < w.endMs) {
        const holdMs = w.endMs - lastSeg.timelineEndMs;
        out.push({
          ...lastSeg,
          id: `${lastSeg.id}-hold-tail`,
          timelineStartMs: lastSeg.timelineEndMs,
          timelineEndMs: w.endMs,
          sourceInMs: lastSeg.sourceOutMs - 1,
          sourceOutMs: lastSeg.sourceOutMs,
          whyClip: `Hold: section voiceover ran ${(holdMs / 1000).toFixed(1)}s longer than footage.`,
          whyTrim: "Holding last frame to fill the section.",
          hold: true,
        });
      }
    }
  }

  const total = out.length ? out[out.length - 1].timelineEndMs : plan.totalDurationMs;
  return { segments: out, totalDurationMs: total };
}
