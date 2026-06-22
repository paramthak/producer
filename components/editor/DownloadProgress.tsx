"use client";
import { AlertCircle, CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export type DownloadStage =
  | "idle"
  | "preparing"
  | "downloading"
  | "saving"
  | "done"
  | "error";

export interface DownloadState {
  stage: DownloadStage;
  /** Bytes received from server so far (downloading stage). */
  receivedBytes: number;
  /** Total bytes from Content-Length, or null if server didn't send one. */
  totalBytes: number | null;
  /** Human-readable error message when stage === "error". */
  errorMessage?: string;
}

interface Props {
  state: DownloadState;
  onCancel: () => void;
  onRetry?: () => void;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Streaming-download progress modal.
 *
 * Mounts while a ZIP bundle is being generated + transferred. The parent
 * page owns the download loop (fetch + ReadableStream reader) and pushes
 * stage updates here. This component is presentational only — it renders
 * the current stage's label, a real-percentage progress bar (when total
 * is known), error messages, and the cancel/retry/close affordances.
 *
 * Why not just a toast: the bundle can take 30-60s on a real session.
 * Toasts dismiss themselves and disappear when the user clicks something
 * else. A modal stays put, blocks accidental clicks, and gives the user
 * a clear path to cancel or retry on failure.
 */
export function DownloadProgress({ state, onCancel, onRetry, onClose }: Props) {
  const isOpen = state.stage !== "idle";
  const isActive = state.stage === "preparing" || state.stage === "downloading" || state.stage === "saving";
  const isError = state.stage === "error";
  const isDone = state.stage === "done";

  const pct =
    state.totalBytes && state.totalBytes > 0
      ? Math.min(100, Math.round((state.receivedBytes / state.totalBytes) * 100))
      : null;

  const stageLabel = (() => {
    switch (state.stage) {
      case "preparing":
        return "Preparing bundle on server…";
      case "downloading":
        return pct !== null
          ? `Downloading — ${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes!)} (${pct}%)`
          : `Downloading — ${formatBytes(state.receivedBytes)} received`;
      case "saving":
        return "Saving to disk…";
      case "done":
        return "Downloaded";
      case "error":
        return "Download failed";
      default:
        return "";
    }
  })();

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o && !isActive) onClose(); }}>
      <DialogContent className="!max-w-md">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary/40">
            {isError ? (
              <AlertCircle className="size-5 text-destructive" />
            ) : isDone ? (
              <CheckCircle2 className="size-5 text-emerald-500" />
            ) : (
              <Loader2 className="size-5 animate-spin text-accent" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <DialogTitle className="font-display text-lg font-semibold">
              Project bundle (.zip)
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              {stageLabel}
            </DialogDescription>
          </div>
        </div>

        {/* Progress bar with prominent percentage. Starts at 0%, fills to
            the real byte percentage when a total is known; falls back to
            a slim shimmer when total is unknown (rather than the old
            placeholder fill that made the bar look stuck at ~33%). */}
        {(state.stage === "downloading" || state.stage === "saving") && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] tabular-nums">
              <span className="text-muted-foreground">
                {pct !== null
                  ? `${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes!)}`
                  : `${formatBytes(state.receivedBytes)} received`}
              </span>
              <span className="font-semibold text-foreground">
                {state.stage === "saving"
                  ? "100%"
                  : pct !== null
                    ? `${pct}%`
                    : "…"}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={
                  pct !== null
                    ? "h-full rounded-full bg-accent transition-[width] duration-150"
                    : "h-full w-1/4 rounded-full bg-accent/60 animate-pulse"
                }
                style={
                  pct !== null
                    ? { width: state.stage === "saving" ? "100%" : `${pct}%` }
                    : undefined
                }
              />
            </div>
          </div>
        )}

        {isError && state.errorMessage && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {state.errorMessage}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {isActive && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="gap-1.5">
              <X className="size-3.5" />
              Cancel
            </Button>
          )}
          {isError && onRetry && (
            <Button variant="default" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
          {(isError || isDone) && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
