import { NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DATA_ROOT, sessionDir } from "@/lib/session";
import { nodeStreamToWebStream } from "@/lib/streamHelpers";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".json": "application/json",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  if (!parts || parts.length < 2) {
    return new Response("Bad request", { status: 400 });
  }
  const [sessionId, ...rest] = parts;
  let base: string;
  try {
    base = sessionDir(sessionId);
  } catch {
    return new Response("Invalid session", { status: 400 });
  }
  const decoded = rest.map((seg) => decodeURIComponent(seg));
  const abs = path.resolve(base, ...decoded);
  // Prevent traversal
  if (!abs.startsWith(path.resolve(DATA_ROOT) + path.sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  let stats;
  try {
    stats = await stat(abs);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stats.isFile()) return new Response("Not found", { status: 404 });

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const range = req.headers.get("range");

  if (range && /^bytes=/.test(range)) {
    const [startStr, endStr] = range.replace("bytes=", "").split("-");
    const start = Number(startStr) || 0;
    const end = endStr ? Number(endStr) : stats.size - 1;
    const chunkSize = end - start + 1;
    const stream = createReadStream(abs, { start, end });
    return new Response(nodeStreamToWebStream(stream, req.signal), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": type,
        "Cache-Control": "no-store",
      },
    });
  }

  const stream = createReadStream(abs);
  return new Response(nodeStreamToWebStream(stream, req.signal), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(stats.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
