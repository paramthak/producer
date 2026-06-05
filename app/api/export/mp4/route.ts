import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { renderFinalMp4, type RenderSegment } from "@/lib/ffmpeg";
import { nodeStreamToWebStream } from "@/lib/streamHelpers";
import type { EditPlan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string };
  if (!body.sessionId) return new Response(JSON.stringify({ error: "Missing sessionId" }), { status: 400 });

  const m = await loadManifest(body.sessionId);
  const p = paths(body.sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  if (!m || !plan || !m.voiceover) {
    return new Response(JSON.stringify({ error: "Edit plan not ready" }), { status: 400 });
  }

  const clipsById = Object.fromEntries(m.clips.map((c) => [c.id, c]));

  const segments: RenderSegment[] = plan.segments
    .map((seg) => {
      const clip = clipsById[seg.clipId];
      if (!clip) return null;
      const dur = (seg.timelineEndMs - seg.timelineStartMs) / 1000;
      if (dur <= 0) return null;
      return {
        inputPath: path.join(p.base, clip.relPath),
        isImage: clip.kind === "image",
        startSec: clip.kind === "image" ? 0 : seg.sourceInMs / 1000,
        durationSec: dur,
      };
    })
    .filter((x): x is RenderSegment => !!x);

  if (!segments.length) return new Response(JSON.stringify({ error: "No segments to render" }), { status: 400 });

  const outPath = path.join(p.output, `producer-${body.sessionId.slice(0, 6)}.mp4`);
  await renderFinalMp4({
    segments,
    voiceoverPath: path.join(p.base, m.voiceover.relPath),
    outPath,
  });

  const stats = await stat(outPath);
  const stream = createReadStream(outPath);
  return new Response(nodeStreamToWebStream(stream, req.signal), {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(stats.size),
      "content-disposition": `attachment; filename="producer-${body.sessionId.slice(0, 6)}.mp4"`,
      "cache-control": "no-store",
    },
  });
}
