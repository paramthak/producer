import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, AUTH_COOKIE_VALUE, AUTH_MAX_AGE, credsMatch } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";

  // Tiny constant-ish delay so guessing is at least not free.
  await new Promise((r) => setTimeout(r, 350));

  if (!credsMatch({ username, password })) {
    return NextResponse.json({ error: "Wrong username or password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, AUTH_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}
