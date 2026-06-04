import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { jobStore } from "@/lib/jobStore";
import { runPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId?: string; overridePrompt?: string };
  if (!body.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  const jobId = `job_${nanoid(10)}`;
  jobStore.create(jobId, body.sessionId, body.overridePrompt);

  // Fire-and-forget. Errors are reported via the job stream.
  void runPipeline({
    jobId,
    sessionId: body.sessionId,
    overridePrompt: body.overridePrompt,
  }).catch((err) => {
    // Already reported via jobStore.fail in pipeline; this is a defensive backstop.
    console.error("[pipeline]", err);
  });

  return NextResponse.json({ jobId });
}
