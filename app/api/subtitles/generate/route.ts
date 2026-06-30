import { NextRequest, NextResponse } from "next/server";
import { paths, readJson } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { loadSubtitleState, saveSubtitleState } from "@/lib/subtitlesStore";
import { chunkCaptions, defaultSubtitleStyle } from "@/lib/subtitles";
import { highlightWords } from "@/lib/gemini/highlightWords";
import { addCaptionCost, emptyCosts } from "@/lib/costs";
import type { SubtitleState, WordTimestamp } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Generate subtitles on demand from the cached forced-alignment. Chunks the
 * words into VEED-style caption groups and (best-effort) flags punchy words
 * via a cheap Gemini call. Idempotent — returns the existing state if already
 * generated. This is what the editor's "Generate subtitles" button calls.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { sessionId?: string };
  const sessionId = body.sessionId;
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });

  const existing = await loadSubtitleState(sessionId);
  if (existing?.captions?.length) return NextResponse.json({ subtitles: existing });

  const p = paths(sessionId);
  const alignment = await readJson<{ words: WordTimestamp[]; durationMs: number }>(p.alignment);
  if (!alignment?.words?.length) {
    return NextResponse.json({ error: "No aligned voiceover to caption yet." }, { status: 400 });
  }

  let captions = chunkCaptions(alignment.words);
  try {
    const hl = await highlightWords(captions, req.signal);
    captions = hl.captions;
    const m = await loadManifest(sessionId);
    if (m) {
      const costs = m.costs ?? emptyCosts();
      addCaptionCost(costs, hl.usage.inputTokens, hl.usage.outputTokens);
      m.costs = costs;
      await saveManifest(m);
    }
  } catch (e) {
    // Emphasis is a nicety — ship un-emphasized captions if Gemini errors.
    console.warn("[subtitles/generate] highlight failed; shipping plain captions:", e);
  }

  const state: SubtitleState = { style: defaultSubtitleStyle(), captions };
  await saveSubtitleState(sessionId, state);
  return NextResponse.json({ subtitles: state });
}
