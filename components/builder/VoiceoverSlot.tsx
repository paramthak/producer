"use client";
import { useId, useRef, useState } from "react";
import { Mic, Upload, X, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AUDIO_EXTS } from "@/lib/types";
import { uploadVoiceover, type ManifestShape } from "@/lib/builderStore";
import { formatDuration } from "@/lib/utils";

interface Props {
  sessionId: string;
  voiceover: ManifestShape["voiceover"];
  onChange: () => void;
}

const ACCEPT = AUDIO_EXTS.join(",");
const ACCEPT_TYPES = new Set<string>([...AUDIO_EXTS] as readonly string[]);

export function VoiceoverSlot({ sessionId, voiceover, onChange }: Props) {
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ACCEPT_TYPES.has(ext)) {
      setError("Upload an audio file (.mp3, .wav, or .m4a).");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await uploadVoiceover(sessionId, file);
      setDurationMs(res.durationMs);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        className="surface flex items-center gap-4 px-4 py-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
      >
        <div className="grid size-10 place-items-center rounded-lg bg-secondary/40">
          <Mic className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          {voiceover ? (
            <>
              <div className="truncate text-sm font-medium">{voiceover.filename}</div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {durationMs ? `${formatDuration(durationMs)} · ` : ""}
                {(voiceover.sizeBytes / 1_048_576).toFixed(1)}MB
              </div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium">Upload one voiceover for the whole reel</div>
              <div className="text-[11px] text-muted-foreground">.mp3, .wav, or .m4a</div>
            </>
          )}
        </div>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          disabled={busy}
        />
        {voiceover ? (
          <div className="flex items-center gap-1">
            <label htmlFor={inputId} className="cursor-pointer">
              <span className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-border bg-background/40 px-2.5 text-xs hover:bg-muted/40 transition-colors">
                <Upload className="size-3" /> Replace
              </span>
            </label>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Remove voiceover"
              onClick={() => {
                /* not strictly required for v0; replace covers it */
                toast.message("Use Replace to swap the voiceover.");
              }}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <label htmlFor={inputId} className="cursor-pointer">
            <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-soft hover:bg-accent/90 transition-colors">
              <Upload className="size-3.5" /> Upload
            </span>
          </label>
        )}
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
