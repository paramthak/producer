# Producer — PRD: Live Editor Revamp

Status: Draft for build · Author: Param + Claude · Date: 2026-06-30
Scope: One large change set. Read [context.md](context.md) first; this PRD assumes that mental model.

---

## 0. TL;DR

Turn Producer from a *render-then-watch* tool into a *live, Premiere-grade editor* with a calm editorial look (the **indiamade** design language).

1. **Rip out all NLE/export plumbing** — XMEML, ZIP bundle, standalone XML, and the entire filename-sanitization / `safeName` / `disambiguateNames` apparatus. Gone.
2. **Rebuild the timeline** into a fluid single-track NLE: free drag placement, a clip library to drag/`+` from, split-at-playhead, edge-trim, delete-to-blank, clip reuse, undo/redo, true Premiere overwrite. Sections become color tags, not constraints.
3. **Live preview, no per-edit render.** On upload we generate tiny **proxy** clips; the editor plays them stitched and synced to the voiceover in-browser. Editing is instant. The end-of-pipeline full render is **removed**.
4. **Full render only on "Download MP4"** — and it must be **pixel-identical** to the proxy preview (hard invariant).
5. **Subtitles on-demand** via a "Generate subtitles" action; rich color palette; global styling; text locked to the voiceover.
6. **Download MP4 → three choices:** clean · burned-in subtitles · clean + separate green-screen subtitle file (two downloads together).
7. **Declutter + redesign:** remove "Reel stats" and instruction panels; keep Steering; fix the broken voiceover waveform (use a *real* sampled waveform); re-skin the whole app to the indiamade editorial theme; interactions must be **buttery-smooth, Premiere-grade**.

Design work uses the **ui-ux-pro-max** skill. Every feature gets **end-to-end QA** (§13).

---

## 1. Goals & non-goals

### Goals
- A timeline that feels like a real NLE: reposition any clip anywhere, split, trim, delete, add-from-library, reuse, undo/redo — with **smooth, non-jittery** interactions.
- Instant visual feedback while editing — no ffmpeg between edits.
- The exported MP4 exactly reflects the live preview.
- Subtitles as an opt-in, post-edit step with a broad color palette and vertical positioning.
- A lighter, calmer, editorial UI (indiamade reference).

### Non-goals
- Multi-user / collaboration (still single-user, one session on disk — invariant unchanged).
- Multi-track *video* compositing (PiP/overlays). One video track + one voiceover track + a subtitle overlay layer.
- Audio editing/mixing beyond the existing silence-trim. Voiceover is the only sound; clip audio is always discarded.
- Premiere/Resolve/FCP interoperability — deliberately dropped.
- Transitions/effects between clips (hard cuts only).
- Editing caption *text* (locked to the forced alignment); fully-editable text and per-caption color/position are out of scope.
- Filmstrip (multi-thumbnail) clip cards — single poster thumbnail per clip in v1.

---

## 2. Decisions locked (clarifying Q&A)

| # | Decision |
|---|---|
| D1 | **Live preview engine:** low-res proxy clips generated at upload, played in-browser synced to the voiceover. No per-edit render. |
| D2 | **Section model:** one free timeline. Sections become color/metadata tags only — no placement constraints. |
| D3 | **Overlap rule:** true Premiere **overwrite** — the dropped clip wins; the underlying clip is trimmed where covered (and split into two if covered mid-clip). |
| D4 | **Delete:** explicit delete → that span goes **black** for the clip's duration. No ripple. |
| D5 | **No end-of-pipeline render.** Editor opens straight into the live proxy preview. |
| D6 | **Full render only on Download MP4**, and it **must exactly match** the proxy preview (parity invariant). |
| D7 | **Subtitles compute on-demand** when "Generate subtitles" is clicked; pipeline skips the caption phase. Cached after first build. |
| D8 | **Download MP4 = three options:** (a) without subtitles, (b) with subtitles burned in, (c) without subtitles + green-screen subtitle file downloaded separately (two files together). |
| D9 | **Clip reuse:** a clip can be placed on the timeline multiple times. |
| D10 | **Undo/redo:** full history for move/split/trim/delete/add, with Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z. |
| D11 | **Re-run match vs manual edits:** show a **confirm dialog** before re-run discards manual timeline edits. |
| D12 | **Caption editing:** **style only** (color/font/size/position + per-word bold). Text + timing stay locked to the alignment. |
| D13 | **Editor uploads:** the clip library can **upload new clips on the fly**; a **section picker** is shown on upload. |
| D14 | **Clip cards:** single poster thumbnail (no filmstrip in v1). |
| D15 | **Keyboard shortcuts:** Space = play/pause · S = split at playhead · Delete/Backspace = delete selected · Arrows = nudge/step (J/K/L scrub welcome). |
| D16 | **Subtitle scope:** **global** look for all captions (color/font/size/position uniform; only per-word bold is local). |
| D17 | **Timeline length:** video **may extend past** the voiceover; total length = last clip end. |
| D18 | **Empty regions:** always **black** (drop the AI "freeze last frame" hold-fills entirely). |
| D19 | **Add-from-library duration:** the new clip **snaps to fill the gap** at the drop point (capped at the clip's real length); fallback below when dropped onto an occupied span. |
| D20 | **Clip audio:** voiceover-only, always discard source clip audio. |
| D21 | **Voiceover waveform:** a **real waveform** sampled from the audio file (not the word-density approximation). |
| D22 | **Silent tail:** when video runs past the voiceover, the tail audio is silence (don't clamp the export to the voiceover length). |
| D23 | **Look & feel:** adopt the **indiamade** editorial design language (§12). Use the **ui-ux-pro-max** skill. Interactions must be smooth/Premiere-grade. |

---

## 3. Teardown (what gets deleted)

### Files removed entirely
- `lib/xmeml.ts` · `lib/zipBundle.ts`
- `app/api/export/bundle/route.ts` · `app/api/export/xml/route.ts`
- `components/editor/DownloadProgress.tsx`

### Code paths removed
- `SourceClip.safeName` and every read of it (`filename` stays).
- `app/api/upload/route.ts`: drop the `sanitizeForNleRelink` import + `safeName` writes. **Do not** regress the streaming-upload mechanics (context.md §8).
- `lib/audioProbe.ts` channel-count back-fill **iff** no consumer of `hasAudio`/`audioChannels` survives the XMEML removal (grep first; likely deletable along with those `SourceClip` fields).
- `app/page.tsx`: remove `BundleConfirm`, `downloadBundleStreamed`, `DownloadProgress`, the ".zip" button + size estimate, the "Reel stats" card, the right-side instructions card, and the old 2-option MP4 modal (replaced by the 3-option modal).
- `Timeline.tsx`: the "Swap clip" dropdown + `swapSegment`; the section-locked `DndContext`-per-section reorder model; `applyHoldFills` freeze-frame logic.
- `lib/pipeline.ts`: remove `render` and `caption` from the default `PHASES`; relocate render to the download path; caption to on-demand. Remove `renderPreviewForSession`'s always-on use and the `manifest.preview` + planHash-staleness machinery (no cached preview MP4 to track).
- `app/api/render/route.ts` + `runRenderOnly`: **removed** (no editor re-render).
- `/api/export/mp4`: the 409/stale path is removed (render is computed on demand).

### Invariants retired (context.md §17/§18)
§18.8, §18.9, §18.12 and the Trap 1–4 minefield are **void**. Update context.md after the build.

### Kept
- Subtitle render stack: `lib/subtitleRender.ts` (`buildOverlayMov`, `renderGreenScreenSubs`, `renderSubtitledMp4`, `computeStates`, `hashSubtitles`), `lib/subtitleSvg.ts`, `lib/subtitles.ts`, `lib/subtitlesStore.ts`.
- The AI pipeline through `assemble`; Steering + Re-run match (now gated by D11); cost tracking; `nodeStreamToWebStream` (context.md §17 — orthogonal to ZIP teardown, still needed for `/api/media` Range).

---

## 4. Proxy generation (foundation for live preview)

**Why:** GB-scale 4K source MOVs streamed in parallel over EC2's public network is what made the old client preview unusable while localhost was fine. Tiny proxies remove the bottleneck.

**When:** at upload, after `probe()`, for every video clip (setup *and* editor uploads). Images skip proxy; they get a normalized poster.

**What:**
- Transcode to ~480px long-edge H.264, `veryfast`, CRF ~28, **dense keyframes (~0.5s GOP:** `-g 15 -keyint_min 15 -sc_threshold 0`) for snappy arbitrary seeks, **`-an`** (no audio).
- Output `proxies/<clipId>.mp4` + poster `proxies/<clipId>.jpg`.

**Data model — `SourceClip` gains:**
```ts
proxyRelPath?: string;   // proxies/<clipId>.mp4 (videos)
posterRelPath?: string;  // proxies/<clipId>.jpg
proxyReady?: boolean;    // false until transcode completes
```
Upload returns immediately with `proxyReady:false`; transcode runs async, manifest patched on completion (library card shows spinner → thumbnail; timeline-add disabled until ready). `pLimit(2–3)` via `lib/concurrency.ts`. `invalidateClipsDownstream` extended to remove proxy/poster on delete.

---

## 5. The new timeline (the heart of this change)

Replace `components/editor/Timeline.tsx`. Data model stays `EditPlan { segments, totalDurationMs }`, but: any segment sits at any `timelineStartMs`, gaps allowed, `section` is a tag only.

### 5.1 Layout
- **Ruler** with seconds, click-to-seek; playhead driven by the master clock. **Zoom** (px/sec) + horizontal scroll.
- **VIDEO track** — one lane; absolutely-positioned segment cards (single poster thumbnail). Gaps render empty/black.
- **VOICE track** — real sampled waveform (§9.3), read-only.
- **SUBS track** — only after subtitles generated; caption chips, click-to-seek.

### 5.2 Pure edit ops (centralize; component stays a thin view)
`normalizePlan`, `applyMove`, `applySplit`, `applyDelete`, `applyTrim`, `addFromLibrary` — all pure functions, unit-testable.

| Action | Behavior |
|---|---|
| **Drag segment** | New `timelineStartMs`. Drop over occupied span → **overwrite** (D3): dropped clip wins; underlying clip trimmed where covered, split if covered mid-clip; origin span becomes black. Snap to playhead / segment edges / second-ticks (magnet threshold; snapping on by default). |
| **Drag from library / `+`** | New segment for that clip at drop point (or playhead for `+`). Duration = **fill the gap** at the drop point capped at the clip's real length (D19); **fallback** when dropped on an occupied span: default 3000ms (video, capped at clip length) / 3000ms (image), then apply overwrite. Section/color from the clip. Reuse allowed (D9). |
| **Edge-trim** | Adjust `sourceInMs`/`sourceOutMs` + span. Trims only this segment; neighbors untouched (gaps allowed). |
| **Split (S / button)** | Split the segment under the playhead at the playhead time into two independent segments; nothing else moves; fresh ids. |
| **Delete (Del / trash)** | Remove selected segment → black span of its former length (D4). No ripple. |
| **Click segment** | Seek to its start + select (drives split/delete/trim). |
| **Undo/Redo** | Cmd/Ctrl+Z / Shift+Cmd/Ctrl+Z over an edit-history stack (D10). |

### 5.3 Plan normalization (parity backbone)
`normalizePlan(plan, totalDurationMs)` — the single source of truth for **both** the player and the renderer:
- Sort by `timelineStartMs`; resolve overlaps by the overwrite rule into a clean non-overlapping list.
- Fill every uncovered span in `[0, totalDurationMs]` with synthetic **black** filler segments (`kind:"blank"`).
- `totalDurationMs = max(voiceoverDurationMs, lastSegmentEndMs)` (D17). Tail past the voiceover = black video / silent audio (D22).

---

## 6. Live preview engine (client-side)

Replace the single-MP4 `<video>` in `Preview.tsx` with a proxy compositor.

### 6.1 Mechanism
- **Master clock = an independent timeline clock** `0..totalDurationMs` (rAF-driven). The voiceover `<audio>` is synced to it and simply ends early if the video extends past it (D17/D22) — the clock is *not* the audio's currentTime, so the tail still plays.
- **Video = double-buffered proxy `<video>` pool (2 elements).** For the active segment set `src=proxy`, seek to `sourceInMs + (clock - timelineStartMs)`, keep aligned; preload the next segment in the spare element for seamless cuts.
- **Blank spans:** show black (hide video) — matches the renderer's black filler exactly.
- **Drift control:** each tick, if `|video.currentTime − expected| > ~50ms`, re-seek. Play/pause tracks the master clock.
- **Subtitle overlay:** existing SVG overlay on top, only when subtitles generated + enabled.

### 6.2 Parity rules (D6 — hard invariant)
- **Fit:** renderer does `scale … force_original_aspect_ratio=decrease, pad … black` = **contain + black letterbox**. Preview must therefore use **`object-fit: contain` on black**, NOT today's `object-cover`.
- **Frame:** 9:16, same as render (1080×1920).
- **Cuts & gaps:** both consume the same `normalizePlan` output; black filler == black frame.
- Add a later automated frame-sample parity check; the rules above are the v1 guarantee.

### 6.3 Performance (EC2 t4.large, 4 cores)
Live preview no longer touches the server per edit, so the old EC2 lag is sidestepped by construction. Proxies served via existing `/api/media` Range handler (keep `nodeStreamToWebStream`).

---

## 7. Render on download (full quality)

Reuse rendering only at "Download MP4". Rework `renderFinalMp4` to consume `normalizePlan(...)`.

### 7.1 Correctness
- **Black spans:** emit a black source (`color=c=black:s=1080x1920` / lavfi) for each blank filler — matches preview.
- **Free positioning:** after normalization it's an ordered, gapless concat (gaps are explicit black segments).
- **Silent tail:** render video for the full timeline; audio = voiceover; **do not** use `-shortest` to clamp to audio — pad/áend audio with silence so video past the voiceover survives (D22).
- Keep: 1080×1920, contain+pad black, `setsar=1`, `fps=30`, `yuv420p`, H.264, AAC 192k, `+faststart`.

### 7.2 Speed (optimization)
Move off the single mega `-filter_complex` to **per-segment normalize + concat demuxer**:
1. Transcode each real segment (and each black filler) to an intermediate `1080×1920/30fps/yuv420p` MP4 with identical params — `pLimit(3–4)` to use the 4 cores.
2. `concat` demuxer (`-c copy`) to stitch, then mux the voiceover.
Cache the final by `hashPlan(plan)` (`download-<planHash>.mp4`) so re-download of an unchanged plan is instant. Show a progress modal during render (reuse jobStore/SSE).

### 7.3 Endpoint `POST /api/export/mp4`
Body `{ sessionId, mode: "clean" | "burned" | "clean+greenscreen" }`:
- `clean` → render/cache the reel MP4, stream it.
- `burned` → `renderSubtitledMp4` (captions burned), stream it.
- `clean+greenscreen` → client downloads **two** files back-to-back: the clean reel MP4 + `renderGreenScreenSubs` output. (Two requests fired together; no ZIP.)

---

## 8. Subtitles on-demand

### 8.1 Pipeline
- Remove the `caption` phase from the default pipeline; it ends at `assemble`.
- Add a **"Generate subtitles"** action in the editor header (next to Download MP4). On click: if `subtitles.json` exists → reveal; else run caption-chunk + Gemini highlight against the cached alignment, persist, reveal (small inline progress; caption cost tracked only now).
- `invalidateVoiceoverDownstream` / `invalidateScriptDownstream` still nuke `subtitles.json`.

### 8.2 Subtitle view & styling
- Subtitle UI (overlay toolbar + script box) appears **only after** generation; right panel shows the script box; live overlay on the preview.
- **More colors:** expand `SWATCHES` in `SubtitleLayer.tsx` from 7 to a broad curated set (~20–30 across white/cream/yellow/green/cyan/blue/violet/pink/red/orange/black + neons), harmonized to the new theme; native hex picker stays.
- **Global** scope (D16): color/font/size/position uniform; per-word bold local. Vertical reposition via the existing `positionY` drag — keep + make discoverable.
- **Text locked** to alignment (D12).

### 8.3 Green-screen file
`renderGreenScreenSubs` stays; delivered standalone via the `clean+greenscreen` mode (no ZIP/XML).

---

## 9. UI declutter + waveform

### 9.1 Remove
Left "Reel stats" card; right instructions/hints card; the ".zip" button + dialogs/modal/progress.

### 9.2 Left panel = Steering + Clip Library
- Keep Steering (override prompt + Re-run match [D11-gated] + Edit inputs).
- **Clip Library:** all uploaded clips (across sections) as poster thumbnail + filename + section dot, with `+` and drag handle to add to the timeline. **Upload button** (D13) → section picker → async proxy. Flat list fine for v1.

### 9.3 Voiceover waveform fix (D21)
Current bars use a nonsensical `translateX` formula in a flex row → they bunch/overflow (the screenshot bug). Replace with a **real waveform**: extract amplitude peaks from the voiceover via ffmpeg (e.g. downsampled PCM / `astats` per window), cache to a small JSON (`waveform.json`), and draw bars **absolutely positioned by time** (`left = bucketStartMs * pxPerMs`), aligned 1:1 with the ruler/clips. Drop the flex+transform hack.

---

## 10. Data model & API summary

### Types (`lib/types.ts`)
- `SourceClip`: remove `safeName`; add `proxyRelPath?`, `posterRelPath?`, `proxyReady?`. Drop `hasAudio`/`audioChannels` if unused post-teardown.
- `PlanSegment`: add `kind?: "clip" | "blank"` (or `blank?: boolean`) for synthetic black fillers.
- `PHASES`: drop `caption` and `render` from the default tuple.

### API
- **Remove:** `/api/export/bundle`, `/api/export/xml`, `/api/render`.
- **Change:** `/api/export/mp4` → `{ sessionId, mode }`; renders on demand, cache by hash; no 409/stale.
- **Add:** `POST /api/subtitles/generate` (or extend `/api/subtitles`) → compute-on-demand + persist + return.
- **Add:** proxy status on the manifest; upload route kicks off async proxy transcode + section picker for editor uploads.
- **Keep:** `/api/editor` GET/PUT, `/api/media`, `/api/manifest`, `/api/generate`, `/api/rerun`, `/api/job`, `/api/session`, `/api/upload`, auth.

### Pipeline (`lib/pipeline.ts`)
End at `assemble`; remove always-on render + caption; remove `manifest.preview`/planHash-staleness. Cost tracking stays (caption cost only when generated).

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Preview ≠ download** (your top concern). | Single `normalizePlan`; `object-fit: contain` on black; identical cut list; later frame-sample check. |
| Proxy seek stutter on long clips. | Dense keyframes; preload next; re-seek on drift. |
| Proxy transcode load on 4 cores. | `pLimit(2–3)`; tiny/fast proxies; add disabled until `proxyReady`. |
| Overwrite trim+split math is fiddly. | Pure functions + unit reasoning; thin view. |
| Undo/redo state sprawl. | Single history stack of `EditPlan` snapshots (plans are small); debounce coalescing during drags. |
| Light theme on a video editor. | Keep the preview frame dark; warm surfaces for chrome/timeline; calm section tags. |
| Removing `hasAudio`/`audioChannels` breaks something. | Grep all consumers before deleting. |
| Silent-tail audio handling. | No `-shortest`; pad audio with silence to the video length. |

---

## 12. Design system — indiamade editorial (D23)

Adopt the **indiamade** language (`/Users/paramthakkar/Development/Projects/indiamade/frontend`). **All design/frontend work goes through the `ui-ux-pro-max` skill.** Calm, warm, editorial, premium; interactions must be **smooth, never jittery — Premiere-grade**.

### 12.1 Palette (light editorial)
```
Surfaces:  bg #FAF6EE · surface #FFFFFF · surface-warm #F4ECDB · surface-hover #EFE5D2
Ink:       ink #1A1612 · ink-soft #4A3C30 · ink-secondary #6B5B4E · ink-muted #9C8B7C · ink-disabled #C9B89E
Rules:     rule #E8DDCB · rule-strong #C9B89E
Accents:   saffron #D97706 (primary action) / saffron-hover #B45309 / saffron-soft #FCD9A2
           peacock #0F766E (secondary / focus / selection) / peacock-soft #CFE8E5
States:    success #15803D · warning #B45309 · error #B91C1C · error-soft #FCD9D9
```
- **Playhead = saffron.** **Selection / focus = peacock.** **Section tags = a calm desaturated set** harmonized to the palette (not neon), distinct enough to scan.
- **Preview frame stays dark/black** (footage judgment); everything else is editorial-light.

### 12.2 Type
- **Display/headings:** Spectral (serif), 500 weight, `-0.01em`; **editorial italics** for deks.
- **Body:** Inter. **Mono/timecodes/eyebrows:** IBM Plex Mono (uppercase, `0.18–0.2em` tracking, `tabular-nums`).

### 12.3 Components & motion
- 6px radius; 1px `rule` borders; whisper-soft shadow (`0 1px 0 rule`, gentle elevation on float).
- Buttons: solid **saffron** (primary) / **peacock** (secondary) with white text; ghost = ink on transparent.
- Mono uppercase "eyebrow" labels; short rule under headings; tables with mono headers + tabular-nums.
- Peacock focus outline (2px, 2px offset); warm custom scrollbars.
- **Motion:** 150–220ms ease for hovers/selection; spring-free, smooth transforms; drag uses transform (GPU), snapping is eased, no layout thrash; honor `prefers-reduced-motion`.

This replaces the current dark aurora-pink theme (`app/globals.css`, `tailwind.config.ts`) wholesale.

---

## 13. End-to-end QA (per feature)

Every feature is verified end-to-end before it's "done" — using the `preview_*` tooling (start dev server, drive the UI, snapshot/console/network) plus a manual pass. Each item: build → exercise → observe → fix → re-verify.

**QA matrix:**
- [ ] Teardown: no XMEML/ZIP/XML/sanitize code or routes; app compiles + runs; no dead imports.
- [ ] Upload (setup + editor): clip → proxy + poster produced; library shows spinner → thumbnail; add disabled until `proxyReady`; editor upload shows section picker.
- [ ] Drag-reposition: move a clip from 30–35s → 15–20s; underlying clip trimmed/split (overwrite); origin goes black.
- [ ] Library add: drag + `+` both create segments; duration snaps to the gap; fallback on occupied; same clip reused twice works.
- [ ] Split: `S` and button split the under-playhead clip into two independent segments; nothing else moves.
- [ ] Delete: selected clip → black span of its length; total duration unchanged.
- [ ] Trim: edge-drag extends/reduces in place; neighbors unaffected.
- [ ] Undo/redo: each op reversible via Cmd/Ctrl+Z and redo; no corruption after many ops.
- [ ] Keyboard: Space / S / Delete / arrows (and J/K/L) behave; no conflicts with inputs.
- [ ] Live preview: instant (no server round-trip); smooth playback; seamless cuts; black gaps; drift < ~50ms.
- [ ] **Parity:** downloaded clean MP4 is visually identical to the preview (cuts, black gaps, contain-letterbox) on ≥2 real sessions.
- [ ] Extend-past-voiceover: tail plays as black-or-clip video with silent audio; export not clamped.
- [ ] Waveform: real, time-aligned, correct (bug gone).
- [ ] Subtitles on-demand: hidden until "Generate subtitles"; computes + reveals; cached; re-chunk on input change.
- [ ] Subtitle styling: expanded palette; global color/font/size; vertical drag; per-word bold; live overlay == export.
- [ ] Download MP4 modal: clean / burned / clean+greenscreen all produce correct file(s); two-file download works.
- [ ] Re-run match: confirm dialog before discarding manual edits; respects choice.
- [ ] Declutter: Reel-stats + instructions gone; Steering present.
- [ ] Smoothness pass: drag/scroll/zoom/playback feel buttery on the EC2-class target; no jank; reduced-motion respected.
- [ ] Design: indiamade palette/type/components applied consistently; preview frame dark; calm section tags.
- [ ] Regression: streaming upload (context.md §8) and `/api/media` Range (`nodeStreamToWebStream`) still intact.

---

## 14. Build phases (suggested order)

1. **Teardown** → clean compile.
2. **Design system** — indiamade theme tokens, fonts, base components (ui-ux-pro-max).
3. **Proxies** — upload-time proxy + poster; `SourceClip` fields; library data + editor upload.
4. **Plan core** — `normalizePlan` + pure edit ops (overwrite/blank/split/delete/trim/add) + undo history.
5. **Timeline UI** — free drag, library drag/`+`, split, delete, trim, zoom, snapping, shortcuts; real waveform.
6. **Live preview** — proxy compositor, master clock, double-buffering, contain-parity.
7. **Download render** — `normalizePlan`-driven render, black fillers, parallel normalize + concat, silent tail, 3-option modal, progress.
8. **Subtitles on-demand** — drop caption phase; "Generate subtitles"; reveal; palette; green-screen separate download.
9. **Polish + parity + full QA pass** (§13); update context.md.
