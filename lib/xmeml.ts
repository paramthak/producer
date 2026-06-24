import path from "node:path";
import type { EditPlan, SourceClip } from "@/lib/types";

/**
 * Build an FCP7 XML Interchange Format ("XMEML") document from an edit plan.
 *
 * Why XMEML?
 *   The de-facto universal NLE interchange XML. Imported natively by
 *   Premiere Pro, DaVinci Resolve, Avid Media Composer, Final Cut Pro
 *   (legacy and X), and Smoke/Flame. Spec is XMEML version 5, published
 *   by Apple (developer.apple.com/library/archive — search "Final Cut Pro
 *   XML Interchange Format").
 *
 * Why local file:// paths work?
 *   Per spec, <pathurl> must be on a local volume and start with
 *   `file://localhost/` or `file:///`. Since this tool runs locally
 *   (localhost only — no Railway/server), absolute Mac paths into
 *   .producer-data/ resolve directly when Premiere opens the XML. No
 *   relink dialog, no "media offline".
 *
 * Multi-segment slicing of one clip:
 *   Every source file gets ONE <file> definition (full body, first
 *   occurrence) keyed by stable id. Subsequent references use the
 *   id-only short form `<file id="f-X"/>`. Multiple <clipitem>s can
 *   point at the same file with different `<in>`/`<out>` frame ranges
 *   — Premiere / Resolve / Avid all honor this correctly.
 *
 * Time conventions:
 *   All times are in INTEGER FRAMES at the timebase. Timeline positions
 *   are <start>/<end>. Source slice points are <in>/<out>. Image clips
 *   get a long synthetic source duration (~4 minutes) so any reasonable
 *   timeline duration fits inside.
 */

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;
const IMAGE_SOURCE_FRAMES = FPS * 60 * 4; // 4-minute synthetic still source

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build a file:// URL from an absolute local path per RFC 2396 / XMEML
 * pathurl rules. Each path segment is encoded but `/` separators stay.
 */
function fileUrl(absPath: string): string {
  // Normalize: ensure leading slash so we end up with exactly one between
  // "localhost" and the first path segment.
  const norm = absPath.startsWith("/") ? absPath : "/" + absPath;
  const encoded = norm
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://localhost${encoded}`;
}

function msToFrames(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * FPS));
}

const RATE = `      <rate>
        <timebase>${FPS}</timebase>
        <ntsc>FALSE</ntsc>
      </rate>`;

function videoSampleCharacteristics(): string {
  return `      <samplecharacteristics>
        <width>${WIDTH}</width>
        <height>${HEIGHT}</height>
        <pixelaspectratio>square</pixelaspectratio>
        <fielddominance>none</fielddominance>
${RATE}
      </samplecharacteristics>`;
}

function audioSampleCharacteristics(): string {
  return `      <samplecharacteristics>
        <depth>16</depth>
        <samplerate>48000</samplerate>
      </samplecharacteristics>`;
}

export function buildXmeml(opts: {
  projectName: string;
  plan: EditPlan;
  clips: Record<string, SourceClip>;
  /** Absolute path on the local filesystem to each clip's source file. */
  clipAbsPath: Record<string, string>;
  voiceoverAbsPath: string;
  voiceoverDurationMs: number;
  /**
   * Channel count of the voiceover audio (1 = mono, 2 = stereo, ...).
   * Must match the actual file or Premiere rejects the relink with
   * "different channel type". Defaults to 2 only as a last-resort
   * fallback for legacy sessions that didn't capture it on upload.
   */
  voiceoverChannels?: number;
  /**
   * Optional clipId → display name override. When provided, becomes the
   * value used for both <name> (Premiere bin label) AND the basename of
   * <pathurl>. The default falls back to clip.filename (original upload
   * name). The ZIP bundle export uses this to apply collision-disambiguated
   * names that match the ZIP's file structure for one-click relink.
   */
  clipNames?: Record<string, string>;
  /**
   * Optional override for the voiceover's display name. Defaults to the
   * original uploaded voiceover filename (from manifest.voiceover.filename
   * if the caller passes it through clip.filename style).
   */
  voiceoverName?: string;
  /**
   * Optional green-screen subtitle video. When provided it's placed on a
   * SECOND video track ABOVE the main footage (V2 in Premiere) spanning the
   * whole sequence, so the user can drop it on top and key out the green.
   * Subtitles are NEVER burned into the source clips — this standalone
   * green-screen file is the only place captions live in the bundle/XML.
   */
  subtitleVideo?: { name: string; absPath: string; durationMs: number };
}): string {
  const {
    projectName,
    plan,
    clips,
    clipAbsPath,
    voiceoverAbsPath,
    voiceoverDurationMs,
    voiceoverChannels,
    clipNames,
    voiceoverName,
    subtitleVideo,
  } = opts;

  // Resolve unique source files (one <file> def per clipId, reused by id).
  const uniqueClipIds = Array.from(new Set(plan.segments.map((s) => s.clipId)));
  const fileIdByClip = new Map<string, string>();
  uniqueClipIds.forEach((cid, i) => fileIdByClip.set(cid, `file-${i + 1}`));

  // Track which file ids have had their full body emitted (vs reused as <file id="..."/>).
  const fileDefined = new Set<string>();

  function buildFileElement(
    fileId: string,
    name: string,
    pathUrl: string,
    durationFrames: number,
    isImage: boolean,
    isVideo: boolean,
    isAudio: boolean,
    audioChannelCount: number,
    extraIndent: string,
  ): string {
    if (fileDefined.has(fileId)) {
      return `${extraIndent}<file id="${fileId}"/>`;
    }
    fileDefined.add(fileId);

    const mediaParts: string[] = [];
    if (isVideo) {
      mediaParts.push(`${extraIndent}    <video>
${extraIndent}${videoSampleCharacteristics()
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")}
${extraIndent}    </video>`);
    }
    if (isAudio) {
      mediaParts.push(`${extraIndent}    <audio>
${extraIndent}${audioSampleCharacteristics()
        .split("\n")
        .map((l) => "    " + l)
        .join("\n")}
${extraIndent}      <channelcount>${audioChannelCount}</channelcount>
${extraIndent}    </audio>`);
    }

    return `${extraIndent}<file id="${fileId}">
${extraIndent}  <name>${xmlEscape(name)}</name>
${extraIndent}  <pathurl>${xmlEscape(pathUrl)}</pathurl>
${extraIndent}${RATE.split("\n").map((l) => "  " + l).join("\n")}
${extraIndent}  <duration>${durationFrames}</duration>
${extraIndent}  ${isImage ? `<media>
${extraIndent}    <video>
${extraIndent}      <duration>${durationFrames}</duration>
${extraIndent}${videoSampleCharacteristics().split("\n").map((l) => "    " + l).join("\n")}
${extraIndent}    </video>
${extraIndent}  </media>` : `<media>
${mediaParts.join("\n")}
${extraIndent}  </media>`}
${extraIndent}</file>`;
  }

  // ---- Build video clipitems on a single track ----
  const sortedSegments = [...plan.segments].sort(
    (a, b) => a.timelineStartMs - b.timelineStartMs,
  );

  const videoClipitems: string[] = [];
  sortedSegments.forEach((seg, i) => {
    const clip = clips[seg.clipId];
    const abs = clipAbsPath[seg.clipId];
    if (!clip || !abs) return;
    const fileId = fileIdByClip.get(seg.clipId)!;
    const isImage = clip.kind === "image";

    // Display name in the NLE bin AND the basename inside <pathurl>. When the
    // ZIP bundle export passes a disambiguated clipNames map, use it — the
    // names match the actual files inside the ZIP so Premiere's relink-by-
    // name finds everything automatically. Otherwise fall back to the
    // user's original filename (clip.filename) which is the clean form
    // they uploaded as.
    const displayName = clipNames?.[clip.id] ?? clip.filename;
    // <pathurl> uses the parent dir of the actual on-disk file but with
    // displayName as the basename — this is what Premiere shows in the
    // relink dialog and what it tries to match against files in any folder.
    const pathBasenameDir = path.dirname(abs);
    const pathForUrl = path.join(pathBasenameDir, displayName);

    // Track-presence MUST match the actual source file. If we declare
    // <audio> for a video-only stock clip, Premiere's relink-by-name
    // rejects the file with "type does not match". Use the probed value
    // from upload; fall back conservatively to false (video-only) for
    // legacy manifest entries lacking the field — a clip that's actually
    // video-only and declared video-only is the safer mismatch than the
    // reverse.
    const hasAudio = !isImage && (clip.hasAudio ?? false);
    // Channel count MUST match too — mono file declared stereo (or vice
    // versa) gets rejected with "different channel type". Probed at
    // upload; legacy fallback of 2 only if missing.
    const clipAudioChannels = clip.audioChannels ?? 2;

    const sourceTotalFrames = isImage
      ? IMAGE_SOURCE_FRAMES
      : Math.max(1, msToFrames(clip.durationMs));
    const timelineStart = msToFrames(seg.timelineStartMs);
    const timelineEnd = msToFrames(seg.timelineEndMs);
    const sourceIn = isImage ? 0 : msToFrames(seg.sourceInMs);
    const segDuration = Math.max(1, timelineEnd - timelineStart);
    const sourceOut = isImage ? segDuration : sourceIn + segDuration;

    const fileEl = buildFileElement(
      fileId,
      displayName,
      fileUrl(pathForUrl),
      sourceTotalFrames,
      isImage,
      true, // has video
      hasAudio, // honest declaration — see comment above
      clipAudioChannels,
      "          ",
    );

    videoClipitems.push(
      `        <clipitem id="ci-v-${i + 1}">
          <name>${xmlEscape(displayName)}</name>
          <enabled>TRUE</enabled>
          <duration>${sourceTotalFrames}</duration>
${RATE.split("\n").map((l) => "    " + l).join("\n")}
          <start>${timelineStart}</start>
          <end>${timelineEnd}</end>
          <in>${sourceIn}</in>
          <out>${sourceOut}</out>
${fileEl}
        </clipitem>`,
    );
  });

  // ---- Voiceover on the audio track ----
  // Same display-name logic as clips: the ZIP bundle passes a clean
  // voiceoverName matching its ZIP entry; otherwise default to the
  // on-disk basename.
  const voDisplayName = voiceoverName ?? path.basename(voiceoverAbsPath);
  const voPathDir = path.dirname(voiceoverAbsPath);
  const voPathForUrl = path.join(voPathDir, voDisplayName);
  const voFileId = "file-vo";
  const voDurationFrames = Math.max(1, msToFrames(voiceoverDurationMs));
  // ElevenLabs voiceovers are typically mono (1 channel). Hardcoding the
  // legacy 2 was the bug that broke voiceover relink with "different
  // channel type". Use the probed value; defensive fallback to 2.
  const voChannels = voiceoverChannels ?? 2;
  const voFileEl = buildFileElement(
    voFileId,
    voDisplayName,
    fileUrl(voPathForUrl),
    voDurationFrames,
    false,
    false,
    true,
    voChannels,
    "          ",
  );
  const voClipitem = `        <clipitem id="ci-a-1">
          <name>${xmlEscape(voDisplayName)}</name>
          <enabled>TRUE</enabled>
          <duration>${voDurationFrames}</duration>
${RATE.split("\n").map((l) => "    " + l).join("\n")}
          <start>0</start>
          <end>${voDurationFrames}</end>
          <in>0</in>
          <out>${voDurationFrames}</out>
${voFileEl}
          <sourcetrack>
            <mediatype>audio</mediatype>
            <trackindex>1</trackindex>
          </sourcetrack>
        </clipitem>`;

  // ---- Sequence total duration ----
  const sequenceDurationFrames = Math.max(
    voDurationFrames,
    sortedSegments.length
      ? msToFrames(sortedSegments[sortedSegments.length - 1].timelineEndMs)
      : 0,
  );

  // ---- Optional subtitle video on a SECOND (top) video track ----
  // FCP7 XML stacks tracks bottom-up: the first <track> is V1, each later
  // <track> sits above it. Emitting this after the footage track puts the
  // green-screen captions on V2 — the top layer, as required.
  let subtitleTrack = "";
  if (subtitleVideo) {
    const subFrames = Math.max(1, msToFrames(subtitleVideo.durationMs));
    const subDir = path.dirname(subtitleVideo.absPath);
    const subPathForUrl = path.join(subDir, subtitleVideo.name);
    const subFileEl = buildFileElement(
      "file-sub",
      subtitleVideo.name,
      fileUrl(subPathForUrl),
      subFrames,
      false, // not an image
      true, // has video
      false, // no audio
      2, // unused (no audio)
      "          ",
    );
    subtitleTrack = `
        <track>
          <clipitem id="ci-sub-1">
            <name>${xmlEscape(subtitleVideo.name)}</name>
            <enabled>TRUE</enabled>
            <duration>${subFrames}</duration>
${RATE.split("\n").map((l) => "    " + l).join("\n")}
            <start>0</start>
            <end>${subFrames}</end>
            <in>0</in>
            <out>${subFrames}</out>
${subFileEl}
          </clipitem>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>`;
  }

  // ---- Assemble the document ----
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="seq-1">
    <name>${xmlEscape(projectName)}</name>
    <duration>${sequenceDurationFrames}</duration>
${RATE}
    <timecode>
      <rate>
        <timebase>${FPS}</timebase>
        <ntsc>FALSE</ntsc>
      </rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${WIDTH}</width>
            <height>${HEIGHT}</height>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
${RATE}
          </samplecharacteristics>
        </format>
        <track>
${videoClipitems.join("\n")}
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>${subtitleTrack}
      </video>
      <audio>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
        <track>
${voClipitem}
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>
`;
}
