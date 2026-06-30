/**
 * Seed a realistic session from ~/Downloads/Final video for manual QA of the
 * live editor (timeline, clip library, preview, render, subtitles-on-demand).
 * No Gemini/ElevenLabs calls — clips, proxies, VO, a multi-segment edit plan,
 * and a synthetic word alignment from the provided script.
 *
 * Usage: node scripts/seed-final-video.mjs [sessionId]
 */
import { promises as fs, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const SID = process.argv[2] || "finalvideo01";
const ROOT = path.resolve(process.cwd(), ".producer-data");
const SESS = path.join(ROOT, SID);
const SRC = path.join(os.homedir(), "Downloads", "Final video");
const FF = process.env.FFMPEG_PATH || "ffmpeg";
const FP = process.env.FFPROBE_PATH || "ffprobe";

const CLIPS = [
  ["hook", "1.HOOK/magnific_a-realistic-vertical-916-_3GKErzEREY.mp4"],
  ["hook", "1.HOOK/magnific_a-realistic-vertical-916-_xgBTW9KjfW.mp4"],
  ["hook", "1.HOOK/magnific_handheld-iphone-footage-s_3GKFck5REY.mp4"],
  ["bridge", "2.Bridge/13558246_1080_1920_60fps.mp4"],
  ["bridge", "2.Bridge/19621045-hd_1080_1920_24fps.mp4"],
  ["bridge", "2.Bridge/clouds travel.mp4"],
  ["body", "3.Body_Product/IMG_7072.MOV"],
  ["body", "3.Body_Product/UAE_Sfx.mp4"],
  ["body", "3.Body_Product/filer.png"],
  ["outro", "4.OUTRO/11954572_2160_3840_30fps.mp4"],
  ["outro", "4.OUTRO/296958.mp4"],
  ["cta", "5.CTA/Dubai_u 15L.MOV"],
];
const VO_REL = "VO/ElevenLabs_2026-05-27T13_57_08_Nikita - Young Smart Ecomm Support Agent_pvc_sp100_s36_sb54_v3.mp3";

const SCRIPT = [
  ["hook", "This is the last goodbye. I'm leaving for my Dubai Master's."],
  ["bridge", "Best part? I'm doing it all under fifteen lakh rupees with a scholarship. Didn't even have to break my parents' FD."],
  ["body", "One call with a Leap Scholar expert, and he shortlisted twenty-six plus colleges for my profile with the scholarships I was actually eligible for."],
  ["outro", "He sorted everything else, and now I'm here. If Dubai Master's has been on your mind,"],
  ["cta", "try out Leap Scholar."],
];

const IMG_EXT = new Set([".png", ".jpg", ".jpeg"]);
const id8 = (i) => `clip${String(i).padStart(2, "0")}`;
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || "").slice(-400)}`); return r.stdout; };

function probe(file) {
  const out = sh(FP, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  let fps;
  if (v?.avg_frame_rate?.includes("/")) { const [n, d] = v.avg_frame_rate.split("/").map(Number); if (d) fps = n / d; }
  return {
    durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000),
    width: v?.width, height: v?.height, fps,
    hasAudio: !!a, audioChannels: a?.channels,
  };
}

async function main() {
  if (!existsSync(SRC)) throw new Error(`Source folder not found: ${SRC}`);
  // Single-session invariant: wipe everything else.
  await fs.mkdir(ROOT, { recursive: true });
  for (const e of await fs.readdir(ROOT)) {
    if (e !== SID) await fs.rm(path.join(ROOT, e), { recursive: true, force: true });
  }
  for (const d of ["sources", "proxies", "voiceover", "output"]) await fs.mkdir(path.join(SESS, d), { recursive: true });

  const clips = [];
  let i = 0;
  for (const [section, rel] of CLIPS) {
    i++;
    const abs = path.join(SRC, rel);
    if (!existsSync(abs)) { console.warn("skip missing", rel); continue; }
    const id = id8(i);
    const ext = path.extname(rel).toLowerCase();
    const isImage = IMG_EXT.has(ext);
    const base = path.basename(rel);
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stored = `${id}_${safe}`;
    const destRel = path.join("sources", stored);
    await fs.copyFile(abs, path.join(SESS, destRel));
    const pr = isImage ? { durationMs: 0, hasAudio: false } : probe(abs);

    let proxyRel, posterRel = path.join("proxies", `${id}.jpg`);
    if (isImage) {
      // Poster = downscaled still; the image plays directly.
      sh(FF, ["-y", "-i", abs, "-vf", "scale=-2:480", "-frames:v", "1", "-q:v", "4", path.join(SESS, posterRel)]);
      posterRel = destRel; // display original directly
    } else {
      proxyRel = path.join("proxies", `${id}.mp4`);
      sh(FF, ["-y", "-i", abs, "-vf", "scale=-2:480", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-an", "-movflags", "+faststart", path.join(SESS, proxyRel)]);
      sh(FF, ["-y", "-i", abs, "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "4", path.join(SESS, posterRel)]);
    }
    const st = await fs.stat(path.join(SESS, destRel));
    clips.push({
      id, section, kind: isImage ? "image" : "video", filename: base, relPath: destRel,
      url: `/api/media/${SID}/${destRel.split(path.sep).join("/")}`,
      durationMs: pr.durationMs, width: pr.width, height: pr.height, fps: pr.fps,
      sizeBytes: st.size, hasAudio: pr.hasAudio, audioChannels: pr.audioChannels,
      proxyRelPath: proxyRel ? proxyRel.split(path.sep).join("/") : undefined,
      posterRelPath: posterRel.split(path.sep).join("/"),
      proxyReady: true,
    });
    console.log(`  + ${section}  ${base}  ${pr.durationMs}ms`);
  }

  // Voiceover
  const voAbs = path.join(SRC, VO_REL);
  const voDur = Math.round(Number(sh(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", voAbs]).trim()) * 1000);
  const voDest = path.join("voiceover", "voiceover.mp3");
  await fs.copyFile(voAbs, path.join(SESS, voDest));
  const voStat = await fs.stat(path.join(SESS, voDest));

  // Edit plan: one segment per section (first clip), back-to-back across the VO.
  const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
  const layout = [
    ["clip01", 4000], ["clip03", 4000], ["clip04", 6000], ["clip08", 6000],
    ["clip07", 4000], ["clip11", 3000], ["clip12", voDur - 27000],
  ];
  let t = 0;
  const segments = [];
  let si = 0;
  for (const [cid, dur] of layout) {
    const c = byId[cid];
    if (!c) continue;
    const d = Math.max(500, Math.min(dur, c.kind === "image" ? dur : c.durationMs));
    segments.push({
      id: `seg${++si}`, section: c.section, clipId: cid,
      sourceInMs: 0, sourceOutMs: d, timelineStartMs: t, timelineEndMs: t + d,
      whyClip: `${c.section} visual`, whyTrim: "trimmed for pace",
    });
    t += d;
  }
  const plan = { segments, totalDurationMs: voDur };
  await fs.writeFile(path.join(SESS, "edit-plan.json"), JSON.stringify(plan, null, 2));

  // Synthetic word alignment across the VO (so subtitles-on-demand has words).
  const allWords = [];
  let cursor = 0;
  const totalTokens = SCRIPT.reduce((n, [, txt]) => n + txt.split(/\s+/).length, 0);
  const per = voDur / totalTokens;
  for (const [, txt] of SCRIPT) {
    for (const tok of txt.split(/\s+/)) {
      const s = Math.round(cursor * per), e = Math.round((cursor + 0.9) * per);
      allWords.push({ text: tok, startMs: s, endMs: e });
      cursor++;
    }
  }
  await fs.writeFile(path.join(SESS, "alignment.json"), JSON.stringify({ words: allWords, durationMs: voDur }, null, 2));

  // sections.json windows (rough, evenly split by script line token counts).
  const windows = [];
  let wcur = 0;
  for (const [section, txt] of SCRIPT) {
    const toks = txt.split(/\s+/).length;
    const startMs = Math.round(wcur * per);
    wcur += toks;
    const endMs = Math.round(wcur * per);
    windows.push({ section, startMs, endMs, lines: [{ id: `l-${section}`, text: txt, section }] });
  }
  await fs.writeFile(path.join(SESS, "sections.json"), JSON.stringify({ windows, totalDurationMs: voDur }, null, 2));

  const manifest = {
    sessionId: SID, createdAt: Date.now(), clips,
    voiceover: { filename: path.basename(VO_REL), relPath: voDest.split(path.sep).join("/"),
      url: `/api/media/${SID}/${voDest.split(path.sep).join("/")}`, sizeBytes: voStat.size, channels: 2 },
    script: SCRIPT.map(([section, text], idx) => ({ id: `l${idx}`, text, section })),
    overridePrompt: "",
  };
  await fs.writeFile(path.join(SESS, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({ sid: SID, clips: clips.length, voDur, segments: segments.length }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
