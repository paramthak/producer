"use client";
import { Check, Loader2, X } from "lucide-react";
import { PHASE_LABEL, PHASES, type PhaseState } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PhaseStrip({ phases }: { phases: PhaseState[] }) {
  const map = new Map(phases.map((p) => [p.id, p]));
  return (
    <ol className="grid gap-3" role="list">
      {PHASES.map((id, i) => {
        const p = map.get(id);
        const status = p?.status ?? "pending";
        return (
          <li key={id} className="flex items-start gap-3">
            <div className="flex flex-col items-center pt-1">
              <div
                className={cn(
                  "grid size-7 place-items-center rounded-full border text-[11px] font-medium tabular-nums",
                  status === "complete" && "border-accent bg-accent text-accent-foreground",
                  status === "running" && "border-accent text-foreground shadow-glow",
                  status === "failed" && "border-destructive bg-destructive text-destructive-foreground",
                  status === "pending" && "border-border bg-card text-muted-foreground",
                  status === "skipped" && "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                {status === "complete" ? (
                  <Check className="size-3.5" />
                ) : status === "running" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : status === "failed" ? (
                  <X className="size-3.5" />
                ) : (
                  i + 1
                )}
              </div>
              {i < PHASES.length - 1 && (
                <div
                  className={cn(
                    "mt-1 h-9 w-px",
                    status === "complete" ? "bg-accent/70" : "bg-border/60",
                  )}
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="flex-1 pb-1">
              <div
                className={cn(
                  "font-medium tracking-tight",
                  status === "pending" ? "text-muted-foreground" : "text-foreground",
                  status === "failed" ? "text-destructive" : "",
                )}
              >
                {PHASE_LABEL[id]}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {p?.detail ?? (status === "pending" ? "Waiting…" : status === "running" ? "Working…" : "")}
              </div>
              {typeof p?.progress === "number" && status === "running" && (
                <div className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-accent transition-[width]"
                    style={{ width: `${Math.round(p.progress * 100)}%` }}
                  />
                </div>
              )}
              {p?.error && (
                <div className="mt-1 text-xs text-destructive">{p.error}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
