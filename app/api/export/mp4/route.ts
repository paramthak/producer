import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { paths, readJson } from "@/lib/session";
import { renderReelMp4 } from "@/lib/render";
import { loadSubtitleState } from "@/lib/subtitlesStore";
import { renderSubtitledMp4, renderGreenScreenSubs } from "@/lib/subtitleRender";
import { nodeStreamToWebStream } from "@/lib/streamHelpers";
import type { EditPlan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 600;

type Mode = "clean" | "burned" | "greenscreen";

/**
 * Render-on-demand MP4 export. One file per request:
 *   - clean       → the reel MP4 (voiceover only, no captions)
 *   - burned      → the reel with captions burned in
 *   - greenscreen → the captions on a chroma-green background (sidecar)
 *
 * The "clean + separate green-screen file" download fires TWO requests
 * (clean, then greenscreen) client-side — no zip. The render is cached by
 * plan/subtitle hash, so the shared reel render is computed once.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId?: string; mode?: Mode; subtitles?: boolean };
  const sessionId = body.sessionId;
  // Back-compat: a bare `subtitles:true` maps to burned, else clean.
  const mode: Mode = body.mode ?? (body.subtitles ? "burned" : "clean");
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "Missing sessionId" }), { status: 400 });
  }

  const p = paths(sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  if (!plan) {
    return new Response(JSON.stringify({ error: "Edit plan not ready" }), { status: 400 });
  }

  const err = (msg: string, status = 500) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { "content-type": "application/json" } });

  let fileToStream: string;
  let suffix = "";
  try {
    if (mode === "greenscreen") {
      const subState = await loadSubtitleState(sessionId);
      const alignment = await readJson<{ durationMs: number }>(p.alignment);
      if (!subState?.captions?.length) return err("No subtitles to export. Generate subtitles first.", 400);
      const gs = await renderGreenScreenSubs({
        state: subState,
        totalMs: alignment?.durationMs ?? plan.totalDurationMs,
        outputDir: p.output,
        signal: req.signal,
      });
      fileToStream = gs.absPath;
      suffix = "-subtitles-greenscreen";
    } else {
      const reel = await renderReelMp4({ sessionId, plan, signal: req.signal });
      if (mode === "burned") {
        const subState = await loadSubtitleState(sessionId);
        const alignment = await readJson<{ durationMs: number }>(p.alignment);
        if (!subState?.captions?.length) return err("No subtitles to burn in. Generate subtitles first.", 400);
        const burned = await renderSubtitledMp4({
          previewPath: reel.absPath,
          planHash: reel.planHash,
          state: subState,
          totalMs: alignment?.durationMs ?? plan.totalDurationMs,
          outputDir: p.output,
          signal: req.signal,
        });
        fileToStream = burned.absPath;
        suffix = "-subtitled";
      } else {
        fileToStream = reel.absPath;
      }
    }
  } catch (e) {
    return err(`Render failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const fileSize = (await stat(fileToStream)).size;
  const stream = createReadStream(fileToStream);
  return new Response(nodeStreamToWebStream(stream, req.signal), {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(fileSize),
      "content-disposition": `attachment; filename="producer-${sessionId.slice(0, 6)}${suffix}.mp4"`,
      "cache-control": "no-store",
    },
  });
}
