import { NextResponse } from "next/server";
import { ensureSession } from "@/lib/session";
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
