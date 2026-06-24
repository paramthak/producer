"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Replace, GripVertical, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  SECTIONS,
  SECTION_LABEL,
  SECTION_DOT_VAR,
  type Caption,
  type EditPlan,
  type PlanSegment,
  type SectionId,
  type SourceClip,
  type WordTimestamp,
} from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

interface Props {
  plan: EditPlan;
  clips: Record<string, SourceClip>;
  clipsBySection: Record<SectionId, SourceClip[]>;
  totalDurationMs: number;
  voiceoverWords?: WordTimestamp[];
  /** Caption chunks for the SUBS track (read-only; click to seek). */
  captions?: Caption[];
  currentTimeMs?: number;
  onSeek?: (ms: number) => void;
  onChange: (plan: EditPlan) => void;
}

const PX_PER_SEC = 36;
const TRACK_HEIGHT = 88;
const MIN_SEG_MS = 80;

/**
 * Ripple-shift one segment's duration change: keep its timelineStartMs,
 * recompute its timelineEndMs from the new source range, and shift all
 * later segments by the delta. Other segments — and any gaps before this
 * one — keep their original positions. This is the standard NLE ripple
 * edit, replacing the old `recompute()` that snapped everything to t=0.
 */
function applySegmentPatch(plan: EditPlan, segId: string, patch: Partial<PlanSegment>): EditPlan {
  const idx = plan.segments.findIndex((s) => s.id === segId);
  if (idx < 0) return plan;

  // Treat segments in timeline order for the ripple math, but keep the
  // returned segments in their original array order so React keys stay stable.
  const inTimelineOrder = [...plan.segments].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const orderIdx = inTimelineOrder.findIndex((s) => s.id === segId);
  const orig = inTimelineOrder[orderIdx];

  const merged = { ...orig, ...patch };
  const newDur = Math.max(MIN_SEG_MS, merged.sourceOutMs - merged.sourceInMs);
  const newEnd = merged.timelineStartMs + newDur;
  const oldDur = orig.timelineEndMs - orig.timelineStartMs;
  const delta = newDur - oldDur;
  merged.timelineEndMs = newEnd;

  const shiftedById = new Map<string, PlanSegment>();
  shiftedById.set(merged.id, merged);
  for (let i = orderIdx + 1; i < inTimelineOrder.length; i++) {
    const s = inTimelineOrder[i];
    shiftedById.set(s.id, {
      ...s,
      timelineStartMs: s.timelineStartMs + delta,
      timelineEndMs: s.timelineEndMs + delta,
    });
  }

  const next = plan.segments.map((s) => shiftedById.get(s.id) ?? s);
  const totalDurationMs = Math.max(
    plan.totalDurationMs,
    ...next.map((s) => s.timelineEndMs),
  );
  return { segments: next, totalDurationMs };
}

/**
 * Ripple-reorder within a section: lay the new section order back-to-back
 * starting at the section's original startMs (so gaps before/after the
 * section are preserved), then shift everything after the section by the
 * delta in section length.
 */
function applySectionReorder(
  plan: EditPlan,
  section: SectionId,
  newSectionSegments: PlanSegment[],
): EditPlan {
  const inOrder = [...plan.segments].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const oldSectionSegs = inOrder.filter((s) => s.section === section);
  if (oldSectionSegs.length === 0) return plan;

  const sectionStart = oldSectionSegs[0].timelineStartMs;
  const oldSectionEnd = oldSectionSegs[oldSectionSegs.length - 1].timelineEndMs;

  let cursor = sectionStart;
  const repositionedSection = newSectionSegments.map((s) => {
    const dur = Math.max(MIN_SEG_MS, s.sourceOutMs - s.sourceInMs);
    const out: PlanSegment = { ...s, timelineStartMs: cursor, timelineEndMs: cursor + dur };
    cursor += dur;
    return out;
  });
  const newSectionEnd = cursor;
  const delta = newSectionEnd - oldSectionEnd;

  const updatedById = new Map<string, PlanSegment>();
  for (const r of repositionedSection) updatedById.set(r.id, r);
  for (const s of inOrder) {
    if (updatedById.has(s.id)) continue;
    if (s.timelineStartMs >= oldSectionEnd && delta !== 0) {
      updatedById.set(s.id, {
        ...s,
        timelineStartMs: s.timelineStartMs + delta,
        timelineEndMs: s.timelineEndMs + delta,
      });
    } else {
      updatedById.set(s.id, s);
    }
  }

  const next = plan.segments.map((s) => updatedById.get(s.id) ?? s);
  const totalDurationMs = Math.max(
    plan.totalDurationMs,
    ...next.map((s) => s.timelineEndMs),
  );
  return { segments: next, totalDurationMs };
}

export function Timeline({
  plan,
  clips,
  clipsBySection,
  totalDurationMs,
  voiceoverWords,
  captions,
  currentTimeMs = 0,
  onSeek,
  onChange,
}: Props) {
  const total = Math.max(totalDurationMs, plan.totalDurationMs, 1000);
  const pxPerMs = PX_PER_SEC / 1000;
  const trackWidthPx = Math.max(800, total * pxPerMs + 80);

  // Order segments and group by section for sortable within-section.
  const ordered = useMemo(() => [...plan.segments].sort((a, b) => a.timelineStartMs - b.timelineStartMs), [plan.segments]);
  const groupedIds = useMemo(() => {
    const m: Record<SectionId, string[]> = { hook: [], bridge: [], body: [], outro: [], cta: [] };
    for (const s of ordered) m[s.section].push(s.id);
    return m;
  }, [ordered]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const updateSegment = useCallback(
    (id: string, patch: Partial<PlanSegment>) => {
      onChange(applySegmentPatch(plan, id, patch));
    },
    [plan, onChange],
  );

  const swapSegment = useCallback(
    (segId: string, newClipId: string) => {
      const seg = plan.segments.find((s) => s.id === segId);
      const newClip = clips[newClipId];
      if (!seg || !newClip) return;
      const dur = seg.timelineEndMs - seg.timelineStartMs;
      updateSegment(segId, {
        clipId: newClipId,
        sourceInMs: 0,
        sourceOutMs: newClip.kind === "image" ? dur : Math.min(newClip.durationMs, dur),
        whyClip: `Swapped to ${newClip.filename}`,
        whyTrim: "Re-trim with the edge handles if needed.",
      });
    },
    [plan, clips, updateSegment],
  );

  const onDragEnd = (section: SectionId) => (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = groupedIds[section];
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const reorderedIdsForSection = arrayMove(ids, from, to);
    const sectionSegs = ordered.filter((s) => s.section === section);
    const byId = Object.fromEntries(sectionSegs.map((s) => [s.id, s]));
    const newSectionSegs = reorderedIdsForSection.map((id) => byId[id]);
    // Ripple-reorder: keep the section anchored where it started, lay the
    // reordered segments back-to-back from there, shift later sections by
    // the resulting delta. Gaps elsewhere in the plan are preserved.
    onChange(applySectionReorder(plan, section, newSectionSegs));
  };

  // Section windows — derived from segment positions (start of first, end of last per section).
  const sectionBands = useMemo(() => {
    const arr: Array<{ section: SectionId; startMs: number; endMs: number }> = [];
    for (const sec of SECTIONS) {
      const segs = ordered.filter((s) => s.section === sec);
      if (!segs.length) continue;
      arr.push({
        section: sec,
        startMs: segs[0].timelineStartMs,
        endMs: segs[segs.length - 1].timelineEndMs,
      });
    }
    return arr;
  }, [ordered]);

  // Voiceover waveform: derive intensity bars from word density.
  const waveform = useMemo(() => {
    if (!voiceoverWords?.length) return null;
    const bucketMs = 100;
    const buckets = Math.ceil(total / bucketMs);
    const heights = new Array(buckets).fill(0);
    for (const w of voiceoverWords) {
      const idx = Math.floor((w.startMs + w.endMs) / 2 / bucketMs);
      if (idx >= 0 && idx < buckets && w.text.trim().length) {
        heights[idx] += Math.min(1, (w.endMs - w.startMs) / 250);
      }
    }
    const max = Math.max(0.001, ...heights);
    return heights.map((h) => h / max);
  }, [voiceoverWords, total]);

  // Ticks every 5s
  const ticks = useMemo(() => {
    const t: number[] = [];
    for (let s = 0; s <= Math.ceil(total / 1000); s += 1) t.push(s);
    return t;
  }, [total]);

  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
    const ms = (x / pxPerMs);
    onSeek(Math.max(0, Math.min(total, ms)));
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card/40 backdrop-blur-md">
      <div style={{ width: trackWidthPx }} className="relative select-none">
        {/* Ruler */}
        <div
          className="relative h-7 cursor-pointer border-b border-border/80 bg-background/40"
          onClick={handleRulerClick}
          role="slider"
          aria-label="Timeline scrubber"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={currentTimeMs}
        >
          {ticks.map((s) => (
            <div
              key={s}
              className="absolute top-0 flex h-full select-none flex-col items-start"
              style={{ left: s * pxPerMs * 1000 }}
            >
              <span className="absolute -top-0.5 left-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                {Math.floor(s / 60)}:{(s % 60).toString().padStart(2, "0")}
              </span>
              <span className={cn("absolute bottom-0 w-px", s % 5 === 0 ? "h-3 bg-border" : "h-1.5 bg-border/60")} />
            </div>
          ))}
          {/* Section colored bands at top of ruler */}
          {sectionBands.map((b) => (
            <div
              key={b.section}
              className="absolute top-0 h-[3px] rounded-full"
              style={{
                left: b.startMs * pxPerMs,
                width: Math.max(4, (b.endMs - b.startMs) * pxPerMs),
                background: `hsl(var(${SECTION_DOT_VAR[b.section]}))`,
                boxShadow: `0 0 12px hsl(var(${SECTION_DOT_VAR[b.section]}) / 0.65)`,
              }}
              aria-hidden="true"
            />
          ))}
        </div>

        {/* VIDEO row */}
        <div className="relative border-b border-border/60" style={{ height: TRACK_HEIGHT }}>
          <RowLabel label="VIDEO" />
          {/* Section background bands */}
          {sectionBands.map((b) => (
            <div
              key={b.section}
              className="absolute top-0 bottom-0 rounded-md"
              style={{
                left: b.startMs * pxPerMs,
                width: Math.max(0, (b.endMs - b.startMs) * pxPerMs),
                background: `hsl(var(${SECTION_DOT_VAR[b.section]}) / 0.06)`,
              }}
            />
          ))}
          {/* Clip cards — one DndContext per section so reorder stays within-section */}
          {SECTIONS.map((sec) => {
            const ids = groupedIds[sec];
            if (!ids.length) return null;
            return (
              <DndContext key={sec} sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd(sec)}>
                <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
                  {ids.map((id) => {
                    const seg = ordered.find((s) => s.id === id)!;
                    return (
                      <SortableClip
                        key={id}
                        segment={seg}
                        clip={clips[seg.clipId]}
                        pxPerMs={pxPerMs}
                        pool={clipsBySection[seg.section]}
                        onSwap={(cid) => swapSegment(seg.id, cid)}
                        onTrim={(patch) => updateSegment(seg.id, patch)}
                      />
                    );
                  })}
                </SortableContext>
              </DndContext>
            );
          })}
        </div>

        {/* VOICEOVER row */}
        <div className="relative" style={{ height: 56 }}>
          <RowLabel label="VOICE" />
          {sectionBands.map((b) => (
            <div
              key={b.section}
              className="absolute top-1 bottom-1 rounded-md"
              style={{
                left: b.startMs * pxPerMs,
                width: Math.max(0, (b.endMs - b.startMs) * pxPerMs),
                background: `linear-gradient(180deg, hsl(var(${SECTION_DOT_VAR[b.section]}) / 0.18), hsl(var(${SECTION_DOT_VAR[b.section]}) / 0.06))`,
                border: `1px solid hsl(var(${SECTION_DOT_VAR[b.section]}) / 0.35)`,
              }}
              aria-hidden="true"
            />
          ))}
          {/* Waveform bars */}
          {waveform && (
            <div className="pointer-events-none absolute inset-y-2 left-0 right-0 flex items-end gap-px pl-12">
              {waveform.map((h, i) => (
                <div
                  key={i}
                  className="rounded-sm bg-foreground/70"
                  style={{
                    height: `${Math.max(6, h * 100)}%`,
                    width: 2,
                    transform: `translateX(${i * 2 * (pxPerMs * 100 / 2) / Math.max(1, pxPerMs * 100 / 2) - i * 2}px)`,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* SUBS row */}
        {captions && captions.length > 0 && (
          <div className="relative border-t border-border/60" style={{ height: 44 }}>
            <RowLabel label="SUBS" />
            {captions.map((c) => {
              const left = c.startMs * pxPerMs;
              const width = Math.max(8, (c.endMs - c.startMs) * pxPerMs);
              const text = c.words.map((w) => w.text).join(" ");
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSeek?.(c.startMs)}
                  title={text}
                  className="absolute top-1.5 bottom-1.5 z-[2] flex items-center overflow-hidden rounded-md border border-primary/40 bg-primary/10 px-1.5 text-[10px] text-foreground/80 hover:bg-primary/20"
                  style={{ left, width }}
                >
                  <span className="truncate">
                    {c.words.map((w, i) => (
                      <span key={i} className={w.bold ? "font-bold text-primary" : undefined}>
                        {w.text}
                        {i < c.words.length - 1 ? " " : ""}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Playhead */}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-aurora"
          style={{ left: currentTimeMs * pxPerMs, boxShadow: "0 0 12px 1px hsl(322 90% 60% / 0.7)" }}
          aria-hidden="true"
        >
          <span className="absolute -left-1.5 -top-1 size-3 rounded-full bg-aurora ring-2 ring-background" />
        </div>
      </div>
    </div>
  );
}

function RowLabel({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[1] flex h-full w-12 items-center justify-center border-r border-border/60 bg-background/70 backdrop-blur-md">
      <span className="rotate-0 font-mono text-[9px] tracking-[0.18em] text-muted-foreground">{label}</span>
    </div>
  );
}

interface ClipProps {
  segment: PlanSegment;
  clip?: SourceClip;
  pxPerMs: number;
  pool: SourceClip[];
  onSwap: (clipId: string) => void;
  onTrim: (patch: Partial<PlanSegment>) => void;
}

function SortableClip({ segment, clip, pxPerMs, pool, onSwap, onTrim }: ClipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: segment.id });
  const left = segment.timelineStartMs * pxPerMs;
  const width = Math.max(40, (segment.timelineEndMs - segment.timelineStartMs) * pxPerMs);
  const sectionColorVar = `var(--section-${segment.section === "body" ? "body" : segment.section})`;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    left,
    width,
  };

  // Trim handles
  const trimRef = useRef<{ side: "L" | "R"; startX: number; startIn: number; startOut: number } | null>(null);
  const onTrimDown = (side: "L" | "R") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    trimRef.current = { side, startX: e.clientX, startIn: segment.sourceInMs, startOut: segment.sourceOutMs };
    const move = (ev: PointerEvent) => {
      const t = trimRef.current;
      if (!t || !clip) return;
      const dMs = (ev.clientX - t.startX) / pxPerMs;
      if (t.side === "L") {
        const newIn = Math.max(0, Math.min(t.startOut - 100, Math.round(t.startIn + dMs)));
        onTrim({ sourceInMs: newIn });
      } else {
        const cap = clip.kind === "image" ? t.startOut + 600000 : clip.durationMs || t.startOut + 60000;
        const newOut = Math.max(t.startIn + 100, Math.min(cap, Math.round(t.startOut + dMs)));
        onTrim({ sourceOutMs: newOut });
      }
    };
    const up = () => {
      trimRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        // @ts-expect-error CSS custom var
        "--seg-color": `hsl(${sectionColorVar})`,
      }}
      className={cn(
        "absolute top-1.5 bottom-1.5 z-[2] flex select-none flex-col overflow-hidden rounded-lg border bg-card/80 backdrop-blur-sm transition-shadow",
        segment.hold ? "border-dashed border-border/70" : "border-[color:var(--seg-color)]/60",
        isDragging && "z-[3] shadow-[0_8px_28px_-8px_var(--seg-color)] ring-1 ring-[color:var(--seg-color)]",
      )}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{ background: `linear-gradient(180deg, var(--seg-color), transparent 60%)` }}
        aria-hidden="true"
      />

      {/* Trim handles */}
      <div
        className="absolute inset-y-0 left-0 z-[3] w-1.5 cursor-ew-resize transition-colors hover:bg-[color:var(--seg-color)]"
        onPointerDown={onTrimDown("L")}
      />
      <div
        className="absolute inset-y-0 right-0 z-[3] w-1.5 cursor-ew-resize transition-colors hover:bg-[color:var(--seg-color)]"
        onPointerDown={onTrimDown("R")}
      />

      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1 z-[4] grid size-5 cursor-grab place-items-center rounded-sm bg-background/70 text-muted-foreground opacity-0 transition-opacity hover:opacity-100 active:cursor-grabbing"
        aria-label="Drag to reorder within section"
      >
        <GripVertical className="size-3" />
      </button>

      {/* Thumbnail / preview */}
      <div className="relative h-12 w-full overflow-hidden bg-black/40">
        {clip && (clip.kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={clip.url} alt="" className="h-full w-full object-cover" />
        ) : (
          <video src={clip.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ))}
        {segment.hold && (
          <span className="absolute right-1 top-1 rounded bg-background/80 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            HOLD
          </span>
        )}
        {/* Section accent stripe */}
        <span
          className="absolute inset-x-0 bottom-0 h-px"
          style={{ background: "var(--seg-color)" }}
          aria-hidden="true"
        />
      </div>

      <div className="relative z-[2] flex items-center justify-between gap-1 px-1.5 py-1">
        <span className="font-mono text-[10px] tabular-nums text-foreground/80">
          {formatDuration(segment.timelineEndMs - segment.timelineStartMs)}
        </span>
        <div className="flex items-center gap-0.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6" aria-label="Why this clip">
                <Info className="size-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 text-xs">
              <div className="space-y-2">
                <div>
                  <div className="font-medium">Why this clip</div>
                  <p className="text-muted-foreground">{segment.whyClip || "—"}</p>
                </div>
                <div>
                  <div className="font-medium">Why this trim</div>
                  <p className="text-muted-foreground">{segment.whyTrim || "—"}</p>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          {pool.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-6" aria-label="Swap clip">
                  <Replace className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Swap with</DropdownMenuLabel>
                {pool
                  .filter((c) => c.id !== segment.clipId)
                  .map((c) => (
                    <DropdownMenuItem key={c.id} onClick={() => onSwap(c.id)}>
                      <span className="truncate">{c.filename}</span>
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
}

// suppress unused import linting
export const _SECTION_LABEL = SECTION_LABEL;
