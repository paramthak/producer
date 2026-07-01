"use client";
import { useCallback, useId, useRef, useState } from "react";
import { Plus, X, Film, Image as ImageIcon, AlertCircle, Loader2, CheckCircle2, RotateCw, HardDrive } from "lucide-react";
import { SectionDot } from "./SectionDot";
import { Button } from "@/components/ui/button";
import { DriveBrowser } from "@/components/drive/DriveBrowser";
import { formatDuration } from "@/lib/utils";
import {
  IMAGE_EXTS,
  VIDEO_EXTS,
  SECTION_DOT_VAR,
  SECTION_LABEL,
  type SectionId,
  type SourceClip,
} from "@/lib/types";
import { uploadClip, deleteClip, type UploadProgress } from "@/lib/builderStore";
import { toast } from "sonner";

interface Props {
  sessionId: string;
  section: SectionId;
  clips: SourceClip[];
  onChange: () => void;
}

const ACCEPT = [...VIDEO_EXTS, ...IMAGE_EXTS].join(",");
const ACCEPT_TYPES = new Set([...VIDEO_EXTS, ...IMAGE_EXTS] as readonly string[]);

interface PendingUpload {
  uploadId: string;
  file: File;
  progress: UploadProgress;
}

function formatMB(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

export function SectionBucket({ sessionId, section, clips, onChange }: Props) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // In-flight + failed uploads keyed by uploadId. We surface progress + status
  // here so the user always sees what's happening, never a blank screen.
  const [pending, setPending] = useState<Record<string, PendingUpload>>({});
  const [driveOpen, setDriveOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const setProgress = useCallback((uploadId: string, file: File, p: UploadProgress) => {
    setPending((prev) => ({
      ...prev,
      [uploadId]: { uploadId, file, progress: p },
    }));
  }, []);

  const removePending = useCallback((uploadId: string) => {
    setPending((prev) => {
      const next = { ...prev };
      delete next[uploadId];
      return next;
    });
  }, []);

  const uploadOne = useCallback(
    async (f: File) => {
      // Generate a placeholder uploadId for the UI; the real one is generated
      // inside uploadClip, and the first onProgress callback will replace this
      // entry. To keep the UI stable we key by a local id we control.
      const localId = `local_${Math.random().toString(36).slice(2)}`;
      setPending((prev) => ({
        ...prev,
        [localId]: {
          uploadId: localId,
          file: f,
          progress: {
            uploadId: localId,
            filename: f.name,
            totalBytes: f.size,
            uploadedBytes: 0,
            status: "uploading",
          },
        },
      }));

      try {
        await uploadClip(sessionId, section, f, (p) => {
          // Re-key under the real uploadId on first event, then keep updating.
          setPending((prev) => {
            const next = { ...prev };
            delete next[localId];
            next[p.uploadId] = { uploadId: p.uploadId, file: f, progress: p };
            return next;
          });
        });
        // Success — remove from pending after a beat so the "done" tick is visible.
        setPending((prev) => {
          const next = { ...prev };
          // Drop any entry matching this file.
          for (const k of Object.keys(next)) if (next[k].file === f) delete next[k];
          return next;
        });
        onChange();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Upload failed";
        toast.error(`${f.name}: ${msg}`);
        // Leave the failed entry visible with a Retry button (state already set
        // by the onProgress callback with status="failed").
      }
    },
    [sessionId, section, onChange],
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      const accepted: File[] = [];
      let badType = false;
      for (const f of arr) {
        const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
        if (ACCEPT_TYPES.has(ext)) accepted.push(f);
        else badType = true;
      }
      setError(badType ? "Only .mp4, .mov, .png, .jpg are supported." : null);
      if (!accepted.length) return;
      // Upload sequentially within a single bucket — keeps the user's
      // bandwidth focused on one file at a time and avoids overwhelming the
      // server. Multi-selecting still shows ALL files in the pending list
      // with clear waiting/active states.
      for (const f of accepted) {
        await uploadOne(f);
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [uploadOne],
  );

  const retryUpload = useCallback(
    async (entry: PendingUpload) => {
      removePending(entry.uploadId);
      await uploadOne(entry.file);
    },
    [removePending, uploadOne],
  );

  const pendingList = Object.values(pending);
  const isUploading = pendingList.some((p) => p.progress.status === "uploading");

  return (
    <div
      className={`group relative flex flex-col rounded-xl border ${
        dragging ? "border-accent bg-accent/5" : "border-border bg-card/60"
      } backdrop-blur-sm transition-colors`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-4">
        <div className="flex items-center gap-2">
          <SectionDot section={section} />
          <h3 className="font-display text-sm font-semibold tracking-tight">{SECTION_LABEL[section]}</h3>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {clips.length} {clips.length === 1 ? "clip" : "clips"}
            {isUploading && <span className="ml-1 text-accent">· uploading…</span>}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDriveOpen(true)}
            title="Import from Google Drive"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background/40 px-2 text-xs transition-colors hover:bg-muted/40"
          >
            <HardDrive className="size-3" /> Drive
          </button>
          <label htmlFor={inputId} className="cursor-pointer">
            <input
              id={inputId}
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
            <span className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-background/40 px-2 text-xs hover:bg-muted/40 transition-colors">
              <Plus className="size-3" /> Add
            </span>
          </label>
        </div>
      </div>

      <DriveBrowser
        open={driveOpen}
        onOpenChange={setDriveOpen}
        sessionId={sessionId}
        section={section}
        onImported={() => onChange()}
      />

      <div className="flex flex-1 flex-col gap-2 px-4 pb-4 pt-3 min-h-[8.5rem]">
        {/* In-flight + failed uploads */}
        {pendingList.length > 0 && (
          <ul className="flex flex-col gap-2" role="list">
            {pendingList.map((entry) => {
              const p = entry.progress;
              const pct = p.totalBytes > 0 ? Math.min(100, Math.round((p.uploadedBytes / p.totalBytes) * 100)) : 0;
              const failed = p.status === "failed";
              return (
                <li
                  key={entry.uploadId}
                  className={`flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 ${
                    failed ? "border-destructive/40 bg-destructive/5" : "border-accent/40 bg-accent/5"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted/50">
                      {failed ? (
                        <AlertCircle className="size-4 text-destructive" />
                      ) : p.status === "done" ? (
                        <CheckCircle2 className="size-4 text-emerald-500" />
                      ) : (
                        <Loader2 className="size-4 animate-spin text-accent" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-xs font-medium">{p.filename}</div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">
                        {failed ? (
                          <span className="text-destructive">{p.error ?? "Failed"}</span>
                        ) : (
                          <>
                            {formatMB(p.uploadedBytes)} / {formatMB(p.totalBytes)} MB · {pct}%
                          </>
                        )}
                      </div>
                    </div>
                    {failed && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Retry upload"
                        onClick={() => void retryUpload(entry)}
                      >
                        <RotateCw className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label="Dismiss"
                      onClick={() => removePending(entry.uploadId)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                  {!failed && (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-accent transition-[width] duration-150"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Completed clips */}
        {clips.length === 0 && pendingList.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-3 py-6 text-center">
            <p className="text-xs text-muted-foreground">Drop clips or images here</p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              .mp4 · .mov · .png · .jpg
            </p>
          </div>
        ) : clips.length > 0 ? (
          <ul className="flex flex-col gap-2" role="list">
            {clips.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
              >
                <div className="relative size-10 shrink-0 overflow-hidden rounded-md bg-muted">
                  {c.kind === "image" ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={c.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <video
                      src={c.url}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-cover"
                    />
                  )}
                  <span
                    className="absolute right-0.5 top-0.5 inline-flex size-3.5 items-center justify-center rounded-sm bg-background/80 text-foreground"
                    aria-hidden="true"
                  >
                    {c.kind === "image" ? <ImageIcon className="size-2.5" /> : <Film className="size-2.5" />}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-xs font-medium">{c.filename}</div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">
                    {c.kind === "video"
                      ? `${formatDuration(c.durationMs)} · ${formatMB(c.sizeBytes)}MB`
                      : `image · ${formatMB(c.sizeBytes)}MB`}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Remove ${c.filename}`}
                  onClick={async () => {
                    await deleteClip(sessionId, c.id).catch(() => {});
                    onChange();
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            <AlertCircle className="mt-0.5 size-3 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Accent line at top */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px rounded-t-xl opacity-70"
        style={{ background: `linear-gradient(90deg, transparent, hsl(var(${SECTION_DOT_VAR[section]}) / 0.6), transparent)` }}
      />
    </div>
  );
}
