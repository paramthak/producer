/**
 * Process-level uncaughtException guard.
 *
 * Streaming HTTP responses on Next.js + Node can throw ERR_INVALID_STATE
 * ("Invalid state: Controller is already closed") when a client disconnects
 * mid-response. The throw happens inside Node's internal ReadableStream
 * plumbing — specifically the controller Readable.toWeb wraps around a Node
 * Readable. It's NOT catchable from userland because the throw is from a
 * microtask scheduled by Node's stream internals, not from our await chain.
 *
 * Sources we've seen this fire from:
 *   - /api/job/[id]              SSE; subscriber emits after client abort.
 *                                (Userland code is fixed; this is a backstop.)
 *   - /api/media/[...path]       Range-requested clip previews where the
 *                                browser cancels the request mid-bytes.
 *   - /api/export/mp4            Download stream where the client aborts.
 *
 * Default Next.js production behavior is to exit the process on any
 * uncaughtException — which on Railway means a container restart, which
 * means a cold boot (~10s of full vCPU), which burns compute credits in a
 * loop whenever the frontend reconnects to a stream.
 *
 * This handler swallows ONLY the known-benign ERR_INVALID_STATE class.
 * Anything else is logged loudly and we still don't exit (one buggy request
 * shouldn't kill a single-container deployment serving other work).
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err?.code === "ERR_INVALID_STATE") {
      // Benign: a streaming response's controller was closed before a final
      // enqueue from Node's internals. The HTTP request is already over.
      console.warn("[uncaughtException ignored — controller closed]", err.message);
      return;
    }
    // Unknown uncaught: log loudly but do not exit. Exiting here cascades into
    // container restart on Railway, which is far more expensive than logging.
    console.error("[uncaughtException]", err);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
}
