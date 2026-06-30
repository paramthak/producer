import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { paths } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { runFfmpeg } from "@/lib/ffmpeg";
import { hashPlan } from "@/lib/planHash";
import { normalizePlan, type NormalizedSegment } from "@/lib/planEdit";
import type { EditPlan, SourceClip } from "@/lib/types";

const W = 1080;
const H = 1920;
const FPS = 30;
// scale-to-fit + black letterbox pad — IDENTICAL fit to the preview's
// object-fit:contain on black, so the download matches what was previewed.
const VF = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p`;
const ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS)];

/**
 * Render the full-quality reel MP4 on demand from a session's edit plan.
 *
 * Consumes normalizePlan() — the SAME gapless/blank-filled list the live
 * preview plays — then encodes each normalized segment to a uniform 1080×1920
 * intermediate (in parallel, to use the box's cores) and stitches them with
 * the concat demuxer. The voiceover is muxed as the only audio with NO
 * -shortest, so video that runs past the voiceover keeps a silent tail.
 * Cached by plan hash. Returns the absolute path.
 */
export async function renderReelMp4(opts: {
  sessionId: string;
  plan: EditPlan;
  signal?: AbortSignal;
}): Promise<{ absPath: string; filename: string; planHash: string }> {
  const { sessionId, plan, signal } = opts;
  const p = paths(sessionId);
  const manifest = await loadManifest(sessionId);
  if (!manifest?.voiceover) throw new Error("renderReelMp4: voiceover missing");

  const planHash = hashPlan(plan);
  const filename = `reel-${planHash}.mp4`;
  const outPath = path.join(p.output, filename);
  try {
    await fs.access(outPath);
    return { absPath: outPath, filename, planHash }; // cache hit
  } catch { /* render below */ }

  const clipsById: Record<string, SourceClip> = Object.fromEntries(manifest.clips.map((c) => [c.id, c]));
  const segments = normalizePlan(plan).filter((s) => s.timelineEndMs - s.timelineStartMs >= 40);
  if (!segments.length) throw new Error("renderReelMp4: nothing to render");

  await fs.mkdir(p.output, { recursive: true });
  const tmp = path.join(p.output, `_render-${planHash}`);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });

  // Encode each normalized segment to a uniform intermediate, in parallel.
  const limit = pLimit(4);
  const parts: string[] = new Array(segments.length);
  await Promise.all(
    segments.map((seg, i) =>
      limit(async () => {
        const part = path.join(tmp, `p${String(i).padStart(4, "0")}.mp4`);
        await encodeSegmentPart(seg, clipsById, p.base, part, signal);
        parts[i] = part;
      }),
    ),
  );

  // Concat (stream-copy) + mux the voiceover. No -shortest → silent tail.
  const listPath = path.join(tmp, "concat.txt");
  await fs.writeFile(listPath, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  await runFfmpeg(
    [
      "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-i", path.join(p.base, manifest.voiceover.relPath),
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      outPath,
    ],
    signal,
  );

  await fs.rm(tmp, { recursive: true, force: true });
  return { absPath: outPath, filename, planHash };
}

async function encodeSegmentPart(
  seg: NormalizedSegment,
  clips: Record<string, SourceClip>,
  base: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const durSec = ((seg.timelineEndMs - seg.timelineStartMs) / 1000).toFixed(3);
  const clip = seg.kind === "clip" && seg.clipId ? clips[seg.clipId] : undefined;

  if (!clip) {
    // Blank / black filler (gaps, deletes, silent tail).
    await runFfmpeg(
      ["-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=${durSec}`, "-vf", "format=yuv420p", "-an", ...ENC, outPath],
      signal,
    );
    return;
  }
  // Final render uses the full-resolution SOURCE (not the proxy).
  const src = path.join(base, clip.relPath);
  if (clip.kind === "image") {
    await runFfmpeg(["-y", "-loop", "1", "-t", durSec, "-i", src, "-vf", VF, "-an", ...ENC, outPath], signal);
  } else {
    const ss = (seg.sourceInMs / 1000).toFixed(3);
    await runFfmpeg(["-y", "-ss", ss, "-t", durSec, "-i", src, "-vf", VF, "-an", ...ENC, outPath], signal);
  }
}
