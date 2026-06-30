import { NextRequest, NextResponse } from "next/server";
import { paths, readJson } from "@/lib/session";
import { loadManifest } from "@/lib/manifest";
import { loadSubtitleState } from "@/lib/subtitlesStore";
import type { EditPlan, SectionWindow, WordTimestamp } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  const p = paths(sessionId);
  const manifest = await loadManifest(sessionId);
  const plan = await readJson<EditPlan>(p.editPlan);
  const sections = await readJson<{ windows: SectionWindow[]; totalDurationMs: number }>(p.sections);
  const alignment = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
  if (!manifest || !plan || !sections || !alignment) {
    return NextResponse.json({ error: "Editor data not ready" }, { status: 404 });
  }
  // Subtitles are ON-DEMAND: only returned if already generated (the user
  // clicked "Generate subtitles"). Null otherwise so the editor stays
  // caption-free while they play with the timeline.
  const subtitles = await loadSubtitleState(sessionId);
  return NextResponse.json({ manifest, plan, sections, alignment, subtitles });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { sessionId: string; plan: EditPlan };
  if (!body.sessionId || !body.plan) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { writeJson } = await import("@/lib/session");
  await writeJson(paths(body.sessionId).editPlan, body.plan);
  return NextResponse.json({ ok: true });
}
