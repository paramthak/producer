import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { buildFcpxml } from "@/lib/fcpxml";
import type { EditPlan, WordTimestamp } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string };
  if (!body.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const m = await loadManifest(body.sessionId);
  const p = paths(body.sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  const alignment = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
  if (!m || !plan || !alignment || !m.voiceover) {
    return NextResponse.json({ error: "Edit plan not ready" }, { status: 400 });
  }

  const clipsById = Object.fromEntries(m.clips.map((c) => [c.id, c]));
  const clipAbs = Object.fromEntries(m.clips.map((c) => [c.id, path.join(p.base, c.relPath)]));

  const xml = buildFcpxml({
    projectName: `Producer-${body.sessionId.slice(0, 6)}`,
    plan,
    clips: clipsById,
    clipAbsPath: clipAbs,
    voiceoverAbsPath: path.join(p.base, m.voiceover.relPath),
    voiceoverFilename: m.voiceover.filename,
    voiceoverDurationMs: alignment.durationMs,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/xml",
      "content-disposition": `attachment; filename="producer-${body.sessionId.slice(0, 6)}.fcpxml"`,
      "cache-control": "no-store",
    },
  });
}
