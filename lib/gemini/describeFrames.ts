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

export async function describeClip(input: DescribeInput, signal?: AbortSignal): Promise<ClipAnalysis> {
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

  return {
    clipId: input.clipId,
    summary: parsed.summary ?? "",
    frames,
  };
}
