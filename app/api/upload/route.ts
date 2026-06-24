import { NextRequest, NextResponse } from "next/server";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { ensureSession, paths, mediaUrl } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { probe, probeAudioDurationMs } from "@/lib/ffmpeg";
import { invalidateClipsDownstream, invalidateVoiceoverDownstream } from "@/lib/cacheInvalidate";
import { sanitizeForNleRelink } from "@/lib/zipBundle";
import { AUTH_COOKIE, AUTH_COOKIE_VALUE } from "@/lib/auth";
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  VIDEO_EXTS,
  type ClipKind,
  type SectionId,
  type SourceClip,
  SECTIONS,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function safeUploadId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

/**
 * Chunked streaming upload endpoint.
 *
 * Why chunked?
 * Railway's edge proxy has a hard 5-minute (300s) timeout on any single HTTP
 * request. A 200-500 MB file on home wifi blows past that and the proxy
 * sends RST → server sees ECONNRESET → upload fails. We sidestep it by
 * splitting each file into ~10 MB chunks; each chunk's request completes in
 * seconds and is well inside any platform timeout.
 *
 * Why not req.formData()?
 * Next.js's FormData parser buffers the whole body and dies above ~10 MiB.
 * We stream the raw request body straight to disk via Web→Node stream
 * bridging instead. Metadata travels in query params; no multipart parsing.
 *
 * middleware.ts excludes /api/upload from its matcher (so Edge's 10 MiB
 * body cap doesn't apply). Auth is checked inline below.
 *
 * Protocol:
 *   POST /api/upload?sessionId=&kind=clip|voiceover&section=&filename=
 *                  &uploadId=&chunkIndex=&totalChunks=
 *   Body: raw bytes of one chunk (no encoding).
 *
 * - First chunk (chunkIndex=0): create/truncate the temp file
 *     <sources|voiceover>/.uploading/<uploadId>.part
 * - Subsequent chunks: append to the same temp file.
 * - Last chunk (chunkIndex === totalChunks-1): close, atomic-rename to the
 *   final path, probe via ffmpeg, attach to manifest, return the clip metadata.
 * - Intermediate chunks: return { ok: true, chunkIndex }.
 *
 * Single-chunk uploads (totalChunks=1) work too — common for small images.
 */
export async function POST(req: NextRequest) {
  if (req.cookies.get(AUTH_COOKIE)?.value !== AUTH_COOKIE_VALUE) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const sessionIdParam = sp.get("sessionId") || undefined;
  const kind = (sp.get("kind") as string) ?? "clip";
  const section = sp.get("section") as SectionId | null;
  const filename = sp.get("filename");
  const uploadId = sp.get("uploadId");
  const chunkIndexStr = sp.get("chunkIndex");
  const totalChunksStr = sp.get("totalChunks");

  if (!filename) {
    return NextResponse.json({ error: "Missing filename" }, { status: 400 });
  }
  if (!uploadId || !safeUploadId(uploadId)) {
    return NextResponse.json({ error: "Missing or invalid uploadId" }, { status: 400 });
  }
  const chunkIndex = Number(chunkIndexStr);
  const totalChunks = Number(totalChunksStr);
  if (
    !Number.isInteger(chunkIndex) ||
    !Number.isInteger(totalChunks) ||
    chunkIndex < 0 ||
    totalChunks < 1 ||
    chunkIndex >= totalChunks
  ) {
    return NextResponse.json({ error: "Invalid chunkIndex/totalChunks" }, { status: 400 });
  }
  if (!req.body) {
    return NextResponse.json({ error: "Missing body" }, { status: 400 });
  }

  const sessionId = await ensureSession(sessionIdParam);
  const ext = extOf(filename);

  // Validate kind/ext early.
  let clipKind: ClipKind | null = null;
  if (kind === "voiceover") {
    if (!(AUDIO_EXTS as readonly string[]).includes(ext)) {
      return NextResponse.json(
        { error: "Upload an audio file (.mp3, .wav, or .m4a)." },
        { status: 400 },
      );
    }
  } else {
    if (!section || !SECTIONS.includes(section)) {
      return NextResponse.json({ error: "Missing or invalid section" }, { status: 400 });
    }
    if ((VIDEO_EXTS as readonly string[]).includes(ext)) clipKind = "video";
    else if ((IMAGE_EXTS as readonly string[]).includes(ext)) clipKind = "image";
    if (!clipKind) {
      return NextResponse.json(
        { error: "Only .mp4, .mov, .png, .jpg are supported." },
        { status: 400 },
      );
    }
  }

  // Pick the .uploading/ scratch dir based on kind. Within a session this is
  // disambiguated by uploadId, so multiple files can upload concurrently
  // without colliding.
  const sessionBase = paths(sessionId).base;
  const scratchDir =
    kind === "voiceover"
      ? path.join(sessionBase, "voiceover", ".uploading")
      : path.join(sessionBase, "sources", ".uploading");
  await fs.mkdir(scratchDir, { recursive: true });
  const partPath = path.join(scratchDir, `${uploadId}.part`);

  // Append this chunk. On chunkIndex=0 we truncate; otherwise we append.
  // pipeline() handles the streaming + backpressure + error propagation.
  const writeFlags = chunkIndex === 0 ? "w" : "a";
  try {
    const nodeStream = Readable.fromWeb(
      req.body as unknown as import("stream/web").ReadableStream,
    );
    await pipeline(nodeStream, createWriteStream(partPath, { flags: writeFlags }));
  } catch (err) {
    // If this fails, leave the .part on disk; the client can retry the chunk
    // with the same uploadId/chunkIndex (we'll just re-append from byte 0 of
    // the chunk, which is fine — the chunk boundary aligns with our file
    // position because each chunk is written atomically end-to-end).
    return NextResponse.json(
      { error: `Chunk write failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 },
    );
  }

  // Intermediate chunk → quick ack.
  if (chunkIndex < totalChunks - 1) {
    return NextResponse.json({ ok: true, chunkIndex });
  }

  // Final chunk: rename .part to the canonical path, probe, update manifest.
  const manifest = (await loadManifest(sessionId)) ?? {
    sessionId,
    createdAt: Date.now(),
    clips: [],
    voiceover: null,
    script: [],
    overridePrompt: "",
  };

  if (kind === "voiceover") {
    const storedName = `voiceover${ext}`;
    const rel = path.join("voiceover", storedName);
    const abs = path.join(sessionBase, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Replace any existing voiceover atomically.
    await fs.rename(partPath, abs);
    // Use the full probe() rather than probeAudioDurationMs() so we also
    // capture the channel count — XMEML's <channelcount> must match the
    // actual file or Premiere refuses to relink. ElevenLabs MP3s are
    // typically mono (1 channel); without this they'd ship as the legacy
    // hardcoded 2 and break.
    let durationMs = 0;
    let channels: number | undefined;
    try {
      const probed = await probe(abs);
      durationMs = probed.durationMs;
      channels = probed.audioChannels;
    } catch {
      /* best effort — leave channels undefined; XML falls back to 2 */
    }
    const stats = await fs.stat(abs);
    manifest.voiceover = {
      filename,
      // Phase 2: canonical NLE-safe name computed once at upload time.
      // Every export path reads this verbatim instead of re-deriving.
      safeName: sanitizeForNleRelink(filename),
      relPath: rel,
      url: mediaUrl(sessionId, rel),
      sizeBytes: stats.size,
      channels,
    };
    await saveManifest(manifest);
    // The voiceover content changed (new file replaced the old one at
    // the same path). Any cached alignment / sections / edit plan /
    // rendered preview is now stale — nuke them so the next pipeline
    // run rebuilds against the new audio.
    await invalidateVoiceoverDownstream(sessionId).catch(() => {});
    return NextResponse.json({ sessionId, voiceover: manifest.voiceover, durationMs });
  }

  // Clip
  const id = nanoid(10);
  const stored = `${id}_${safeName(filename)}`;
  const rel = path.join("sources", stored);
  const abs = path.join(sessionBase, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.rename(partPath, abs);

  const stats = await fs.stat(abs);
  let durationMs = 0;
  let width: number | undefined;
  let height: number | undefined;
  let fps: number | undefined;
  // Default for images and unprobed video files: no audio. Stock video
  // footage frequently has no audio track and Premiere refuses to relink
  // a file claiming audio against a file with no audio stream.
  let hasAudio = false;
  let audioChannels: number | undefined;
  if (clipKind === "video") {
    try {
      const probed = await probe(abs);
      durationMs = probed.durationMs;
      width = probed.width;
      height = probed.height;
      fps = probed.fps;
      hasAudio = probed.hasAudio;
      audioChannels = probed.audioChannels;
    } catch {
      /* best effort */
    }
  }

  const clip: SourceClip = {
    id,
    section: section!,
    kind: clipKind!,
    filename,
    // Phase 2: canonical NLE-safe name computed once at upload time.
    // Every export path (XMEML <name>, ZIP entry, <pathurl> basename)
    // reads this verbatim instead of re-deriving it — so a future code
    // path that bypasses disambiguateNames still gets the safe name.
    safeName: sanitizeForNleRelink(filename),
    relPath: rel,
    url: mediaUrl(sessionId, rel),
    durationMs,
    width,
    height,
    fps,
    sizeBytes: stats.size,
    hasAudio,
    audioChannels,
  };
  manifest.clips.push(clip);
  await saveManifest(manifest);
  // A new clip is a new candidate for the matcher. Any cached edit plan
  // was computed without this clip, so it's stale. Frames/descriptions
  // of OTHER clips remain valid.
  await invalidateClipsDownstream(sessionId).catch(() => {});

  return NextResponse.json({ sessionId, clip });
}
