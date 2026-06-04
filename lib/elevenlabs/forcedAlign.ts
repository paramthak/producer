import { createReadStream } from "node:fs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { withBackoff } from "@/lib/concurrency";
import type { WordTimestamp } from "@/lib/types";

let _client: ElevenLabsClient | null = null;

function client(): ElevenLabsClient {
  if (_client) return _client;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY in environment.");
  _client = new ElevenLabsClient({ apiKey });
  return _client;
}

export async function forcedAlign(
  audioPath: string,
  text: string,
  signal?: AbortSignal,
): Promise<WordTimestamp[]> {
  const response = await withBackoff(
    () =>
      client().forcedAlignment.create({
        file: createReadStream(audioPath),
        text,
      }),
    { signal },
  );
  return response.words.map((w) => ({
    text: w.text,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
}
