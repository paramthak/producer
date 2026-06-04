import { NextRequest, NextResponse } from "next/server";
import { loadManifest, saveManifest } from "@/lib/manifest";
import type { ScriptLine } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  const m = await loadManifest(sessionId);
  return NextResponse.json({ manifest: m });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    sessionId: string;
    script?: ScriptLine[];
    overridePrompt?: string;
  };
  const m = await loadManifest(body.sessionId);
  if (!m) return NextResponse.json({ error: "Unknown session" }, { status: 404 });
  if (body.script !== undefined) m.script = body.script;
  if (body.overridePrompt !== undefined) m.overridePrompt = body.overridePrompt;
  await saveManifest(m);
  return NextResponse.json({ manifest: m });
}
