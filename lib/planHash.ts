import type { EditPlan } from "@/lib/types";

/**
 * Stable hash of an EditPlan.
 *
 * Used to cache-bust the rendered preview MP4: the same plan always hashes
 * to the same string; any edit (resize, reorder, swap clip, change trim,
 * etc.) produces a different hash, marking the cached render stale.
 *
 * Implementation is intentionally hand-rolled (no crypto / no SubtleCrypto)
 * so the same function runs server-side (Node) and client-side (browser).
 * Hash collisions are practically irrelevant for our use case — we're
 * comparing two values that came from the same codebase, not defending
 * against adversaries.
 */
export function hashPlan(plan: EditPlan): string {
  const canonical = canonicalize(plan);
  return fnv1a64(canonical).toString(36);
}

/** Order segments and stringify the fields that matter for rendering. */
function canonicalize(plan: EditPlan): string {
  const parts: string[] = [];
  parts.push(`total:${plan.totalDurationMs}`);
  const sorted = [...plan.segments].sort((a, b) => {
    if (a.timelineStartMs !== b.timelineStartMs) return a.timelineStartMs - b.timelineStartMs;
    return a.id < b.id ? -1 : 1;
  });
  for (const s of sorted) {
    parts.push(
      [
        s.section,
        s.clipId,
        s.sourceInMs,
        s.sourceOutMs,
        s.timelineStartMs,
        s.timelineEndMs,
        s.hold ? "h" : "n",
      ].join("|"),
    );
  }
  return parts.join("\n");
}

/** FNV-1a 64-bit hash, returned as a positive bigint. */
function fnv1a64(s: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}
