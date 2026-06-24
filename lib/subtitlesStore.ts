/**
 * Server-side persistence for a session's subtitle state (subtitles.json).
 *
 * The pipeline's caption phase writes this file. These helpers read it back,
 * persist editor edits, and — for sessions generated before subtitles
 * existed — lazily initialize a sensible default from the alignment words so
 * the editor and exports always have something to work with.
 */

import { paths, readJson, writeJson } from "@/lib/session";
import { chunkCaptions, defaultSubtitleStyle } from "@/lib/subtitles";
import type { SubtitleState, WordTimestamp } from "@/lib/types";

export async function loadSubtitleState(sessionId: string): Promise<SubtitleState | null> {
  return readJson<SubtitleState>(paths(sessionId).subtitles);
}

export async function saveSubtitleState(sessionId: string, state: SubtitleState): Promise<void> {
  await writeJson(paths(sessionId).subtitles, state);
}

/**
 * Return the saved subtitle state, or build a default one from the alignment
 * words (no LLM emphasis — just chunked captions + the default preset) and
 * persist it. Returns null only when there's no alignment to derive from.
 */
export async function loadOrInitSubtitleState(sessionId: string): Promise<SubtitleState | null> {
  const existing = await loadSubtitleState(sessionId);
  if (existing?.captions?.length) return existing;

  const p = paths(sessionId);
  const alignment = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
  if (!alignment?.words?.length) return existing ?? null;

  const state: SubtitleState = {
    style: defaultSubtitleStyle(),
    captions: chunkCaptions(alignment.words),
  };
  await saveSubtitleState(sessionId, state);
  return state;
}
