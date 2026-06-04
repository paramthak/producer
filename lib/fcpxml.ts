import type { EditPlan, SourceClip } from "@/lib/types";

const FRAME_DURATION = "1/30s"; // 30fps timebase

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function msToFrames(ms: number, fps = 30): number {
  return Math.round((ms / 1000) * fps);
}

function frameTime(ms: number, fps = 30): string {
  const f = msToFrames(ms, fps);
  return `${f}/${fps}s`;
}

/**
 * Build FCPXML 1.10 from an edit plan + clip map + voiceover. The clips reference original source
 * files by absolute path so Premiere can resolve them after import.
 */
export function buildFcpxml(opts: {
  projectName: string;
  plan: EditPlan;
  clips: Record<string, SourceClip>;
  /** Absolute path to each clip's source file on disk. */
  clipAbsPath: Record<string, string>;
  voiceoverAbsPath: string;
  voiceoverFilename: string;
  voiceoverDurationMs: number;
}): string {
  const { projectName, plan, clips, clipAbsPath, voiceoverAbsPath, voiceoverFilename, voiceoverDurationMs } = opts;
  const fps = 30;

  // Build a map of unique source assets (one asset per unique clipId).
  const usedClipIds = Array.from(new Set(plan.segments.map((s) => s.clipId)));
  const assets: string[] = [];
  let nextAssetId = 1;
  const assetIdByClip = new Map<string, string>();
  for (const cid of usedClipIds) {
    const clip = clips[cid];
    const abs = clipAbsPath[cid];
    if (!clip || !abs) continue;
    const id = `r${nextAssetId++}`;
    assetIdByClip.set(cid, id);
    const duration = clip.kind === "image" ? "0s" : frameTime(clip.durationMs, fps);
    const hasVideo = "1";
    const hasAudio = "0"; // source audio muted in v0
    const src = `file://${encodeURI(abs)}`;
    assets.push(
      `    <asset id="${id}" name="${xmlEscape(clip.filename)}" src="${src}" start="0s" duration="${duration}" hasVideo="${hasVideo}" hasAudio="${hasAudio}" format="r0"/>`,
    );
  }
  // Voiceover asset
  const voAssetId = `r${nextAssetId++}`;
  const voSrc = `file://${encodeURI(voiceoverAbsPath)}`;
  assets.push(
    `    <asset id="${voAssetId}" name="${xmlEscape(voiceoverFilename)}" src="${voSrc}" start="0s" duration="${frameTime(voiceoverDurationMs, fps)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2"/>`,
  );

  // Build the video clips on the spine.
  const spine: string[] = [];
  for (const seg of plan.segments) {
    const assetId = assetIdByClip.get(seg.clipId);
    if (!assetId) continue;
    const clip = clips[seg.clipId];
    const offset = frameTime(seg.timelineStartMs, fps);
    const duration = frameTime(seg.timelineEndMs - seg.timelineStartMs, fps);
    if (clip?.kind === "image") {
      spine.push(
        `        <video name="${xmlEscape(clip.filename)}" ref="${assetId}" offset="${offset}" duration="${duration}" start="0s"/>`,
      );
    } else {
      const start = frameTime(seg.sourceInMs, fps);
      spine.push(
        `        <asset-clip name="${xmlEscape(clips[seg.clipId]?.filename ?? seg.clipId)}" ref="${assetId}" offset="${offset}" duration="${duration}" start="${start}" audioRole="dialogue"/>`,
      );
    }
  }

  // Voiceover audio on a connected timeline.
  const voClip = `        <asset-clip lane="-1" ref="${voAssetId}" offset="0s" duration="${frameTime(voiceoverDurationMs, fps)}" start="0s" name="${xmlEscape(voiceoverFilename)}"/>`;

  const totalDuration = frameTime(plan.totalDurationMs || voiceoverDurationMs, fps);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r0" name="FFVideoFormat1080p3000Vertical" frameDuration="${FRAME_DURATION}" width="1080" height="1920"/>
${assets.join("\n")}
  </resources>
  <library>
    <event name="${xmlEscape(projectName)}">
      <project name="${xmlEscape(projectName)}">
        <sequence format="r0" duration="${totalDuration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${spine.join("\n")}
${voClip}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
