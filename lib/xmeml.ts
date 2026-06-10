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
}): string {
  const {
    projectName,
    plan,
    clips,
    clipAbsPath,
    voiceoverAbsPath,
    voiceoverDurationMs,
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
${extraIndent}      <channelcount>2</channelcount>
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

    // The on-disk basename includes our upload-side prefix (e.g.
    // "abc123_Master_s_Footage.mp4"). Premiere's relink-by-name prompts
    // use this basename — making <name> match the actual file on disk
    // means a user who downloads the source clips to any folder can
    // point Premiere at one and the rest get found automatically.
    const storedBasename = path.basename(abs);

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
      storedBasename,
      fileUrl(abs),
      sourceTotalFrames,
      isImage,
      true, // has video
      !isImage, // has audio (only real video clips; we ignore source audio in render but Premiere needs the metadata)
      "          ",
    );

    videoClipitems.push(
      `        <clipitem id="ci-v-${i + 1}">
          <name>${xmlEscape(storedBasename)}</name>
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
  // Same on-disk-basename rule as clips: match what the user has on their
  // machine after download so Premiere's relink-by-name lands cleanly.
  const voStoredBasename = path.basename(voiceoverAbsPath);
  const voFileId = "file-vo";
  const voDurationFrames = Math.max(1, msToFrames(voiceoverDurationMs));
  const voFileEl = buildFileElement(
    voFileId,
    voStoredBasename,
    fileUrl(voiceoverAbsPath),
    voDurationFrames,
    false,
    false,
    true,
    "          ",
  );
  const voClipitem = `        <clipitem id="ci-a-1">
          <name>${xmlEscape(voStoredBasename)}</name>
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
        </track>
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
