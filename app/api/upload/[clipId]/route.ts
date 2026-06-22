import { NextRequest, NextResponse } from "next/server";
import { removeSource } from "@/lib/manifest";
import { invalidateClipsDownstream } from "@/lib/cacheInvalidate";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  await removeSource(sessionId, clipId);
  // The deleted clip may have been referenced in the current edit plan
  // (and therefore in the rendered preview). Invalidate so the next
  // pipeline run rematches without the gone clip.
  await invalidateClipsDownstream(sessionId).catch(() => {});
  return NextResponse.json({ ok: true });
}
