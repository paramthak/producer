"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/utils";
import { SubtitleOverlay, SubtitleToolbar, type SubtitleTarget } from "@/components/editor/SubtitleLayer";
import type { Caption, EditPlan, SubtitleStyle } from "@/lib/types";

interface Props {
  /**
   * URL of the rendered preview MP4 (served via /api/media/<sessionId>/output/<filename>).
   * When null, the preview hasn't been rendered yet — we show the empty
   * state with a "Render preview" CTA.
   */
  previewMp4Url: string | null;
  /**
   * True when the current EditPlan's hash diverges from the cached
   * manifest.preview.planHash — the rendered MP4 doesn't reflect the
   * latest edits. We show a "Stale" indicator and the re-render button.
   */
  isStale: boolean;
  /** True while /api/render is running. Shows a spinner overlay. */
  isRendering: boolean;
  onRequestRerender: () => void;
  /** Used to compute active segment highlighting from currentTime. */
  segments: EditPlan["segments"];
  /** Source-of-truth for the timeline length (in case the MP4 hasn't loaded). */
  totalDurationMs: number;
  /** Optional controlled "seek to this ms" trigger; bump nonce to re-seek. */
  seekRequest?: { ms: number; nonce: number } | null;
  /** Fires on every rAF tick with the current playhead time (ms). */
  onTime?: (ms: number) => void;
  /** Fires when the active segment changes. */
  onActiveSegmentChange?: (segId: string | null) => void;
  /** Caption chunks (forced-alignment derived) for the live subtitle overlay. */
  captions?: Caption[];
  /** Global subtitle style; null hides the overlay. */
  subtitleStyle?: SubtitleStyle | null;
  /** Persist style edits (drag/toolbar) from the overlay. */
  onSubtitleStyleChange?: (s: SubtitleStyle) => void;
}

/**
 * Single-video preview.
 *
 * The rendered MP4 contains the full reel (all cuts + voiceover already
 * baked in by ffmpeg at the end of the pipeline). So playback is just one
 * <video> tag streaming one file — no parallel preloads, no source-clip
 * switching, no audio sync logic. This is the difference between "works"
 * and "unusable" once deployed behind a public network.
 *
 * Timeline chip clicks set currentTime via seekRequest. Active segment is
 * derived from currentTime against the (cached client-side) plan.
 */
export function Preview({
  previewMp4Url,
  isStale,
  isRendering,
  onRequestRerender,
  segments,
  totalDurationMs,
  seekRequest,
  onTime,
  onActiveSegmentChange,
  captions,
  subtitleStyle,
  onSubtitleStyleChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  // Subtitle editing: whether the caption is selected (shows the toolbar
  // below the frame) and which text the toolbar styles.
  const [subSelected, setSubSelected] = useState(false);
  const [subTarget, setSubTarget] = useState<SubtitleTarget>("normal");

  // Apply external seek requests (clicking a segment chip in the Timeline).
  useEffect(() => {
    if (!seekRequest) return;
    const v = videoRef.current;
    if (!v) return;
    const targetSec = Math.max(0, seekRequest.ms / 1000);
    if (Number.isFinite(v.duration) && v.duration > 0) {
      v.currentTime = Math.min(targetSec, v.duration);
    } else {
      v.currentTime = targetSec;
    }
    setCurrentMs(seekRequest.ms);
  }, [seekRequest]);

  // Drive currentMs + active-segment highlighting from the video's currentTime.
  useEffect(() => {
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const tMs = v.currentTime * 1000;
        setCurrentMs(tMs);
        onTime?.(tMs);
        const seg = segments.find((s) => tMs >= s.timelineStartMs && tMs < s.timelineEndMs);
        const id = seg?.id ?? null;
        if (id !== activeId) {
          setActiveId(id);
          onActiveSegmentChange?.(id);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [segments, activeId, onTime, onActiveSegmentChange]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const showEmptyState = !previewMp4Url;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[18rem] max-h-[calc(100vh-19rem)] overflow-hidden rounded-2xl border border-border bg-black shadow-[0_24px_60px_-12px_rgb(0_0_0_/_0.6)]">
        {showEmptyState ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm text-white/80">Preview not rendered yet</p>
            <Button
              variant="default"
              size="sm"
              onClick={onRequestRerender}
              disabled={isRendering}
              className="gap-1.5"
            >
              {isRendering ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {isRendering ? "Rendering…" : "Render preview"}
            </Button>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={previewMp4Url}
            playsInline
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}

        {/* Live caption overlay — same SVG markup as the export (parity). */}
        {!showEmptyState && subtitleStyle && captions && captions.length > 0 && (
          <SubtitleOverlay
            currentMs={currentMs}
            captions={captions}
            style={subtitleStyle}
            editable={!isRendering}
            selected={subSelected}
            onToggleSelect={() => setSubSelected((s) => !s)}
            onChange={(s) => onSubtitleStyleChange?.(s)}
          />
        )}

        {/* Stale-render warning, only when we have an MP4 but the plan changed */}
        {!showEmptyState && isStale && (
          <div className="absolute left-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-200 backdrop-blur-sm">
            <span className="size-1.5 rounded-full bg-amber-300" />
            Preview stale — re-render to see edits
          </div>
        )}

        {/* Re-rendering overlay */}
        {!showEmptyState && isRendering && (
          <div className="absolute inset-0 z-20 grid place-items-center bg-black/60 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full bg-background/80 px-4 py-2 text-sm">
              <Loader2 className="size-4 animate-spin" /> Rendering preview…
            </div>
          </div>
        )}

        {/* Bottom overlay: play/pause + time + re-render button */}
        {!showEmptyState && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent p-3">
            <div className="pointer-events-auto flex items-center gap-3">
              <Button
                size="icon"
                variant="default"
                className="size-10 rounded-full"
                onClick={toggle}
                aria-label={playing ? "Pause" : "Play"}
                disabled={isRendering}
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </Button>
              <div className="flex-1 font-mono text-xs tabular-nums text-white/90">
                {formatDuration(currentMs)}{" "}
                <span className="text-white/50">/ {formatDuration(totalDurationMs)}</span>
              </div>
              {isStale && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={onRequestRerender}
                  disabled={isRendering}
                  className="gap-1.5"
                >
                  <RefreshCw className="size-3.5" /> Re-render
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Caption style toolbar — BELOW the frame (never clipped by the
          frame's overflow-hidden), appears when the caption is selected. */}
      {!showEmptyState && subtitleStyle?.enabled && captions && captions.length > 0 && subSelected && (
        <SubtitleToolbar
          style={subtitleStyle}
          target={subTarget}
          onTargetChange={setSubTarget}
          onChange={(s) => onSubtitleStyleChange?.(s)}
        />
      )}
    </div>
  );
}
