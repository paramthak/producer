import type { Readable } from "node:stream";

/**
 * Convert a Node Readable into a Web ReadableStream with bulletproof
 * lifecycle management.
 *
 * Why not Node's built-in `Readable.toWeb()`?
 * It has a documented race condition: when the HTTP client disconnects,
 * the Web ReadableStream's controller gets closed (by Next.js / the
 * Response runtime), but Node's internal Readable can still emit one
 * more chunk in flight. That emission calls `controller.enqueue()` on
 * the closed controller, which throws `ERR_INVALID_STATE`. The throw
 * is from a microtask Node schedules — uncatchable from userland —
 * and in production Next.js exits the process on any uncaughtException,
 * causing container restarts. We saw this fire on every <video> Range
 * request and every MP4 export.
 *
 * This implementation manually wires the Node→Web bridge so we own the
 * lifecycle:
 *   - Track a `closed` flag so we never enqueue after close.
 *   - Listen for `data` / `end` / `error` from the Node side.
 *   - Listen for client `abort` from the Request side.
 *   - Wrap every controller call in try/catch as a final belt.
 *   - Destroy the Node stream on cancel to avoid file-descriptor leaks.
 *
 * Pass the request's AbortSignal so the file stream is torn down the
 * instant the browser cancels (which it does constantly during video
 * scrubbing).
 */
export function nodeStreamToWebStream(
  nodeStream: Readable,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          nodeStream.destroy();
        } catch {
          /* already destroyed */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const fail = (err: unknown) => {
        if (closed) return;
        closed = true;
        try {
          nodeStream.destroy();
        } catch {
          /* ignore */
        }
        try {
          controller.error(err);
        } catch {
          /* already closed/errored */
        }
      };

      nodeStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch {
          // Controller went away mid-emit (client gone). Tear down quietly.
          close();
        }
      });

      nodeStream.on("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      nodeStream.on("error", fail);

      if (signal) {
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
      }
    },
    cancel() {
      // Reader cancelled (e.g. client disconnect propagated through Next.js).
      try {
        nodeStream.destroy();
      } catch {
        /* ignore */
      }
    },
  });
}
