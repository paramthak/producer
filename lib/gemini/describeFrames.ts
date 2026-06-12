import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaResolution, ThinkingLevel, Type } from "@google/genai";
import { gemini, MODEL_DESCRIBE } from "@/lib/gemini/client";
import { withBackoff } from "@/lib/concurrency";
import type { ClipAnalysis, FrameDescription, SectionId } from "@/lib/types";

export interface DescribeInput {
  clipId: string;
  section: SectionId;
  /** For videos: absolute paths to extracted frames, in order. For images: a single image path. */
  framePaths: string[];
  /** Timestamps in ms for each frame (videos). Pass [0] for an image. */
  timestamps: number[];
  /** Pass true to use HIGH media resolution (product/software shots). */
  highRes?: boolean;
}

const responseSchema = {
  type: Type.OBJECT,
  required: ["summary", "frames"],
  properties: {
    summary: {
      type: Type.STRING,
      description:
        "A two-to-three sentence summary of what this clip shows overall — setting, subject, action, key visuals, and any on-screen text.",
    },
    frames: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["timestampMs", "description"],
        properties: {
          timestampMs: { type: Type.INTEGER },
          description: {
            type: Type.STRING,
            description:
              "Extremely detailed visual description: subject, action, setting, framing, motion, on-screen text exactly as it reads, mood. 2-4 sentences.",
          },
        },
      },
    },
  },
} as const;

/**
 * One describe call's API token usage. Surfaced to the pipeline so it can
 * accumulate per-session cost without each leaf function touching the
 * manifest (avoids races on parallel describe calls).
 */
export interface DescribeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DescribeResult {
  analysis: ClipAnalysis;
  usage: DescribeUsage;
}

export async function describeClip(input: DescribeInput, signal?: AbortSignal): Promise<DescribeResult> {
  if (input.framePaths.length !== input.timestamps.length) {
    throw new Error("describeClip: framePaths and timestamps mismatched");
  }

  const parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
  > = [];

  parts.push({
    text:
      `You will see ${input.framePaths.length} frame(s) from a single source clip, in chronological order. ` +
      `Each frame is followed by its exact timestamp in milliseconds. ` +
      `For each frame, return an extremely detailed visual description (subject, framing, action, setting, motion, ` +
      `any on-screen text exactly as it appears, mood). Also return a short overall summary of the whole clip. ` +
      `Be specific. This will be used to match clips to a voiceover script and decide which seconds to keep.`,
  });

  for (let i = 0; i < input.framePaths.length; i++) {
    const buf = await fs.readFile(input.framePaths[i]);
    const ext = path.extname(input.framePaths[i]).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    parts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
    parts.push({ text: `^ timestamp: ${input.timestamps[i]}ms` });
  }

  const result = await withBackoff(
    () =>
      gemini().models.generateContent({
        model: MODEL_DESCRIBE,
        contents: [{ role: "user", parts }],
        config: {
          mediaResolution: input.highRes ? MediaResolution.MEDIA_RESOLUTION_HIGH : MediaResolution.MEDIA_RESOLUTION_LOW,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    { signal },
  );

  const text = result.text ?? "";
  let parsed: { summary?: string; frames?: Array<{ timestampMs?: number; description?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`describeClip: invalid JSON from ${MODEL_DESCRIBE}: ${text.slice(0, 300)}`);
  }

  const frames: FrameDescription[] = (parsed.frames ?? []).map((f, i) => ({
    timestampMs:
      typeof f.timestampMs === "number" && Number.isFinite(f.timestampMs)
        ? f.timestampMs
        : input.timestamps[i] ?? 0,
    description: f.description ?? "",
  }));

  // Same diagnostic-with-fallback pattern as matchAndTrim. Image-token
  // estimate is roughly the published Gemini vision rate: ~258 tokens per
  // image at LOW media resolution, ~1024 at HIGH. Add the small text
  // prompt overhead. The fallback only fires when the SDK refuses to
  // report tokens — otherwise we use the real number.
  const usageMetadata = (result as unknown as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  }).usageMetadata;
  const reportedIn = usageMetadata?.promptTokenCount;
  const reportedOut = usageMetadata?.candidatesTokenCount;
  const tokensPerImage = input.highRes ? 1024 : 258;
  const estimatedIn = input.framePaths.length * tokensPerImage + 200; // +200 for the instruction text
  const estimatedOut = Math.ceil((result.text ?? "").length / 4);
  const usage: DescribeUsage = {
    inputTokens: typeof reportedIn === "number" && reportedIn > 0 ? reportedIn : estimatedIn,
    outputTokens: typeof reportedOut === "number" && reportedOut > 0 ? reportedOut : estimatedOut,
  };
  console.log(
    `[gemini-describe clip=${input.clipId} frames=${input.framePaths.length} highRes=${input.highRes}] usageMetadata=${JSON.stringify(usageMetadata)} | reported in/out=${reportedIn ?? "MISSING"}/${reportedOut ?? "MISSING"} | estimated in/out=${estimatedIn}/${estimatedOut} | using in/out=${usage.inputTokens}/${usage.outputTokens}`,
  );

  return {
    analysis: {
      clipId: input.clipId,
      summary: parsed.summary ?? "",
      frames,
    },
    usage,
  };
}
