import { promises as fs } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

export const DATA_ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.resolve(process.cwd(), ".producer-data");

export function sessionDir(sessionId: string): string {
  // Defensive: reject traversal.
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  return path.join(DATA_ROOT, sessionId);
}

export function paths(sessionId: string) {
  const base = sessionDir(sessionId);
  return {
    base,
    sources: path.join(base, "sources"),
    frames: path.join(base, "frames"),
    descriptions: path.join(base, "descriptions"),
    voiceover: path.join(base, "voiceover"),
    alignment: path.join(base, "alignment.json"),
    sections: path.join(base, "sections.json"),
    editPlan: path.join(base, "edit-plan.json"),
    subtitles: path.join(base, "subtitles.json"),
    output: path.join(base, "output"),
    manifest: path.join(base, "manifest.json"),
  };
}

export async function ensureSession(sessionId?: string): Promise<string> {
  const id = sessionId && /^[a-zA-Z0-9_-]{6,}$/.test(sessionId) ? sessionId : nanoid(12);
  const p = paths(id);
  await fs.mkdir(p.sources, { recursive: true });
  await fs.mkdir(p.frames, { recursive: true });
  await fs.mkdir(p.descriptions, { recursive: true });
  await fs.mkdir(p.voiceover, { recursive: true });
  await fs.mkdir(p.output, { recursive: true });
  return id;
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export function mediaUrl(sessionId: string, relPath: string): string {
  const safe = relPath.split(path.sep).map(encodeURIComponent).join("/");
  return `/api/media/${sessionId}/${safe}`;
}
