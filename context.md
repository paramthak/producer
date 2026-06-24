# Producer — Deep Context

A single source of truth for what this codebase is, how every piece fits together, what assumptions hold, and why each design decision was made. Read this if you've just walked into the project and need to be productive in an hour.

Last refreshed: 2026-06-23. The repo has drifted significantly from the original 7-phase / Railway / FCPXML design described in earlier revisions of this doc — this revision reflects the actual current state on `release`.

---

## 1. What this product is

**Producer is an AI Reel assembler.** A single user feeds in:

1. A pile of source clips and stills (videos, images), each pre-tagged into one of five script sections.
2. A voiceover audio file (the narration, already recorded).
3. The script text, broken into lines, each line tagged to a section.
4. An optional override prompt that biases the AI's editorial choices.

The system produces:

- A 9:16 (1080×1920) vertical Reel MP4 — voiceover as the only audio, clips trimmed and concatenated under it. **Rendered automatically at the end of the pipeline** (not on demand at download time).
- An editable timeline view where the user can fine-tune the AI's clip/trim choices, then click "Re-render preview" to refresh the MP4.
- A **self-contained `.zip` project bundle** with FCP7 XMEML version 5 + every source clip with its original filename + voiceover + preview MP4. Drops into Premiere/Resolve/Avid with zero relink prompts.
- A standalone `.xml` export (XMEML) with absolute server paths, for cases where the user is on the same machine as the server.

The "intelligence" is two Gemini calls and one ElevenLabs call wrapped around ffmpeg.

---

## 2. The five script sections

Hardcoded in [lib/types.ts:1](lib/types.ts:1) and [lib/sections.ts](lib/sections.ts):

```
hook → bridge → body → outro → cta
```

These are the only valid section IDs anywhere in the system. The user tags every script line to one of these. The Match phase only ever considers clips tagged to a section as candidates for that section's segments.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | API routes + React 19 frontend in one app. |
| Runtime | Node.js (`runtime = "nodejs"` on every route) | No Edge. We need `node:fs`, `child_process`, and long-lived requests. |
| Language | TypeScript strict | `tsc --noEmit` is the gate; no ESLint enforcement in CI. |
| UI | Tailwind + shadcn/ui (Radix primitives) | All components live under `components/`. |
| State (server) | Local filesystem (`.producer-data/` or `$DATA_ROOT`) + in-process singleton | No database. |
| Media processing | `ffmpeg` / `ffprobe` (system binaries) spawned via `child_process` | Not `ffmpeg.wasm`. Real native ffmpeg. |
| AI — vision/text | Google Gemini via `@google/genai` ^1.5 | Two models: `gemini-3.5-flash` (describe) and `gemini-3.1-pro-preview` (match). |
| AI — audio align | ElevenLabs Forced Alignment via `@elevenlabs/elevenlabs-js` ^2.51 | Returns per-word timestamps from a script + audio file. |
| Archive | `archiver` ^7 with `{ store: true }` + `Buffer` append (NOT `createReadStream`) | See §17 — the difference between this and stream-append is the difference between Premiere importing the ZIP and Premiere silently failing. |
| Drag-and-drop | `@dnd-kit` | Used in the bucket UI to drop clips into sections. |
| Forms / validation | `react-hook-form` + `zod` |  |
| Toasts | `sonner` |  |

---

## 4. Repository layout

```
app/
  page.tsx              ← The studio. Setup mode + Edit mode in one page, toggled by `mode`.
                          ~1080 lines. Contains BundleConfirm + CostChip inline components.
  layout.tsx            ← Root layout, fonts, toaster.
  globals.css           ← Tailwind base + section color tokens.
  login/                ← /login page (the auth gate UI).
  processing/           ← Legacy "cooking" overlay route. Live code uses the inline overlay.
  editor/               ← Used by some editor sub-views; bulk of edit UI lives in app/page.tsx.
  api/
    auth/login          POST    set the cookie if creds match
    auth/logout         POST    clear the cookie
    session             POST    new session (+ wipes orphans, see §10)
                        DELETE  wipe the named session
    manifest            GET     read session manifest JSON
                        PATCH   update script / override prompt
                                (script changes trigger invalidateScriptDownstream)
    upload              POST    streaming upload of one clip OR voiceover
                                (kind=voiceover triggers invalidateVoiceoverDownstream)
                                (kind=clip triggers invalidateClipsDownstream)
    upload/[clipId]     DELETE  remove a clip from session
                                (triggers invalidateClipsDownstream)
    generate            POST    kick off the full 9-phase pipeline (fire-and-forget)
    rerun               POST    re-run only phases 6-7 using cached outputs
    render              POST    re-run ONLY the render phase (post-edit refresh)
    job/[id]            GET     job snapshot OR SSE stream of phase events
    job/[id]/stop       POST    abort an in-flight job
    media/[...path]     GET     serve a file out of .producer-data with HTTP Range
    editor              GET     bundle of {manifest, plan, sections, alignment} for the editor view
                        PUT     persist an edited edit-plan
    export/mp4          POST    cache passthrough — streams the pre-rendered preview MP4
                                (returns 409 + {stale, currentHash, cachedHash} if plan changed)
    export/xml          POST    standalone XMEML with absolute local pathurls (single-machine use)
    export/bundle       POST    self-contained ZIP: XMEML + clips + voiceover + preview.mp4
                                (Content-Length is exact; see §17)

components/
  branding/             Logo
  ui/                   shadcn primitives (Button, Card, Dialog, Tooltip, Progress, ...)
  builder/              Setup-mode widgets
                          SectionBucket, ScriptPane (with selection-glitch fix),
                          VoiceoverSlot, OverridePrompt, SectionDot
  editor/               Edit-mode widgets
                          Preview, Timeline, DownloadProgress (the streaming ZIP modal)
  processing/           Cook overlay parts: PhaseStrip, ElapsedTimer

lib/
  types.ts              Single source of truth for all shared types
                        (SourceClip, EditPlan, PlanSegment, JobState, PHASES tuple, etc.)
  sections.ts           Section list + line-to-window alignment algorithm (token-walking)
  session.ts            DATA_ROOT, sessionDir(), paths(), readJson/writeJson, ensureSession
  manifest.ts           loadManifest/saveManifest/removeSource — wraps session.ts
                        SessionManifest now carries `preview` and `costs` fields.
  audioProbe.ts         ensureClipsHaveAudioInfo() — back-fill hasAudio + audioChannels on
                        legacy uploads so XMEML's <channelcount> matches reality (else
                        Premiere refuses to relink with "channel type does not match").
  jobStore.ts           In-memory singleton: JobState + EventEmitter for SSE.
                        Uses globalThis.__PRODUCER_JOB_STORE__ so Next HMR doesn't double it.
  pipeline.ts           The 9-phase orchestrator (see §6).
                        Also exports `renderPreviewForSession` and `runRenderOnly`.
  silenceTrim.ts        ffmpeg silencedetect at -30dB / 800ms threshold; rebuild with
                        aselect/asetpts; atomic-rename over original. Idempotent.
  cacheInvalidate.ts    Three helpers: invalidateVoiceoverDownstream,
                        invalidateScriptDownstream, invalidateClipsDownstream. Wired into
                        every input-mutating API route.
  planHash.ts           Hand-rolled FNV-1a 64-bit hash of an EditPlan (no crypto;
                        same fn runs server-side and in the browser). Cache key for
                        the rendered preview MP4 filename.
  costs.ts              Gemini + ElevenLabs pricing constants, geminiCost(),
                        forcedAlignmentCost(), SessionCosts shape, addDescribeCost /
                        addMatchCost / addAlignCost mutators, formatUsd().
  ffmpeg.ts             probe() (returns hasAudio + audioChannels), probeAudioDurationMs(),
                        extractFrames(), renderFinalMp4() (used by render phase).
  streamHelpers.ts      nodeStreamToWebStream() — manually-wired Node→Web bridge that
                        survives client aborts WITHOUT throwing ERR_INVALID_STATE
                        (the built-in Readable.toWeb has a known race; see §17).
  xmeml.ts              buildXmeml() — FCP7 XML version 5 serialiser.
                        <channelcount> reflects probed audio; <name>/<pathurl>
                        basename = disambiguated original filename.
  zipBundle.ts          disambiguateNames(), predictStoreZipSize(), predictBundleSize(),
                        buildBundleZip(). The ZIP is store-mode + buffer-append, NOT
                        stream-append — see §17 for the Premiere-import bug this avoids.
  concurrency.ts        sleep(), withBackoff() — exponential backoff for 429/5xx.
  auth.ts               Cookie name/value constants, getServerCreds, credsMatch.
  utils.ts              cn() (tailwind merge), formatDuration().
  builderStore.ts       Client-side hooks: useSessionManifest, uploadClip, uploadVoiceover,
                        resetSession.
  gemini/
    client.ts           Lazy singleton GoogleGenAI client; constants
                        MODEL_DESCRIBE = "gemini-3.5-flash"
                        MODEL_MATCH    = "gemini-3.1-pro-preview"
    describeFrames.ts   describeClip() — Phase 3 Gemini call (returns analysis + usage).
    matchAndTrim.ts     matchAndTrim() — Phase 6 Gemini call (the editor brain).
                        13 rules incl. word-first Rule 0; emits whyMatch + coveredWords.
                        validateWordCoverage() logs warnings (does not retry).
  elevenlabs/
    forcedAlign.ts      forcedAlign() — Phase 4 ElevenLabs call.

scripts/
  analyze-frames.mjs    One-off script — sends extracted frames to Gemini and dumps
                        per-frame analysis JSON to ~/Downloads. NOT part of the pipeline;
                        kept for ad-hoc investigation. Not in git history yet (untracked).

middleware.ts           Cookie-based auth gate. Excludes /api/upload (see §8).
next.config.ts          serverActions.bodySizeLimit = "2gb";
                        serverExternalPackages: ["@google/genai"]
nixpacks.toml           Tells Railway/Nixpacks to install ffmpeg. Kept for portability
                        even though primary deploy is now EC2 (see §15).
.env.example            Documented env vars.
.gitignore              .producer-data/, .env, etc. excluded from git.
```

---

## 5. Data model (the important types)

All defined in [lib/types.ts](lib/types.ts).

- **`SourceClip`** — `{ id, section, kind ("video"|"image"), filename, relPath, url, durationMs, width?, height?, fps?, sizeBytes, hasAudio?, audioChannels? }`. The trailing audio fields are populated by `lib/audioProbe.ts:probe()` at upload time, and back-filled lazily by `loadManifestWithAudioInfo` before each XML/ZIP export so legacy manifests still produce valid XMEML.
- **`ScriptLine`** — `{ id, text, section }`. The user can type the script in any order; each line carries the section it belongs to.
- **`WordTimestamp`** — `{ text, startMs, endMs }`. One per word from ElevenLabs forced alignment.
- **`SectionWindow`** — `{ section, startMs, endMs, lines, lineTimings? }`. The voiceover time-range that a section occupies. `lineTimings` is a `Record<lineId, { startMs, endMs }>` populated by `computeSectionWindows` and threaded into the match prompt so Gemini can see exactly when speech happens vs. silence inside each window (lets it pick establishing/breathing visuals for silent lead-ins/trails).
- **`FrameDescription`** — `{ timestampMs, description }`. One per extracted frame, produced by Gemini in Phase 3.
- **`ClipAnalysis`** — `{ clipId, frames[], summary }`. The full Phase 3 output for one clip.
- **`PlanSegment`** — `{ id, section, clipId, sourceInMs, sourceOutMs, timelineStartMs, timelineEndMs, whyClip, whyTrim, whyMatch?, coveredWords?, hold? }`.
  - `whyMatch` is the Rule-12 audit string: one sentence quoting both the spoken words at this segment's timeline range AND the matching frame description from the source slice. Empty for hold-fill segments.
  - `coveredWords` is the per-word audit Rule 0 demands — every voiceover word that plays during this segment's timeline range, with text + startMs + endMs. Used by `validateWordCoverage` to log drift warnings (log-only; no retry).
- **`EditPlan`** — `{ segments: PlanSegment[], totalDurationMs }`. The complete edit decision list. Hashed by `lib/planHash.ts:hashPlan` for the preview-MP4 cache key.
- **`JobState`** — `{ id, sessionId, phases: PhaseState[], currentPhase, status, ... }`. Live progress for a pipeline run.
- **`PhaseId`** — exactly **nine** values, in this order: `upload, frames, analyse, trim, align, map, match, assemble, render`.
- **`SessionManifest`** (in `lib/manifest.ts`) — adds two fields on top of the original clips/voiceover/script/overridePrompt set:
  - `preview?: { filename, planHash, renderedAt }` — the most recently rendered preview MP4 for this session. The frontend hashes the current edit plan and compares against `preview.planHash` to know whether the cached render is stale.
  - `costs?: SessionCosts` — running USD total + per-phase token/audio breakdown. See §16.

The **invariant the AI must obey**: for every segment, `sourceOutMs - sourceInMs === timelineEndMs - timelineStartMs` (Rule 8). The prompt enforces this; the schema doesn't.

---

## 6. The pipeline — the heart of the product

[lib/pipeline.ts](lib/pipeline.ts) runs **nine** phases. Each one (a) reports status via `jobStore.updatePhase`, (b) checks `aborted(jobId)` between steps so a stop button works, and (c) **caches its output to disk** so a rerun can skip it. Two new phases were added since the original 7-phase design: `trim` (between analyse and align) and `render` (after assemble).

### Phase 1 — `upload` (validate)
Pre-flight. Checks: at least one clip, voiceover present, every script line non-empty, every line section-tagged. Throws an `Error` whose message becomes the user-visible failure detail. Never modifies disk.

### Phase 2 — `frames` (extract)
For each video clip: spawn ffmpeg to extract JPEGs at **5 fps** ([lib/pipeline.ts:37](lib/pipeline.ts:37): `FRAME_FPS = 5`), write to `.producer-data/<session>/frames/<clipId>/0001.jpg`, etc. For images, no extraction — the single image path is reused.

**Why 5 fps and not 2:** Rule 0 (word-first matching) needs frame descriptions at ~200 ms resolution — the scale of one spoken word — so the model can pick the exact source millisecond where a word's content appears on screen. At 2 fps (500 ms between frames) the model had to interpolate between far-apart frames and would drift within multi-word segments. The trade-off is ~2.5× more describe-phase input tokens (≈ $0.08 more per Generate).

Frame timestamps are stamped at `(i + 0.5) / FPS * 1000` ms — the centre of each frame's source slice, not the edge.

**Cache key**: existence of the frame directory with `.jpg` files. Invalidate by deleting the clip (which mints a new clipId on re-upload).

### Phase 3 — `analyse` (Gemini describe)
For each clip, pack all its frames into a single Gemini `generateContent` call ([lib/gemini/describeFrames.ts](lib/gemini/describeFrames.ts)):

- Model: `gemini-3.5-flash` ([lib/gemini/client.ts:15](lib/gemini/client.ts:15)).
- Media resolution: `MEDIA_RESOLUTION_HIGH` for `section === "body"` (product shots need detail), else `LOW`.
- Thinking level: `LOW`.
- Response schema: `{ summary: string, frames: [{ timestampMs, description }] }`, returned as JSON.

Parallelised with `pLimit(4)` ([lib/pipeline.ts:38](lib/pipeline.ts:38): `CLIP_CONCURRENCY = 4`) and wrapped in `withBackoff` for 429/5xx.

**Cost wiring**: each call returns `{ analysis, usage }`. Usages are collected into `describeUsages[]` during the parallel pass to avoid manifest-write races, then rolled in via `updateSessionCosts` once the phase finishes.

Result written to `.producer-data/<session>/descriptions/<clipId>.json`. **Cache key**: file exists.

### Phase 3.5 — `trim` (silence trim, NEW)
Runs *before* align, against `manifest.voiceover.relPath` on disk.

`lib/silenceTrim.ts:trimSilences` runs ffmpeg twice:

1. **Detect**: `silencedetect=noise=-30dB:d=0.8`, parse `silence_start:` / `silence_end:` lines from stderr.
2. **Splice**: `aselect='between(t,a1,b1)+between(t,a2,b2)+…',asetpts=N/SR/TB` over the keep-ranges, written to a sibling temp file, then `fs.rename` over the original.

Idempotent — running it on an already-trimmed file finds no silences ≥ 800ms and returns early. If any silences were removed, `invalidateVoiceoverDownstream(sessionId)` deletes `alignment.json`, `sections.json`, `edit-plan.json`, every `output/*.mp4`, and clears `manifest.preview` — because the audio content on disk has changed, every cached derivative is wrong.

**Why this phase exists**: untrimmed voiceovers have ~200–800 ms inter-sentence pauses that turn into dead air in the Reel timeline, which match-and-trim has to fill with held frames or stretched clips. Trimming upstream means every downstream phase works against a tight timeline where words land back-to-back.

Edge case: if the *entire* audio is silence (an uploaded silent file), `keepRanges` is empty and the function returns the file untouched — splicing to empty would explode forced-alignment.

### Phase 4 — `align` (ElevenLabs forced alignment)
Concatenate all script lines into one string. Send the (now-silence-trimmed) voiceover audio + that string to ElevenLabs's Forced Alignment endpoint ([lib/elevenlabs/forcedAlign.ts](lib/elevenlabs/forcedAlign.ts)). Returns one `{ text, startMs, endMs }` per word. `voDurationMs` = max `endMs`.

Cached as `.producer-data/<session>/alignment.json`. **Cache key**: file exists and `words.length > 0`. **Cost**: `addAlignCost(c, voDurationMs)` runs only on actual API hits (cache hits are free).

### Phase 5 — `map` (compute section windows)
Pure CPU. [lib/sections.ts](lib/sections.ts): `computeSectionWindows()` walks two token streams in lock-step (the script-line tokens and the voiceover tokens) and assigns each line a `{ startMs, endMs }`. Then groups lines by section, takes min/max within each group, and produces five `SectionWindow`s in canonical order. The final non-empty section's `endMs` is extended to cover the full voiceover duration so the timeline closes cleanly. Each window also gets a `lineTimings` map (per-line spoken-word timing in absolute ms) for the match phase.

**Key subtlety**: ElevenLabs returns words with punctuation/apostrophes ("I'm"). The mapper tokenises both streams to lowercase alphanumeric ("im" → tokens `["i", "m"]`) and distributes the timing within multi-token words evenly. A small 8-token forward search window absorbs minor drift if ElevenLabs adds/drops a word.

Output: `.producer-data/<session>/sections.json`.

### Phase 6 — `match` (Gemini match + trim)
The editorial brain. [lib/gemini/matchAndTrim.ts](lib/gemini/matchAndTrim.ts).

- Model: `gemini-3.1-pro-preview`.
- Thinking level: `HIGH` (this is where the model actually "edits"). Lowering produces noticeably worse edits.
- Input: the five `SectionWindow`s (each with its script lines + per-line `spokenStartMs/spokenEndMs`, the section's per-word array, and candidate clips with summaries + frame descriptions), plus the full alignment `words` array.
- Output: `EditPlan { segments[] }` — for each section, one or more segments chosen from that section's candidates, each with `sourceInMs/sourceOutMs` (cut points), `timelineStartMs/timelineEndMs` (position), and the four justifications (`whyClip`, `whyTrim`, `whyMatch`, `coveredWords`).

The prompt enforces **13** numbered rules ([lib/gemini/matchAndTrim.ts:226](lib/gemini/matchAndTrim.ts:226)). The shape:

- **Rule 0 — word-first matching (highest priority).** Build the edit plan word-by-word, not segment-by-segment. The unit of decision is the word, not the segment. Segments are produced *after* per-word decisions, by collapsing adjacent decisions that share a clip and continuous source range with a strict ±400 ms tolerance. Default: split. Collapsing is the deliberate exception. This is what prevents drift inside a segment (the classic "voiceover says 'profile, budget, country' as three quick words but the clip slowly pans across those three UI states behind it" bug).
- **Rules 1–13** cover hard section boundaries, semantic match per word, silent-region handling, hook-specific cuts (each hook segment from a *different* clipId, punchiest frames; no Rule-6b "must have 3-6 cuts" — that was tried and removed), clip diversity (use at least 2-3 distinct clipIds when ≥2 candidates exist in a non-hook section), no overlapping source ranges across segments sharing a clipId, image segments anchored at sourceInMs=0, the duration invariant, override-prompt obedience, ordering, the four-justification mandate, the explicit `whyMatch` quote format, and a hard-min 400 ms per segment.

The override prompt is appended verbatim.

Returned segments are sorted by `timelineStartMs`, clamped to non-negative, and given fresh `nanoid(8)` ids. `totalDurationMs` defaults to the last window's `endMs`. Returns `{ plan, usage }`; usage is rolled in via `addMatchCost`.

**Server-side validation** ([lib/gemini/matchAndTrim.ts:110+](lib/gemini/matchAndTrim.ts:110)): `validateWordCoverage` checks that the union of `coveredWords` across each section's segments matches the section's `words` array. Mismatches are logged as warnings — no retry, no fail; it's an audit trail.

### Phase 7 — `assemble` (hold-fills)
Pure CPU. [lib/pipeline.ts:452](lib/pipeline.ts:452): `applyHoldFills()` enforces two rules:

1. **Tail-hold**: If a section's last segment ends before its window's end, append a "hold" segment that freezes on the last frame of the real segment. `sourceInMs = sourceOutMs - 1` is the convention for "still frame from the end."
2. **No-clips hold**: If a section has script lines but zero clips uploaded, copy the previous section's last segment frozen on its last frame across the entire section window.

Output: `.producer-data/<session>/edit-plan.json`.

### Phase 8 — `render` (preview MP4, NEW)
[lib/pipeline.ts:330](lib/pipeline.ts:330): `renderPreviewForSession()` calls `renderFinalMp4` with the assembled plan and writes the result to `output/preview-<planHash>.mp4`. Persists the metadata on `manifest.preview = { filename, planHash, renderedAt }`.

**Critical implementation detail** ([lib/pipeline.ts:375](lib/pipeline.ts:375)): before writing the manifest, it **re-reads the manifest from disk** and merges into the on-disk copy — NOT the stale in-memory `manifest` loaded at pipeline start. Earlier phases (analyse, align, match) write per-call API costs via `updateSessionCosts`; if we spread the stale in-memory snapshot here we'd overwrite those cost writes and the UI would forever show `$0.00`. This bug was hit in production on three devices before the fix landed.

**Why render in the pipeline rather than on download**: the editor's `Preview.tsx` plays one rendered MP4 instead of streaming N raw source clips in parallel. On EC2 over a public network, the difference is "works" vs. "unusable" — a 10-segment reel would otherwise preload ~1 GB of source video simultaneously.

### Re-run paths
- `POST /api/rerun` short-circuits to phases 6–7 only (cached descriptions + alignment + sections + you-changed-the-override-prompt scenario).
- `POST /api/render` calls `runRenderOnly(sessionId, jobId)` — fires just Phase 8 against the existing on-disk edit plan. Used by the editor's "Re-render preview" button after the user edits the plan and `hashPlan(currentPlan) !== manifest.preview.planHash`. Reuses the same `jobStore` + `/api/job/[id]` SSE stream.
- The disk-cache + cache-invalidation helpers (§17) mean a plain `/api/generate` call already skips phases whose inputs haven't changed.

---

## 7. External APIs

### Google Gemini
- SDK: `@google/genai` ^1.5 (declared as a `serverExternalPackages` in [next.config.ts](next.config.ts:7) so Next's bundler leaves it as a real Node import — its native binary loaders can fail otherwise).
- Models used: `gemini-3.5-flash` (vision, describe-frames), `gemini-3.1-pro-preview` (text, match-and-trim).
- Auth: `GEMINI_API_KEY` (or `GOOGLE_API_KEY` fallback).
- Retries: every call goes through `withBackoff` ([lib/concurrency.ts](lib/concurrency.ts)) — 5 attempts, exponential 800ms → 16s with jitter, retries on 429/5xx/timeouts/ECONNRESET.
- **Cost tracking**: every Gemini call returns `usageMetadata.promptTokenCount` and `candidatesTokenCount`. These flow into `lib/costs.ts:geminiCost(model, in, out)` which applies the per-model rate and the >200K-token long-context multiplier for `gemini-3.1-pro-preview`.

### ElevenLabs
- SDK: `@elevenlabs/elevenlabs-js` ^2.51.
- Endpoint: `client.forcedAlignment.create({ file, text })`. Returns `{ words: [{ text, start, end }] }` in seconds; we convert to ms.
- Auth: `ELEVENLABS_API_KEY`.
- Retries: same `withBackoff` wrapper.
- **Cost tracking**: priced as a proxy off Speech-to-Text Scribe v1/v2 at $0.22/hour of audio (forced-alignment doesn't have a published per-call rate). See [lib/costs.ts](lib/costs.ts) for source citations.

### No other external services.

---

## 8. The upload story (why `/api/upload` looks weird)

This is the most important quirk in the codebase and the most frequent thing future-you will trip over.

**The problem**: Next.js's built-in `req.formData()` parser buffers the whole multipart body in memory before parsing, and **fails on bodies over ~10 MiB** with `"expected boundary after body"`. Source clips are GB-scale. This was tried and abandoned.

**The solution** ([app/api/upload/route.ts](app/api/upload/route.ts)):

1. **Browser side** ([lib/builderStore.ts](lib/builderStore.ts)): `fetch(url, { method: "POST", body: file })`. The `File` object goes into the request body directly. Metadata (`sessionId`, `section`, `kind`, `filename`) goes in the URL query string. **No multipart at all.** No `FormData`.

2. **Server side**: Read `req.body` (a Web `ReadableStream`), convert to a Node `Readable` via `Readable.fromWeb`, pipe into `createWriteStream(absPath)`. Streams chunk-by-chunk. The whole file never lives in RAM.

**The middleware exclusion** ([middleware.ts:38](middleware.ts:38)): Next.js middleware runs on the Edge runtime, which buffers the entire request body before passing it to the matched route and **caps that buffer at 10 MiB** — even if middleware does nothing with the body. The fix is to exclude `/api/upload` from the matcher entirely. As a consequence, **auth is checked inline at the top of the upload handler** rather than via middleware.

**Cache-invalidation hooks**: After a successful upload, the handler calls `invalidateClipsDownstream(sessionId)` (for `kind=clip`) or `invalidateVoiceoverDownstream(sessionId)` (for `kind=voiceover`). Without this, replacing a voiceover would leave `alignment.json` and downstream caches intact, and the next Generate would happily reuse the OLD voiceover's word timings against the NEW audio (drift everywhere). The DELETE handler at `/api/upload/[clipId]` similarly fires `invalidateClipsDownstream`.

This pattern is fragile in three ways and should not be "cleaned up" without understanding:
- Anyone who switches the route to `req.formData()` will re-break large uploads.
- Anyone who removes the middleware exclusion will silently truncate uploads to 10 MiB.
- Anyone who removes the cache-invalidation calls will reintroduce the stale-cache drift bug.

All three have happened during the project's history.

---

## 9. The job model + SSE

Pipelines take minutes. HTTP responses can't hold open that long without something to show. The pattern:

- `POST /api/generate` creates a `JobState` in [lib/jobStore.ts](lib/jobStore.ts), starts the pipeline with `void runPipeline(...)` (fire-and-forget), and immediately returns `{ jobId }`.
- `POST /api/render` does the same with `runRenderOnly` — the editor's re-render button reuses this whole machinery rather than inventing a parallel one.
- `GET /api/job/[id]` with `Accept: text/event-stream` opens a Server-Sent Events stream. The store has an `EventEmitter`; each `updatePhase` / `finish` emits, and the route forwards each emission as a `data: ...\n\n` SSE message.
- `POST /api/job/[id]/stop` calls `abortController.abort()`. The pipeline polls `aborted(jobId)` between phases and after every clip iteration; the ffmpeg helpers kill the child process on abort. Gemini/ElevenLabs calls pass the signal through `withBackoff`. `silenceTrim` honours the signal too.

**The critical architectural requirement**: the `jobStore` is a `globalThis` singleton. The pipeline and the SSE handler must run **in the same Node process**. This works on a single long-running container (Railway / EC2 / `next start`) and breaks on serverless (Vercel functions are separate isolates).

On redeploy, the in-memory store is empty. In-flight jobs vanish. Single-user mitigation: don't redeploy while someone is mid-pipeline.

---

## 10. Sessions and the filesystem

### Layout
`DATA_ROOT` ([lib/session.ts:5](lib/session.ts:5)) resolves to:
- `process.env.DATA_ROOT` if set (production, points at a persistent mount)
- `<projectRoot>/.producer-data` otherwise (local dev)

Per session:
```
<DATA_ROOT>/<sessionId>/
  sources/            ← original uploaded clips & images (largest)
  frames/<clipId>/    ← extracted JPEGs at 5fps
  descriptions/       ← Gemini frame-description JSONs, one per clip
  voiceover/          ← the uploaded MP3/WAV/M4A (may have been trimmed in place)
  output/             ← rendered preview MP4(s); filename = preview-<planHash>.mp4
  manifest.json       ← session state: clips, voiceover, script, override prompt,
                        preview pointer, running cost totals
  alignment.json      ← ElevenLabs words + total duration
  sections.json       ← computed section windows + line timings
  edit-plan.json      ← final EditPlan
```

A `sessionId` is `nanoid(12)`, validated by regex `^[a-zA-Z0-9_-]{6,}$` in [lib/session.ts](lib/session.ts) to defend against path traversal.

### Single-session invariant

**The product is single-user.** The `POST /api/session` handler (new-session flow) wipes every session folder under `DATA_ROOT` that isn't the one it just created. So **at most one session exists on disk at any time.** This is safe because there is no notion of concurrent users.

This is the only thing keeping the volume bounded. There is no TTL cron, no usage-based GC, no manual cleanup task. The new-session POST is the cleanup mechanism.

The "Reset" button uses a different path (`DELETE /api/session?sessionId=...`), which wipes only the named session. That's also correct given single-user.

### Worst-case storage
Empirically one session weighs ~500–700 MB. A heavy session with 10+ clips of 4K MOV can spike to 2 GB+. The EC2 root volume has plenty of headroom; locally, `.producer-data/` is gitignored and you clean it by clicking "Reset" in the UI (or `rm -rf` it).

---

## 11. Auth

[lib/auth.ts](lib/auth.ts) + [middleware.ts](middleware.ts).

- Two env vars: `AUTH_USERNAME` and `AUTH_PASSWORD`. Plaintext on purpose. This is a "keep random visitors from burning the API keys" gate, not a real auth system.
- `POST /api/auth/login` checks the body against env, and on success sets `Set-Cookie: producer_auth=1; HttpOnly; Path=/; Max-Age=2592000`.
- Middleware checks for that cookie on every request except `/login`, `/api/auth/*`, and `/api/upload` (the upload exclusion is for the body-size reason in §8, **not** to skip auth — auth is re-checked inline in the upload handler).
- API requests without the cookie get a JSON 401. Page requests get redirected to `/login?next=...`.
- `POST /api/auth/logout` clears the cookie.

There is no per-user state. Everyone who knows the credentials sees the same single session on disk.

---

## 12. Frontend — the studio (`app/page.tsx`)

One page, two modes, one big stateful component. ~1080 lines (it grew from ~600). Inline-defines `BundleConfirm` and `CostChip` helper components at the bottom of the file.

### `mode: "setup"`
The pre-pipeline view:
- **Section buckets** (`components/builder/SectionBucket.tsx`) — five drop zones, one per section. `@dnd-kit` lets the user drag clips between buckets. Upload button on each bucket fires `uploadClip`.
- **Script pane** (`components/builder/ScriptPane.tsx`) — textarea-ish UI where the user pastes the script and tags each line to a section. The textarea uses `text-transparent` overlaid on a colored `<pre>` for syntax-style section tinting; the selection-glitch fix sets explicit `whitespace: pre-wrap`, `word-break: break-word`, `overflow-wrap: anywhere !important`, and `-webkit-text-fill-color: transparent` to stop the textarea's "invisible" text from doubling against the `<pre>` on selection. The textarea also intercepts `dragover`/`drop` events with `dataTransfer.types.includes("Files")` to suppress the browser's default file-drop preview leaking in from the surrounding drop zones.
- **Voiceover slot** (`components/builder/VoiceoverSlot.tsx`) — drop zone for the audio file.
- **Override prompt** (`components/builder/OverridePrompt.tsx`) — free-text bias for the match phase.
- **"Generate" button** — calls `POST /api/generate`, then opens the cooking overlay.

### `mode: "edit"`
Shown after the pipeline completes (or when a session already has an `edit-plan.json` on disk):
- **Preview** (`components/editor/Preview.tsx`) — a single `<video>` element pointed at `/api/media/<session>/output/<manifest.preview.filename>`. Timeline chip clicks just `video.currentTime = ...`. When `manifest.preview` is missing or `hashPlan(currentPlan) !== manifest.preview.planHash`, the empty-state CTA reads "Render preview" / "Stale — re-render" and wires to `POST /api/render`.
- **Timeline** (`components/editor/Timeline.tsx`) — scrollable strip of segment chips, each labeled with its section color. Active-segment highlight comes from `video.currentTime` vs. the cached edit plan, not from N parallel `<video>` elements. Tooltip shows `whyClip`, `whyTrim`, `whyMatch` per segment.
- **CostChip** (inline in `app/page.tsx`) — pill next to the export buttons. Reads `editor.manifest.costs?.totalUsd ?? 0`; formats with `formatUsd()` from `lib/costs.ts`. Tooltip shows the breakdown (calls + tokens per Gemini model, audio-ms for ElevenLabs).
- **Export buttons** — three of them now:
  - "Download MP4" — POSTs `/api/export/mp4`. Cache passthrough; on 409 (stale) shows a toast telling the user to re-render first.
  - "Download XML" — POSTs `/api/export/xml`. Single absolute-path XMEML for on-this-machine use.
  - "Download project (.zip)" — opens `BundleConfirm` dialog (size estimate + warning that this includes every source file). On confirm, runs `downloadBundleStreamed()` — a `fetch` + `ReadableStream` reader loop that pushes byte-level progress into `DownloadProgress` state.
- **DownloadProgress** (`components/editor/DownloadProgress.tsx`) — modal with a real-percentage progress bar, stages (`preparing` → `downloading` → `saving` → `done` / `error`), Cancel / Retry / Close buttons. Falls back to a shimmer if `Content-Length` is missing (it shouldn't be — see §17).
- **"Re-render preview"** — wired to `/api/render`. Visible whenever the cached preview is missing or its planHash doesn't match.

### Session bootstrap
[lib/builderStore.ts](lib/builderStore.ts): `useSessionManifest()` runs once on mount.
1. Look for a session id in `sessionStorage` (`producer.sessionId`).
2. If absent: `POST /api/session`, get a fresh id, store it.
3. `GET /api/manifest?sessionId=<id>`, hydrate the React state.

**This is what triggers the orphan cleanup.** Because the only way to get a new session id is to clear `sessionStorage` (Reset button) or open in a fresh browser context, every "new session" POST is also a cleanup pass.

### Cooking overlay
`components/processing/PhaseStrip.tsx` iterates `PHASES` (now nine entries) and renders one row per phase, status-coloured. Opens an SSE connection to `/api/job/<jobId>`. The Stop button fires `/api/job/<jobId>/stop`. The Try Again button stays in setup mode and re-fires `/api/generate`.

The same overlay is reused for the standalone `/api/render` job — same `jobStore`, same `/api/job/[id]` SSE, just one phase running.

---

## 13. ffmpeg — what we actually do with it

[lib/ffmpeg.ts](lib/ffmpeg.ts) + [lib/silenceTrim.ts](lib/silenceTrim.ts).

### `probe(file)` — on upload
`ffprobe -v error -print_format json -show_streams -show_format <file>`. Returns `{ durationMs, width, height, fps, hasAudio, audioChannels }`. The audio fields are critical for XMEML's `<channelcount>` to match the actual file — Premiere refuses to relink with "channel type does not match" otherwise.

### `probeAudioDurationMs(file)` — on voiceover upload
`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <file>`. Returns ms. Also called by `silenceTrim` to bookend the trim.

### `extractFrames(videoFile, outDir, fps=5)` — Phase 2
`ffmpeg -y -i <file> -vf fps=5 -q:v 3 <outDir>/%04d.jpg`. Streams JPEGs at 5fps. Wrapped in a helper that respects an `AbortSignal` (kills the child on abort).

### `silenceTrim.trimSilences(audioFile, opts)` — Phase 3.5
Two ffmpeg passes (detect + splice) plus an atomic rename over the original. See §6 Phase 3.5 for the full story.

### `renderFinalMp4({ segments, voiceoverPath, outPath, signal })` — Phase 8 / `/api/render` / `/api/export/mp4` (indirectly)
Builds a single ffmpeg invocation with one `-i` per segment (using `-ss` + `-t` for video trim, or `-loop 1 -t` for images), one final `-i` for the voiceover, and a `-filter_complex` graph that:

1. Scales each input to fit inside 1080×1920 (preserving aspect ratio).
2. Pads to 1080×1920 with black bars where needed.
3. Sets `sar=1`, normalises to 30 fps, normalises pixel format to `yuv420p`.
4. Concatenates all video streams with `concat=n=N:v=1:a=0`.

Output: H.264 `veryfast` CRF 20, AAC 192k, `+faststart`. Mapped to the voiceover audio (source audio is discarded). Result lands at `output/preview-<planHash>.mp4`.

### Binary paths
`FFMPEG_PATH` / `FFPROBE_PATH` env vars override the default (`ffmpeg` / `ffprobe` on PATH). On EC2 with `apt install ffmpeg`, both are on PATH out of the box. On Railway via `nixpacks.toml`, same story.

---

## 14. The complete API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/login` | POST | Body `{ username, password }`. Sets cookie on match. |
| `/api/auth/logout` | POST | Clears cookie. |
| `/api/session` | POST | Mint session id; wipe orphans; init empty manifest. |
| `/api/session?sessionId=X` | DELETE | `rm -rf` that session folder. |
| `/api/manifest?sessionId=X` | GET | Read manifest JSON. |
| `/api/manifest` | PATCH | Body `{ sessionId, script?, overridePrompt? }`. Persist. Script changes fire `invalidateScriptDownstream`. |
| `/api/upload?sessionId=X&kind=clip&section=Y&filename=Z` | POST | Stream raw file body to disk. Updates manifest. Fires `invalidateClipsDownstream` / `invalidateVoiceoverDownstream` per kind. |
| `/api/upload/[clipId]?sessionId=X` | DELETE | Remove a clip from manifest + disk. Fires `invalidateClipsDownstream`. |
| `/api/generate` | POST | Body `{ sessionId, overridePrompt? }`. Start the 9-phase pipeline; return `{ jobId }`. |
| `/api/rerun` | POST | Body `{ sessionId, overridePrompt? }`. Re-run phases 6–7 only. |
| `/api/render` | POST | Body `{ sessionId }`. Re-run phase 8 only (preview re-render after plan edits). |
| `/api/job/[id]` | GET | JSON snapshot, OR SSE stream if `Accept: text/event-stream`. |
| `/api/job/[id]/stop` | POST | Abort the job. |
| `/api/media/[...path]` | GET | Stream file from `.producer-data/<sessionId>/...` with Range support. |
| `/api/editor?sessionId=X` | GET | `{ manifest, plan, sections, alignment }` bundle for the editor view. |
| `/api/editor` | PUT | Body `{ sessionId, plan }`. Overwrite `edit-plan.json`. |
| `/api/export/mp4` | POST | Cache passthrough. Streams `output/preview-<planHash>.mp4`. Returns 409 + `{ stale, currentHash, cachedHash }` if the plan changed since the last render. |
| `/api/export/xml` | POST | XMEML with absolute local pathurls. For on-this-machine use. |
| `/api/export/bundle` | POST | Self-contained ZIP (XMEML + sources + voiceover + preview.mp4). Sets exact `Content-Length` so the progress bar is honest. |

All routes are `runtime = "nodejs"`. Routes that may run >60s (`upload`, `generate`, `rerun`, `render`, `export/mp4`, `export/bundle`) declare `maxDuration` (300–600). On EC2 the value is informational; on Railway likewise. On Vercel it would actually matter (and the architecture would not work — see §15).

---

## 15. Deployment

Two targets supported, both shapes of the same single-process-with-disk pattern.

### Bitbucket `origin` (canonical) → EC2 (current primary)
Production runs as a single long-lived `next start` process on EC2. ffmpeg installed via apt. `DATA_ROOT` set to a persistent volume mounted under the user's home. All four env vars set there. There is no in-repo IaC file for this; the host is configured by hand.

### GitHub `github` (mirror, push `release:main`) / Railway (alternate)
The `nixpacks.toml` (`nixPkgs = ["...", "ffmpeg"]`) keeps Railway working as a fallback target. Volume mount `/data`, 2 GB. Set `DATA_ROOT=/data` so [lib/session.ts](lib/session.ts) writes to the volume instead of ephemeral container disk.

Common to both:

```
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
AUTH_USERNAME=...
AUTH_PASSWORD=...
DATA_ROOT=/data          # or whatever the persistent mount is on your host
# FFMPEG_PATH=, FFPROBE_PATH=  (optional, override the on-PATH defaults)
```

### What does NOT need changing for either target
- `runtime = "nodejs"` on every route — already correct.
- `maxDuration` — both targets ignore it, harmless.
- `next.config.ts` `bodySizeLimit: "2gb"` — only applies to server actions, which this app doesn't use. Harmless.
- `serverExternalPackages: ["@google/genai"]` — required for the SDK to load correctly.
- The streaming upload pattern — already a real Node read of `req.body`.
- `jobStore` — works because both targets give us one long-running process.

### Git remotes
```
origin   git@bitbucket.org:leapfinance/producer.git  (release branch — canonical)
github   https://github.com/paramthak/producer.git   (push release:main — backup / Railway target)
```

Push to both on release: `git push origin release && git push github release:main`.

---

## 16. Cost tracking

[lib/costs.ts](lib/costs.ts) + manifest's `costs?: SessionCosts` field.

```ts
SessionCosts = {
  totalUsd: number;
  breakdown: {
    describe: { calls, inputTokens, outputTokens, usd };  // Gemini 3.5 Flash
    match:    { calls, inputTokens, outputTokens, usd };  // Gemini 3.1 Pro Preview
    align:    { calls, audioMs, usd };                    // ElevenLabs forced alignment
  }
}
```

Pricing snapshot (web-verified May/June 2026 — see citations in [lib/costs.ts:5](lib/costs.ts:5)):

| Service | Rate |
|---|---|
| `gemini-3.5-flash` input | $1.50 / 1M tokens |
| `gemini-3.5-flash` output | $9.00 / 1M tokens |
| `gemini-3.1-pro-preview` input ≤200K | $2.00 / 1M tokens |
| `gemini-3.1-pro-preview` output ≤200K | $12.00 / 1M tokens |
| `gemini-3.1-pro-preview` input >200K | $4.00 / 1M tokens (doubles) |
| `gemini-3.1-pro-preview` output >200K | $18.00 / 1M tokens (doubles) |
| ElevenLabs forced alignment (proxied off STT) | $0.22 / hour of audio |

Mutators (`addDescribeCost`, `addMatchCost`, `addAlignCost`) are called by `lib/pipeline.ts:updateSessionCosts`, which loads → mutates → saves the manifest. Single-process app + per-phase serialisation means no real concurrent-writer race, but be aware: if you parallelise phases later, this would need a lock.

**The bug that haunted this**: an early version of `renderPreviewForSession` spread the in-memory `manifest` snapshot (loaded once at pipeline start) at the end, which silently overwrote cost writes done by earlier phases. The UI showed `$0.00` on three devices. Fix: re-read the manifest from disk before merging the preview metadata. See [lib/pipeline.ts:375](lib/pipeline.ts:375).

UI: the `CostChip` inline component in `app/page.tsx` renders `formatUsd(totalUsd)` in a pill next to the export buttons. Hovering shows the per-phase breakdown.

---

## 17. ZIP bundle — the Premiere-import minefield

[lib/zipBundle.ts](lib/zipBundle.ts) + `app/api/export/bundle/route.ts`. This is the export path the user actually uses; the standalone `.xml` is a sidecar.

### The shape
A flat ZIP at the repo root:
```
producer-<sessionShort>.xml      ← XMEML version 5
<voiceoverOriginalFilename>      ← e.g. narration.mp3
<clip 1 original name>.mp4       ← collision-disambiguated as "clip (2).mp4" etc.
<clip 2 original name>.mov
...
preview.mp4                      ← rendered preview (optional)
```

`disambiguateNames(clips)` is the single source of truth for clip naming — used by *both* the XML's `<name>`/`<pathurl>` basenames and the actual filenames inside the ZIP. Premiere falls back to name-matching when the absolute `<pathurl>` doesn't resolve, and because the names match, every clip relinks with zero prompts.

### Three subtle traps, three deliberate fixes

**Trap 1 — `Content-Length` mismatch.** Early version sent no Content-Length, so the frontend's progress bar defaulted to a placeholder fill and looked stuck at ~30%. Fix: `predictBundleSize()` walks the entries and returns the exact byte count using the store-mode layout formula:

```
per entry:  30 + len(name)        (local file header)
            + size of file data
            + 46 + len(name)      (central directory entry)
once:       22                    (end of central directory record)
```

Verified to match `stat` of the produced ZIP byte-for-byte. Sent as the `Content-Length` header. Frontend progress bar is now honest.

**Trap 2 — slow zlib spinning on already-compressed media.** Original used `archiver("zip", { zlib: { level: 1 } })`. Bundle is 95%+ already-compressed media (mp4/jpg/mp3); zlib spent CPU for ~0% size benefit. Fix: switched to `archiver("zip", { store: true })`. 5–10× faster on a real bundle.

**Trap 3 (the one that bit hardest) — Premiere silent-fail on store-mode ZIPs with data descriptors.** After the store-mode switch, importing the XMEML in Premiere opened the project, flashed a progress bar, then sat blank with no error dialog. `zipinfo -v` revealed the cause: every entry was `compression method: stored` + `extended local header: yes`. That second flag is the ZIP "data descriptor" (general purpose bit 3), which `archiver`'s `_appendStream` code path sets unconditionally on every entry. For *deflated* entries this is normal and Premiere reads it fine; for *stored* entries the combination is uncommon and Premiere's XMEML import silently bails.

Fix: stop using `createReadStream`. Read each file into a `Buffer` first, then `archive.append(buffer, { name })`. Buffer-append goes through `_appendBuffer` which writes a complete local header with sizes upfront — no data descriptor needed.

```ts
// lib/zipBundle.ts — the critical line shape
const voBuf = await readFile(voiceoverAbsPath);
archive.append(voBuf, { name: voiceoverName });

for (const clip of manifest.clips) {
  const buf = await readFile(clipAbsPath[clip.id]);
  archive.append(buf, { name: cleanName });
}
```

Memory cost: peak ~sum-of-source-clip-bytes (~70 MB for our typical bundles). Acceptable; the slow-zlib problem stays solved.

Repro verified against archiver itself: stream-append → `extended local header: yes`; buffer-append → `extended local header: no`. With buffer-append, Premiere imports cleanly.

**`buildBundleZip` is now `async` and returns `Promise<Readable>`** because the buffer reads have to happen before/during `archive.finalize()`. The bundle route awaits it.

### `nodeStreamToWebStream` — why we don't use `Readable.toWeb()`
[lib/streamHelpers.ts](lib/streamHelpers.ts). `Readable.toWeb` has a known race: when the HTTP client disconnects, the Web `ReadableStream` controller gets closed by Next.js's Response runtime, but Node's internal `Readable` can still emit one more chunk in flight. That chunk calls `controller.enqueue()` on a closed controller and throws `ERR_INVALID_STATE` from a microtask — uncatchable from userland, fatal under Next's `uncaughtException` handler. We saw this fire on every `<video>` Range request and every MP4 export, causing container restarts.

The custom bridge: track a `closed` flag, listen for both Node side (`data`/`end`/`error`) and Web side (cancel/abort) lifecycle events, wrap every controller call in try/catch, destroy the Node stream on cancel. Pass the request's `AbortSignal` to tear down file descriptors the instant the browser cancels (which it does constantly during video scrubbing).

Every route that streams a file uses this helper.

---

## 18. Operational invariants

Things that are true and must stay true:

1. **At most one session on disk at a time.** Enforced by `POST /api/session`. Don't add code that creates session folders outside that path.
2. **Single user.** No locking, no per-user state. Two browsers hitting the app simultaneously will fight; this is by design.
3. **The pipeline, the render-only job, and the SSE stream share an in-memory store.** They must run in the same Node process. Splitting them across processes/workers/Vercel functions will silently break the cooking overlay.
4. **`req.body` is streamed, not buffered, on upload.** Don't `await req.formData()` or `await req.text()` in the upload handler. Don't add Next.js middleware that reads the body.
5. **Every long-running route uses `runtime = "nodejs"`.** Edge would cap bodies at 10 MiB and disallow `child_process`.
6. **`DATA_ROOT` is the only source of truth for storage location.** Don't hardcode `.producer-data` in new code; import `paths()` from `lib/session.ts`.
7. **`sessionId` is regex-validated everywhere it comes from outside.** Don't add a route that takes a `sessionId` query param without going through `sessionDir()` or `paths()`.
8. **The ZIP uses `{ store: true }` + buffer-append.** Don't switch back to stream-append. Don't switch back to default deflate. See §17.
9. **`Content-Length` on `/api/export/bundle` is exact.** Don't drop it — the download progress bar relies on it.
10. **Every input-mutating route fires the matching cache-invalidate helper.** Voiceover upload → `invalidateVoiceoverDownstream`. Script PATCH → `invalidateScriptDownstream`. Clip POST/DELETE → `invalidateClipsDownstream`. Without these, stale derivatives leak into the next pipeline run.
11. **`renderPreviewForSession` re-reads the manifest from disk** before merging the preview metadata. Don't replace it with an in-memory spread; you'll obliterate the cost writes done by earlier phases.

---

## 19. Known quirks / gotchas

- **`.producer-data/` is in `.gitignore`.** Local sessions never leak into commits. On a fresh clone, the directory is created at first request via `ensureSession`.
- **Module-level globals in `jobStore`** use `globalThis.__PRODUCER_JOB_STORE__` so Next's HMR doesn't multiply the store during dev. Keep that pattern if you add similar singletons.
- **`describeFrames.ts` switches resolution by section.** Body section gets HIGH; everything else LOW. Intentional — body shots are often product/text-heavy.
- **`matchAndTrim.ts` uses `ThinkingLevel.HIGH`** — this is where the model gets time to "think" about cut points. Lowering it produces noticeably worse edits.
- **The XML output muscle-memorises 30fps.** Source files at other framerates are still referenced; Premiere conforms them on import. `<channelcount>` in `<audio>` must match the actual file (probed via `lib/audioProbe.ts`).
- **`<pathurl>` in the standalone `/api/export/xml` is an absolute local path** (works only on the server's machine). In the ZIP bundle's XML, the basename matches a file sitting next to the XML, so Premiere's name-relink finds it regardless of where the user unzips.
- **Hold-fills set `sourceInMs = sourceOutMs - 1`** to indicate "freeze on last frame." ffmpeg respects this because the clip is sliced to 1ms and the segment duration is longer — effectively a still.
- **The forced-alignment token walker** in `lib/sections.ts` tolerates ~30% mismatch via the 8-token search window. If the script and voiceover diverge wildly, sections will be misaligned silently. Garbage-in, garbage-out.
- **`scripts/analyze-frames.mjs` is untracked** (in `.gitignore`-equivalent state by being a one-off dump under `~/Downloads`). It's a research aid, not pipeline code; do not call it from the app.
- **The `Re-render preview` button only appears when the cached preview is missing OR `hashPlan(currentPlan) !== manifest.preview.planHash`.** If both match, the button is hidden — the existing render is already current.
- **`/api/export/mp4` no longer renders.** It used to call `renderFinalMp4` on every click; now it's a cache passthrough that returns 409 if the plan is stale. The render machinery lives in `/api/render` and the Phase 8 of `/api/generate`.

---

## 20. Things you probably should NOT do

- Switch the upload handler to `req.formData()`.
- Move `jobStore` to a separate process / worker / function.
- Deploy to a serverless platform (Vercel, Cloudflare Workers, Netlify Functions). The architecture is server-shaped.
- Add a database. The filesystem layout *is* the database; adding Postgres for a single-user one-session-at-a-time tool would be Stockholm-syndrome engineering.
- Bundle ffmpeg via `@ffmpeg-installer/ffmpeg`. That npm package's binaries are old, slow, and miss filters. Use the system ffmpeg.
- Reintroduce `createReadStream` in `lib/zipBundle.ts`. See §17.
- Drop the `Content-Length` header from `/api/export/bundle`.
- Remove a cache-invalidate call from an input-mutating route.
- Lower `FRAME_FPS` back to 2. Rule 0 needs the resolution.
- Spread an in-memory manifest snapshot into a `saveManifest()` after cost-writing phases have run. Always re-read the on-disk manifest first.
- Add backwards-compat shims for renamed env vars or moved files. There's one user (you). Just edit the code.

---

## 21. The mental model in one paragraph

> A user dumps videos + a voiceover + a tagged script into a folder on disk. A ten-phase pipeline streams progress over SSE: ffmpeg extracts frames at 5 fps, Gemini 3.5 Flash describes them, ffmpeg trims long silences out of the voiceover, ElevenLabs aligns the trimmed voiceover word-for-word, a caption phase chunks those words into VEED-style phrase groups and Gemini Flash flags the punchy words to emphasize, a section mapper figures out which time-range each script section occupies, Gemini 3.1 Pro word-by-word picks and trims clips under a 13-rule prompt with a hard word-first audit, a small CPU pass fills any visual gaps with held frames, and ffmpeg renders the final 9:16 MP4. The user reviews in an editor that plays the rendered preview with a live caption overlay, optionally tweaks the plan and the subtitle look (re-rendering/re-rasterizing on demand), and exports a self-contained ZIP — XMEML + every original-named clip + voiceover + preview.mp4 + a green-screen subtitles.mp4 on its own top Premiere track — that drops into Premiere with zero relink prompts. The whole thing runs as one Next.js process on an EC2 host (or Railway container) with a persistent disk and no database, no queue, no worker, no second service. Auth is a cookie. The product is single-user; the disk holds exactly one session at a time. Every cache lives on disk keyed by either the inputs themselves or a stable plan hash, and every input-mutating route invalidates the right downstream slice. ffmpeg is the heavy machinery; Gemini is the brain; ElevenLabs is the ear; archiver is the courier; Next.js is glue.

---

## 22. Subtitles — the caption layer

A real-time, editable subtitle layer driven entirely by the forced-alignment word timings. Because silence-trim (Phase 3.5) runs *before* align (Phase 4), and the rendered reel concatenates clips under the voiceover, the **alignment timeline === voiceover timeline === preview-MP4 timeline 1:1** — so captions map directly onto `video.currentTime` with no re-alignment.

### Pipeline: Phase 4.5 `caption`
[lib/pipeline.ts](lib/pipeline.ts) (between `align` and `map`). `PHASES` is now **ten** entries. The phase:
1. `chunkCaptions(words)` ([lib/subtitles.ts](lib/subtitles.ts)) — the **VEED-faithful chunker**: greedy grouping with `maxChars≈22`, `maxWords≈5`, force-break on sentence punctuation (`.?!`) and on a speech-pause gap `>320ms`. Reproduces the variable 1–5-word groups ("on", "the entire study", "my own and landed").
2. `highlightWords(captions)` ([lib/gemini/highlightWords.ts](lib/gemini/highlightWords.ts)) — one cheap Gemini 3.5 Flash call marks the punchy word(s) per caption `bold:true` (any number; ~1 typical). Non-fatal — captions ship un-emphasized if it errors. Cost tracked via `addCaptionCost` (new `caption` bucket in [lib/costs.ts](lib/costs.ts)).
3. Writes `subtitles.json` = `{ style: SubtitleStyle, captions: Caption[] }` with the default preset.

`subtitles.json` is invalidated by `invalidateVoiceoverDownstream` (new words) and `invalidateScriptDownstream` (re-chunk); see [lib/cacheInvalidate.ts](lib/cacheInvalidate.ts).

### Two presets, one data model
[lib/subtitles.ts](lib/subtitles.ts) `PRESETS`:
- **`lowerLeftDisplay`** (default) — lower-left two-tier: a huge **Inter Black** keyword over a smaller **Libre Caslon Text italic** line ("six" / "months."). `twoTier:true` breaks a line whenever bold-ness flips between adjacent words. Cream `#F5F0DC` + soft drop shadow.
- **`centeredSerif`** — centered single line, **Libre Caslon Text**, emphasized words pop in bright `#E9FF12` ("the *entire* study").

The preset fixes structure + emphasis treatment; the user overrides **font / size / base colour / highlight colour / vertical position** globally (only per-word **bold** is local — toggled in the script box). `applyPreset` resets the four preset-derived defaults when switching, VEED-style.

### Parity: ONE SVG, three surfaces
[lib/subtitleSvg.ts](lib/subtitleSvg.ts) `buildCaptionSvg()` returns an SVG string in the **1080×1920 export space**. The live overlay ([components/editor/SubtitleLayer.tsx](components/editor/SubtitleLayer.tsx)) injects this exact string (scaled to the video via the SVG `viewBox`) and the server renderer hands the **same** string to resvg. No second layout engine → the preview is the export.

### Render engine — **SVG→PNG via @resvg/resvg-js + ffmpeg** (NOT libass)
[lib/subtitleRender.ts](lib/subtitleRender.ts). Each caption "state" (one per word-reveal, via `computeStates`) is rasterized to PNG by resvg, then composited with ffmpeg's universal `overlay`/`concat`/`color` filters — **no `ass`/`subtitles`/`drawtext` filter needed**.
- `buildOverlayMov` → a full-length transparent **qtrle** (alpha) overlay video, cached by `hashSubtitles`.
- `renderGreenScreenSubs` → **subtitles.mp4**: overlay composited onto `color=#00B140` (broadcast chroma green), 1080×1920, reel duration.
- `renderSubtitledMp4` → the preview MP4 with captions burned in (keeps the voiceover audio).

**Why this engine and not ASS/libass** (the originally-chosen approach): the dev machine's Homebrew ffmpeg ships **without libass/freetype** (Homebrew core dropped it; the tap build is a slow source compile), and an external static-binary download is blocked by policy. SVG→PNG runs on **any** ffmpeg (local + EC2) with **zero** ffmpeg dependency, and is **pixel-identical** to the live overlay because it reuses the same SVG. **Fallback if fidelity ever falls short:** headless-browser frame capture (Playwright) screenshotting the real overlay — heavier (~300MB Chromium), but the same-renderer guarantee. ASS/libass remains a theoretical option only where a libass-enabled ffmpeg is guaranteed.

> ⚠️ `@resvg/resvg-js` is a **native** module — it MUST be in `serverExternalPackages` in [next.config.ts](next.config.ts) (alongside `@google/genai`) or the bundler fails with "could not resolve @resvg/resvg-js-darwin-arm64". Also: pass fonts to resvg via **`fontFiles` (paths), not `fontBuffers`** — buffers lose the weight axis and render every weight as Regular (verified).

### Fonts
Static instances in **`public/fonts/`** (instantiated from the variable originals with `fonttools`, since resvg ignores variable-font weight axes): `Inter-{Regular,Bold,Black}.ttf`, `LibreCaslonText-{Regular,Bold,Italic}.ttf`. `@font-face`'d in [app/globals.css](app/globals.css) for the browser overlay; loaded by file path in the renderer. Browser and resvg use the same families/weights → match.

### Editor UI
- **Live overlay + on-canvas controls** ([SubtitleLayer.tsx](components/editor/SubtitleLayer.tsx)): click the caption → a VEED-style floating toolbar. A **Normal / Highlight target toggle** selects which text the font dropdown · size stepper · colour swatch act on, so base and emphasized text are styled **independently** (`fontFamily`/`fontSize`/`color` vs `highlightFontFamily`/`highlightFontSize`/`highlightColor`). Drag the caption vertically to set `positionY` (horizontal anchor stays per preset).
  - The highlight font/size fields are **optional** on `SubtitleStyle` — when unset they fall back to the preset's emphasis font and `baseSize × emphasisScale`, so sessions created before this control still render correctly.
  - **No entrance animation**: words appear instantly at full opacity. An earlier CSS fade restarted on every word-reveal re-injection and left short captions stuck near opacity 0 ("blinking"); it was removed. The injected SVG is wrapped in a `React.memo`'d `CaptionSvg` so the per-frame `currentMs` re-renders never re-touch the DOM.
- **Script box** ([components/editor/SubtitleScriptBox.tsx](components/editor/SubtitleScriptBox.tsx)): enable toggle, two preset cards, and the captions one-per-line. Select word(s) + **⌘/Ctrl+B** or the Emphasize button, or click a single word, to toggle `bold`. Text/timing are locked to the alignment (emphasis is the only per-caption edit).
- **Timeline SUBS row** ([components/editor/Timeline.tsx](components/editor/Timeline.tsx)): caption chips, click to seek.
- Edits update local React state instantly (live preview) and persist debounced to `PUT /api/subtitles`.

### API + exports
- `GET/PUT /api/subtitles` — read (lazily inits from alignment for pre-feature sessions via [lib/subtitlesStore.ts](lib/subtitlesStore.ts)) / persist state. `GET /api/editor` now also returns `subtitles`.
- `POST /api/export/mp4` — body `{ subtitles?: boolean }`. Without → preview passthrough (unchanged). With → `renderSubtitledMp4` (burned), cached by `planHash`+`subHash`.
- `POST /api/export/bundle` — renders the green-screen **subtitles.mp4**, adds it to the ZIP, and passes it to the XMEML as a **second video track stacked above** the footage (V2/top in Premiere). `Content-Length` stays byte-exact (predictBundleSize accounts for the new entry).
- `POST /api/export/xml` — same top subtitle track, referencing the rendered file by absolute path.
- [lib/xmeml.ts](lib/xmeml.ts) `subtitleVideo` option emits the top track. **Subtitles are NEVER burned into the source clips in the ZIP/XML** — only the standalone green-screen file carries them.

The "Download MP4" button opens a modal (with-subtitles / without); the ZIP always includes the green-screen layer.

> ⚠️ The browser download helper in `exportFile` ([app/page.tsx](app/page.tsx)) MUST set `a.href = objectUrl` before `a.click()` (an anchor with only a `download` attr and no `href` is a silent no-op — the success toast fires but nothing saves). Revoke the object URL on a delay, not synchronously after click.
