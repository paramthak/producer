import { NextRequest, NextResponse } from "next/server";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { invalidateScriptDownstream } from "@/lib/cacheInvalidate";
import type { ScriptLine } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  const m = await loadManifest(sessionId);
  return NextResponse.json({ manifest: m });
}

/**
 * Helper: deep-compare two ScriptLine arrays by their meaningful content
 * (text + section). Used to decide whether a PATCH actually changed the
 * script and therefore invalidates section/edit-plan/preview caches.
 * Override-prompt changes alone do NOT invalidate — they're only
 * consumed at next match-phase invocation.
 */
function scriptChanged(prev: ScriptLine[] | undefined, next: ScriptLine[]): boolean {
  if (!prev || prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].text !== next[i].text || prev[i].section !== next[i].section) {
      return true;
    }
  }
  return false;
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    sessionId: string;
    script?: ScriptLine[];
    overridePrompt?: string;
  };
  const m = await loadManifest(body.sessionId);
  if (!m) return NextResponse.json({ error: "Unknown session" }, { status: 404 });
  let needScriptInvalidate = false;
  if (body.script !== undefined) {
    if (scriptChanged(m.script, body.script)) needScriptInvalidate = true;
    m.script = body.script;
  }
  if (body.overridePrompt !== undefined) m.overridePrompt = body.overridePrompt;
  await saveManifest(m);
  // Script content changed → section windows and downstream caches are
  // stale (the section→line tagging drives section windows; line text
  // changes change what the matcher needs to match). Alignment stays
  // valid because it depends only on the audio file.
  if (needScriptInvalidate) {
    await invalidateScriptDownstream(body.sessionId).catch(() => {});
  }
  return NextResponse.json({ manifest: m });
}
