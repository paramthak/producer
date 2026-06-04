"use client";
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/utils";
import type { EditPlan, SourceClip } from "@/lib/types";

interface Props {
  segments: EditPlan["segments"];
  clips: Record<string, SourceClip>;
  voiceoverUrl: string;
  totalDurationMs: number;
  /** Optional controlled "seek to this ms" trigger; bump value to re-seek. */
  seekRequest?: { ms: number; nonce: number } | null;
  /** Fires on every rAF with the current audio time (ms). */
  onTime?: (ms: number) => void;
}

export function Preview({ segments, clips, voiceoverUrl, totalDurationMs, seekRequest, onTime }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!seekRequest) return;
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = Math.min(seekRequest.ms / 1000, a.duration || seekRequest.ms / 1000);
    setCurrentMs(seekRequest.ms);
  }, [seekRequest]);

  useEffect(() => {
    const tick = () => {
      const a = audioRef.current;
      if (a) {
        const tMs = a.currentTime * 1000;
        setCurrentMs(tMs);
        onTime?.(tMs);
        const seg = segments.find((s) => tMs >= s.timelineStartMs && tMs < s.timelineEndMs);
        const id = seg?.id ?? null;
        if (id !== activeId) setActiveId(id);
        if (seg) {
          const target = seg.sourceInMs + (tMs - seg.timelineStartMs);
          const v = videoRefs.current.get(seg.id);
          if (v && v.tagName === "VIDEO") {
            const want = target / 1000;
            if (Math.abs(v.currentTime - want) > 0.18) v.currentTime = want;
            if (a.paused) {
              try { v.pause(); } catch {}
            } else if (v.paused) {
              v.play().catch(() => {});
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [segments, activeId, onTime]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play().catch(() => {}); setPlaying(true); }
    else { a.pause(); setPlaying(false); }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[18rem] max-h-[calc(100vh-19rem)] overflow-hidden rounded-2xl border border-border bg-black shadow-[0_24px_60px_-12px_rgb(0_0_0_/_0.6)]">
        {segments.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            No segments yet
          </div>
        )}
        {segments.map((seg) => {
          const clip = clips[seg.clipId];
          if (!clip) return null;
          const isActive = activeId === seg.id;
          if (clip.kind === "image") {
            return (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={seg.id}
                src={clip.url}
                alt=""
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-0"}`}
              />
            );
          }
          return (
            <video
              key={seg.id}
              ref={(el) => {
                if (el) videoRefs.current.set(seg.id, el);
                else videoRefs.current.delete(seg.id);
              }}
              src={clip.url}
              muted
              playsInline
              preload="auto"
              className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${isActive ? "opacity-100" : "opacity-0"}`}
            />
          );
        })}

        <audio
          ref={audioRef}
          src={voiceoverUrl}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          preload="auto"
        />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent p-3">
          <div className="pointer-events-auto flex items-center gap-3">
            <Button size="icon" variant="default" className="size-10 rounded-full" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <div className="flex-1 font-mono text-xs tabular-nums text-white/90">
              {formatDuration(currentMs)} <span className="text-white/50">/ {formatDuration(totalDurationMs)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
