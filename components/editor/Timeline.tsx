"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  SECTIONS,
  SECTION_DOT_VAR,
  type Caption,
  type EditPlan,
  type PlanSegment,
  type SectionId,
  type SourceClip,
} from "@/lib/types";
import { applyMove, applySwap, applyTrim, effectiveDurationMs, findSwapTarget, MIN_SEG_MS } from "@/lib/planEdit";
import { cn, formatDuration } from "@/lib/utils";

interface Props {
  plan: EditPlan;
  clips: Record<string, SourceClip>;
  voiceoverUrl?: string | null;
  captions?: Caption[];
  currentTimeMs: number;
  selectedId: string | null;
  pxPerSec: number;
  onZoom: (pxPerSec: number) => void;
  onSeek: (ms: number) => void;
  onSelect: (id: string | null) => void;
  onChange: (plan: EditPlan) => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  onAddClipAt: (clipId: string, ms: number) => void;
}

const TRACK_H = 76;
const SNAP_PX = 8;

export function Timeline({
  plan,
  clips,
  voiceoverUrl,
  captions,
  currentTimeMs,
  selectedId,
  pxPerSec,
  onZoom,
  onSeek,
  onSelect,
  onChange,
  onSplit,
  onDeleteSelected,
  onAddClipAt,
}: Props) {
  const pxPerMs = pxPerSec / 1000;
  const total = effectiveDurationMs(plan);
  const trackWidthPx = Math.max(640, total * pxPerMs + 24);

  // A draft overlay during a drag/trim gesture so we render live but commit
  // a single history entry on pointer-up.
  const [draft, setDraft] = useState<EditPlan | null>(null);
  const view = draft ?? plan;
  const ordered = useMemo(
    () => [...view.segments].sort((a, b) => a.timelineStartMs - b.timelineStartMs),
    [view.segments],
  );

  const waveform = useWaveform(voiceoverUrl ?? null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Snap a timeline ms to nearby segment edges / playhead / second ticks.
  const snapTargets = useMemo(() => {
    const t = new Set<number>([0, currentTimeMs]);
    for (const s of plan.segments) { t.add(s.timelineStartMs); t.add(s.timelineEndMs); }
    for (let s = 0; s <= total; s += 1000) t.add(s);
    return [...t];
  }, [plan.segments, currentTimeMs, total]);

  const snap = useCallback(
    (ms: number, skipId?: string) => {
      const tol = SNAP_PX / pxPerMs;
      let best = ms, bestD = tol;
      const targets = skipId
        ? snapTargets // edges of the dragged seg are still fine to snap to others
        : snapTargets;
      for (const tgt of targets) {
        const d = Math.abs(tgt - ms);
        if (d < bestD) { best = tgt; bestD = d; }
      }
      return Math.round(best);
    },
    [snapTargets, pxPerMs],
  );

  // Scrub: pointer-down seeks immediately, then the playhead follows the mouse
  // continuously until release (not just a jump on click-up).
  const onRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const seekTo = (clientX: number) => onSeek(Math.max(0, Math.min(total, (clientX - rect.left) / pxPerMs)));
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Mirror the live draft so pointer-up can commit it FLATLY (never call a
  // parent setter inside a setDraft updater — that warns "update while
  // rendering").
  const draftRef = useRef<EditPlan | null>(null);
  const setDraftPlan = useCallback((next: EditPlan | null) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  // ---- Move a segment (drag its body) ----
  // Drop onto another clip → SWAP positions (each keeps its length); drop into
  // empty space → free move. During the drag the clip rides the cursor as a
  // ghost (no plan mutation) and the swap target is highlighted; we resolve on
  // release. The dragged clip's live x lives in `drag` (purely visual).
  const [drag, setDrag] = useState<{ id: string; leftPx: number; targetId: string | null } | null>(null);
  const onSegPointerDown = (seg: PlanSegment) => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.handle) return; // trim handle takes over
    e.preventDefault();
    onSelect(seg.id);
    onSeek(seg.timelineStartMs);
    const startX = e.clientX;
    const origStart = seg.timelineStartMs;
    const dur = seg.timelineEndMs - seg.timelineStartMs;
    let curMs = origStart;
    let curTargetId: string | null = null;
    setDrag({ id: seg.id, leftPx: origStart * pxPerMs, targetId: null });
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      curMs = snap(Math.max(0, origStart + dx / pxPerMs), seg.id);
      const target = findSwapTarget(ordered, seg.id, curMs, dur);
      curTargetId = target?.id ?? null;
      setDrag({ id: seg.id, leftPx: curMs * pxPerMs, targetId: curTargetId });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      // Commit flatly (never inside a setState updater).
      if (curTargetId) onChange(applySwap(plan, seg.id, curTargetId, clips));
      else if (Math.abs(curMs - origStart) > 1) onChange(applyMove(plan, seg.id, curMs));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Trim a segment edge ----
  const trimRef = useRef<{ id: string; side: "L" | "R"; startX: number; inMs: number; outMs: number } | null>(null);
  const onTrimDown = (seg: PlanSegment, side: "L" | "R") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(seg.id);
    const clip = clips[seg.clipId];
    trimRef.current = { id: seg.id, side, startX: e.clientX, inMs: seg.sourceInMs, outMs: seg.sourceOutMs };
    const move = (ev: PointerEvent) => {
      const t = trimRef.current;
      if (!t) return;
      const dMs = (ev.clientX - t.startX) / pxPerMs;
      if (t.side === "L") {
        const newIn = Math.max(0, Math.min(t.outMs - MIN_SEG_MS, Math.round(t.inMs + dMs)));
        setDraftPlan(applyTrim(plan, t.id, { sourceInMs: newIn }));
      } else {
        const cap = clip && clip.kind !== "image" && clip.durationMs ? clip.durationMs : t.outMs + 600000;
        const newOut = Math.max(t.inMs + MIN_SEG_MS, Math.min(cap, Math.round(t.outMs + dMs)));
        setDraftPlan(applyTrim(plan, t.id, { sourceOutMs: newOut }));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      trimRef.current = null;
      const d = draftRef.current;
      setDraftPlan(null);
      if (d) onChange(d);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- Drop a library clip ----
  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const clipId = e.dataTransfer.getData("text/clip-id");
    if (!clipId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ms = Math.max(0, (e.clientX - rect.left + (scrollerRef.current?.scrollLeft ?? 0)) / pxPerMs);
    onAddClipAt(clipId, snap(ms));
  };

  const ticks = useMemo(() => {
    const step = pxPerSec < 24 ? 5 : 1; // sparser labels when zoomed out
    const arr: number[] = [];
    for (let s = 0; s <= Math.ceil(total / 1000); s += step) arr.push(s);
    return arr;
  }, [total, pxPerSec]);

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Timeline</span>
        <div className="ml-1 flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onSplit} title="Split at playhead (S)">
            <Scissors className="size-3.5" /> Split
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs disabled:opacity-40"
            onClick={onDeleteSelected}
            disabled={!selectedId}
            title="Delete selected (Del)"
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatDuration(currentTimeMs)} / {formatDuration(total)}
          </span>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => onZoom(Math.max(12, pxPerSec - 12))} title="Zoom out">
            <ZoomOut className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => onZoom(Math.min(160, pxPerSec + 12))} title="Zoom in">
            <ZoomIn className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Scroller */}
      <div ref={scrollerRef} className="overflow-x-auto">
        <div style={{ width: trackWidthPx }} className="relative select-none">
          {/* Ruler */}
          <div
            className="relative h-6 cursor-pointer select-none border-b border-border bg-secondary/40"
            onPointerDown={onRulerPointerDown}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={currentTimeMs}
          >
            {ticks.map((s) => (
              <div key={s} className="absolute top-0 h-full" style={{ left: s * 1000 * pxPerMs }}>
                <span className="absolute left-1 top-0 font-mono text-[9px] tabular-nums text-muted-foreground">
                  {Math.floor(s / 60)}:{(s % 60).toString().padStart(2, "0")}
                </span>
                <span className="absolute bottom-0 h-2 w-px bg-border" />
              </div>
            ))}
          </div>

          {/* VIDEO lane (drop target) */}
          <div
            className={cn(
              "relative border-b border-border transition-colors",
              dragOver && "bg-accent/10",
            )}
            style={{ height: TRACK_H }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {ordered.map((seg) => (
              <SegmentCard
                key={seg.id}
                seg={seg}
                clip={clips[seg.clipId]}
                pxPerMs={pxPerMs}
                selected={seg.id === selectedId}
                active={currentTimeMs >= seg.timelineStartMs && currentTimeMs < seg.timelineEndMs}
                dragLeftPx={drag?.id === seg.id ? drag.leftPx : undefined}
                isSwapTarget={drag?.targetId === seg.id}
                onPointerDown={onSegPointerDown(seg)}
                onTrimDown={onTrimDown}
              />
            ))}
            {ordered.length === 0 && (
              <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
                Drag clips here from the library, or use the + button.
              </div>
            )}
          </div>

          {/* VOICE lane (real waveform) */}
          <div className="relative border-b border-border bg-secondary/20" style={{ height: 44 }}>
            <span className="absolute left-2 top-1 z-[1] font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Voice</span>
            <Waveform peaks={waveform} widthPx={trackWidthPx} />
          </div>

          {/* SUBS lane (only after subtitles generated) */}
          {captions && captions.length > 0 && (
            <div className="relative" style={{ height: 30 }}>
              {captions.map((c) => {
                const left = c.startMs * pxPerMs;
                const width = Math.max(10, (c.endMs - c.startMs) * pxPerMs);
                const text = c.words.map((w) => w.text).join(" ");
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onSeek(c.startMs)}
                    title={text}
                    className="absolute top-1 bottom-1 overflow-hidden rounded border border-accent/40 bg-accent/10 px-1 text-[9px] text-foreground/80 hover:bg-accent/20"
                    style={{ left, width }}
                  >
                    <span className="truncate">{text}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-[3] w-px bg-primary"
            style={{ left: currentTimeMs * pxPerMs }}
            aria-hidden="true"
          >
            <span className="absolute -left-1.5 -top-0.5 size-3 rounded-full bg-primary ring-2 ring-card" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================== SEGMENT CARD ============================== */

function SegmentCard({
  seg,
  clip,
  pxPerMs,
  selected,
  active,
  dragLeftPx,
  isSwapTarget,
  onPointerDown,
  onTrimDown,
}: {
  seg: PlanSegment;
  clip?: SourceClip;
  pxPerMs: number;
  selected: boolean;
  active: boolean;
  dragLeftPx?: number;
  isSwapTarget?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onTrimDown: (seg: PlanSegment, side: "L" | "R") => (e: React.PointerEvent) => void;
}) {
  const dragging = dragLeftPx !== undefined;
  const left = dragging ? dragLeftPx : seg.timelineStartMs * pxPerMs;
  const width = Math.max(8, (seg.timelineEndMs - seg.timelineStartMs) * pxPerMs);
  const colorVar = SECTION_DOT_VAR[seg.section];
  const posterUrl = posterUrlFor(clip);
  const [imgFailed, setImgFailed] = useState(false);
  const fallbackBg = `linear-gradient(135deg, hsl(var(${colorVar}) / 0.35), hsl(var(${colorVar}) / 0.12))`;

  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "group absolute top-1.5 bottom-1.5 cursor-grab overflow-hidden rounded-md border bg-card active:cursor-grabbing",
        dragging ? "z-[5] cursor-grabbing opacity-90 shadow-[0_12px_28px_-8px_rgba(0,0,0,0.45)] ring-2 ring-primary" :
          selected ? "ring-2 ring-accent" : active ? "ring-1 ring-primary/50" : "",
        isSwapTarget && "ring-2 ring-accent ring-offset-1 ring-offset-card",
      )}
      style={{
        left,
        width,
        borderColor: `hsl(var(${colorVar}) / 0.6)`,
        transition: dragging ? "none" : "left 120ms ease",
      }}
    >
      {/* section color strip */}
      <span className="absolute inset-x-0 top-0 z-[1] h-0.5" style={{ background: `hsl(var(${colorVar}))` }} />
      {/* thumbnail (never a video URL — placeholder while the poster is missing) */}
      {posterUrl && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={posterUrl} alt="" draggable={false} onError={() => setImgFailed(true)} className="pointer-events-none h-full w-full object-cover opacity-90" />
      ) : (
        <div className="pointer-events-none h-full w-full" style={{ background: fallbackBg }} />
      )}
      {/* label */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2">
        <span className="truncate font-mono text-[9px] text-white/90">{clip?.filename ?? "clip"}</span>
        <span className="ml-1 shrink-0 font-mono text-[9px] tabular-nums text-white/80">
          {formatDuration(seg.timelineEndMs - seg.timelineStartMs)}
        </span>
      </div>
      {/* trim handles */}
      <div
        data-handle="L"
        onPointerDown={onTrimDown(seg, "L")}
        className="absolute inset-y-0 left-0 z-[2] w-2 cursor-ew-resize bg-black/0 hover:bg-accent/70"
      />
      <div
        data-handle="R"
        onPointerDown={onTrimDown(seg, "R")}
        className="absolute inset-y-0 right-0 z-[2] w-2 cursor-ew-resize bg-black/0 hover:bg-accent/70"
      />
    </div>
  );
}

function mediaFromRel(clip: SourceClip): string {
  // posterRelPath is relative to the session base; build the same /api/media
  // URL shape the `url` field already uses (strip the trailing relPath).
  const base = clip.url.slice(0, clip.url.length - clip.relPath.length); // ".../api/media/<sid>/"
  return clip.posterRelPath ? base + clip.posterRelPath : clip.url;
}

/**
 * A poster URL that is ALWAYS a real image (or null). Never returns a video
 * source — using a .mp4/.mov as an <img src> renders the browser's broken
 * thumbnail. Videos whose proxy/poster isn't ready yet return null so the
 * caller shows a placeholder instead.
 */
function posterUrlFor(clip?: SourceClip): string | null {
  if (!clip) return null;
  if (clip.posterRelPath) return mediaFromRel(clip);
  if (clip.kind === "image") return clip.url;
  return null;
}

/* ============================== WAVEFORM ============================== */

function Waveform({ peaks, widthPx }: { peaks: number[] | null; widthPx: number }) {
  if (!peaks || peaks.length === 0) {
    return null;
  }
  const h = 36;
  const mid = h / 2;
  const step = widthPx / peaks.length;
  return (
    <svg className="absolute inset-x-0 bottom-1 left-0" width={widthPx} height={h} preserveAspectRatio="none" aria-hidden="true">
      {peaks.map((p, i) => {
        const barH = Math.max(1, p * (h - 2));
        return (
          <rect
            key={i}
            x={i * step}
            y={mid - barH / 2}
            width={Math.max(1, step - 1)}
            height={barH}
            rx={0.5}
            fill="hsl(var(--accent) / 0.55)"
          />
        );
      })}
    </svg>
  );
}

/**
 * Decode the voiceover audio in the browser and compute per-bucket peak
 * amplitudes — a real waveform aligned to time (replaces the old broken
 * word-density bars). Cached per URL.
 */
function useWaveform(url: string | null): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!url) { setPeaks(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf);
        const ch = audio.getChannelData(0);
        const BUCKETS = 600;
        const size = Math.floor(ch.length / BUCKETS) || 1;
        const out = new Array(BUCKETS).fill(0);
        for (let b = 0; b < BUCKETS; b++) {
          let peak = 0;
          const start = b * size;
          for (let i = 0; i < size; i++) {
            const v = Math.abs(ch[start + i] ?? 0);
            if (v > peak) peak = v;
          }
          out[b] = peak;
        }
        const max = Math.max(0.01, ...out);
        const norm = out.map((v) => v / max);
        void ctx.close();
        if (!cancelled) setPeaks(norm);
      } catch {
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  return peaks;
}

// keep SECTIONS referenced (section ordering is used elsewhere)
export const _SECTIONS = SECTIONS;
