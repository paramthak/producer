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
  // Run on everything except:
  //  - _next/ and static assets (don't need auth)
  //  - /api/upload — the Edge runtime that middleware runs in buffers the entire
  //    request body and caps it at 10 MiB. Even when middleware returns
  //    NextResponse.next() without reading the body, Edge still applies that cap.
  //    Excluding the path entirely routes large uploads straight to the Node
  //    runtime handler. Auth is done inline in app/api/upload/route.ts.
  matcher: [
    "/((?!_next/|favicon|api/upload|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf)$).*)",
  ],
};
