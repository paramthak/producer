import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, AUTH_COOKIE_VALUE } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public paths bypass.
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const authed = req.cookies.get(AUTH_COOKIE)?.value === AUTH_COOKIE_VALUE;
  if (authed) return NextResponse.next();

  // For API requests, return 401 JSON.
  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // For pages, redirect to /login with a return path.
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except static assets + favicon.
  matcher: ["/((?!_next/|favicon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)"],
};
