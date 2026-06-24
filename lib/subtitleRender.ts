/**
 * Server-side subtitle rendering: SVG → PNG (resvg) → ffmpeg compositing.
 *
 * Why this design (see context.md §22): the live editor overlay and these
 * exports are produced from the SAME SVG markup (lib/subtitleSvg.ts), so the
 * burned/green-screen output is pixel-identical to what the user styled. It
 * needs only universal ffmpeg filters (overlay/concat/color) — NO libass —
 * so it runs on any ffmpeg, locally and on EC2.
 *
 * Two outputs:
 *   - renderGreenScreenSubs → subtitles.mp4: captions over chroma green
 *     (#00B140), 1080×1920, for the ZIP's top Premiere track.
 *   - renderSubtitledMp4 → preview MP4 with captions burned in, for the
 *     "Download MP4 with subtitles" path.
 *
 * Both go through one transparent overlay build (one PNG per caption state),
 * cached on disk by the subtitle-state hash.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { FFMPEG_BIN, runFfmpeg } from "@/lib/ffmpeg";
import { buildCaptionSvg, buildEmptySvg } from "@/lib/subtitleSvg";
import { computeStates, sortedCaptions, hashSubtitles } from "@/lib/subtitles";
import type { SubtitleState } from "@/lib/types";

/** Broadcast-standard chroma key green for the subtitle screen. */
export const CHROMA_GREEN = "#00B140";
export const SUB_W = 1080;
export const SUB_H = 1920;
const FPS = 30;

const FONTS_DIR = path.join(process.cwd(), "public", "fonts");
const FONT_FILES = [
  "Inter-Regular.ttf",
  "Inter-Bold.ttf",
  "Inter-Black.ttf",
  "LibreCaslonText-Regular.ttf",
  "LibreCaslonText-Bold.ttf",
  "LibreCaslonText-Italic.ttf",
];
// IMPORTANT: pass font FILE PATHS, not pre-read buffers. resvg resolves the
// font-weight axis (Regular/Bold/Black) only via fontFiles/fontDirs — when
// given anonymous fontBuffers it loses the weight metadata and renders every
// weight as Regular (verified empirically). The OS file cache makes the
// per-state re-reads cheap.
const FONT_PATHS = FONT_FILES.map((f) => path.join(FONTS_DIR, f));

function rasterize(svg: string): Buffer {
  const r = new Resvg(svg, {
    font: { fontFiles: FONT_PATHS, loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "width", value: SUB_W },
  });
  return Buffer.from(r.render().asPng());
}

interface StatePng {
  file: string;
  durationSec: number;
}

/**
 * Render every caption state to a PNG in `dir`. `background` null → transparent
 * PNGs (for the alpha overlay); a colour → opaque PNGs (unused today but kept
 * symmetric). Returns the ordered PNG list with per-state durations.
 */
async function renderStatePngs(
  state: SubtitleState,
  totalMs: number,
  dir: string,
  background: string | null,
  signal?: AbortSignal,
): Promise<StatePng[]> {
  await fs.mkdir(dir, { recursive: true });
  const sorted = sortedCaptions(state.captions);
  const states = computeStates(state.captions, totalMs);
  const out: StatePng[] = [];

  for (let i = 0; i < states.length; i++) {
    if (signal?.aborted) throw new Error("aborted");
    const s = states[i];
    const svg =
      s.captionIndex === null
        ? buildEmptySvg(background)
        : buildCaptionSvg({
            caption: sorted[s.captionIndex],
            revealedCount: s.revealedCount,
            style: state.style,
            background,
            // No CSS animation in exports — each PNG is a settled frame.
            animateLastWord: false,
          });
    const png = rasterize(svg);
    const file = path.join(dir, `s${String(i).padStart(5, "0")}.png`);
    await fs.writeFile(file, png);
    out.push({ file, durationSec: Math.max(0.001, (s.endMs - s.startMs) / 1000) });
  }
  return out;
}

/** Write an ffconcat list (last entry repeated — concat demuxer quirk). */
async function writeConcatList(pngs: StatePng[], listPath: string): Promise<void> {
  const lines = ["ffconcat version 1.0"];
  for (const p of pngs) {
    lines.push(`file '${p.file.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${p.durationSec.toFixed(3)}`);
  }
  // Repeat the final image so its duration is honoured.
  if (pngs.length) lines.push(`file '${pngs[pngs.length - 1].file.replace(/'/g, "'\\''")}'`);
  await fs.writeFile(listPath, lines.join("\n"), "utf8");
}

/**
 * Build (and cache) a full-length transparent overlay video (qtrle, alpha) of
 * the captions. Reused to composite onto green OR onto the preview MP4.
 */
async function buildOverlayMov(
  state: SubtitleState,
  totalMs: number,
  outputDir: string,
  subHash: string,
  signal?: AbortSignal,
): Promise<string> {
  const movPath = path.join(outputDir, `suboverlay-${subHash}.mov`);
  try {
    await fs.access(movPath);
    return movPath; // cached
  } catch {
    /* render */
  }

  const tmpDir = path.join(outputDir, `_subtmp-${subHash}`);
  const listPath = path.join(tmpDir, "list.txt");
  try {
    const pngs = await renderStatePngs(state, totalMs, tmpDir, null, signal);
    await writeConcatList(pngs, listPath);
    await runFfmpeg(
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        // RGBA preserves the transparency; qtrle is lossless with alpha.
        "-vf",
        `fps=${FPS},format=rgba`,
        "-c:v",
        "qtrle",
        movPath,
      ],
      signal,
    );
    return movPath;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render the green-screen subtitles.mp4 (#00B140, 1080×1920, the duration of
 * the reel). Cached by the subtitle-state hash.
 */
export async function renderGreenScreenSubs(opts: {
  state: SubtitleState;
  totalMs: number;
  outputDir: string;
  signal?: AbortSignal;
}): Promise<{ filename: string; absPath: string }> {
  const { state, totalMs, outputDir, signal } = opts;
  const subHash = hashSubtitles(state);
  const filename = `subtitles-${subHash}.mp4`;
  const absPath = path.join(outputDir, filename);
  try {
    await fs.access(absPath);
    return { filename, absPath }; // cached
  } catch {
    /* render */
  }

  const overlay = await buildOverlayMov(state, totalMs, outputDir, subHash, signal);
  const durSec = Math.max(0.04, totalMs / 1000);
  await runFfmpeg(
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${CHROMA_GREEN}:s=${SUB_W}x${SUB_H}:r=${FPS}:d=${durSec.toFixed(3)}`,
      "-i",
      overlay,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:shortest=1,format=yuv420p[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      absPath,
    ],
    signal,
  );
  return { filename, absPath };
}

/**
 * Burn captions onto an existing rendered preview MP4 (keeps the voiceover
 * audio). Cached by preview plan hash + subtitle-state hash.
 */
export async function renderSubtitledMp4(opts: {
  previewPath: string;
  planHash: string;
  state: SubtitleState;
  totalMs: number;
  outputDir: string;
  signal?: AbortSignal;
}): Promise<{ filename: string; absPath: string }> {
  const { previewPath, planHash, state, totalMs, outputDir, signal } = opts;
  const subHash = hashSubtitles(state);
  const filename = `subbed-${planHash}-${subHash}.mp4`;
  const absPath = path.join(outputDir, filename);
  try {
    await fs.access(absPath);
    return { filename, absPath }; // cached
  } catch {
    /* render */
  }

  const overlay = await buildOverlayMov(state, totalMs, outputDir, subHash, signal);
  await runFfmpeg(
    [
      "-y",
      "-i",
      previewPath,
      "-i",
      overlay,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p[v]",
      "-map",
      "[v]",
      // Keep the voiceover audio already baked into the preview.
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-shortest",
      absPath,
    ],
    signal,
  );
  return { filename, absPath };
}

// Silence unused-import lint if FFMPEG_BIN ends up only referenced indirectly.
export const _FFMPEG_BIN = FFMPEG_BIN;
