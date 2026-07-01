import { NextRequest, NextResponse } from "next/server";
import { driveList } from "@/lib/googleDrive";

export const runtime = "nodejs";

/** List Drive folders + video/image files for the browser. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const folderId = sp.get("folderId") ?? undefined;
  const recent = sp.get("recent") === "1";
  const search = sp.get("search") ?? undefined;
  try {
    const { files } = await driveList({ folderId, recent, search });
    return NextResponse.json({ files });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "NOT_CONNECTED") {
      return NextResponse.json({ error: "Not connected", connected: false }, { status: 401 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
