import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { paths } from "@/lib/session";
import { loadManifest, saveManifest } from "@/lib/manifest";
import { buildProxy } from "@/lib/ffmpeg";

// Cap proxy transcodes so a batch upload doesn't saturate the (4-core EC2)
// box while the user is still setting up. Tiny/fast jobs, so 2 is plenty.
const limit = pLimit(2);

/**
 * Kick off async proxy + poster generation for a freshly-uploaded video
 * clip. Fire-and-forget: the upload route returns immediately with
 * proxyReady:false, and this patches the manifest (proxyReady:true +
 * paths) once the transcode finishes. Runs in the same long-lived Node
 * process as the rest of the app.
 */
export function queueClipProxy(sessionId: string, clipId: string): void {
  void limit(() => generateClipProxy(sessionId, clipId)).catch((err) => {
    console.warn(`[proxy] generation failed for ${clipId}:`, err);
  });
}

async function generateClipProxy(sessionId: string, clipId: string): Promise<void> {
  const p = paths(sessionId);
  const manifest = await loadManifest(sessionId);
  const clip = manifest?.clips.find((c) => c.id === clipId);
  // Clip may have been deleted, or the session wiped, before we got here.
  if (!manifest || !clip || clip.kind !== "video") return;

  const proxyRel = path.join("proxies", `${clipId}.mp4`);
  const posterRel = path.join("proxies", `${clipId}.jpg`);
  await fs.mkdir(p.proxies, { recursive: true });
  await buildProxy(
    path.join(p.base, clip.relPath),
    path.join(p.base, proxyRel),
    path.join(p.base, posterRel),
  );

  // Re-read before patching — other clips may have been added/removed while
  // we transcoded, and we must not clobber those writes (same discipline as
  // the cost-write re-read in the old render path).
  const fresh = await loadManifest(sessionId);
  const target = fresh?.clips.find((c) => c.id === clipId);
  if (!fresh || !target) return;
  target.proxyRelPath = proxyRel;
  target.posterRelPath = posterRel;
  target.proxyReady = true;
  await saveManifest(fresh);
}
