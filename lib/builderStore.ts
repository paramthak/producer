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

// Stream the raw file body to the server with metadata in query params.
// Sidesteps Next.js's req.formData() parser which fails on files >~10 MiB.
export async function uploadClip(
  sessionId: string,
  section: SectionId,
  file: File,
): Promise<SourceClip> {
  const params = new URLSearchParams({
    sessionId,
    section,
    kind: "clip",
    filename: file.name,
  });
  const res = await fetch(`/api/upload?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Upload failed (${res.status})`);
  }
  const data = (await res.json()) as { clip: SourceClip };
  return data.clip;
}

export async function uploadVoiceover(sessionId: string, file: File) {
  const params = new URLSearchParams({
    sessionId,
    kind: "voiceover",
    filename: file.name,
  });
  const res = await fetch(`/api/upload?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Upload failed (${res.status})`);
  }
  return (await res.json()) as {
    sessionId: string;
    voiceover: ManifestShape["voiceover"];
    durationMs: number;
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
