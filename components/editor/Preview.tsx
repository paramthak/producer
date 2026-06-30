"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/utils";
import { SubtitleOverlay, SubtitleToolbar, type SubtitleTarget } from "@/components/editor/SubtitleLayer";
import { normalizePlan, type NormalizedSegment } from "@/lib/planEdit";
import type { Caption, PlanSegment, SourceClip, SubtitleStyle } from "@/lib/types";

interface Props {
  clips: Record<string, SourceClip>;
  segments: PlanSegment[];
  /** Voiceover floor (plan.totalDurationMs). */
  totalDurationMs: number;
  voiceoverUrl: string | null;
  /** Voiceover duration in ms (audio ends here; video may run past = silent tail). */
  voiceoverDurationMs: number;
  /** Controlled seek: bump nonce to jump the clock. */
  seekRequest?: { ms: number; nonce: number } | null;
  /** Master-clock tick (ms) → drives the timeline playhead. */
  onTime?: (ms: number) => void;
  captions?: Caption[];
  subtitleStyle?: SubtitleStyle | null;
  onSubtitleStyleChange?: (s: SubtitleStyle) => void;
}

/** Build a media URL for a relative session path, reusing the clip's url base. */
function mediaUrl(clip: SourceClip, rel?: string): string {
  if (!rel) return clip.url;
  const base = clip.url.slice(0, clip.url.length - clip.relPath.length);
  return base + rel;
}
function proxyUrlFor(clip: SourceClip): string {
  return clip.kind === "image" ? clip.url : mediaUrl(clip, clip.proxyRelPath);
}

/**
 * Live preview compositor.
 *
 * Plays the LOW-RES PROXY clips stitched under the voiceover, synced by a
 * master clock — no server render. Consumes the SAME normalizePlan() output
 * the downloader uses (gaps → black, contain-letterbox) so the preview is
 * pixel-faithful to the exported MP4 (PRD §6 parity invariant).
 */
export function Preview({
  clips,
  segments,
  totalDurationMs,
  voiceoverUrl,
  voiceoverDurationMs,
  seekRequest,
  onTime,
  captions,
  subtitleStyle,
  onSubtitleStyleChange,
}: Props) {
  const normalized = useMemo(
    () => normalizePlan({ segments, totalDurationMs }),
    [segments, totalDurationMs],
  );
  const total = normalized.length ? normalized[normalized.length - 1].timelineEndMs : totalDurationMs;

  const [playing, setPlaying] = useState(false);
  const [displayMs, setDisplayMs] = useState(0);
  const [subSelected, setSubSelected] = useState(false);
  const [subTarget, setSubTarget] = useState<SubtitleTarget>("normal");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Double-buffered proxy video pool.
  const vidRefs = [useRef<HTMLVideoElement | null>(null), useRef<HTMLVideoElement | null>(null)];
  const frontRef = useRef(0); // index of the visible element
  const clockRef = useRef(0);
  const playingRef = useRef(false);
  const normRef = useRef<NormalizedSegment[]>(normalized);
  normRef.current = normalized;
  // Refs for the per-frame callbacks so the audio/clock loop NEVER restarts
  // when these identities change on re-render (e.g. a manifest refresh churns
  // `clips` → `renderAt`). Restarting the loop mid-play re-seeks/re-plays the
  // voiceover and sounds doubled/choppy.
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  const segAt = useCallback((ms: number, list: NormalizedSegment[]) => {
    return list.find((s) => ms >= s.timelineStartMs && ms < s.timelineEndMs) ?? null;
  }, []);

  // Image overlay shown when the active segment is a still image.
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // Position the proxy <video> elements + image overlay for the current clock.
  const renderAt = useCallback(
    (ms: number) => {
      const list = normRef.current;
      const active = segAt(ms, list);
      const front = vidRefs[frontRef.current].current;
      const back = vidRefs[1 - frontRef.current].current;

      if (!active || active.kind === "blank" || !active.clipId) {
        setImageUrl(null);
        if (front) front.style.opacity = "0";
        if (back) back.style.opacity = "0";
        return;
      }
      const clip = clips[active.clipId];
      if (!clip) { setImageUrl(null); return; }

      if (clip.kind === "image") {
        setImageUrl(clip.url);
        if (front) front.style.opacity = "0";
        if (back) back.style.opacity = "0";
        return;
      }
      setImageUrl(null);
      const url = proxyUrlFor(clip);
      const targetSec = (active.sourceInMs + (ms - active.timelineStartMs)) / 1000;
      const f = vidRefs[frontRef.current].current;
      if (!f) return;
      // (Re)load the front element if it isn't already on this segment.
      if (f.dataset.seg !== active.id) {
        // If the back element was preloaded with this segment, swap to it.
        const b = vidRefs[1 - frontRef.current].current;
        if (b && b.dataset.seg === active.id) {
          frontRef.current = 1 - frontRef.current;
        } else {
          f.src = url;
          f.dataset.seg = active.id;
          // Seek to the right source position once the new src has data
          // (setting currentTime before metadata loads doesn't stick).
          const aseg = active;
          const seekOnce = () => {
            try {
              f.currentTime = Math.max(0, (aseg.sourceInMs + (clockRef.current - aseg.timelineStartMs)) / 1000);
            } catch { /* ignore */ }
          };
          f.addEventListener("loadeddata", seekOnce, { once: true });
          f.load();
        }
      }
      const cur = vidRefs[frontRef.current].current!;
      cur.style.opacity = "1";
      const other = vidRefs[1 - frontRef.current].current;
      if (other) other.style.opacity = "0";
      if (cur.readyState >= 1 && Math.abs(cur.currentTime - targetSec) > 0.06) {
        try { cur.currentTime = Math.max(0, targetSec); } catch { /* not seekable yet */ }
      }
      if (playingRef.current) { void cur.play().catch(() => {}); } else { cur.pause(); }

      // Preload the next segment into the back element.
      const idx = list.indexOf(active);
      const next = list[idx + 1];
      const b = vidRefs[1 - frontRef.current].current;
      if (b && next && next.kind === "clip" && next.clipId) {
        const nc = clips[next.clipId];
        if (nc && nc.kind !== "image" && b.dataset.seg !== next.id) {
          b.src = proxyUrlFor(nc);
          b.dataset.seg = next.id;
          b.load();
        }
      }
    },
    [clips, segAt], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const renderAtRef = useRef(renderAt);
  renderAtRef.current = renderAt;

  // Keep a ref of `playing` for renderAt's play/pause decision.
  useEffect(() => { playingRef.current = playing; }, [playing]);

  // Master clock — keyed on `playing` state. Uses setInterval (not rAF) so it
  // keeps ticking when the tab is backgrounded/hidden (rAF is gated on page
  // visibility); the <video> itself plays natively-smooth regardless.
  useEffect(() => {
    if (!playing) return;
    const a = audioRef.current;
    if (a && clockRef.current < voiceoverDurationMs) {
      try { a.currentTime = clockRef.current / 1000; } catch { /* ignore */ }
      void a.play().catch(() => {});
    }
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const au = audioRef.current;
      if (au && !au.paused && clockRef.current < voiceoverDurationMs && Number.isFinite(au.currentTime)) {
        clockRef.current = au.currentTime * 1000;
      } else {
        clockRef.current += now - last;
      }
      last = now;
      if (clockRef.current >= total) {
        clockRef.current = total;
        setDisplayMs(total);
        onTimeRef.current?.(total);
        renderAtRef.current(total);
        au?.pause();
        setPlaying(false);
        return;
      }
      setDisplayMs(clockRef.current);
      onTimeRef.current?.(clockRef.current);
      renderAtRef.current(clockRef.current);
    }, 33);
    return () => {
      clearInterval(id);
      audioRef.current?.pause();
    };
    // Deps intentionally minimal — onTime/renderAt are read via refs so a
    // re-render (manifest refresh, etc.) never tears down + restarts playback.
  }, [playing, total, voiceoverDurationMs]);

  // Apply external seeks (timeline ruler / segment / caption clicks).
  useEffect(() => {
    if (!seekRequest) return;
    const ms = Math.max(0, Math.min(total, seekRequest.ms));
    clockRef.current = ms;
    setDisplayMs(ms);
    const a = audioRef.current;
    if (a && ms <= voiceoverDurationMs) { try { a.currentTime = ms / 1000; } catch { /* ignore */ } }
    renderAt(ms);
    onTime?.(ms);
  }, [seekRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-position video when the plan changes while paused (live edit feedback).
  useEffect(() => {
    if (!playingRef.current) renderAt(clockRef.current);
  }, [normalized, renderAt]);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      const next = !p;
      if (next && clockRef.current >= total) { clockRef.current = 0; setDisplayMs(0); }
      return next;
    });
  }, [total]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[18rem] max-h-[calc(100vh-19rem)] overflow-hidden rounded-2xl border border-border bg-black shadow-[0_24px_60px_-12px_rgb(0_0_0_/_0.35)]">
        {/* Proxy video pool — object-contain on black to match the renderer's letterbox-pad. */}
        {[0, 1].map((i) => (
          <video
            key={i}
            ref={vidRefs[i]}
            muted
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            style={{ opacity: 0 }}
          />
        ))}
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-contain" />
        )}
        {voiceoverUrl && <audio ref={audioRef} src={voiceoverUrl} preload="auto" />}

        {/* Live caption overlay — same SVG as the export. */}
        {subtitleStyle && captions && captions.length > 0 && (
          <SubtitleOverlay
            currentMs={displayMs}
            captions={captions}
            style={subtitleStyle}
            editable
            selected={subSelected}
            onToggleSelect={() => setSubSelected((s) => !s)}
            onChange={(s) => onSubtitleStyleChange?.(s)}
          />
        )}

        {/* Bottom controls */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent p-3">
          <div className="pointer-events-auto flex items-center gap-3">
            <Button size="icon" variant="default" className="size-10 rounded-full" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <div className="flex-1 font-mono text-xs tabular-nums text-white/90">
              {formatDuration(displayMs)} <span className="text-white/50">/ {formatDuration(total)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Caption style toolbar — below the frame so it's never clipped. */}
      {subtitleStyle?.enabled && captions && captions.length > 0 && subSelected && (
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
