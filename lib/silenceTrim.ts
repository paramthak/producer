import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Detect silences in an audio file and produce a trimmed copy with the
 * silences excised.
 *
 * The motivation: the voiceover has natural inter-sentence/inter-section
 * pauses. Without trimming, those pauses become dead air in the section
 * timeline that the match phase has to fill with held frames or stretched
 * clips. By cutting silences upstream of forced-alignment, every
 * downstream phase works against a tight timeline where every spoken
 * word lands back-to-back.
 *
 * Threshold defaults:
 *   - silenceDb = -30 (any RMS below -30dB counts as silence — catches
 *     room tone but ignores quiet speech)
 *   - minSilenceMs = 800 (only trim silences ≥ 800ms — preserves the
 *     natural ~200-500ms inter-word breathing)
 *
 * Returns the absolute path of the trimmed file (which is the input path
 * itself — we overwrite in place so downstream code reads the manifest's
 * voiceover.relPath transparently). If no silences ≥ minSilenceMs are
 * found, the input is left untouched and we return its path unchanged.
 *
 * Idempotent: running this on an already-trimmed file is a no-op because
 * the long silences have already been cut.
 */
export interface TrimResult {
  /** Final on-disk path of the trimmed audio (== input path; rewritten in place). */
  path: string;
  /** Audio duration before any trim (ms). */
  originalDurationMs: number;
  /** Audio duration after trim (ms). */
  trimmedDurationMs: number;
  /** Number of silent intervals we removed. */
  silencesRemoved: number;
  /** Total milliseconds of silence cut out. */
  msRemoved: number;
}

export async function trimSilences(
  audioFile: string,
  opts: { silenceDb?: number; minSilenceMs?: number; signal?: AbortSignal } = {},
): Promise<TrimResult> {
  const silenceDb = opts.silenceDb ?? -30;
  const minSilenceMs = opts.minSilenceMs ?? 800;
  const minSilenceSec = minSilenceMs / 1000;

  const originalDurationMs = await probeAudioDurationMs(audioFile);

  // Pass 1: detect silences. ffmpeg writes silence_start / silence_end /
  // silence_duration lines to stderr; we parse them into intervals.
  const detectStderr = await runCaptureStderr(
    FFMPEG,
    [
      "-hide_banner",
      "-i",
      audioFile,
      "-af",
      `silencedetect=noise=${silenceDb}dB:d=${minSilenceSec}`,
      "-f",
      "null",
      "-",
    ],
    opts.signal,
  );

  const silences = parseSilences(detectStderr);
  if (silences.length === 0) {
    return {
      path: audioFile,
      originalDurationMs,
      trimmedDurationMs: originalDurationMs,
      silencesRemoved: 0,
      msRemoved: 0,
    };
  }

  // Build the keep-ranges: intervals between/around silences that we WANT
  // to retain. Walk in order, keeping cursor at the end of the last
  // emitted keep-range.
  const keepRanges: Array<{ startSec: number; endSec: number }> = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.startSec > cursor) {
      keepRanges.push({ startSec: cursor, endSec: s.startSec });
    }
    cursor = Math.max(cursor, s.endSec);
  }
  const totalSec = originalDurationMs / 1000;
  if (cursor < totalSec) {
    keepRanges.push({ startSec: cursor, endSec: totalSec });
  }

  if (keepRanges.length === 0) {
    // Entire audio is silence (edge case). Don't trim — that would yield
    // an empty file and explode downstream.
    return {
      path: audioFile,
      originalDurationMs,
      trimmedDurationMs: originalDurationMs,
      silencesRemoved: 0,
      msRemoved: 0,
    };
  }

  // Pass 2: splice the keep-ranges back together. aselect picks samples
  // whose presentation timestamp falls inside ANY of the keep-ranges;
  // asetpts re-stamps the output so durations stay correct.
  const aselectExpr = keepRanges
    .map((r) => `between(t,${r.startSec.toFixed(6)},${r.endSec.toFixed(6)})`)
    .join("+");

  // Write to a sibling temp file, then atomic-rename over the original.
  // Writing in-place would corrupt ffmpeg's input read.
  const ext = path.extname(audioFile);
  const tmpPath = path.join(
    path.dirname(audioFile),
    `${path.basename(audioFile, ext)}.trimmed${ext}`,
  );

  await runVoid(
    FFMPEG,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      audioFile,
      "-af",
      `aselect='${aselectExpr}',asetpts=N/SR/TB`,
      tmpPath,
    ],
    opts.signal,
  );
  await fs.rename(tmpPath, audioFile);

  const trimmedDurationMs = await probeAudioDurationMs(audioFile);
  const msRemoved = Math.max(0, originalDurationMs - trimmedDurationMs);

  return {
    path: audioFile,
    originalDurationMs,
    trimmedDurationMs,
    silencesRemoved: silences.length,
    msRemoved,
  };
}

/** Parse `[silencedetect ...] silence_start: X` / `silence_end: Y` lines. */
function parseSilences(stderr: string): Array<{ startSec: number; endSec: number }> {
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const result: Array<{ startSec: number; endSec: number }> = [];
  const n = Math.min(starts.length, ends.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(starts[i]) && Number.isFinite(ends[i]) && ends[i] > starts[i]) {
      result.push({ startSec: starts[i], endSec: ends[i] });
    }
  }
  // If there's a trailing silence_start without a matching silence_end
  // (ffmpeg occasionally omits it when the file ends in silence), treat
  // the file end as the implicit silence_end. Done in the caller by
  // returning what we have; the caller already clips against totalSec.
  return result.sort((a, b) => a.startSec - b.startSec);
}

async function probeAudioDurationMs(file: string): Promise<number> {
  const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
  const out = await runCaptureStdout(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Math.round(Number(out.trim()) * 1000);
}

function runCaptureStdout(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function runCaptureStderr(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      // silencedetect writes detection lines to stderr at info-level;
      // ffmpeg returns 0 even when it printed nothing.
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1000)}`));
    });
    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function runVoid(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code, sig) => {
      if (code === 0) {
        resolve();
        return;
      }
      const why = sig ? `killed by ${sig}` : `exited ${code}`;
      reject(new Error(`${cmd} ${why}: ${stderr.slice(-1000)}`));
    });
    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
