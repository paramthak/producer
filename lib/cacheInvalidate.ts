import { promises as fs } from "node:fs";
import path from "node:path";
import { paths } from "@/lib/session";

/**
 * Cache invalidation for the per-session derived data on disk.
 *
 * The pipeline caches forced-alignment results, section windows, the
 * edit plan, and the rendered preview MP4. Each of those caches has
 * upstream INPUTS that, when mutated, render the cache stale:
 *
 *   alignment.json   ← depends on the voiceover audio file content
 *   sections.json    ← depends on alignment.json AND the tagged script
 *   edit-plan.json   ← depends on sections.json AND clips AND match output
 *   output/*.mp4     ← rendered reels, keyed by plan hash
 *
 * Without these helpers, the pipeline would happily reuse stale cached
 * data when an input changed — the user would replace their voiceover,
 * click Generate, and see the OLD voiceover's word timings applied to
 * the new audio (drift everywhere).
 */

/**
 * Voiceover was replaced (or trimmed) — every downstream cache is stale.
 * Use case: POST /api/upload?kind=voiceover, and the pipeline's own
 * post-trim invalidation.
 */
export async function invalidateVoiceoverDownstream(sessionId: string): Promise<void> {
  const p = paths(sessionId);
  await rmIfExists(p.alignment);
  await rmIfExists(p.sections);
  await rmIfExists(p.editPlan);
  // Captions are derived from the alignment word timings — new audio means
  // new words, so the cached captions (and any rendered subtitle videos) are
  // stale.
  await rmIfExists(p.subtitles);
  await deletePreviewMp4s(p.output);
}

/**
 * Script changed (lines added, removed, retagged). Alignment is purely
 * about the audio so it stays valid; sections + downstream become stale.
 * Use case: PATCH /api/manifest with a `script` field.
 */
export async function invalidateScriptDownstream(sessionId: string): Promise<void> {
  const p = paths(sessionId);
  await rmIfExists(p.sections);
  await rmIfExists(p.editPlan);
  // Script text drives caption chunking — retagging/editing lines re-chunks.
  await rmIfExists(p.subtitles);
  await deletePreviewMp4s(p.output);
}

/**
 * A clip was added or deleted. Edit plan may have referenced the deleted
 * clip (or now have a better candidate that wasn't available before), so
 * the plan + preview are stale. Frames/descriptions for OTHER clips stay
 * valid. The deleted clip's own frames/descriptions are handled by the
 * existing removeSource flow in lib/manifest.ts.
 */
export async function invalidateClipsDownstream(sessionId: string): Promise<void> {
  const p = paths(sessionId);
  await rmIfExists(p.editPlan);
  await deletePreviewMp4s(p.output);
}

async function rmIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch {
    /* ignore */
  }
}

async function deletePreviewMp4s(outputDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      // .mov = cached transparent subtitle-overlay intermediates.
      .filter((n) => n.endsWith(".mp4") || n.endsWith(".mov"))
      .map((n) => fs.rm(path.join(outputDir, n), { force: true })),
  );
}
