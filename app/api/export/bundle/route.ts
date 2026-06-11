import { NextRequest, NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import path from "node:path";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { buildBundleZip } from "@/lib/zipBundle";
import { nodeStreamToWebStream } from "@/lib/streamHelpers";
import type { EditPlan, WordTimestamp } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Download a self-contained project bundle: ZIP containing the XMEML, all
 * source clips with original filenames (collision-disambiguated), the
 * voiceover audio, and the rendered preview MP4 if one exists.
 *
 * The user unzips, opens the .xml from inside the folder, and Premiere /
 * Resolve / Avid find every clip by name in the same folder — zero relink
 * prompts.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string };
  if (!body.sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const m = await loadManifest(body.sessionId);
  const p = paths(body.sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  const alignment = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
  if (!m || !plan || !alignment || !m.voiceover) {
    return NextResponse.json({ error: "Edit plan not ready" }, { status: 400 });
  }

  const clipAbsPath = Object.fromEntries(
    m.clips.map((c) => [c.id, path.join(p.base, c.relPath)]),
  );

  // Include the rendered preview MP4 if it's been rendered for this session.
  let previewMp4AbsPath: string | undefined;
  if (m.preview) {
    const previewPath = path.join(p.output, m.preview.filename);
    try {
      await stat(previewPath);
      previewMp4AbsPath = previewPath;
    } catch {
      /* preview file missing on disk despite manifest entry — skip */
    }
  }

  const sessionShort = body.sessionId.slice(0, 6);
  const zipStream = buildBundleZip({
    sessionShort,
    projectName: `Producer-${sessionShort}`,
    manifest: m,
    plan,
    clipAbsPath,
    voiceoverAbsPath: path.join(p.base, m.voiceover.relPath),
    voiceoverDurationMs: alignment.durationMs,
    previewMp4AbsPath,
  });

  return new Response(nodeStreamToWebStream(zipStream, req.signal), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="producer-${sessionShort}.zip"`,
      "cache-control": "no-store",
    },
  });
}
