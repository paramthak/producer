import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT, ensureSession, sessionDir } from "@/lib/session";
import { saveManifest, loadManifest } from "@/lib/manifest";

export const runtime = "nodejs";

export async function POST() {
  const sessionId = await ensureSession();

  // Single-user product: any session folder that isn't the one we just created
  // is an orphan from a closed tab or crashed run. Nuke them so the disk stays
  // bounded to a single live session at any time.
  try {
    const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && e.name !== sessionId)
        .map((e) => fs.rm(path.join(DATA_ROOT, e.name), { recursive: true, force: true })),
    );
  } catch {
    /* DATA_ROOT may not exist yet on a fresh deploy — ensureSession will create it. */
  }

  const existing = await loadManifest(sessionId);
  if (!existing) {
    // New manifests start with no costs field; UI treats absent as $0.00.
    // Cost is per-session by design — flushing happens implicitly when a
    // brand-new sessionId mints a brand-new manifest.
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
