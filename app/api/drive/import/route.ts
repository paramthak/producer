import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { paths, mediaUrl, ensureSession } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { probe } from "@/lib/ffmpeg";
import { queueClipProxy } from "@/lib/proxy";
import { invalidateClipsDownstream } from "@/lib/cacheInvalidate";
import { driveFileMeta, driveDownloadToFile } from "@/lib/googleDrive";
import { SECTIONS, type SectionId, type SourceClip } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 600;

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

/** Import one Drive file into a session's section — same as a native upload. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId?: string; section?: string; fileId?: string };
  const { sessionId, section, fileId } = body;
  if (!sessionId || !fileId || !section || !SECTIONS.includes(section as SectionId)) {
    return NextResponse.json({ error: "Missing/invalid sessionId, section, or fileId" }, { status: 400 });
  }

  let meta;
  try {
    meta = await driveFileMeta(fileId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "NOT_CONNECTED") return NextResponse.json({ error: "Not connected", connected: false }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  const kind: "video" | "image" = meta.isImage ? "image" : "video";
  if (!meta.isVideo && !meta.isImage) {
    return NextResponse.json({ error: "Only video or image files can be imported." }, { status: 400 });
  }

  await ensureSession(sessionId);
  const id = nanoid(10);
  const rel = path.join("sources", `${id}_${safeName(meta.name)}`);
  const p = paths(sessionId);
  const abs = path.join(p.base, rel);

  try {
    await driveDownloadToFile(fileId, abs, req.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "NOT_CONNECTED") return NextResponse.json({ error: "Not connected", connected: false }, { status: 401 });
    return NextResponse.json({ error: `Drive download failed: ${msg}` }, { status: 500 });
  }

  const stats = await fs.stat(abs);
  let durationMs = 0, width: number | undefined, height: number | undefined, fps: number | undefined;
  let hasAudio = false, audioChannels: number | undefined;
  if (kind === "video") {
    try {
      const pr = await probe(abs);
      durationMs = pr.durationMs; width = pr.width; height = pr.height; fps = pr.fps;
      hasAudio = pr.hasAudio; audioChannels = pr.audioChannels;
    } catch { /* best effort */ }
  }

  const manifest = await loadManifest(sessionId);
  if (!manifest) return NextResponse.json({ error: "Unknown session" }, { status: 404 });

  const clip: SourceClip = {
    id,
    section: section as SectionId,
    kind,
    filename: meta.name,
    relPath: rel,
    url: mediaUrl(sessionId, rel),
    durationMs,
    width,
    height,
    fps,
    sizeBytes: stats.size,
    hasAudio,
    audioChannels,
    proxyReady: kind === "image",
    posterRelPath: kind === "image" ? rel : undefined,
  };
  manifest.clips.push(clip);
  await saveManifest(manifest);
  await invalidateClipsDownstream(sessionId).catch(() => {});
  if (kind === "video") queueClipProxy(sessionId, id);

  return NextResponse.json({ clip });
}
