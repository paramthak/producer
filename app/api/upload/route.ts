import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { ensureSession, paths, mediaUrl } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { probe, probeAudioDurationMs } from "@/lib/ffmpeg";
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

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const sessionId = await ensureSession((form.get("sessionId") as string) || undefined);
  const kind = (form.get("kind") as string) ?? "clip";
  const section = (form.get("section") as string | null) as SectionId | null;
  const file = form.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const ext = extOf(file.name);
  const manifest = (await loadManifest(sessionId)) ?? {
    sessionId,
    createdAt: Date.now(),
    clips: [],
    voiceover: null,
    script: [],
    overridePrompt: "",
  };

  const bytes = Buffer.from(await file.arrayBuffer());

  if (kind === "voiceover") {
    if (!(AUDIO_EXTS as readonly string[]).includes(ext)) {
      return NextResponse.json(
        { error: "Upload an audio file (.mp3, .wav, or .m4a)." },
        { status: 400 },
      );
    }
    const filename = `voiceover${ext}`;
    const rel = path.join("voiceover", filename);
    const abs = path.join(paths(sessionId).base, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    let durationMs = 0;
    try {
      durationMs = await probeAudioDurationMs(abs);
    } catch {
      /* probe is best-effort */
    }
    manifest.voiceover = {
      filename: file.name,
      relPath: rel,
      url: mediaUrl(sessionId, rel),
      sizeBytes: bytes.length,
    };
    await saveManifest(manifest);
    return NextResponse.json({
      sessionId,
      voiceover: manifest.voiceover,
      durationMs,
    });
  }

  // Clip upload
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
  const stored = `${id}_${safeName(file.name)}`;
  const rel = path.join("sources", stored);
  const abs = path.join(paths(sessionId).base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);

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
    filename: file.name,
    relPath: rel,
    url: mediaUrl(sessionId, rel),
    durationMs,
    width,
    height,
    fps,
    sizeBytes: bytes.length,
  };
  manifest.clips.push(clip);
  await saveManifest(manifest);

  return NextResponse.json({ sessionId, clip });
}
