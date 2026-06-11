import archiver from "archiver";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { buildXmeml } from "@/lib/xmeml";
import type { EditPlan, SourceClip } from "@/lib/types";
import type { SessionManifest } from "@/lib/manifest";

/**
 * Map clipId → display name we'll use in BOTH the XML and the ZIP entries.
 *
 * Starts from each clip's original `filename` (what the user uploaded as,
 * stored in the manifest), then disambiguates collisions by appending
 * ` (2)`, ` (3)`, etc. Case-insensitive collision check because most user
 * filesystems are case-insensitive.
 *
 * This is the single source of truth for clip naming consumed by Premiere
 * et al. — the XML's <name>/<pathurl> basenames match the actual filenames
 * inside the ZIP, so opening the XML from the unzipped folder auto-links
 * every clip with zero relink prompts.
 */
export function disambiguateNames(clips: SourceClip[]): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<string>();
  for (const c of clips) {
    let name = c.filename;
    if (used.has(name.toLowerCase())) {
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      let n = 2;
      while (used.has(`${base} (${n})${ext}`.toLowerCase())) n++;
      name = `${base} (${n})${ext}`;
    }
    used.add(name.toLowerCase());
    result[c.id] = name;
  }
  return result;
}

export interface BundleOpts {
  sessionShort: string;
  projectName: string;
  manifest: SessionManifest;
  plan: EditPlan;
  /** Absolute path on the local filesystem to each clip's source file. */
  clipAbsPath: Record<string, string>;
  voiceoverAbsPath: string;
  voiceoverDurationMs: number;
  /**
   * Optional absolute path to the rendered preview MP4. If present, it's
   * included at the root of the ZIP as `preview.mp4` so the user can play
   * the final cut locally without re-rendering.
   */
  previewMp4AbsPath?: string;
}

/**
 * Build a Node Readable stream that emits a ZIP containing:
 *   - producer-<sessionShort>.xml     (XMEML with disambiguated original
 *                                      filenames in <name>; pathurl points
 *                                      at the server path but Premiere
 *                                      relinks by name to files in the
 *                                      same folder as the XML)
 *   - <originalFilename>              (each source clip, with collision
 *                                      suffixes applied)
 *   - <voiceoverOriginalFilename>     (the voiceover audio)
 *   - preview.mp4                     (optional — the rendered preview)
 *
 * The user unzips → opens the .xml → Premiere finds every file. Zero
 * relink prompts.
 */
export function buildBundleZip(opts: BundleOpts): Readable {
  const {
    sessionShort,
    projectName,
    manifest,
    plan,
    clipAbsPath,
    voiceoverAbsPath,
    voiceoverDurationMs,
    previewMp4AbsPath,
  } = opts;

  const archive = archiver("zip", { zlib: { level: 1 } }); // fast compression — clips are already compressed

  // Disambiguated names: clipId → cleanedName (matches what's in the ZIP).
  const clipNames = disambiguateNames(manifest.clips);
  const voiceoverName = manifest.voiceover?.filename ?? "voiceover.mp3";

  // The XML inside the ZIP references files by basename — Premiere falls
  // back to name-matching when the absolute pathurl doesn't resolve.
  // Putting clipName as the <name>/<pathurl> basename guarantees a clean
  // relink against files sitting next to the XML.
  const xml = buildXmeml({
    projectName,
    plan,
    clips: Object.fromEntries(manifest.clips.map((c) => [c.id, c])),
    clipAbsPath,
    voiceoverAbsPath,
    voiceoverDurationMs,
    voiceoverChannels: manifest.voiceover?.channels,
    clipNames,
    voiceoverName,
  });

  archive.append(xml, { name: `producer-${sessionShort}.xml` });

  // Voiceover at root with original filename.
  archive.append(createReadStream(voiceoverAbsPath), { name: voiceoverName });

  // Each clip at root with its disambiguated original filename.
  for (const clip of manifest.clips) {
    const abs = clipAbsPath[clip.id];
    if (!abs) continue;
    const cleanName = clipNames[clip.id] ?? clip.filename;
    archive.append(createReadStream(abs), { name: cleanName });
  }

  // Rendered preview MP4 if available.
  if (previewMp4AbsPath) {
    archive.append(createReadStream(previewMp4AbsPath), { name: "preview.mp4" });
  }

  archive.finalize().catch(() => {
    /* finalize errors propagate through the stream */
  });

  return archive as unknown as Readable;
}
