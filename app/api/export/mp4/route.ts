import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { hashPlan } from "@/lib/planHash";
import { nodeStreamToWebStream } from "@/lib/streamHelpers";
import type { EditPlan } from "@/lib/types";

export const runtime = "nodejs";

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
  const body = (await req.json()) as { sessionId: string };
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
