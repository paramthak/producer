import archiver from "archiver";
import { readFile, stat } from "node:fs/promises";
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
    let name = sanitizeForNleRelink(c.filename);
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

/**
 * Strip filename characters that break Premiere's XMEML name-relink.
 *
 * The failure mode this fixes: a clip whose original filename contains a
 * non-ASCII General Punctuation character (e.g. the horizontal ellipsis
 * `…` at U+2026, smart quotes, em-dash) makes Premiere silently fail the
 * ENTIRE XMEML import — not just that one clip. ZIP filename encoding +
 * macOS Finder's unzip + Premiere's name-relink form a fragile chain;
 * one byte-mismatch anywhere and the whole import goes blank with no
 * error dialog.
 *
 * Plain emoji (regional indicators, faces) round-trip cleanly in our
 * testing, so we keep those. The rule below: NFC-normalize, then keep
 * only letters/digits and a small whitelist of safe punctuation. Any
 * other codepoint becomes `_`. Symmetric — the same sanitized name is
 * used in the ZIP entry, the XMEML `<name>`, and the XMEML `<pathurl>`
 * basename, so byte mismatch is impossible.
 *
 * Trailing/leading underscores from a run of replacements are collapsed
 * so we don't ship "Dublin_____202606081535.mp4" looking glitchy.
 */
function sanitizeForNleRelink(filename: string): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  const normalized = base.normalize("NFC");
  const cleaned = normalized
    // Keep letters/digits in any script (including emoji), spaces, and a
    // small whitelist of punctuation that XMEML + macOS + Premiere all
    // round-trip cleanly.
    .replace(/[^\p{L}\p{N}\p{Emoji} ._\-(),&]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  const cleanedExt = ext.normalize("NFC").replace(/[^\p{L}\p{N}.]/gu, "");
  return (cleaned || "clip") + cleanedExt;
}

/**
 * Predict the EXACT byte size of the ZIP in store mode given a list of
 * entries. All entries are buffer-appended (no streams) which means
 * archiver writes a complete local header with sizes upfront — NO data
 * descriptor — so Premiere/Resolve/FCP parsers don't get confused by
 * the unusual stored+DD combination.
 *
 * ZIP store-mode layout per entry:
 *   - Local file header        30 bytes + filename
 *   - File data                exact uncompressed size
 *   - Central directory entry  46 bytes + filename
 * Plus once at end:
 *   - End of central directory record  22 bytes
 */
export function predictStoreZipSize(
  entries: Array<{ name: string; size: number }>,
): number {
  let total = 0;
  for (const e of entries) {
    const nameLen = Buffer.byteLength(e.name, "utf8");
    total += 30 + nameLen; // local file header
    total += e.size; // data
    total += 46 + nameLen; // central directory entry
  }
  total += 22; // end of central directory record
  return total;
}

/**
 * Same as predictStoreZipSize but takes a BundleOpts directly. Returns
 * null if any file referenced in the bundle is missing on disk (we
 * can't predict in that case — better to ship without Content-Length
 * than ship a wrong one and confuse the browser).
 */
export async function predictBundleSize(opts: BundleOpts): Promise<number | null> {
  const clipNames = disambiguateNames(opts.manifest.clips);
  const voiceoverName = opts.manifest.voiceover?.filename ?? "voiceover.mp3";
  const entries: Array<{ name: string; size: number }> = [];

  // All entries are buffer-appended (see buildBundleZip), so all entries
  // are DD-free in the ZIP — that's why predictStoreZipSize doesn't add
  // any 16-byte data-descriptor allowance per entry anymore.
  const xml = buildXmeml({
    projectName: opts.projectName,
    plan: opts.plan,
    clips: Object.fromEntries(opts.manifest.clips.map((c) => [c.id, c])),
    clipAbsPath: opts.clipAbsPath,
    voiceoverAbsPath: opts.voiceoverAbsPath,
    voiceoverDurationMs: opts.voiceoverDurationMs,
    voiceoverChannels: opts.manifest.voiceover?.channels,
    clipNames,
    voiceoverName,
  });
  entries.push({
    name: `producer-${opts.sessionShort}.xml`,
    size: Buffer.byteLength(xml, "utf8"),
  });

  try {
    const voStat = await stat(opts.voiceoverAbsPath);
    entries.push({ name: voiceoverName, size: voStat.size });
  } catch {
    return null;
  }

  for (const clip of opts.manifest.clips) {
    const abs = opts.clipAbsPath[clip.id];
    if (!abs) continue;
    try {
      const s = await stat(abs);
      entries.push({ name: clipNames[clip.id] ?? clip.filename, size: s.size });
    } catch {
      return null;
    }
  }

  if (opts.previewMp4AbsPath) {
    try {
      const s = await stat(opts.previewMp4AbsPath);
      entries.push({ name: "preview.mp4", size: s.size });
    } catch {
      // Preview missing is fine — we just won't include it in the count.
    }
  }

  return predictStoreZipSize(entries);
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
 *   - producer-<sessionShort>.xml     (XMEML)
 *   - <originalFilename>              (each source clip)
 *   - <voiceoverOriginalFilename>     (the voiceover audio)
 *   - preview.mp4                     (optional — the rendered preview)
 *
 * Why buffer-append (and not createReadStream): archiver's _appendStream
 * unconditionally sets the data-descriptor flag on every entry. With
 * the deflated (compressed) method, that's normal — and Premiere reads
 * it fine. But with the stored (no-compression) method we use, the
 * resulting "stored + data descriptor" combination is uncommon and
 * Premiere's XMEML import silently fails on the ZIP. Buffer-append
 * goes through _appendBuffer which writes a complete local header with
 * sizes upfront — NO data descriptor — and Premiere reads it cleanly.
 *
 * Memory cost: peak ~sum-of-source-clip-bytes while building (each
 * Buffer is held until archiver consumes it). For our ~70MB bundles
 * that's negligible. Switching to a different archive lib that supports
 * stored+streaming-without-DD is the only way to get both at once;
 * the trade-off isn't worth it.
 */
export async function buildBundleZip(opts: BundleOpts): Promise<Readable> {
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

  // Store mode (no compression). Bundle contents are 95%+ already-
  // compressed media — zlib was spinning CPU on them for ~0% size
  // benefit. See block comment above for why buffer-append matters.
  const archive = archiver("zip", { store: true });

  // Wire fatal errors through the stream so the client's download loop
  // sees a truncated body instead of a silent partial ZIP.
  archive.on("error", (err) => {
    console.error("[zipBundle] archiver fatal:", err);
    (archive as unknown as { destroy?: (e?: Error) => void }).destroy?.(err);
  });
  archive.on("warning", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn("[zipBundle] missing file (skipping):", err.message);
    } else {
      console.warn("[zipBundle] archiver warning:", err);
    }
  });

  const clipNames = disambiguateNames(manifest.clips);
  const voiceoverName = manifest.voiceover?.filename ?? "voiceover.mp3";

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

  // XML is already a buffer — straightforward append.
  archive.append(Buffer.from(xml, "utf8"), { name: `producer-${sessionShort}.xml` });

  // Read each file fully into memory, then append as Buffer. This is the
  // critical change from the previous createReadStream path — it forces
  // archiver onto its _appendBuffer code path which doesn't emit a data
  // descriptor on stored-mode entries (the cause of the Premiere
  // silent-import bug).
  const voBuf = await readFile(voiceoverAbsPath);
  archive.append(voBuf, { name: voiceoverName });

  for (const clip of manifest.clips) {
    const abs = clipAbsPath[clip.id];
    if (!abs) continue;
    const cleanName = clipNames[clip.id] ?? clip.filename;
    const buf = await readFile(abs);
    archive.append(buf, { name: cleanName });
  }

  if (previewMp4AbsPath) {
    try {
      const buf = await readFile(previewMp4AbsPath);
      archive.append(buf, { name: "preview.mp4" });
    } catch {
      // Preview missing — skip silently. The XMEML doesn't reference
      // preview.mp4 so the bundle is still valid without it.
    }
  }

  archive.finalize().catch(() => {
    /* finalize errors propagate through the stream */
  });

  return archive as unknown as Readable;
}
