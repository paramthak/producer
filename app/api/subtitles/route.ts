import { NextRequest, NextResponse } from "next/server";
import { loadOrInitSubtitleState, saveSubtitleState } from "@/lib/subtitlesStore";
import type { SubtitleState } from "@/lib/types";

export const runtime = "nodejs";

/** Read the session's subtitle state (lazily initialized for old sessions). */
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  const subtitles = await loadOrInitSubtitleState(sessionId);
  if (!subtitles) return NextResponse.json({ error: "Subtitles not ready" }, { status: 404 });
  return NextResponse.json({ subtitles });
}

/** Persist editor edits (style + per-word emphasis). Debounced by the client. */
export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { sessionId?: string; subtitles?: SubtitleState };
  if (!body.sessionId || !body.subtitles || !Array.isArray(body.subtitles.captions)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  await saveSubtitleState(body.sessionId, body.subtitles);
  return NextResponse.json({ ok: true });
}
