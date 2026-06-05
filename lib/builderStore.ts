"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import type { ScriptLine, SectionId, SourceClip } from "@/lib/types";

const SESSION_KEY = "producer.sessionId";

export function loadSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(SESSION_KEY);
}

export function saveSessionId(id: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(SESSION_KEY, id);
}

export function clearSessionId() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_KEY);
}

export interface ManifestShape {
  sessionId: string;
  createdAt: number;
  clips: SourceClip[];
  voiceover: { filename: string; relPath: string; url: string; sizeBytes: number } | null;
  script: ScriptLine[];
  overridePrompt: string;
}

export function useSessionManifest() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ManifestShape | null>(null);
  const [loading, setLoading] = useState(true);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    (async () => {
      let id = loadSessionId();
      if (!id) {
        const res = await fetch("/api/session", { method: "POST" });
        const json = (await res.json()) as { sessionId: string };
        id = json.sessionId;
        saveSessionId(id);
      }
      setSessionId(id);
      const m = await fetch(`/api/manifest?sessionId=${id}`);
      const data = (await m.json()) as { manifest: ManifestShape | null };
      if (data.manifest) setManifest(data.manifest);
      else
        setManifest({
          sessionId: id,
          createdAt: Date.now(),
          clips: [],
          voiceover: null,
          script: [],
          overridePrompt: "",
        });
      setLoading(false);
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const m = await fetch(`/api/manifest?sessionId=${sessionId}`);
    const data = (await m.json()) as { manifest: ManifestShape | null };
    if (data.manifest) setManifest(data.manifest);
  }, [sessionId]);

  const patch = useCallback(
    async (changes: Partial<Pick<ManifestShape, "script" | "overridePrompt">>) => {
      if (!sessionId) return;
      setManifest((m) => (m ? { ...m, ...changes } : m));
      await fetch("/api/manifest", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...changes }),
      });
    },
    [sessionId],
  );

  return { sessionId, manifest, setManifest, loading, refresh, patch };
}

// === Chunked upload ===
//
// Why chunked? Railway's edge proxy enforces a 5-minute (300s) hard timeout
// on any single HTTP request. A 200-500 MB file on home wifi hits that cap
// and the upload dies mid-stream with ECONNRESET. Splitting into ~10 MB
// chunks means every chunk completes in seconds and the per-request timeout
// is never close to relevant. The server appends each chunk to a .part file
// and atomically renames to the final path on the last chunk.
//
// Why XMLHttpRequest, not fetch? XHR is the only browser API that emits
// upload progress events (xhr.upload.onprogress). We need byte-level
// progress for the UI; fetch() can't do that.

export type UploadStatus = "uploading" | "done" | "failed";

export interface UploadProgress {
  uploadId: string;
  filename: string;
  totalBytes: number;
  uploadedBytes: number;
  status: UploadStatus;
  error?: string;
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB — comfortably under any timeout
const CHUNK_RETRIES = 2;

function makeUploadId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return "up_" + crypto.randomUUID().replace(/-/g, "");
  }
  return "up_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function postChunkWithXhr(
  url: string,
  chunk: Blob,
  onLoaded: (bytes: number) => void,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onLoaded(e.loaded);
    });
    xhr.addEventListener("load", () => {
      onLoaded(chunk.size);
      resolve({ status: xhr.status, body: xhr.responseText });
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () => reject(new Error("Aborted")));
    xhr.addEventListener("timeout", () => reject(new Error("Timeout")));
    xhr.send(chunk);
  });
}

async function uploadFileChunked(opts: {
  url: (chunkIndex: number, totalChunks: number, uploadId: string) => string;
  file: File;
  uploadId: string;
  filename: string;
  onProgress: (p: UploadProgress) => void;
}): Promise<{ status: number; body: string }> {
  const { url, file, uploadId, filename, onProgress } = opts;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  let finishedBytes = 0;
  let finalResponse: { status: number; body: string } | null = null;

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const chunkUrl = url(i, totalChunks, uploadId);

    let lastErr: unknown = null;
    let succeeded = false;
    for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
      try {
        const res = await postChunkWithXhr(chunkUrl, chunk, (bytesInThisChunk) => {
          onProgress({
            uploadId,
            filename,
            totalBytes: file.size,
            uploadedBytes: finishedBytes + bytesInThisChunk,
            status: "uploading",
          });
        });
        if (res.status >= 200 && res.status < 300) {
          succeeded = true;
          finishedBytes += chunk.size;
          if (i === totalChunks - 1) finalResponse = res;
          break;
        }
        // Non-2xx response. Try to surface the server's error message.
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(res.body) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* ignore */
        }
        lastErr = new Error(msg);
      } catch (err) {
        lastErr = err;
      }
      // Backoff before retry: 1s, 2s.
      if (attempt < CHUNK_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!succeeded) {
      const msg = lastErr instanceof Error ? lastErr.message : "Upload failed";
      onProgress({
        uploadId,
        filename,
        totalBytes: file.size,
        uploadedBytes: finishedBytes,
        status: "failed",
        error: msg,
      });
      throw new Error(msg);
    }
  }

  if (!finalResponse) {
    // Defensive — should always be set on the last successful chunk.
    throw new Error("Upload finished without a final response");
  }
  return finalResponse;
}

export async function uploadClip(
  sessionId: string,
  section: SectionId,
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<SourceClip> {
  const uploadId = makeUploadId();
  const noop = () => {};
  const progress = onProgress ?? noop;

  const res = await uploadFileChunked({
    url: (chunkIndex, totalChunks, id) => {
      const params = new URLSearchParams({
        sessionId,
        section,
        kind: "clip",
        filename: file.name,
        uploadId: id,
        chunkIndex: String(chunkIndex),
        totalChunks: String(totalChunks),
      });
      return `/api/upload?${params.toString()}`;
    },
    file,
    uploadId,
    filename: file.name,
    onProgress: progress,
  });

  const parsed = (() => {
    try {
      return JSON.parse(res.body) as { clip?: SourceClip; error?: string };
    } catch {
      return null;
    }
  })();
  if (!parsed?.clip) {
    const msg = parsed?.error ?? `Upload failed (${res.status})`;
    progress({
      uploadId,
      filename: file.name,
      totalBytes: file.size,
      uploadedBytes: file.size,
      status: "failed",
      error: msg,
    });
    throw new Error(msg);
  }

  progress({
    uploadId,
    filename: file.name,
    totalBytes: file.size,
    uploadedBytes: file.size,
    status: "done",
  });
  return parsed.clip;
}

export async function uploadVoiceover(
  sessionId: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,
) {
  const uploadId = makeUploadId();
  const noop = () => {};
  const progress = onProgress ?? noop;

  const res = await uploadFileChunked({
    url: (chunkIndex, totalChunks, id) => {
      const params = new URLSearchParams({
        sessionId,
        kind: "voiceover",
        filename: file.name,
        uploadId: id,
        chunkIndex: String(chunkIndex),
        totalChunks: String(totalChunks),
      });
      return `/api/upload?${params.toString()}`;
    },
    file,
    uploadId,
    filename: file.name,
    onProgress: progress,
  });

  const parsed = (() => {
    try {
      return JSON.parse(res.body) as {
        sessionId?: string;
        voiceover?: ManifestShape["voiceover"];
        durationMs?: number;
        error?: string;
      };
    } catch {
      return null;
    }
  })();
  if (!parsed?.voiceover) {
    const msg = parsed?.error ?? `Upload failed (${res.status})`;
    progress({
      uploadId,
      filename: file.name,
      totalBytes: file.size,
      uploadedBytes: file.size,
      status: "failed",
      error: msg,
    });
    throw new Error(msg);
  }

  progress({
    uploadId,
    filename: file.name,
    totalBytes: file.size,
    uploadedBytes: file.size,
    status: "done",
  });
  return {
    sessionId: parsed.sessionId ?? sessionId,
    voiceover: parsed.voiceover,
    durationMs: parsed.durationMs ?? 0,
  };
}

export async function deleteClip(sessionId: string, clipId: string): Promise<void> {
  const res = await fetch(`/api/upload/${clipId}?sessionId=${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}

/** Nuke the current session on the server, clear local pointer, hard reload. */
export async function resetSession(currentSessionId: string | null): Promise<void> {
  if (currentSessionId) {
    await fetch(`/api/session?sessionId=${currentSessionId}`, { method: "DELETE" }).catch(() => {});
  }
  clearSessionId();
  if (typeof window !== "undefined") {
    window.location.assign("/");
  }
}
