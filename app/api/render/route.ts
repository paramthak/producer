import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { jobStore } from "@/lib/jobStore";
import { runRenderOnly } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Re-render the preview MP4 for an existing session whose edit plan has
 * been changed in the editor (so the cached `manifest.preview.planHash`
 * no longer matches `hashPlan(currentPlan)`).
 *
 * Returns a jobId; the client subscribes to /api/job/[id] for SSE progress
 * the same way it does for the main pipeline. On completion, the new
 * preview filename + planHash are written to the manifest, and the editor
 * refetches to reload the Preview with the new MP4.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId?: string };
  if (!body.sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const jobId = `job_${nanoid(10)}`;
  jobStore.create(jobId, body.sessionId);

  // Fire-and-forget. Errors are reported via the job stream.
  void runRenderOnly({ jobId, sessionId: body.sessionId }).catch((err) => {
    console.error("[render]", err);
  });

  return NextResponse.json({ jobId });
}
