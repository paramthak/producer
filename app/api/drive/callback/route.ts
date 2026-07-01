import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/googleDrive";

export const runtime = "nodejs";

/**
 * OAuth redirect target. Exchanges the code for tokens, then returns a tiny
 * page that notifies the opener (the Drive browser popup) and closes — or
 * falls back to redirecting home if opened as a full page.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  const page = (ok: boolean, msg: string) =>
    new NextResponse(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#FAF6EE;color:#1A1612;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
  <p style="font-size:15px">${msg}</p>
  <p style="font-size:12px;color:#6B5B4E">You can close this window.</p>
</div>
<script>
  try { if (window.opener) window.opener.postMessage({ type: "producer-drive", ok: ${ok} }, "*"); } catch (e) {}
  setTimeout(function(){ if (window.opener) window.close(); else location.replace("/"); }, ${ok ? 400 : 2500});
</script>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );

  if (error) return page(false, `Google sign-in was cancelled (${error}).`);
  if (!code) return page(false, "Missing authorization code.");
  try {
    await exchangeCode(code);
    return page(true, "Google Drive connected ✓");
  } catch (e) {
    return page(false, `Could not connect Drive: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}
