import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

/** Resolved ffmpeg binary path (honours FFMPEG_PATH). */
export const FFMPEG_BIN = FFMPEG;

/**
 * Run an arbitrary ffmpeg invocation, honouring an AbortSignal (kills the
 * child on abort) and surfacing stderr on failure. Used by the subtitle
 * renderer, which composes its own multi-input filtergraphs.
 */
export function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return runVoid(FFMPEG, args, signal);
}

export interface ProbeResult {
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  /**
   * True iff the file contains at least one audio stream. Critical for
   * XMEML export — Premiere's relink-by-name refuses to link a file whose
   * track configuration (audio yes/no) doesn't match what the project
   * file declares. Stock-footage MP4s are often video-only; if we tell
   * Premiere they have audio when they don't, the relink dialog throws
   * "Cannot Link Media — type does not match" and refuses.
   */
  hasAudio: boolean;
  /**
   * Number of audio channels in the first audio stream (1 = mono,
   * 2 = stereo, 6 = 5.1, ...). Undefined when hasAudio is false. The
   * XMEML <channelcount> MUST match this or Premiere rejects the relink
   * with "different channel type" — the same class of bug as hasAudio.
   */
  audioChannels?: number;
  /** Sample rate in Hz of the first audio stream, e.g. 44100 or 48000. */
  audioSampleRate?: number;
  /** Bit depth of the first audio stream when reported (PCM only). */
  audioBitDepth?: number;
}

export async function probe(file: string): Promise<ProbeResult> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    file,
  ];
  const out = await runStdout(FFPROBE, args);
  const json = JSON.parse(out);
  const streams = (json.streams as Array<Record<string, unknown>> | undefined) ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const hasAudio = !!audio;
  const durationSec = Number(json.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  let fps: number | undefined;
  if (video?.avg_frame_rate && typeof video.avg_frame_rate === "string") {
    const [num, den] = video.avg_frame_rate.split("/").map(Number);
    if (den) fps = num / den;
  }
  // ffprobe surfaces audio channel count as `channels` (number) and sample
  // rate as `sample_rate` (string). `bits_per_raw_sample` only appears
  // for PCM-ish formats; lossy codecs omit it.
  const audioChannels =
    typeof audio?.channels === "number" ? audio.channels : undefined;
  const audioSampleRate = audio?.sample_rate
    ? Number(audio.sample_rate as string)
    : undefined;
  const audioBitDepth = audio?.bits_per_raw_sample
    ? Number(audio.bits_per_raw_sample as string)
    : undefined;
  return {
    durationMs: Math.round(durationSec * 1000),
    width: video?.width as number | undefined,
    height: video?.height as number | undefined,
    fps,
    hasAudio,
    audioChannels,
    audioSampleRate,
    audioBitDepth,
  };
}

export async function probeAudioDurationMs(file: string): Promise<number> {
  const out = await runStdout(FFPROBE, [
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

/** Extract frames at fps and write to outDir/0001.jpg ... Returns absolute frame paths in order. */
export async function extractFrames(
  videoFile: string,
  outDir: string,
  fps: number,
  signal?: AbortSignal,
): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const args = [
    "-y",
    "-i",
    videoFile,
    "-vf",
    `fps=${fps}`,
    "-q:v",
    "3",
    path.join(outDir, "%04d.jpg"),
  ];
  await runVoid(FFMPEG, args, signal);
  const entries = await fs.readdir(outDir);
  return entries
    .filter((e) => e.endsWith(".jpg"))
    .sort()
    .map((e) => path.join(outDir, e));
}

export interface RenderSegment {
  inputPath: string;
  isImage: boolean;
  startSec: number;
  durationSec: number;
}

/**
 * Render the final 1080x1920 MP4: each segment trimmed/looped, concatenated, with the voiceover
 * as the only audio track. Returns the output path.
 */
export async function renderFinalMp4(opts: {
  segments: RenderSegment[];
  voiceoverPath: string;
  outPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { segments, voiceoverPath, outPath } = opts;
  if (!segments.length) throw new Error("renderFinalMp4: no segments");

  const args: string[] = ["-y"];

  // Add each segment as an input.
  for (const seg of segments) {
    if (seg.isImage) {
      args.push("-loop", "1", "-t", seg.durationSec.toFixed(3), "-i", seg.inputPath);
    } else {
      args.push(
        "-ss",
        seg.startSec.toFixed(3),
        "-t",
        seg.durationSec.toFixed(3),
        "-i",
        seg.inputPath,
      );
    }
  }

  // Voiceover is the last input.
  args.push("-i", voiceoverPath);
  const voiceoverIdx = segments.length;

  // Build a filter graph: scale/pad each input to 1080x1920, set sar, then concat.
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    parts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${i}]`,
    );
  }
  const concatInputs = segments.map((_, i) => `[v${i}]`).join("");
  parts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=0[vout]`);
  const filter = parts.join(";");

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    `${voiceoverIdx}:a`,
    "-shortest",
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
    outPath,
  );

  await runVoid(FFMPEG, args, opts.signal);
  return outPath;
}

function runStdout(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function runVoid(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
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
