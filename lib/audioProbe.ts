import path from "node:path";
import { paths } from "@/lib/session";
import { probe } from "@/lib/ffmpeg";
import { loadManifest, saveManifest, type SessionManifest } from "@/lib/manifest";

/**
 * One-shot back-fill of `hasAudio` for video clips in a session manifest
 * that were uploaded before we started capturing audio-stream presence.
 *
 * Runs ffprobe on each video clip that's missing `hasAudio`, mutates the
 * manifest in place, and persists. Idempotent — if all clips already have
 * the field, this is a no-op and returns the input manifest unchanged.
 *
 * Why a backfill rather than re-uploading: a session can have GBs of
 * source clips already on disk. Re-uploading is hostile UX for existing
 * users. Probing each file is fast (sub-second on local NVMe) and only
 * runs once per session — the result is persisted on the manifest.
 *
 * Called by the XML and ZIP-bundle export routes before they build the
 * XMEML, so the generated <file> elements declare track presence honestly
 * (otherwise Premiere's relink-by-name rejects video-only stock footage
 * with "Cannot Link Media — type does not match").
 */
export async function ensureClipsHaveAudioInfo(
  sessionId: string,
  manifest: SessionManifest,
): Promise<SessionManifest> {
  const needsProbe = manifest.clips.filter(
    (c) => c.kind === "video" && c.hasAudio === undefined,
  );
  if (needsProbe.length === 0) return manifest;

  const sessionBase = paths(sessionId).base;
  await Promise.all(
    needsProbe.map(async (clip) => {
      const abs = path.join(sessionBase, clip.relPath);
      try {
        const result = await probe(abs);
        clip.hasAudio = result.hasAudio;
      } catch {
        // Probe failed — assume video-only. Premiere will accept a
        // false-negative declaration (XML says no audio, file has audio)
        // gracefully; the reverse is the bug we're fixing.
        clip.hasAudio = false;
      }
    }),
  );

  // Images always have hasAudio = false. Backfill them too while we're here.
  for (const clip of manifest.clips) {
    if (clip.kind === "image" && clip.hasAudio === undefined) {
      clip.hasAudio = false;
    }
  }

  await saveManifest(manifest);
  return manifest;
}

/** Convenience: load + backfill in one call. */
export async function loadManifestWithAudioInfo(
  sessionId: string,
): Promise<SessionManifest | null> {
  const m = await loadManifest(sessionId);
  if (!m) return null;
  return ensureClipsHaveAudioInfo(sessionId, m);
}
