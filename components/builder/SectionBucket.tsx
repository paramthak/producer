"use client";
import { useCallback, useId, useRef, useState } from "react";
import { Plus, X, Film, Image as ImageIcon, AlertCircle } from "lucide-react";
import { SectionDot } from "./SectionDot";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/utils";
import {
  IMAGE_EXTS,
  VIDEO_EXTS,
  SECTION_DOT_VAR,
  SECTION_LABEL,
  type SectionId,
  type SourceClip,
} from "@/lib/types";
import { uploadClip, deleteClip } from "@/lib/builderStore";
import { toast } from "sonner";

interface Props {
  sessionId: string;
  section: SectionId;
  clips: SourceClip[];
  onChange: () => void;
}

const ACCEPT = [...VIDEO_EXTS, ...IMAGE_EXTS].join(",");
const ACCEPT_TYPES = new Set([...VIDEO_EXTS, ...IMAGE_EXTS] as readonly string[]);

export function SectionBucket({ sessionId, section, clips, onChange }: Props) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      setBusy(true);
      try {
        for (const f of accepted) {
          try {
            await uploadClip(sessionId, section, f);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Upload failed");
          }
        }
        onChange();
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [sessionId, section, onChange],
  );

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
          </span>
        </div>
        <label htmlFor={inputId} className="cursor-pointer">
          <input
            id={inputId}
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
            disabled={busy}
          />
          <span className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-background/40 px-2 text-xs hover:bg-muted/40 transition-colors">
            <Plus className="size-3" /> Add
          </span>
        </label>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-4 pb-4 pt-3 min-h-[8.5rem]">
        {clips.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-3 py-6 text-center">
            <p className="text-xs text-muted-foreground">Drop clips or images here</p>
            <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              .mp4 · .mov · .png · .jpg
            </p>
          </div>
        ) : (
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
                      ? `${formatDuration(c.durationMs)} · ${(c.sizeBytes / 1_048_576).toFixed(1)}MB`
                      : `image · ${(c.sizeBytes / 1_048_576).toFixed(1)}MB`}
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
        )}
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
