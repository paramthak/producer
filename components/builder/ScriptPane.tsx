"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { SectionDot } from "./SectionDot";
import { SECTIONS, SECTION_DOT_VAR, type ScriptLine, type SectionId } from "@/lib/types";

/** Accepted label keywords → canonical section id. */
const LABEL_MAP: Record<string, SectionId> = {
  hook: "hook",
  bridge: "bridge",
  body: "body",
  "body/product": "body",
  product: "body",
  outro: "outro",
  cta: "cta",
};

/** What we type back into the textarea when reconstructing existing tagged script. */
const LABEL_FOR_RECONSTRUCT: Record<SectionId, string> = {
  hook: "hook",
  bridge: "bridge",
  body: "product",
  outro: "outro",
  cta: "cta",
};

const LABEL_REGEX = /^\s*(hook|bridge|body\/product|body|product|outro|cta)\s*:\s*/i;

interface Props {
  value: ScriptLine[];
  onChange: (lines: ScriptLine[]) => void;
}

interface HighlightSegment {
  text: string;
  label?: SectionId;
}

function reconstructRaw(lines: ScriptLine[]): string {
  if (!lines.length) return "";
  let lastSection: SectionId | null = null;
  const out: string[] = [];
  for (const l of lines) {
    if (l.section && l.section !== lastSection) {
      lastSection = l.section;
      if (out.length) out.push("");
      out.push(`${LABEL_FOR_RECONSTRUCT[l.section]}: ${l.text}`);
    } else {
      out.push(l.text);
    }
  }
  return out.join("\n");
}

function parseRaw(raw: string, existing: ScriptLine[]): ScriptLine[] {
  const split = raw.split(/\r?\n/);
  const out: ScriptLine[] = [];
  let current: SectionId | null = null;
  const usedIds = new Set<string>();

  for (const rawLine of split) {
    const m = LABEL_REGEX.exec(rawLine);
    let text: string;
    if (m) {
      const key = m[1].toLowerCase();
      current = LABEL_MAP[key] ?? current;
      text = rawLine.slice(m[0].length);
    } else {
      text = rawLine;
    }
    if (!text.trim()) continue;

    const reuse = existing.find((e) => e.text === text && !usedIds.has(e.id));
    const id = reuse?.id ?? nanoid(8);
    usedIds.add(id);
    out.push({ id, text, section: current });
  }
  return out;
}

/** Build colorable segments for the syntax-highlight overlay. */
function highlightSegments(raw: string): HighlightSegment[] {
  const lines = raw.split(/\r?\n/);
  const out: HighlightSegment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = LABEL_REGEX.exec(line);
    if (m) {
      const sectionId = LABEL_MAP[m[1].toLowerCase()];
      const labelText = line.slice(0, m[0].length);
      const rest = line.slice(m[0].length);
      out.push({ text: labelText, label: sectionId });
      if (rest) out.push({ text: rest });
    } else if (line) {
      out.push({ text: line });
    }
    if (i < lines.length - 1) out.push({ text: "\n" });
  }
  // Trailing newline so the pre's last line height matches the textarea exactly.
  out.push({ text: "\n" });
  return out;
}

export function ScriptPane({ value, onChange }: Props) {
  const initial = useMemo(() => reconstructRaw(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [raw, setRaw] = useState(initial);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const lines = parseRaw(raw, value);
    onChange(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const linesWithText = value.filter((l) => l.text.trim().length > 0);
  const untagged = linesWithText.filter((l) => !l.section).length;
  const sectionsUsed = new Set(linesWithText.map((l) => l.section).filter(Boolean));

  const insertLabel = (sectionId: SectionId) => {
    const label = LABEL_FOR_RECONSTRUCT[sectionId];
    setRaw((prev) => {
      if (!prev.trim()) return `${label}: `;
      const needsBreak = !prev.endsWith("\n");
      return `${prev}${needsBreak ? "\n\n" : "\n"}${label}: `;
    });
    // Move focus back to the textarea after inserting.
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const pos = el.value.length;
      el.setSelectionRange(pos, pos);
      el.scrollTop = el.scrollHeight;
    });
  };

  const syncScroll = () => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const segments = useMemo(() => highlightSegments(raw), [raw]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>Script</span>
        <span className="tabular-nums">{raw.length} chars</span>
      </div>

      <div className="relative w-full rounded-md border border-input bg-input/40 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
        <pre
          ref={preRef}
          aria-hidden
          style={{ scrollbarWidth: "none" }}
          className="pointer-events-none absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px] leading-[1.7] text-foreground [&::-webkit-scrollbar]:hidden"
        >
          {segments.map((seg, i) =>
            seg.label ? (
              <span
                key={i}
                className="font-semibold"
                style={{ color: `hsl(var(${SECTION_DOT_VAR[seg.label]}))` }}
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </pre>
        {/*
          Selection-color fix: textarea text is `text-transparent` so the
          colored <pre> underneath shows through. But selecting text reveals
          the textarea's "invisible" glyphs against the selection background
          as ghost characters doubled with the <pre>'s colored version.
          Forcing ::selection foreground to transparent keeps selected
          glyphs invisible — only the <pre>'s coloring shows even when
          highlighted.

          Drag-drop suppression: the textarea has no business accepting
          files. Without these handlers, the browser renders a file-preview
          overlay (e.g. PDF icon) when something is dragged over.
        */}
        <style>{`
          .producer-script-textarea::selection { color: transparent; }
          .producer-script-textarea::-moz-selection { color: transparent; }
        `}</style>
        <textarea
          ref={taRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onScroll={syncScroll}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "none";
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          spellCheck={false}
          placeholder={`Paste your script, then mark sections with inline labels.\n\nhook: …\nbridge: …\nproduct: …\noutro: …\ncta: …`}
          style={{ caretColor: "hsl(var(--foreground))" }}
          className="producer-script-textarea relative block min-h-[15rem] w-full resize-y bg-transparent px-3 py-2 font-mono text-[13px] leading-[1.7] text-transparent caret-foreground outline-none placeholder:text-muted-foreground"
          aria-label="Script text"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Insert:</span>
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => insertLabel(s)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 font-mono text-[11px] transition-colors hover:bg-muted/50"
            style={{ color: `hsl(var(${SECTION_DOT_VAR[s]}))` }}
            aria-label={`Insert ${LABEL_FOR_RECONSTRUCT[s]} label`}
          >
            <SectionDot section={s} />
            {LABEL_FOR_RECONSTRUCT[s]}:
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between text-[11px]">
        <span className="tabular-nums text-muted-foreground">
          {linesWithText.length - untagged} of {linesWithText.length}{" "}
          {linesWithText.length === 1 ? "line" : "lines"} tagged
          {sectionsUsed.size > 0 && ` · ${sectionsUsed.size} ${sectionsUsed.size === 1 ? "section" : "sections"}`}
        </span>
        {untagged > 0 && (
          <span className="text-destructive">Add a section label before the first line.</span>
        )}
      </div>
    </div>
  );
}
