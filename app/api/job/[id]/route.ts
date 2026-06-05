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
  //
  // Be defensive: the subscriber callback can fire microseconds after the
  // client disconnects, by which time controller.enqueue() throws
  // ERR_INVALID_STATE on a closed controller. That throw is uncatchable from
  // the EventEmitter call site and surfaces as an uncaughtException, which
  // can crash-loop the container. Track a `closed` flag, wrap every enqueue
  // in try/catch, and ensure unsubscribe runs exactly once.
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsub: (() => void) | null = null;

      const teardown = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        if (unsub) {
          unsub();
          unsub = null;
        }
      };

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Client went away mid-emit — tear down cleanly instead of throwing.
          teardown();
        }
      };

      const initial = jobStore.get(id);
      if (!initial) {
        send({ error: "Unknown job" });
        teardown();
        return;
      }
      send(initial);

      unsub = jobStore.subscribe(id, (job) => {
        send(job);
        if (job.status === "complete" || job.status === "failed" || job.status === "stopped") {
          // Give the client a tick to read final state before closing.
          setTimeout(teardown, 80);
        }
      });

      req.signal.addEventListener("abort", teardown);
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
