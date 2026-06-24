import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { loadOrInitSubtitleState } from "@/lib/subtitlesStore";
import { renderSubtitledMp4 } from "@/lib/subtitleRender";
import { hashPlan } from "@/lib/planHash";
import { nodeStreamToWebStream } from "@/lib/streamHelpers";
import type { EditPlan } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Cache passthrough.
 *
 * The pipeline's render phase (and the /api/render endpoint) writes a
 * preview MP4 named preview-<planHash>.mp4 and stores the metadata on
 * manifest.preview. This route just streams that file — no rendering
 * happens here anymore.
 *
 * If the cached planHash doesn't match the current edit plan's hash, the
 * cached MP4 is stale (user edited the plan since the last render). We
 * return 409 with structured error so the frontend can prompt the user
 * to click "Re-render preview" before downloading.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string; subtitles?: boolean };
  if (!body.sessionId) {
    return new Response(JSON.stringify({ error: "Missing sessionId" }), { status: 400 });
  }

  const m = await loadManifest(body.sessionId);
  const p = paths(body.sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  if (!m || !plan) {
    return new Response(JSON.stringify({ error: "Edit plan not ready" }), { status: 400 });
  }

  if (!m.preview) {
    return new Response(
      JSON.stringify({
        error: "Preview not rendered yet. Click Re-render in the editor first.",
        stale: true,
        cachedHash: null,
        currentHash: hashPlan(plan),
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  const currentHash = hashPlan(plan);
  if (m.preview.planHash !== currentHash) {
    return new Response(
      JSON.stringify({
        error: "Preview is stale (plan changed since last render). Click Re-render in the editor.",
        stale: true,
        cachedHash: m.preview.planHash,
        currentHash,
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  const outPath = path.join(p.output, m.preview.filename);
  let stats;
  try {
    stats = await stat(outPath);
  } catch {
    return new Response(
      JSON.stringify({
        error: "Cached preview file missing. Click Re-render in the editor.",
        stale: true,
        cachedHash: m.preview.planHash,
        currentHash,
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }

  // Default: stream the bare preview (subtitles live on a separate layer).
  let fileToStream = outPath;
  let fileSize = stats.size;

  // "Download MP4 with subtitles" → burn the captions onto the preview.
  if (body.subtitles) {
    const subState = await loadOrInitSubtitleState(body.sessionId);
    const alignment = await readJson<{ words: unknown[]; durationMs: number }>(p.alignment);
    if (!subState?.captions?.length) {
      return new Response(
        JSON.stringify({ error: "No subtitles to burn in. Generate the reel first." }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    try {
      const burned = await renderSubtitledMp4({
        previewPath: outPath,
        planHash: m.preview.planHash,
        state: subState,
        totalMs: alignment?.durationMs ?? plan.totalDurationMs,
        outputDir: p.output,
        signal: req.signal,
      });
      fileToStream = burned.absPath;
      fileSize = (await stat(burned.absPath)).size;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Subtitle render failed";
      return new Response(JSON.stringify({ error: `Could not burn subtitles: ${msg}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  const suffix = body.subtitles ? "-subtitled" : "";
  const stream = createReadStream(fileToStream);
  return new Response(nodeStreamToWebStream(stream, req.signal), {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(fileSize),
      "content-disposition": `attachment; filename="producer-${body.sessionId.slice(0, 6)}${suffix}.mp4"`,
      "cache-control": "no-store",
    },
  });
}
