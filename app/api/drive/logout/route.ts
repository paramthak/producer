import { NextResponse } from "next/server";
import { disconnect } from "@/lib/googleDrive";

export const runtime = "nodejs";

/** Disconnect Drive only (revoke + clear token) — used to switch accounts. */
export async function POST() {
  await disconnect();
  return NextResponse.json({ ok: true });
}
