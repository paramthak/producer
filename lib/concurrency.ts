/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry with exponential backoff for HTTP 429 / transient errors.
 * Throws the last error if all attempts fail.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; maxMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const retries = opts.retries ?? 5;
  const baseMs = opts.baseMs ?? 800;
  const maxMs = opts.maxMs ?? 16000;
  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1)) * (0.6 + Math.random() * 0.8);
      await sleep(delay);
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate.?limit|quota|temporarily|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|503|502|504/i.test(msg)) return true;
  const status = (err as { status?: number; statusCode?: number; code?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { code?: number }).code;
  if (typeof status === "number" && (status === 429 || (status >= 500 && status < 600))) return true;
  return false;
}
