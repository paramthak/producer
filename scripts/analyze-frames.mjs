// One-off: send extracted video frames to Gemini and store per-frame analysis.
// Reuses the same model + LOW media-resolution settings as lib/gemini/describeFrames.ts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { GoogleGenAI, MediaResolution, ThinkingLevel, Type } from "@google/genai";

const OUT = "/Users/paramthakkar/Downloads/frame-analysis-ScreenRecording_06-23-2026_01-44-23";
const FRAMES_DIR = path.join(OUT, "frames");
const FPS = 20;
const BATCH = 20;          // frames per Gemini request
const CONCURRENCY = 5;     // parallel requests
const MODEL = "gemini-3.5-flash";

// --- load GEMINI_API_KEY from .env (no dotenv dep) ---
const envRaw = await fs.readFile(path.resolve(".env"), "utf8");
const keyLine = envRaw.split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
const apiKey = keyLine?.slice("GEMINI_API_KEY=".length).trim();
if (!apiKey) throw new Error("GEMINI_API_KEY not found in .env");

const ai = new GoogleGenAI({ apiKey });

const responseSchema = {
  type: Type.OBJECT,
  required: ["frames"],
  properties: {
    frames: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["index", "description"],
        properties: {
          index: { type: Type.INTEGER, description: "1-based position of the frame within THIS batch, in the order shown." },
          description: {
            type: Type.STRING,
            description:
              "Extremely detailed description of the frame: subject, action, UI/layout, framing, motion, and any on-screen text transcribed exactly. 2-4 sentences.",
          },
        },
      },
    },
  },
};

async function withBackoff(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = Math.min(2000 * 2 ** i, 20000);
      process.stderr.write(`  retry ${i + 1}/${tries} after error: ${e?.message ?? e}\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

const files = (await fs.readdir(FRAMES_DIR)).filter((f) => f.endsWith(".jpg")).sort();
const timestampMs = files.map((_, i) => Math.round(((i + 0.5) / FPS) * 1000));
console.error(`Frames: ${files.length} | batches of ${BATCH} | model ${MODEL}`);

// Build batches
const batches = [];
for (let i = 0; i < files.length; i += BATCH) {
  batches.push(files.slice(i, i + BATCH).map((f, j) => ({ file: f, globalIdx: i + j })));
}

const results = new Array(files.length); // per-frame { frame, file, timestampMs, description }
let usageIn = 0, usageOut = 0, doneBatches = 0;

async function runBatch(batch) {
  const parts = [{
    text:
      `You will see ${batch.length} frame(s) extracted from a screen recording, in chronological order. ` +
      `Each image is followed by a line giving its batch index. For each frame return an extremely detailed ` +
      `visual description (subject, UI/layout, action, motion, and any on-screen text transcribed exactly). ` +
      `Return one entry per frame, keyed by the batch index shown.`,
  }];
  for (let k = 0; k < batch.length; k++) {
    const buf = await fs.readFile(path.join(FRAMES_DIR, batch[k].file));
    parts.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
    parts.push({ text: `^ batch index: ${k + 1}` });
  }
  const res = await withBackoff(() =>
    ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      config: {
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema,
      },
    }),
  );
  const meta = res.usageMetadata ?? {};
  usageIn += meta.promptTokenCount ?? 0;
  usageOut += meta.candidatesTokenCount ?? 0;

  const parsed = JSON.parse(res.text ?? "{}");
  for (const fr of parsed.frames ?? []) {
    const local = (fr.index ?? 0) - 1;
    const item = batch[local];
    if (!item) continue;
    results[item.globalIdx] = {
      frame: item.globalIdx + 1,
      file: `frames/${item.file}`,
      timestampMs: timestampMs[item.globalIdx],
      description: fr.description ?? "",
    };
  }
  doneBatches++;
  process.stderr.write(`  batch ${doneBatches}/${batches.length} done (frames ${batch[0].globalIdx + 1}-${batch[batch.length - 1].globalIdx + 1})\n`);
}

// simple concurrency pool
let cursor = 0;
async function worker() {
  while (cursor < batches.length) {
    const mine = batches[cursor++];
    await runBatch(mine);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// fill any frames the model skipped
for (let i = 0; i < files.length; i++) {
  if (!results[i]) {
    results[i] = { frame: i + 1, file: `frames/${files[i]}`, timestampMs: timestampMs[i], description: "" };
  }
}

const missing = results.filter((r) => !r.description).length;

await fs.writeFile(path.join(OUT, "analysis.json"), JSON.stringify({
  source: "ScreenRecording_06-23-2026 01-44-23_1.MP4",
  fps: FPS,
  model: MODEL,
  totalFrames: files.length,
  framesWithDescription: files.length - missing,
  usage: { inputTokens: usageIn, outputTokens: usageOut },
  frames: results,
}, null, 2));

const jsonl = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
await fs.writeFile(path.join(OUT, "analysis.jsonl"), jsonl);

console.error(`DONE. frames=${files.length} missing=${missing} tokens in/out=${usageIn}/${usageOut}`);
console.error(`Wrote: ${path.join(OUT, "analysis.json")}`);
console.error(`Wrote: ${path.join(OUT, "analysis.jsonl")}`);
