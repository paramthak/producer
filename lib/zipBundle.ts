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
    // Phase 2: prefer the canonical safeName stored on the manifest at
    // upload time. Fall back to sanitizing the original filename on the
    // fly for legacy manifests written before this field existed.
    let name = c.safeName ?? sanitizeForNleRelink(c.filename);
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
 * Applies symmetrically to the ZIP entry, the XMEML `<name>`, and the
 * XMEML `<pathurl>` basename — same sanitized string in all three places,
 * so byte-mismatch on relink is impossible.
 *
 * Failure modes this defends against (each observed in real downloads):
 *
 *   1. Non-ASCII General Punctuation (`…`, `"`, `"`, `—`, `–`) — Premiere
 *      silently aborts the ENTIRE import, no error dialog.
 *   2. Mid-name dots from URL-derived filenames (`pindown.io_x.mp4`,
 *      `instagram.com_p_x.mp4`) — NLEs interpret `.io` / `.com` as the
 *      extension and fail to find the media file. Same silent-import
 *      result.
 *   3. Filesystem-reserved chars (`:`, `\`, `/`, `|`, `?`, `*`, `<`, `>`,
 *      `"`) — break ZIP extraction on Windows, mangle on macOS.
 *   4. Zero-width / bidi control chars — invisible breakage of byte-match.
 *   5. Leading `.` (hidden file on Unix), leading `-` (mistaken as CLI
 *      flag by tooling), leading/trailing whitespace.
 *   6. Windows reserved basenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 *   7. Total length over ~200 bytes (some tooling chokes; ZIP central
 *      directory tolerates 64K but downstream chains often don't).
 *
 * What we PRESERVE: letters/digits in any script, plain emoji (regional
 * indicators, faces), spaces, and the safe-punctuation whitelist
 * `_ - ( ) , &`. These all round-trip cleanly in our testing across
 * archiver → macOS Finder → Premiere name-relink.
 */
export function sanitizeForNleRelink(filename: string): string {
  const ext = path.extname(filename);
  let base = ext ? filename.slice(0, -ext.length) : filename;
  let cleanedExt = ext;

  // NFC: collapse decomposed combining marks back into precomposed
  // characters so byte-match isn't broken by visually-identical strings.
  base = base.normalize("NFC");
  cleanedExt = cleanedExt.normalize("NFC");

  // Strip zero-width and bidi controls — invisible in any editor, lethal
  // for byte-match relink. Range covers ZWSP/ZWNJ/ZWJ/LRM/RLM/PDF/LRE/
  // RLE/PDF/LRO/RLO/word-joiner/invisible-{times,separator,plus} + BOM.
  const stripInvisibles = (s: string) =>
    // eslint-disable-next-line no-misleading-character-class
    s.replace(/[​-‏‪-‮⁠-⁤﻿]/g, "");
  base = stripInvisibles(base);
  cleanedExt = stripInvisibles(cleanedExt);

  // Basename whitelist. NOTE — `.` is intentionally NOT here. Any dot
  // inside the basename (e.g. `pindown.io_x`) gets folded to `_` so
  // there is exactly one dot in the final filename: the one that
  // introduces the extension.
  base = base.replace(/[^\p{L}\p{N}\p{Emoji} _\-(),&]+/gu, "_");

  // Collapse runs of separators introduced by the substitution above.
  base = base.replace(/_+/g, "_").replace(/  +/g, " ");

  // Trim leading/trailing separators incl. leading `.` (Unix hidden) and
  // leading `-` (mistaken as a CLI flag by ffmpeg/zip/etc).
  base = base.replace(/^[-._\s]+|[-._\s]+$/g, "");

  // Extension: alphanumeric only, including the leading dot. Falls back
  // to empty if extension was nothing but punctuation.
  cleanedExt = cleanedExt.replace(/[^\p{L}\p{N}.]/gu, "");
  if (cleanedExt === ".") cleanedExt = "";

  // Windows reserved basenames — adding `clip_` prefix keeps the original
  // base visible while making it safe to extract on any OS.
  if (WINDOWS_RESERVED.has(base.toLowerCase())) base = `clip_${base}`;

  if (!base) base = "clip";

  // Cap the byte length so ZIP/manifest/downstream tooling doesn't trip
  // on edge cases. Truncate the basename; append a short stable hash
  // suffix so two long-and-similar names don't collide after the chop.
  const totalBytes = Buffer.byteLength(base + cleanedExt, "utf8");
  if (totalBytes > MAX_NAME_BYTES) {
    const suffix = `_${fnv1aHex(filename)}`;
    const headroom = MAX_NAME_BYTES - Buffer.byteLength(suffix + cleanedExt, "utf8");
    while (Buffer.byteLength(base, "utf8") > headroom && base.length > 0) {
      base = base.slice(0, -1);
    }
    base = base.replace(/[-._\s]+$/g, "") + suffix;
  }

  return base + cleanedExt;
}

/** ~200 byte ceiling on the final ZIP entry / XMEML `<name>` filename. */
const MAX_NAME_BYTES = 200;

/** Windows reserved device names — illegal as a *basename* on NTFS. */
const WINDOWS_RESERVED = new Set<string>([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Short stable suffix for collision-resistant filename truncation. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 5).padStart(5, "0");
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
  // Phase 2: prefer the manifest's canonical safeName when present, fall
  // back to sanitizing the original filename for legacy manifests.
  const voiceoverName =
    opts.manifest.voiceover?.safeName ??
    sanitizeForNleRelink(opts.manifest.voiceover?.filename ?? "voiceover.mp3");
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
    // Gated off — see EMIT_SUBTITLE_OVERLAY_IN_XMEML. subtitles.mp4 still
    // lands in the ZIP via the explicit append below buildBundleZip; we
    // just stop referencing it on a stacked overlay track that Premiere
    // can't parse.
    subtitleVideo:
      EMIT_SUBTITLE_OVERLAY_IN_XMEML && opts.subtitleVideoAbsPath
        ? { name: SUBTITLE_ZIP_NAME, absPath: opts.subtitleVideoAbsPath, durationMs: opts.voiceoverDurationMs }
        : undefined,
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
      // disambiguateNames produces an entry for every clip.id, so the
      // fallback chain below only fires if a future code path adds a
      // clip outside that loop. Prefer the manifest-stored safeName
      // before falling back to the raw filename.
      entries.push({
        name: clipNames[clip.id] ?? clip.safeName ?? clip.filename,
        size: s.size,
      });
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

  if (opts.subtitleVideoAbsPath) {
    try {
      const s = await stat(opts.subtitleVideoAbsPath);
      entries.push({ name: SUBTITLE_ZIP_NAME, size: s.size });
    } catch {
      return null; // can't predict exactly if we promised subs but file is gone
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
  /**
   * Optional absolute path to the rendered green-screen subtitles MP4. If
   * present it's added to the ZIP as `subtitles.mp4` AND referenced by the
   * XMEML on a top video track. Subtitles are never burned into the clips.
   */
  subtitleVideoAbsPath?: string;
}

/** Fixed ZIP/XML basename for the green-screen subtitle video. */
const SUBTITLE_ZIP_NAME = "subtitles.mp4";

/**
 * Whether to reference subtitles.mp4 as a stacked overlay track (V2) inside
 * the XMEML's `<video>` element.
 *
 * Currently FALSE. The XMEML emitted with a stacked overlay track triggers
 * Premiere Pro 2024–2026's documented silent-import-fail: progress bar
 * flashes, project goes blank, no error dialog. The overlay clipitem is
 * structurally valid per Apple's FCP7 XMEML v5 DTD — Premiere's parser
 * simply doesn't degrade gracefully when it dislikes anything about an
 * overlay track. DaVinci Resolve and Avid import the same XMEML cleanly;
 * it's Premiere-specific. See context.md §17 / the recent failing
 * mkgj8u.xml session for the smoking gun (every filename was correct;
 * only the overlay track was different from a previously-working XMEML).
 *
 * What this constant controls:
 *   - true  → emit a second `<track>` referencing subtitles.mp4 (V2 in
 *             Premiere). Today this breaks Premiere import.
 *   - false → don't reference subtitles.mp4 in the XMEML at all. The
 *             file still ships in the ZIP, so the user opens the
 *             unzipped folder and drags subtitles.mp4 onto V2 manually.
 *             One drag; Premiere import never breaks.
 *
 * Flip back to true if/when Adobe ships a Premiere build with a robust
 * XMEML overlay-track parser. Until then, manual drag is strictly better
 * than silent-fail.
 */
const EMIT_SUBTITLE_OVERLAY_IN_XMEML = false;

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
    subtitleVideoAbsPath,
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
  // Phase 2: prefer the manifest's canonical safeName when present, fall
  // back to sanitizing the original filename for legacy manifests.
  const voiceoverName =
    manifest.voiceover?.safeName ??
    sanitizeForNleRelink(manifest.voiceover?.filename ?? "voiceover.mp3");

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
    // Gated off — see EMIT_SUBTITLE_OVERLAY_IN_XMEML. subtitles.mp4 still
    // ships in the ZIP via the explicit append below; we just stop
    // referencing it as a stacked overlay track that Premiere can't parse.
    subtitleVideo:
      EMIT_SUBTITLE_OVERLAY_IN_XMEML && subtitleVideoAbsPath
        ? { name: SUBTITLE_ZIP_NAME, absPath: subtitleVideoAbsPath, durationMs: voiceoverDurationMs }
        : undefined,
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
    // Same fallback chain as in predictBundleSize: prefer disambiguated
    // (collision-aware) name, then the upload-time canonical safeName,
    // then raw filename as a last resort.
    const cleanName = clipNames[clip.id] ?? clip.safeName ?? clip.filename;
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

  if (subtitleVideoAbsPath) {
    // The XMEML references subtitles.mp4 by this exact name on its top track,
    // so it must be present for Premiere's relink-by-name to find it.
    const buf = await readFile(subtitleVideoAbsPath);
    archive.append(buf, { name: SUBTITLE_ZIP_NAME });
  }

  archive.finalize().catch(() => {
    /* finalize errors propagate through the stream */
  });

  return archive as unknown as Readable;
}
