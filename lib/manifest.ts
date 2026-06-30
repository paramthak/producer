import { promises as fs } from "node:fs";
import path from "node:path";
import { paths, readJson, writeJson } from "@/lib/session";
import type { SessionCosts } from "@/lib/costs";
import type { SourceClip, ScriptLine } from "@/lib/types";

export interface SessionManifest {
  sessionId: string;
  createdAt: number;
  clips: SourceClip[];
  voiceover: {
    /** Original filename as uploaded — kept verbatim for UI display. */
    filename: string;
    relPath: string;
    url: string;
    sizeBytes: number;
    /** Channel count of the voiceover audio (1 = mono, 2 = stereo, ...). */
    channels?: number;
  } | null;
  script: ScriptLine[];
  overridePrompt: string;
  /**
   * Cumulative API spend this session (Gemini + ElevenLabs). Updated as
   * each phase completes. Reset on new-session creation. Undefined for
   * brand-new manifests; UI treats undefined as zero.
   */
  costs?: SessionCosts;
}

export async function loadManifest(sessionId: string): Promise<SessionManifest | null> {
  return readJson<SessionManifest>(paths(sessionId).manifest);
}

export async function saveManifest(m: SessionManifest): Promise<void> {
  await writeJson(paths(m.sessionId).manifest, m);
}

export async function removeSource(sessionId: string, clipId: string): Promise<void> {
  const m = await loadManifest(sessionId);
  if (!m) return;
  const target = m.clips.find((c) => c.id === clipId);
  if (!target) return;
  const base = paths(sessionId).base;
  // Source + any generated proxy/poster. (For images posterRelPath === relPath,
  // so dedupe to avoid a redundant unlink.)
  const rels = new Set<string>([target.relPath]);
  if (target.proxyRelPath) rels.add(target.proxyRelPath);
  if (target.posterRelPath) rels.add(target.posterRelPath);
  for (const rel of rels) {
    try {
      await fs.unlink(path.join(base, rel));
    } catch {
      /* ignore */
    }
  }
  m.clips = m.clips.filter((c) => c.id !== clipId);
  await saveManifest(m);
}
