import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { ensureSession, sessionDir } from "@/lib/session";
import { saveManifest, loadManifest } from "@/lib/manifest";

export const runtime = "nodejs";

export async function POST() {
  const sessionId = await ensureSession();
  const existing = await loadManifest(sessionId);
  if (!existing) {
    await saveManifest({
      sessionId,
      createdAt: Date.now(),
      clips: [],
      voiceover: null,
      script: [],
      overridePrompt: "",
    });
  }
  return NextResponse.json({ sessionId });
}

export async function DELETE(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  let dir: string;
  try {
    dir = sessionDir(sessionId);
  } catch {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return NextResponse.json({ ok: true });
}
