import { promises as fs } from "node:fs";
import path from "node:path";
import { paths, readJson, writeJson } from "@/lib/session";
import type { SourceClip, ScriptLine } from "@/lib/types";

export interface SessionManifest {
  sessionId: string;
  createdAt: number;
  clips: SourceClip[];
  voiceover: { filename: string; relPath: string; url: string; sizeBytes: number } | null;
  script: ScriptLine[];
  overridePrompt: string;
  /**
   * The most recently rendered preview MP4 for this session, if any.
   * `planHash` is computed by hashPlan() at render time; the frontend
   * compares it to the current EditPlan's hash to know whether the
   * render is stale (user edited the plan since render).
   */
  preview?: {
    filename: string;
    planHash: string;
    renderedAt: number;
  };
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
  const abs = path.join(paths(sessionId).base, target.relPath);
  try {
    await fs.unlink(abs);
  } catch {
    /* ignore */
  }
  m.clips = m.clips.filter((c) => c.id !== clipId);
  await saveManifest(m);
}
