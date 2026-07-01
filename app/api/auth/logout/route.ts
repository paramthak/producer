import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth";
import { disconnect } from "@/lib/googleDrive";

export const runtime = "nodejs";

/** Full logout: clear the Producer session AND disconnect Google Drive. */
export async function POST() {
  await disconnect().catch(() => {});
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
