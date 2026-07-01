import { NextResponse } from "next/server";
import { getAuthUrl, isConfigured } from "@/lib/googleDrive";

export const runtime = "nodejs";

/** Kick off the OAuth consent flow (opened in a popup by the Drive browser). */
export async function GET() {
  if (!isConfigured()) {
    return new NextResponse(
      "<h3>Google Drive is not configured</h3><p>Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI.</p>",
      { status: 500, headers: { "content-type": "text/html" } },
    );
  }
  return NextResponse.redirect(getAuthUrl());
}
