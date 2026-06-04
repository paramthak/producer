import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { jobStore } from "@/lib/jobStore";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { jobStore as _store } from "@/lib/jobStore";
import { runPipeline } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string; overridePrompt?: string };
  if (!body.sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  // Sanity: the cached frame descriptions + alignment should exist.
  const p = paths(body.sessionId);
  const alignment = await readJson(p.alignment);
  if (!alignment) return NextResponse.json({ error: "No cached alignment — full run required." }, { status: 400 });

  // If override prompt was supplied, persist it to manifest so future re-runs see it.
  if (typeof body.overridePrompt === "string") {
    const m = await loadManifest(body.sessionId);
    if (m) {
      m.overridePrompt = body.overridePrompt;
      const { saveManifest } = await import("@/lib/manifest");
      await saveManifest(m);
    }
  }

  const jobId = `job_${nanoid(10)}`;
  jobStore.create(jobId, body.sessionId, body.overridePrompt);
  void runPipeline({ jobId, sessionId: body.sessionId, overridePrompt: body.overridePrompt }).catch(() => {});
  return NextResponse.json({ jobId });
}
