"use client";
import { useCallback, useRef, useState } from "react";
import { Bold, Captions, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PRESETS, applyPreset, sortedCaptions, cleanCaptionWord } from "@/lib/subtitles";
import {
  SUBTITLE_PRESETS,
  type Caption,
  type SubtitlePreset,
  type SubtitleStyle,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  style: SubtitleStyle;
  captions: Caption[];
  onStyleChange: (s: SubtitleStyle) => void;
  onCaptionsChange: (c: Caption[]) => void;
}

/**
 * Right-side caption editor. Each caption renders on its own line (mirroring
 * VEED's subtitle list). The user selects word(s) and presses ⌘/Ctrl+B or the
 * Bold button to emphasize them; a single click on a word toggles it directly.
 * Emphasis (the `bold` flag) is the only per-caption edit — text & timing stay
 * locked to the forced alignment so subtitles always match the audio.
 */
export function SubtitleScriptBox({ style, captions, onStyleChange, onCaptionsChange }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const ordered = sortedCaptions(captions);

  // Inline spelling edit of a single word (double-click). Timing + bold stay;
  // only the word's text changes, and it's still auto-cleaned on display.
  const [editing, setEditing] = useState<{ capId: string; wi: number } | null>(null);
  const [draftText, setDraftText] = useState("");
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitEdit = useCallback(
    (capId: string, wi: number, text: string) => {
      setEditing(null);
      const trimmed = text.trim();
      const cur = captions.find((c) => c.id === capId)?.words[wi]?.text ?? "";
      if (!trimmed || trimmed === cur) return; // no-op / empty guard
      const next = captions.map((c) =>
        c.id === capId
          ? { ...c, words: c.words.map((w, i) => (i === wi ? { ...w, text: trimmed } : w)) }
          : c,
      );
      onCaptionsChange(next);
    },
    [captions, onCaptionsChange],
  );

  const beginEdit = useCallback((capId: string, wi: number, current: string) => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    setDraftText(current);
    setEditing({ capId, wi });
  }, []);

  const setBoldForIds = useCallback(
    (targets: Map<string, Set<number>>, forceBold?: boolean) => {
      // Decide the toggle direction: if every targeted word is already bold,
      // un-bold; otherwise bold them all.
      let allBold = true;
      for (const c of captions) {
        const wis = targets.get(c.id);
        if (!wis) continue;
        for (const wi of wis) if (!c.words[wi]?.bold) allBold = false;
      }
      const makeBold = forceBold ?? !allBold;
      const next = captions.map((c) => {
        const wis = targets.get(c.id);
        if (!wis || !wis.size) return c;
        return {
          ...c,
          words: c.words.map((w, wi) => (wis.has(wi) ? { ...w, bold: makeBold } : w)),
        };
      });
      onCaptionsChange(next);
    },
    [captions, onCaptionsChange],
  );

  /** Toggle every word touched by the current text selection. */
  const applyToSelection = useCallback(() => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !listRef.current) return;
    const targets = new Map<string, Set<number>>();
    listRef.current.querySelectorAll<HTMLElement>("[data-cap]").forEach((el) => {
      if (sel.containsNode(el, true)) {
        const ci = el.dataset.cap!;
        const wi = Number(el.dataset.word);
        if (!targets.has(ci)) targets.set(ci, new Set());
        targets.get(ci)!.add(wi);
      }
    });
    if (targets.size) {
      setBoldForIds(targets);
      sel.removeAllRanges();
    }
  }, [setBoldForIds]);

  const toggleWord = useCallback(
    (capId: string, wi: number) => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      // Ignore the click if the user was making a multi-word selection.
      if (sel && !sel.isCollapsed) return;
      setBoldForIds(new Map([[capId, new Set([wi])]]));
    },
    [setBoldForIds],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        applyToSelection();
      }
    },
    [applyToSelection],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Enable + preset */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Captions className="size-4 text-primary" />
          Subtitles
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={style.enabled}
          onClick={() => onStyleChange({ ...style, enabled: !style.enabled })}
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
            style.enabled ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "inline-block size-4 transform rounded-full bg-white transition-transform",
              style.enabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      <div className={cn("flex flex-col gap-3", !style.enabled && "pointer-events-none opacity-40")}>
        {/* Preset switcher */}
        <div className="grid grid-cols-2 gap-2">
          {SUBTITLE_PRESETS.map((p) => (
            <PresetCard
              key={p}
              preset={p}
              active={style.preset === p}
              onSelect={() => onStyleChange(applyPreset(style, p))}
            />
          ))}
        </div>

        {/* Emphasis controls */}
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] leading-tight text-muted-foreground">
            Click a word to emphasize · <span className="text-foreground/80">double-click to fix spelling</span>.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            onClick={applyToSelection}
          >
            <Bold className="size-3.5" /> Emphasize
          </Button>
        </div>

        {/* Caption list — one chunk per line */}
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="max-h-[42vh] overflow-y-auto rounded-lg border border-border/60 bg-background/40 p-2 outline-none focus:ring-1 focus:ring-primary/40"
        >
          {ordered.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">No captions yet.</p>
          )}
          {ordered.map((c) => (
            <div key={c.id} className="rounded-md px-1.5 py-1 text-sm leading-relaxed hover:bg-muted/40">
              {c.words.map((w, wi) => {
                // Show the cleaned display form (same as the captions); skip
                // tokens that clean to empty (pure punctuation).
                const display = cleanCaptionWord(w.text);
                if (!display) return null;
                const isEditing = editing?.capId === c.id && editing?.wi === wi;
                return (
                  <span key={wi}>
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        onBlur={() => commitEdit(c.id, wi, draftText)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitEdit(c.id, wi, draftText); }
                          else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                        size={Math.max(2, draftText.length)}
                        className="rounded-sm border border-primary/60 bg-background px-1 text-sm text-foreground outline-none"
                      />
                    ) : (
                      <span
                        data-cap={c.id}
                        data-word={wi}
                        title="Click to emphasize · double-click to fix spelling"
                        onClick={() => {
                          if (clickTimer.current) clearTimeout(clickTimer.current);
                          clickTimer.current = setTimeout(() => { toggleWord(c.id, wi); clickTimer.current = null; }, 200);
                        }}
                        onDoubleClick={() => beginEdit(c.id, wi, display)}
                        className={cn(
                          "cursor-pointer rounded-sm px-0.5 transition-colors",
                          w.bold
                            ? "font-bold text-primary"
                            : "text-foreground/85 hover:text-foreground",
                        )}
                      >
                        {display}
                      </span>
                    )}{" "}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  active,
  onSelect,
}: {
  preset: SubtitlePreset;
  active: boolean;
  onSelect: () => void;
}) {
  const cfg = PRESETS[preset];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative rounded-lg border p-2 text-left transition-colors",
        active ? "border-primary bg-primary/10" : "border-border/60 hover:border-border",
      )}
    >
      {active && (
        <Check className="absolute right-1.5 top-1.5 size-3.5 text-primary" aria-hidden />
      )}
      <div className="text-xs font-medium">{cfg.label}</div>
      <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{cfg.description}</div>
    </button>
  );
}
