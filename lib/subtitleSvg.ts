/**
 * The single source of truth for how a caption looks.
 *
 * `buildCaptionSvg` returns an SVG string in the 1080×1920 export coordinate
 * space. The browser overlay injects this exact string (scaled to the video
 * via the SVG viewBox) and the server renderer hands the exact same string to
 * resvg → so the live preview and the exported pixels are produced from one
 * markup. No second layout engine, no drift.
 *
 * Isomorphic — no Node imports.
 */

import type { Caption, SubtitleStyle } from "@/lib/types";
import { PRESETS } from "@/lib/subtitles";

const CANVAS_W = 1080;
const CANVAS_H = 1920;

export interface BuildCaptionSvgOpts {
  caption: Caption;
  /** Number of leading words to show (karaoke). Defaults to all words. */
  revealedCount?: number;
  style: SubtitleStyle;
  /** Solid background colour (e.g. chroma green). Omit/null for transparent. */
  background?: string | null;
  /** Add an 80ms fade to the newest word (browsers honour it; resvg ignores). */
  animateLastWord?: boolean;
}

interface Line {
  words: { text: string; bold: boolean }[];
  /** Uniform boldness for two-tier lines; null for a mixed single line. */
  uniformBold: boolean | null;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the empty (no caption) SVG — used for lead-in/pause spans. */
export function buildEmptySvg(background?: string | null): string {
  const bg = background ? `<rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${xmlEscape(background)}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">${bg}</svg>`;
}

export function buildCaptionSvg(opts: BuildCaptionSvgOpts): string {
  const { caption, style, background } = opts;
  const cfg = PRESETS[style.preset];
  const revealed =
    opts.revealedCount === undefined
      ? caption.words.length
      : Math.max(0, Math.min(caption.words.length, opts.revealedCount));
  const words = caption.words.slice(0, revealed);
  if (!words.length) return buildEmptySvg(background);

  const baseFamily = style.fontFamily;
  // Emphasis font/size are independently editable; fall back to the preset's
  // intrinsic emphasis font and scaled size when not explicitly set (old data).
  const empFamily = style.highlightFontFamily ?? cfg.emphasisFontFamily ?? style.fontFamily;
  const baseSize = style.fontSize;
  const empSize = style.highlightFontSize ?? Math.round(style.fontSize * cfg.emphasisScale);

  // ---- group words into lines ----
  const lines: Line[] = [];
  if (cfg.twoTier) {
    // New line whenever boldness flips between adjacent words.
    let cur: Line | null = null;
    for (const w of words) {
      if (!cur || cur.uniformBold !== w.bold) {
        cur = { words: [], uniformBold: w.bold };
        lines.push(cur);
      }
      cur.words.push({ text: w.text, bold: w.bold });
    }
  } else {
    lines.push({ words: words.map((w) => ({ text: w.text, bold: w.bold })), uniformBold: null });
  }

  // ---- vertical metrics ----
  const lineSizeOf = (ln: Line): number => {
    if (ln.uniformBold === true) return empSize;
    if (ln.uniformBold === false) return baseSize;
    // mixed single line → size by the tallest run present
    return ln.words.some((w) => w.bold) ? empSize : baseSize;
  };
  const LINE_SPACING = 1.16;
  const lineHeights = lines.map((ln) => lineSizeOf(ln) * LINE_SPACING);
  const totalH = lineHeights.reduce((a, b) => a + b, 0);
  const centerY = style.positionY * CANVAS_H;
  let top = centerY - totalH / 2;

  const anchor = cfg.align === "center" ? "middle" : "start";
  const x = cfg.anchorX;

  const lastWordGlobalIdx = words.length - 1;
  let wordCursor = 0;

  const textEls: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const lh = lineHeights[li];
    const size = lineSizeOf(ln);
    const baseline = top + size * 0.9;
    top += lh;

    if (ln.uniformBold !== null) {
      // Uniform line (two-tier): one <text>, all runs share style.
      const emp = ln.uniformBold;
      const family = emp ? empFamily : baseFamily;
      const weight = emp ? cfg.emphasisWeight : cfg.baseWeight;
      const italic = emp ? cfg.emphasisItalic : cfg.baseItalic;
      const fill = emp ? style.highlightColor : style.color;
      const text = ln.words.map((w) => xmlEscape(w.text)).join(" ");
      const isLastLine = li === lines.length - 1;
      const cls = opts.animateLastWord && isLastLine ? ' class="sw-new"' : "";
      textEls.push(
        `<text${cls} x="${x}" y="${baseline.toFixed(1)}" text-anchor="${anchor}" ` +
          `font-family="${xmlEscape(family)}" font-size="${size}" font-weight="${weight}" ` +
          `font-style="${italic ? "italic" : "normal"}" fill="${xmlEscape(fill)}">${text}</text>`,
      );
      wordCursor += ln.words.length;
    } else {
      // Mixed single line (centered): per-word <tspan>s on one baseline.
      const tspans: string[] = [];
      for (let wi = 0; wi < ln.words.length; wi++) {
        const w = ln.words[wi];
        const sep = wi > 0 ? " " : "";
        const isLast = wordCursor === lastWordGlobalIdx;
        const cls = opts.animateLastWord && isLast ? ' class="sw-new"' : "";
        if (w.bold) {
          tspans.push(
            `${sep}<tspan${cls} font-family="${xmlEscape(empFamily)}" font-size="${empSize}" ` +
              `font-weight="${cfg.emphasisWeight}" font-style="${cfg.emphasisItalic ? "italic" : "normal"}" ` +
              `fill="${xmlEscape(style.highlightColor)}">${xmlEscape(w.text)}</tspan>`,
          );
        } else if (cls) {
          tspans.push(`${sep}<tspan${cls}>${xmlEscape(w.text)}</tspan>`);
        } else {
          tspans.push(`${sep}${xmlEscape(w.text)}`);
        }
        wordCursor++;
      }
      textEls.push(
        `<text x="${x}" y="${baseline.toFixed(1)}" text-anchor="${anchor}" ` +
          `font-family="${xmlEscape(baseFamily)}" font-size="${baseSize}" font-weight="${cfg.baseWeight}" ` +
          `font-style="${cfg.baseItalic ? "italic" : "normal"}" fill="${xmlEscape(style.color)}">${tspans.join("")}</text>`,
      );
    }
  }

  const defs = cfg.shadow
    ? `<defs><filter id="sw-shadow" x="-20%" y="-20%" width="140%" height="140%">` +
      `<feDropShadow dx="0" dy="3" stdDeviation="7" flood-color="#062a0c" flood-opacity="0.45"/></filter></defs>`
    : "";
  const groupOpen = cfg.shadow ? `<g filter="url(#sw-shadow)">` : `<g>`;
  const styleBlock = opts.animateLastWord
    ? `<style>.sw-new{animation:swfade .08s ease-out}@keyframes swfade{from{opacity:0}to{opacity:1}}</style>`
    : "";
  const bg = background
    ? `<rect width="${CANVAS_W}" height="${CANVAS_H}" fill="${xmlEscape(background)}"/>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">` +
    styleBlock +
    defs +
    bg +
    groupOpen +
    textEls.join("") +
    `</g></svg>`
  );
}
