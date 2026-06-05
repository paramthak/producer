import { NextRequest, NextResponse } from "next/server";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { ensureSession, paths, mediaUrl } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { probe, probeAudioDurationMs } from "@/lib/ffmpeg";
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

/**
 * Streaming upload endpoint.
 *
 * Why not req.formData()?  Next.js's built-in FormData parser fails on files
 * above ~10 MiB with "expected boundary after body" — it buffers the whole
 * body and the multipart parser desyncs on large bodies. We stream the raw
 * request body straight to disk instead. Metadata travels in query params so
 * there's no multipart parsing at all.
 *
 * middleware.ts excludes /api/upload from its matcher (so the Edge runtime's
 * 10 MiB body cap doesn't apply), which means we must do the auth check
 * inline here.
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

  if (!filename) {
    return NextResponse.json({ error: "Missing filename" }, { status: 400 });
  }
  if (!req.body) {
    return NextResponse.json({ error: "Missing body" }, { status: 400 });
  }

  const sessionId = await ensureSession(sessionIdParam);
  const ext = extOf(filename);
  const manifest = (await loadManifest(sessionId)) ?? {
    sessionId,
    createdAt: Date.now(),
    clips: [],
    voiceover: null,
    script: [],
    overridePrompt: "",
  };

  if (kind === "voiceover") {
    if (!(AUDIO_EXTS as readonly string[]).includes(ext)) {
      return NextResponse.json(
        { error: "Upload an audio file (.mp3, .wav, or .m4a)." },
        { status: 400 },
      );
    }
    const storedName = `voiceover${ext}`;
    const rel = path.join("voiceover", storedName);
    const abs = path.join(paths(sessionId).base, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await streamToFile(req.body, abs);
    let durationMs = 0;
    try {
      durationMs = await probeAudioDurationMs(abs);
    } catch {
      /* probe is best-effort */
    }
    const stats = await fs.stat(abs);
    manifest.voiceover = {
      filename,
      relPath: rel,
      url: mediaUrl(sessionId, rel),
      sizeBytes: stats.size,
    };
    await saveManifest(manifest);
    return NextResponse.json({
      sessionId,
      voiceover: manifest.voiceover,
      durationMs,
    });
  }

  // Clip
  if (!section || !SECTIONS.includes(section)) {
    return NextResponse.json({ error: "Missing or invalid section" }, { status: 400 });
  }
  let clipKind: ClipKind | null = null;
  if ((VIDEO_EXTS as readonly string[]).includes(ext)) clipKind = "video";
  else if ((IMAGE_EXTS as readonly string[]).includes(ext)) clipKind = "image";
  if (!clipKind) {
    return NextResponse.json(
      { error: "Only .mp4, .mov, .png, .jpg are supported." },
      { status: 400 },
    );
  }

  const id = nanoid(10);
  const stored = `${id}_${safeName(filename)}`;
  const rel = path.join("sources", stored);
  const abs = path.join(paths(sessionId).base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await streamToFile(req.body, abs);

  const stats = await fs.stat(abs);
  let durationMs = 0;
  let width: number | undefined;
  let height: number | undefined;
  let fps: number | undefined;
  if (clipKind === "video") {
    try {
      const probed = await probe(abs);
      durationMs = probed.durationMs;
      width = probed.width;
      height = probed.height;
      fps = probed.fps;
    } catch {
      /* probe is best-effort */
    }
  }

  const clip: SourceClip = {
    id,
    section,
    kind: clipKind,
    filename,
    relPath: rel,
    url: mediaUrl(sessionId, rel),
    durationMs,
    width,
    height,
    fps,
    sizeBytes: stats.size,
  };
  manifest.clips.push(clip);
  await saveManifest(manifest);

  return NextResponse.json({ sessionId, clip });
}

async function streamToFile(body: ReadableStream<Uint8Array>, abs: string): Promise<void> {
  // Web ReadableStream → Node Readable → pipe to disk.
  // Streams chunk-by-chunk; never holds the full file in memory.
  const nodeStream = Readable.fromWeb(body as unknown as import("stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(abs));
}
