"use client";
import { memo, useCallback, useMemo, useRef } from "react";
import { Minus, Plus, Type } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildCaptionSvg } from "@/lib/subtitleSvg";
import { activeCaptionAt, revealedCountAt, sortedCaptions, PRESETS } from "@/lib/subtitles";
import { SUBTITLE_FONTS, type Caption, type SubtitleFont, type SubtitleStyle } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SubtitleTarget = "normal" | "highlight";

const SIZE_MIN = 20;
const SIZE_MAX = 220;
const SIZE_STEP = 4;
const POS_MIN = 0.08;
const POS_MAX = 0.94;

/** Quick colour presets shown alongside the native picker. */
const SWATCHES = [
  // neutrals
  "#FFFFFF", "#F5F0DC", "#F2E9D0", "#C9C9C9", "#1A1612", "#000000",
  // yellows / golds
  "#E9FF12", "#FFD60A", "#F5A623", "#D97706",
  // reds / pinks
  "#FF4D4D", "#E5484D", "#FF6B9D", "#FF2D87",
  // greens
  "#00B140", "#15803D", "#7CFC00", "#A7F3D0",
  // blues / cyans
  "#00E5FF", "#0EA5E9", "#2563EB", "#1E3A8A",
  // purples
  "#A855F7", "#7C3AED", "#C4B5FD",
  // warm accents
  "#0F766E", "#FB923C",
];

/* ============================== OVERLAY ============================== */

interface OverlayProps {
  currentMs: number;
  captions: Caption[];
  style: SubtitleStyle;
  /** Interactive: click to select (toggles the toolbar), drag to reposition. */
  editable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onChange: (next: SubtitleStyle) => void;
}

/**
 * The live caption overlay drawn over the video. Renders the EXACT same SVG
 * markup the server hands to resvg (lib/subtitleSvg.ts), sized to the video
 * via the SVG viewBox — so the preview is what you export. Clicking selects
 * the caption (parent shows the toolbar); dragging moves it vertically.
 *
 * Must live INSIDE the (overflow-hidden) video box; the toolbar is rendered
 * separately by the parent BELOW the box so it's never clipped.
 */
export function SubtitleOverlay({
  currentMs,
  captions,
  style,
  editable,
  selected,
  onToggleSelect,
  onChange,
}: OverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startPos: number; moved: boolean } | null>(null);

  const sorted = useMemo(() => sortedCaptions(captions), [captions]);
  const active = useMemo(() => activeCaptionAt(sorted, currentMs), [sorted, currentMs]);
  const revealed = active ? revealedCountAt(active.caption, currentMs) : 0;

  // Rebuild the SVG only when something visible actually changes — keeps the
  // DOM stable across the per-frame currentMs ticks.
  const boldKey = active ? active.caption.words.map((w) => (w.bold ? "1" : "0")).join("") : "";
  const svg = useMemo(() => {
    if (!style.enabled || !active) return "";
    return buildCaptionSvg({
      caption: active.caption,
      revealedCount: revealed,
      style,
      // No CSS fade: it restarted on every word-reveal re-injection, leaving
      // short captions stuck near opacity 0 ("blinking"). Instant reveal.
      animateLastWord: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    style.enabled,
    style.preset,
    style.fontFamily,
    style.fontSize,
    style.color,
    style.highlightColor,
    style.highlightFontFamily,
    style.highlightFontSize,
    style.positionY,
    active?.caption.id,
    revealed,
    boldKey,
  ]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!editable || !style.enabled) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = { startY: e.clientY, startPos: style.positionY, moved: false };
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* non-fatal: capture is a nicety, not required for the drag math */
      }
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const dy = ev.clientY - d.startY;
        if (Math.abs(dy) > 3) d.moved = true;
        const next = Math.max(POS_MIN, Math.min(POS_MAX, d.startPos + dy / rect.height));
        onChange({ ...style, positionY: next });
      };
      const onUp = () => {
        const d = dragRef.current;
        dragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (d && !d.moved) onToggleSelect(); // a click (no drag) toggles the toolbar
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [editable, style, onChange, onToggleSelect],
  );

  if (!style.enabled) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0 z-[5]",
        editable ? "cursor-grab active:cursor-grabbing" : "pointer-events-none",
        selected && "ring-1 ring-inset ring-primary/50",
      )}
      onPointerDown={onPointerDown}
      aria-label="Subtitle — drag to move vertically, click to edit"
    >
      {svg && <CaptionSvg html={svg} />}
    </div>
  );
}

/* ============================== TOOLBAR ============================== */

interface ToolbarProps {
  style: SubtitleStyle;
  target: SubtitleTarget;
  onTargetChange: (t: SubtitleTarget) => void;
  onChange: (next: SubtitleStyle) => void;
}

/**
 * The caption style toolbar. Rendered by the parent BELOW the video frame
 * (in normal flow) so it's never clipped by the frame's overflow-hidden and
 * has room for all controls. A Normal/Highlight target toggle selects which
 * text the font/size/colour controls act on — base and emphasized text are
 * styled independently.
 */
export function SubtitleToolbar({ style, target, onTargetChange, onChange }: ToolbarProps) {
  const cfg = PRESETS[style.preset];
  const isHl = target === "highlight";
  const hlFont = style.highlightFontFamily ?? cfg.emphasisFontFamily ?? style.fontFamily;
  const hlSize = style.highlightFontSize ?? Math.round(style.fontSize * cfg.emphasisScale);
  const curFont = isHl ? hlFont : style.fontFamily;
  const curSize = isHl ? hlSize : style.fontSize;
  const curColor = isHl ? style.highlightColor : style.color;

  const setFont = (v: SubtitleFont) =>
    onChange(isHl ? { ...style, highlightFontFamily: v } : { ...style, fontFamily: v });
  const setColor = (c: string) =>
    onChange(isHl ? { ...style, highlightColor: c } : { ...style, color: c });
  const setSize = (delta: number) => {
    const next = Math.max(SIZE_MIN, Math.min(SIZE_MAX, curSize + delta));
    onChange(isHl ? { ...style, highlightFontSize: next } : { ...style, fontSize: next });
  };

  return (
    <div
      className="mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border border-border/70 bg-popover/95 px-1.5 py-1 shadow-[0_10px_30px_-8px_rgb(0_0_0/0.6)]"
      role="toolbar"
      aria-label="Subtitle style"
    >
      {/* Target toggle */}
      <div className="flex items-center rounded-lg bg-muted/60 p-0.5 text-[11px] font-medium">
        <button
          type="button"
          onClick={() => onTargetChange("normal")}
          className={cn(
            "rounded-md px-2 py-1 transition-colors",
            !isHl ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={!isHl}
        >
          Normal
        </button>
        <button
          type="button"
          onClick={() => onTargetChange("highlight")}
          className={cn(
            "rounded-md px-2 py-1 transition-colors",
            isHl ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={isHl}
        >
          Highlight
        </button>
      </div>

      <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden />

      <Type className="size-3.5 text-muted-foreground" aria-hidden />
      <Select value={curFont} onValueChange={(v) => setFont(v as SubtitleFont)}>
        <SelectTrigger className="h-7 w-[8.5rem] border-0 bg-transparent px-1.5 text-xs focus:ring-1 focus:ring-primary">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUBTITLE_FONTS.map((f) => (
            <SelectItem key={f} value={f} className="text-xs">
              <span style={{ fontFamily: `"${f}"` }}>{f}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden />

      <button
        type="button"
        onClick={() => setSize(-SIZE_STEP)}
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Decrease size"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="w-7 text-center font-mono text-xs tabular-nums">{curSize}</span>
      <button
        type="button"
        onClick={() => setSize(SIZE_STEP)}
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Increase size"
      >
        <Plus className="size-3.5" />
      </button>

      <div className="mx-0.5 h-5 w-px bg-border/70" aria-hidden />

      <ColorButton
        label={isHl ? "Highlight colour" : "Text colour"}
        value={curColor}
        onChange={setColor}
        highlight={isHl}
      />
    </div>
  );
}

/* ============================== INTERNALS ============================== */

/**
 * The injected caption SVG. Memoized on the markup string so the per-frame
 * currentMs re-renders of the parent never re-set innerHTML (which would
 * flash/blink the overlay). Only an actual word-reveal/style change — which
 * changes `html` — updates the DOM. Identical to the export markup for parity.
 */
const CaptionSvg = memo(function CaptionSvg({ html }: { html: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

function ColorButton({
  label,
  value,
  onChange,
  highlight,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
  highlight?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="relative grid size-7 place-items-center rounded-md hover:bg-muted"
        >
          <span className="size-4 rounded-full border border-white/30" style={{ background: value }} />
          {highlight && (
            <span className="absolute -right-0 -top-0 text-[8px] font-bold text-amber-300">★</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="top" className="w-44 p-2">
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">{label}</div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={cn(
                "size-6 rounded-full border",
                value.toLowerCase() === c.toLowerCase() ? "border-primary ring-2 ring-primary/40" : "border-white/20",
              )}
              style={{ background: c }}
              aria-label={c}
            />
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
          />
          <span className="font-mono">{value.toUpperCase()}</span>
        </label>
      </PopoverContent>
    </Popover>
  );
}
