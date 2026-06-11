import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { paths, readJson } from "@/lib/session";
import { loadManifestWithAudioInfo } from "@/lib/audioProbe";
import { buildXmeml } from "@/lib/xmeml";
import { disambiguateNames } from "@/lib/zipBundle";
import type { EditPlan, WordTimestamp } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Export the edit as FCP7 XML (XMEML version 5).
 *
 * Why this format?
 *   Universal NLE interchange — Premiere Pro, DaVinci Resolve, Avid,
 *   Final Cut Pro, Smoke/Flame all import .xml natively with full
 *   fidelity (clip references, source in/out per instance, timeline
 *   positions, audio). Far more reliable than FCPXML in non-FCP tools.
 *
 * Why <pathurl> is absolute local?
 *   This tool runs locally (localhost only). The XML embeds absolute
 *   paths into .producer-data/ on this Mac, so when the user opens the
 *   .xml in Premiere, the source clips are already linked. No relink
 *   dialog, no "media offline" prompts.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string };
  if (!body.sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  // loadManifestWithAudioInfo back-fills clip.hasAudio for any clips that
  // were uploaded before we started capturing audio-stream presence —
  // critical for Premiere's relink-by-name not to fail with "type does
  // not match" on video-only stock footage.
  const m = await loadManifestWithAudioInfo(body.sessionId);
  const p = paths(body.sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  const alignment = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
  if (!m || !plan || !alignment || !m.voiceover) {
    return NextResponse.json({ error: "Edit plan not ready" }, { status: 400 });
  }

  const clipsById = Object.fromEntries(m.clips.map((c) => [c.id, c]));
  const clipAbs = Object.fromEntries(m.clips.map((c) => [c.id, path.join(p.base, c.relPath)]));
  // Use the same name disambiguation as the ZIP bundle so the standalone
  // XML's <name> and <pathurl> basenames match what the user would have
  // on disk if they re-downloaded the bundle. Premiere relinks by name.
  const clipNames = disambiguateNames(m.clips);

  const xml = buildXmeml({
    projectName: `Producer-${body.sessionId.slice(0, 6)}`,
    plan,
    clips: clipsById,
    clipAbsPath: clipAbs,
    voiceoverAbsPath: path.join(p.base, m.voiceover.relPath),
    voiceoverDurationMs: alignment.durationMs,
    voiceoverChannels: m.voiceover.channels,
    clipNames,
    voiceoverName: m.voiceover.filename,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/xml",
      "content-disposition": `attachment; filename="producer-${body.sessionId.slice(0, 6)}.xml"`,
      "cache-control": "no-store",
    },
  });
}
