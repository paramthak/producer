/**
 * Seed a synthetic but fully-valid session so the subtitle editor + all
 * exports can be tested without running the full Gemini/ElevenLabs pipeline.
 *
 * Usage: node scripts/seed-test-session.mjs <sessionId>
 */
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const sid = process.argv[2];
if (!sid || !/^[a-zA-Z0-9_-]{6,}$/.test(sid)) {
  console.error("Usage: node scripts/seed-test-session.mjs <sessionId>");
  process.exit(1);
}

const ROOT = path.resolve(process.cwd(), ".producer-data", sid);
const FF = process.env.FFMPEG_PATH || "ffmpeg";
// Pick whatever source video is available on this machine.
const CANDIDATES = [
  "/Users/paramthakkar/Downloads/Kumar Dipankar_s Video - Dec 13, 2025.mp4",
  "/tmp/rec.mov",
];
import { existsSync } from "node:fs";
const TALKING = CANDIDATES.find((p) => existsSync(p));
if (!TALKING) { console.error("No source video found; tried:", CANDIDATES); process.exit(1); }

const TOTAL = 10000;

// ---- planHash replica (mirrors lib/planHash.ts) ----
function fnv1a64(s) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}
function hashPlan(plan) {
  const parts = [`total:${plan.totalDurationMs}`];
  const sorted = [...plan.segments].sort((a, b) =>
    a.timelineStartMs !== b.timelineStartMs ? a.timelineStartMs - b.timelineStartMs : a.id < b.id ? -1 : 1,
  );
  for (const s of sorted)
    parts.push([s.section, s.clipId, s.sourceInMs, s.sourceOutMs, s.timelineStartMs, s.timelineEndMs, s.hold ? "h" : "n"].join("|"));
  return fnv1a64(parts.join("\n")).toString(36);
}

function ff(args) {
  const r = spawnSync(FF, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + args.join(" "));
}

async function main() {
  for (const d of ["sources", "frames", "descriptions", "voiceover", "output"]) {
    await fs.mkdir(path.join(ROOT, d), { recursive: true });
  }

  // Source clip = the source video re-encoded + with a silent audio track
  // (so the bundle/XML have valid audio regardless of the source).
  const clipPath = path.join(ROOT, "sources", "clip.mp4");
  ff(["-y", "-loglevel", "error", "-t", "10", "-i", TALKING, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "96k", "-shortest", clipPath]);

  // Voiceover = a generated silent track (timing comes from alignment.json).
  const voPath = path.join(ROOT, "voiceover", "vo.m4a");
  ff(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "10", "-c:a", "aac", "-b:a", "96k", voPath]);

  // Edit plan: single segment spanning the whole 10s.
  const plan = {
    segments: [
      {
        id: "seg1",
        section: "hook",
        clipId: "clipA",
        sourceInMs: 0,
        sourceOutMs: TOTAL,
        timelineStartMs: 0,
        timelineEndMs: TOTAL,
        whyClip: "test",
        whyTrim: "test",
        hold: false,
      },
    ],
    totalDurationMs: TOTAL,
  };
  const planHash = hashPlan(plan);
  const previewName = `preview-${planHash}.mp4`;

  // Preview MP4 = clip scaled/padded to 1080x1920 with its audio (what the
  // overlay sits on, and what "with subtitles" burns onto).
  const previewPath = path.join(ROOT, "output", previewName);
  ff([
    "-y", "-loglevel", "error", "-t", "10", "-i", TALKING,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", previewPath,
  ]);

  const statClip = await fs.stat(clipPath);
  const statVo = await fs.stat(voPath);

  // Forced-alignment words spread across 10s.
  const sentence = "I cracked the entire study abroad process on my own and landed in the UK within six months.";
  const tokens = sentence.split(" ");
  const per = TOTAL / tokens.length;
  const words = tokens.map((t, i) => ({ text: t, startMs: Math.round(i * per), endMs: Math.round((i + 0.85) * per) }));
  await fs.writeFile(path.join(ROOT, "alignment.json"), JSON.stringify({ words, durationMs: TOTAL }, null, 2));

  await fs.writeFile(
    path.join(ROOT, "sections.json"),
    JSON.stringify({ windows: [{ section: "hook", startMs: 0, endMs: TOTAL, lines: [{ id: "l1", text: sentence, section: "hook" }] }], totalDurationMs: TOTAL }, null, 2),
  );

  await fs.writeFile(path.join(ROOT, "edit-plan.json"), JSON.stringify(plan, null, 2));

  // Captions with a few emphasized words to exercise both presets + bold.
  const cap = (id, s, e, ws) => ({ id, startMs: s, endMs: e, words: ws });
  const w = (text, s, e, bold = false) => ({ text, startMs: s, endMs: e, bold });
  const subtitles = {
    style: {
      enabled: true,
      preset: "lowerLeftDisplay",
      fontFamily: "Libre Caslon Text",
      fontSize: 60,
      color: "#F5F0DC",
      highlightColor: "#F5F0DC",
      positionY: 0.72,
    },
    captions: [
      cap("cap-0", 0, 1300, [w("I", 0, 500), w("cracked", 500, 1300, true)]),
      cap("cap-1", 1300, 2900, [w("the", 1300, 1700), w("entire", 1700, 2400, true), w("study", 2400, 2900)]),
      cap("cap-2", 2900, 4200, [w("abroad", 2900, 3600, true), w("process", 3600, 4200)]),
      cap("cap-3", 4200, 5800, [w("on", 4200, 4500), w("my", 4500, 4900), w("own", 4900, 5800)]),
      cap("cap-4", 5800, 7800, [w("and", 5800, 6100), w("landed", 6100, 6900, true), w("in", 6900, 7100), w("the", 7100, 7300), w("UK", 7300, 7800, true)]),
      cap("cap-5", 7800, 10000, [w("within", 7800, 8400), w("six", 8400, 9100, true), w("months.", 9100, 10000)]),
    ],
  };
  await fs.writeFile(path.join(ROOT, "subtitles.json"), JSON.stringify(subtitles, null, 2));

  const manifest = {
    sessionId: sid,
    createdAt: Date.now(),
    clips: [
      {
        id: "clipA",
        section: "hook",
        kind: "video",
        filename: "clip.mp4",
        relPath: "sources/clip.mp4",
        url: `/api/media/${sid}/sources/clip.mp4`,
        durationMs: TOTAL,
        width: 720,
        height: 1280,
        fps: 30,
        sizeBytes: statClip.size,
        hasAudio: true,
        audioChannels: 2,
      },
    ],
    voiceover: {
      filename: "vo.m4a",
      relPath: "voiceover/vo.m4a",
      url: `/api/media/${sid}/voiceover/vo.m4a`,
      sizeBytes: statVo.size,
      channels: 2,
    },
    script: [{ id: "l1", text: sentence, section: "hook" }],
    overridePrompt: "",
    preview: { filename: previewName, planHash, renderedAt: Date.now() },
    costs: {
      totalUsd: 0.0123,
      breakdown: {
        describe: { calls: 1, inputTokens: 1000, outputTokens: 500, usd: 0.005 },
        match: { calls: 1, inputTokens: 2000, outputTokens: 800, usd: 0.006 },
        align: { calls: 1, audioMs: TOTAL, usd: 0.001 },
        caption: { calls: 1, inputTokens: 300, outputTokens: 100, usd: 0.0003 },
      },
    },
  };
  await fs.writeFile(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({ sid, planHash, previewName, root: ROOT }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
