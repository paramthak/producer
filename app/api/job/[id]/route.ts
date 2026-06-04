import { NextRequest } from "next/server";
import { jobStore } from "@/lib/jobStore";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const accept = req.headers.get("accept") ?? "";
  // Default: JSON snapshot.
  if (!accept.includes("text/event-stream")) {
    const job = jobStore.get(id);
    if (!job) return new Response(JSON.stringify({ error: "Unknown job" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(job), { headers: { "content-type": "application/json" } });
  }

  // SSE stream.
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      const initial = jobStore.get(id);
      if (!initial) {
        send({ error: "Unknown job" });
        controller.close();
        return;
      }
      send(initial);
      const unsub = jobStore.subscribe(id, (job) => {
        send(job);
        if (job.status === "complete" || job.status === "failed" || job.status === "stopped") {
          // Give the client a tick to read final state.
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              /* ignore */
            }
            unsub();
          }, 80);
        }
      });
      req.signal.addEventListener("abort", () => {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        unsub();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
