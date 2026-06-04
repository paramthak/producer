import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  jobStore.abort(id);
  return NextResponse.json({ ok: true });
}
