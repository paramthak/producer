import { NextRequest, NextResponse } from "next/server";
import { removeSource } from "@/lib/manifest";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await ctx.params;
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  await removeSource(sessionId, clipId);
  return NextResponse.json({ ok: true });
}
