# Producer — Deep Context

A single source of truth for what this codebase is, how every piece fits together, what assumptions hold, and why each design decision was made. Read this if you've just walked into the project and need to be productive in an hour.

---

## 1. What this product is

**Producer is an AI Reel assembler.** A single user feeds in:

1. A pile of source clips and stills (videos, images), each pre-tagged into one of five script sections.
2. A voiceover audio file (the narration, already recorded).
3. The script text, broken into lines, each line tagged to a section.
4. An optional override prompt that biases the AI's editorial choices.

The system produces:

- A 9:16 (1080×1920) vertical Reel MP4 — voiceover as the only audio, clips trimmed and concatenated under it.
- An editable timeline view where the user can fine-tune the AI's clip/trim choices before exporting.
- Optional FCPXML export so Premiere/FCP can pick up the edit.

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
| State (server) | Local filesystem (`.producer-data/`) + in-process singleton | No database. |
| Media processing | `ffmpeg` / `ffprobe` (system binaries) spawned via `child_process` | Not `ffmpeg.wasm`. Real native ffmpeg. |
| AI — vision/text | Google Gemini via `@google/genai` | Two models: `gemini-3.5-flash` (describe) and `gemini-3.1-pro-preview` (match). |
| AI — audio align | ElevenLabs Forced Alignment via `@elevenlabs/elevenlabs-js` | Returns per-word timestamps from a script + audio file. |
| Drag-and-drop | `@dnd-kit` | Used in the bucket UI to drop clips into sections. |
| Forms / validation | `react-hook-form` + `zod` |  |
| Toasts | `sonner` |  |

---

## 4. Repository layout

```
app/
  page.tsx              ← The studio. Setup mode + Edit mode in one page, toggled by `mode`.
  layout.tsx            ← Root layout, fonts, toaster.
  globals.css           ← Tailwind base + section color tokens.
  login/                ← /login page (the auth gate UI).
  processing/           ← The "cooking" overlay route (legacy; current code uses an overlay component).
  editor/               ← (Used by some editor sub-views; bulk of edit UI is in app/page.tsx.)
  api/
    auth/login          POST    set the cookie if creds match
    auth/logout         POST    clear the cookie
    session             POST    new session (+ wipes orphans, see §10)
                        DELETE  wipe the named session
    manifest            GET     read session manifest JSON
                        PATCH   update script / override prompt
    upload              POST    streaming upload of one clip or voiceover
    upload/[clipId]     DELETE  remove a clip from session
    generate            POST    kick off the full 7-phase pipeline (fire-and-forget)
    rerun               POST    re-run only phases 6-7 using cached outputs
    job/[id]            GET     job snapshot OR SSE stream of phase events
    job/[id]/stop       POST    abort an in-flight job
    media/[...path]     GET     serve a file out of .producer-data with HTTP Range
    editor              GET     bundle of {manifest, plan, sections, alignment} for the editor view
                        PUT     persist an edited edit-plan
    export/mp4          POST    render the final MP4 with ffmpeg, stream it back
    export/fcpxml       POST    serialise the edit-plan to FCPXML and return it

components/
  branding/             Logo
  ui/                   shadcn primitives (Button, Card, Dialog, Tooltip, ...)
  builder/              Setup-mode widgets (SectionBucket, ScriptPane, VoiceoverSlot, OverridePrompt)
  editor/               Edit-mode widgets (Preview, Timeline, segment chips)
  processing/           Job overlay (CookOverlay, PhaseStrip, ElapsedTimer)

lib/
  types.ts              Single source of truth for all shared types (SourceClip, EditPlan, JobState, etc.)
  sections.ts           Section list + line-to-window alignment algorithm (token-walking)
  session.ts            DATA_ROOT, sessionDir(), paths(), readJson/writeJson, ensureSession
  manifest.ts           loadManifest/saveManifest/removeSource — wraps session.ts for the manifest JSON
  jobStore.ts           In-memory singleton: JobState + EventEmitter for SSE
  pipeline.ts           The 7-phase orchestrator (see §6)
  ffmpeg.ts             probe(), probeAudioDurationMs(), extractFrames(), renderFinalMp4()
  concurrency.ts        sleep(), withBackoff() — exponential backoff for 429/5xx
  fcpxml.ts             buildFcpxml() — serialise an EditPlan to FCPXML 1.10
  auth.ts               Cookie name/value constants, getServerCreds, credsMatch
  utils.ts              cn() (tailwind merge), formatDuration()
  builderStore.ts       Client-side hooks: useSessionManifest, uploadClip, uploadVoiceover, resetSession
  gemini/
    client.ts           Lazy singleton GoogleGenAI client; constants MODEL_DESCRIBE / MODEL_MATCH
    describeFrames.ts   describeClip() — Phase 3 Gemini call (frame descriptions + summary)
    matchAndTrim.ts     matchAndTrim() — Phase 6 Gemini call (the editor brain)
  elevenlabs/
    forcedAlign.ts      forcedAlign() — Phase 4 ElevenLabs call

middleware.ts           Cookie-based auth gate. Excludes /api/upload (see §8).
next.config.ts          serverActions.bodySizeLimit = "2gb"; serverExternalPackages: ["@google/genai"]
nixpacks.toml           Tells Railway to install ffmpeg.
.env.example            Documented env vars.
.gitignore              .producer-data/, .env, etc. excluded from git.
```

---

## 5. Data model (the important types)

All defined in [lib/types.ts](lib/types.ts).

- **`SourceClip`** — a single uploaded clip or image. Has `id`, `section`, `kind` (`video` or `image`), `relPath` (under `.producer-data/<session>/sources/`), `url` (a `/api/media/...` path), `durationMs`, `width`, `height`, `fps`, `sizeBytes`.
- **`ScriptLine`** — `{ id, text, section }`. The user can type the script in any order; each line carries the section it belongs to.
- **`WordTimestamp`** — `{ text, startMs, endMs }`. One per word from ElevenLabs forced alignment.
- **`SectionWindow`** — `{ section, startMs, endMs, lines }`. The voiceover time-range that a section occupies, computed in Phase 5 from line-to-token alignment.
- **`FrameDescription`** — `{ timestampMs, description }`. One per extracted frame, produced by Gemini in Phase 3.
- **`ClipAnalysis`** — `{ clipId, frames[], summary }`. The full Phase 3 output for one clip.
- **`PlanSegment`** — `{ id, section, clipId, sourceInMs, sourceOutMs, timelineStartMs, timelineEndMs, whyClip, whyTrim, hold? }`. One block on the final timeline. Source in/out are slice points into the original clip; timeline in/out are the position on the final Reel.
- **`EditPlan`** — `{ segments: PlanSegment[], totalDurationMs }`. The complete edit decision list.
- **`JobState`** — `{ id, sessionId, phases: PhaseState[], currentPhase, status, ... }`. Live progress for a pipeline run.
- **`PhaseId`** — exactly seven values, in this order: `upload`, `frames`, `analyse`, `align`, `map`, `match`, `assemble`.

The **invariant the AI must obey**: for every segment, `sourceOutMs - sourceInMs === timelineEndMs - timelineStartMs`. The prompt enforces this; the schema doesn't.

---

## 6. The pipeline — the heart of the product

[lib/pipeline.ts](lib/pipeline.ts) runs seven phases. Each one (a) reports status via `jobStore.updatePhase`, (b) checks `aborted(jobId)` between steps so a stop button works, and (c) **caches its output to disk** so a rerun can skip it.

### Phase 1 — `upload` (validate)
Pre-flight. Checks: at least one clip, voiceover present, every script line non-empty, every line section-tagged. Throws an `Error` whose message becomes the user-visible failure detail. Never modifies disk.

### Phase 2 — `frames` (extract)
For each video clip: spawn ffmpeg to extract JPEGs at **2 fps** ([lib/pipeline.ts:21](lib/pipeline.ts:21): `FRAME_FPS = 2`), write to `.producer-data/<session>/frames/<clipId>/0001.jpg`, `0002.jpg`, ... For images, no extraction — the single image path is reused. **Cache key: existence of the frame directory with `.jpg` files.** Sufficient because nothing rewrites an existing frames dir; the only way to invalidate is to delete the clip and re-upload (which mints a new clipId).

`framesByClip: Map<string, { paths, timestamps }>` is built in-memory for handoff to Phase 3.

### Phase 3 — `analyse` (Gemini describe)
For each clip, pack all its frames into a single Gemini `generateContent` call ([lib/gemini/describeFrames.ts:46](lib/gemini/describeFrames.ts:46)):

- Model: `gemini-3.5-flash` ([lib/gemini/client.ts:15](lib/gemini/client.ts:15))
- Media resolution: `MEDIA_RESOLUTION_HIGH` for `section === "body"` (product shots need detail), else `LOW`.
- Thinking level: `LOW` (Gemini's reasoning budget).
- Response schema: `{ summary: string, frames: [{ timestampMs, description }] }`, returned as JSON.

Parallelised with `pLimit(4)` ([lib/pipeline.ts:22](lib/pipeline.ts:22): `CLIP_CONCURRENCY = 4`) and wrapped in `withBackoff` for 429/5xx. Result written to `.producer-data/<session>/descriptions/<clipId>.json`. **Cache key: file exists.**

### Phase 4 — `align` (ElevenLabs forced alignment)
Concatenate all script lines into one string. Send the voiceover audio + that string to ElevenLabs's Forced Alignment endpoint ([lib/elevenlabs/forcedAlign.ts:16](lib/elevenlabs/forcedAlign.ts:16)). Returns one `{ text, startMs, endMs }` per word. `voDurationMs` = max `endMs`.

Cached as `.producer-data/<session>/alignment.json`. **Cache key: file exists and `words.length > 0`.**

### Phase 5 — `map` (compute section windows)
Pure CPU. [lib/sections.ts:115](lib/sections.ts:115): `computeSectionWindows()` walks two token streams in lock-step (the script-line tokens and the voiceover tokens) and assigns each line a `{ startMs, endMs }`. Then groups lines by section, takes min/max within each group, and produces five `SectionWindow`s in canonical order. The final non-empty section's `endMs` is extended to cover the full voiceover duration so the timeline closes cleanly.

**Key subtlety**: ElevenLabs returns words with punctuation/apostrophes ("I'm"). The mapper tokenizes both streams to lowercase alphanumeric ("im" → tokens `["i", "m"]`) and distributes the timing within multi-token words evenly. A small 8-token forward search window absorbs minor drift if ElevenLabs adds/drops a word.

Output: `.producer-data/<session>/sections.json`.

### Phase 6 — `match` (Gemini match + trim)
The editorial brain. [lib/gemini/matchAndTrim.ts](lib/gemini/matchAndTrim.ts).

- Model: `gemini-3.1-pro-preview`.
- Thinking level: `HIGH` (this is where the model actually "edits").
- Input: the five `SectionWindow`s (each with its script lines and candidate clips with summaries + frame descriptions).
- Output: `EditPlan { segments[] }` — for each section, one or more segments chosen from that section's candidates, each with `sourceInMs`/`sourceOutMs` (cut points) and `timelineStartMs`/`timelineEndMs` (position).

The prompt enforces ten rules in plain English (see [lib/gemini/matchAndTrim.ts:88](lib/gemini/matchAndTrim.ts:88)). The override prompt is appended verbatim.

Returned segments are sorted by `timelineStartMs`, clamped to non-negative, and given fresh `nanoid(8)` ids. `totalDurationMs` defaults to the last window's `endMs`.

### Phase 7 — `assemble` (hold-fills)
Pure CPU. [lib/pipeline.ts:239](lib/pipeline.ts:239): `applyHoldFills()` enforces two rules:

1. **Tail-hold**: If a section's last segment ends before its window's end, append a "hold" segment that freezes on the last frame of the real segment. `sourceInMs = sourceOutMs - 1` is the convention for "still frame from the end."
2. **No-clips hold**: If a section has script lines but zero clips uploaded, copy the previous section's last segment frozen on its last frame across the entire section window.

Output: `.producer-data/<session>/edit-plan.json`. Pipeline finishes; `jobStore.finish(jobId, "complete")`.

### Re-run path
[app/api/rerun/route.ts](app/api/rerun/route.ts) and the `rerunMatchOnly` flag in `RunOpts` exist for "I changed the override prompt, redo only the parts that depend on it." In practice, the disk-cache means a plain `/api/generate` call already skips Phases 2-5 if their outputs exist. The dedicated rerun endpoint short-circuits more aggressively.

---

## 7. External APIs

### Google Gemini
- SDK: `@google/genai` (declared as a serverExternalPackage in [next.config.ts](next.config.ts:7) so Next's bundler leaves it as a real Node import — its native binary loaders can fail otherwise).
- Models used: `gemini-3.5-flash` (vision, describe-frames), `gemini-3.1-pro-preview` (text, match-and-trim).
- Auth: `GEMINI_API_KEY` (or `GOOGLE_API_KEY` fallback).
- Retries: every call goes through `withBackoff` ([lib/concurrency.ts:10](lib/concurrency.ts:10)) — 5 attempts, exponential 800ms → 16s with jitter, retries on 429/5xx/timeouts/ECONNRESET.

### ElevenLabs
- SDK: `@elevenlabs/elevenlabs-js`.
- Endpoint: `client.forcedAlignment.create({ file, text })`. Returns `{ words: [{ text, start, end }] }` in seconds; we convert to ms.
- Auth: `ELEVENLABS_API_KEY`.
- Retries: same `withBackoff` wrapper.

### No other external services.

---

## 8. The upload story (why `/api/upload` looks weird)

This is the most important quirk in the codebase and the most frequent thing future-you will trip over.

**The problem**: Next.js's built-in `req.formData()` parser buffers the whole multipart body in memory before parsing, and **fails on bodies over ~10 MiB** with `"expected boundary after body"`. Source clips are GB-scale. This was tried and abandoned.

**The solution** ([app/api/upload/route.ts:45](app/api/upload/route.ts:45)):

1. **Browser side** ([lib/builderStore.ts:90](lib/builderStore.ts:90)): `fetch(url, { method: "POST", body: file })`. The `File` object goes into the request body directly. Metadata (`sessionId`, `section`, `kind`, `filename`) goes in the URL query string. **No multipart at all.** No `FormData`.

2. **Server side**: Read `req.body` (a Web `ReadableStream`), convert to a Node `Readable` via `Readable.fromWeb`, pipe into `createWriteStream(absPath)`. Streams chunk-by-chunk. The whole file never lives in RAM. ([app/api/upload/route.ts:164](app/api/upload/route.ts:164)).

**The middleware exclusion** ([middleware.ts:38](middleware.ts:38)): Next.js middleware runs on the Edge runtime, which buffers the entire request body before passing it to the matched route and **caps that buffer at 10 MiB** — even if middleware does nothing with the body. The fix is to exclude `/api/upload` from the matcher entirely. As a consequence, **auth is checked inline at the top of the upload handler** ([app/api/upload/route.ts:46](app/api/upload/route.ts:46)) rather than via middleware.

This pattern is fragile in two ways and should not be "cleaned up" without understanding:
- Anyone who switches the route to `req.formData()` will re-break large uploads.
- Anyone who removes the middleware exclusion will silently truncate uploads to 10 MiB.

Both have happened during the project's history.

---

## 9. The job model + SSE

Pipelines take minutes. HTTP responses can't hold open that long without something to show. The pattern:

- `POST /api/generate` creates a `JobState` in [lib/jobStore.ts](lib/jobStore.ts), starts the pipeline with `void runPipeline(...)` (fire-and-forget), and immediately returns `{ jobId }`.
- `GET /api/job/[id]` with `Accept: text/event-stream` opens a Server-Sent Events stream. The store has an `EventEmitter`; each `updatePhase` / `finish` emits, and the route forwards each emission as a `data: ...\n\n` SSE message.
- `POST /api/job/[id]/stop` calls `abortController.abort()`. The pipeline polls `aborted(jobId)` between phases and after every clip iteration; the `runVoid` ffmpeg helper kills the child process on abort. Gemini/ElevenLabs calls pass the signal through `withBackoff`.

**The critical architectural requirement**: the `jobStore` is a `globalThis` singleton. The pipeline and the SSE handler must run **in the same Node process**. This works on a single long-running container (Railway) and breaks on serverless (Vercel functions are separate isolates — see `context.md` history).

On redeploy, the in-memory store is empty. In-flight jobs vanish. Single-user mitigation: don't redeploy while someone is mid-pipeline.

---

## 10. Sessions and the filesystem

### Layout
`DATA_ROOT` ([lib/session.ts:5](lib/session.ts:5)) resolves to:
- `process.env.DATA_ROOT` if set (production, points at the Railway volume mount, e.g. `/data`)
- `<projectRoot>/.producer-data` otherwise (local dev)

Per session:
```
<DATA_ROOT>/<sessionId>/
  sources/           ← original uploaded clips & images (largest)
  frames/<clipId>/   ← extracted JPEGs at 2fps
  descriptions/      ← Gemini frame-description JSONs, one per clip
  voiceover/         ← the uploaded MP3/WAV/M4A
  output/            ← rendered final MP4s
  manifest.json      ← session state: clips, voiceover, script, override prompt
  alignment.json     ← ElevenLabs words + total duration
  sections.json      ← computed section windows
  edit-plan.json     ← final EditPlan
```

A `sessionId` is `nanoid(12)`, validated by regex `^[a-zA-Z0-9_-]{6,}$` in [lib/session.ts:9](lib/session.ts:9) to defend against path traversal.

### Single-session invariant

**The product is single-user.** As of [app/api/session/route.ts:11](app/api/session/route.ts:11), the `POST /api/session` handler (new-session flow) wipes every session folder under `DATA_ROOT` that isn't the one it just created. So **at most one session exists on disk at any time.** This is safe because there is no notion of concurrent users — anyone else clicking "new session" would be the same user.

This is the only thing keeping the volume bounded. There is no TTL cron, no usage-based GC, no manual cleanup task. The new-session POST is the cleanup mechanism.

The "Reset" button uses a different path (`DELETE /api/session?sessionId=...` at [app/api/session/route.ts:35](app/api/session/route.ts:35)), which wipes only the named session. That's also correct given single-user.

### Worst-case storage

Empirically from the two real sessions we measured (`4DaKltz7ynor`: 487 MB, `ypdIpwhch5lE`: 604 MB): one session weighs ~500-700 MB. The 2 GB Railway volume gives a 3× margin. If a user uploads 10+ clips of 4K MOV (each 200+ MB), it can spike — bump the volume and move on.

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

One page, two modes, one big stateful component. ~600 lines.

### `mode: "setup"`
The pre-pipeline view. Three regions:
- **Section buckets** (`components/builder/SectionBucket.tsx`) — five drop zones, one per section. `@dnd-kit` lets the user drag clips between buckets. Upload button on each bucket fires `uploadClip`.
- **Script pane** (`components/builder/ScriptPane.tsx`) — textarea-ish UI where the user pastes the script and tags each line to a section.
- **Voiceover slot** (`components/builder/VoiceoverSlot.tsx`) — drop zone for the audio file.
- **Override prompt** (`components/builder/OverridePrompt.tsx`) — free-text bias for the match phase.
- **"Generate" button** — calls `POST /api/generate`, then opens the cooking overlay.

### `mode: "edit"`
Shown after the pipeline completes (or when a session already has an `edit-plan.json` on disk — see [app/page.tsx:73](app/page.tsx:73)). Two regions:
- **Preview** (`components/editor/Preview.tsx`) — `<video>` element that plays the source clips back according to the plan. Honors `seekReq` from the timeline.
- **Timeline** (`components/editor/Timeline.tsx`) — scrollable strip of segment chips, each labeled with its section color. Clicking a chip seeks the preview.
- **Export buttons** — MP4 (fires `/api/export/mp4`, streams the response into a download) or FCPXML (`/api/export/fcpxml`).
- **Re-run with new prompt** — re-fires `/api/rerun` which only redoes phases 6-7.

### Session bootstrap
[lib/builderStore.ts:31](lib/builderStore.ts:31): `useSessionManifest()` runs once on mount.
1. Look for a session id in `sessionStorage` (`producer.sessionId`).
2. If absent: `POST /api/session`, get a fresh id, store it.
3. `GET /api/manifest?sessionId=<id>`, hydrate the React state.

**This is what triggers the orphan cleanup.** Because the only way to get a new session id is to clear `sessionStorage` (Reset button) or open in a fresh browser context, every "new session" POST is also a cleanup pass.

### Cooking overlay
`components/processing/CookOverlay.tsx` (+ `PhaseStrip`, `ElapsedTimer`). Opens an SSE connection to `/api/job/<jobId>` and renders one row per phase, status-coloured. The Stop button fires `/api/job/<jobId>/stop`. The Try Again button stays in setup mode and re-fires `/api/generate`.

---

## 13. ffmpeg — what we actually do with it

[lib/ffmpeg.ts](lib/ffmpeg.ts). Three operations.

### `probe(file)` — on upload
`ffprobe -v error -print_format json -show_streams -show_format <file>`. Used to extract `durationMs`, `width`, `height`, `fps` from a freshly-uploaded video. Wrapped in try/catch; "best effort." Cheap (<200ms).

### `probeAudioDurationMs(file)` — on voiceover upload
`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <file>`. Returns ms.

### `extractFrames(videoFile, outDir, fps)` — Phase 2
`ffmpeg -y -i <file> -vf fps=2 -q:v 3 <outDir>/%04d.jpg`. Streams JPEGs at 2fps. Takes a few seconds per minute of source. Wrapped in `runVoid` which respects an `AbortSignal` (kills the child on abort).

### `renderFinalMp4({ segments, voiceoverPath, outPath })` — `/api/export/mp4`
Builds a single ffmpeg invocation with one `-i` per segment (using `-ss` + `-t` for video trim, or `-loop 1 -t` for images), one final `-i` for the voiceover, and a `-filter_complex` graph that:

1. Scales each input to fit inside 1080×1920 (preserving aspect ratio).
2. Pads to 1080×1920 with black bars where needed.
3. Sets `sar=1`, normalises to 30 fps, normalises pixel format to `yuv420p`.
4. Concatenates all video streams with `concat=n=N:v=1:a=0`.

Output: H.264 `veryfast` CRF 20, AAC 192k, `+faststart`. Mapped to the voiceover audio (source audio is discarded). The result is written to `.producer-data/<session>/output/producer-<sessionShort>.mp4` and streamed back to the browser with `Content-Disposition: attachment`.

### Binary paths
`FFMPEG_PATH` / `FFPROBE_PATH` env vars override the default (`ffmpeg` / `ffprobe` on PATH). On Railway with our `nixpacks.toml`, both are on PATH out of the box.

---

## 14. The complete API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/login` | POST | Body `{ username, password }`. Sets cookie on match. |
| `/api/auth/logout` | POST | Clears cookie. |
| `/api/session` | POST | Mint session id; wipe orphans; init empty manifest. |
| `/api/session?sessionId=X` | DELETE | `rm -rf` that session folder. |
| `/api/manifest?sessionId=X` | GET | Read manifest JSON. |
| `/api/manifest` | PATCH | Body `{ sessionId, script?, overridePrompt? }`. Persist. |
| `/api/upload?sessionId=X&kind=clip&section=Y&filename=Z` | POST | Stream raw file body to disk. Updates manifest. |
| `/api/upload/[clipId]?sessionId=X` | DELETE | Remove a clip from manifest + disk. |
| `/api/generate` | POST | Body `{ sessionId, overridePrompt? }`. Start the 7-phase pipeline; return `{ jobId }`. |
| `/api/rerun` | POST | Body `{ sessionId, overridePrompt? }`. Re-run phases 6-7 only. |
| `/api/job/[id]` | GET | JSON snapshot, OR SSE stream if `Accept: text/event-stream`. |
| `/api/job/[id]/stop` | POST | Abort the job. |
| `/api/media/[...path]` | GET | Stream file from `.producer-data/<sessionId>/...` with Range support. |
| `/api/editor?sessionId=X` | GET | `{ manifest, plan, sections, alignment }` bundle for the editor view. |
| `/api/editor` | PUT | Body `{ sessionId, plan }`. Overwrite `edit-plan.json`. |
| `/api/export/mp4` | POST | Render final MP4, stream as attachment. |
| `/api/export/fcpxml` | POST | Return FCPXML 1.10 string. |

All routes are `runtime = "nodejs"`. Routes that may run >60s (`upload`, `generate`, `rerun`, `export/mp4`) declare `maxDuration` (300-600). On Railway that value is informational only; Railway has no per-request timeout.

---

## 15. Deployment — Railway

The target platform. Three pieces of configuration:

### `nixpacks.toml` (in repo)
```toml
[phases.setup]
nixPkgs = ["...", "ffmpeg"]
```
The `"..."` keeps Nixpacks' auto-detected Node toolchain; `"ffmpeg"` adds the binary (which includes `ffprobe`).

### Volume
Mount path `/data`, 2 GB. **Volumes are runtime-only** on Railway — they are not present during build, and writing to a mount path at build time silently does nothing useful. The mount path must not collide with anything the image ships.

### Env vars
```
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
AUTH_USERNAME=...
AUTH_PASSWORD=...
DATA_ROOT=/data
```

Setting `DATA_ROOT=/data` makes [lib/session.ts:5](lib/session.ts:5) point at the volume instead of `./.producer-data`. Without that, the app writes to ephemeral container disk and every redeploy wipes all uploads.

### What does NOT need changing
- `runtime = "nodejs"` on every route — already correct.
- `maxDuration` — Railway ignores it, harmless.
- `next.config.ts` `bodySizeLimit: "2gb"` — only applies to server actions, which this app doesn't use. Harmless.
- `serverExternalPackages: ["@google/genai"]` — required for the SDK to load correctly.
- The streaming upload pattern — already a real Node read of `req.body`, no Vercel-shaped workarounds in the way.
- `jobStore` — works because Railway is one long-running process.

### Cost expectation (Hobby $5/mo + $5 included credit)
- 2 GB volume: $0.30/mo
- Idle compute: ~$1-2/mo
- ffmpeg bursts: cents
- Egress: minimal

Expected: ~$2-4/mo of usage inside the $5 credit → only out-of-pocket is the $5 subscription.

---

## 16. Operational invariants

Things that are true and must stay true:

1. **At most one session on disk at a time.** Enforced by `POST /api/session`. Don't add code that creates session folders outside that path.
2. **Single user.** No locking, no per-user state. Two browsers hitting the app simultaneously will fight; this is by design.
3. **The pipeline and the SSE stream share an in-memory store.** They must run in the same Node process. Splitting them across processes/workers/Vercel functions will silently break the cooking overlay.
4. **`req.body` is streamed, not buffered, on upload.** Don't `await req.formData()` or `await req.text()` in the upload handler. Don't add Next.js middleware that reads the body.
5. **Every long-running route uses `runtime = "nodejs"`.** Edge would cap bodies at 10 MiB and disallow `child_process`.
6. **`DATA_ROOT` is the only source of truth for storage location.** Don't hardcode `.producer-data` in new code; import `DATA_ROOT` or `paths()` from `lib/session.ts`.
7. **`sessionId` is regex-validated everywhere it comes from outside.** Don't add a route that takes a `sessionId` query param without going through `sessionDir()` or `paths()`.

---

## 17. Known quirks / gotchas

- **`.producer-data/` is in `.gitignore`.** Local sessions never leak into commits. On a fresh clone, the directory is created at first request via `ensureSession`.
- **Module-level globals in `jobStore`** use `globalThis.__PRODUCER_JOB_STORE__` so Next's HMR doesn't multiply the store during dev. Keep that pattern if you add similar singletons.
- **`describeFrames.ts:79` switches resolution by section.** Body section gets HIGH; everything else LOW. This is intentional — body shots are often product/text-heavy.
- **`matchAndTrim.ts:114` uses `ThinkingLevel.HIGH`** — this is where the model gets time to "think" about cut points. Lowering it produces noticeably worse edits.
- **The FCPXML output muscle-memorises 30fps.** Source files at other framerates are still referenced; Premiere conforms them on import.
- **Hold-fills set `sourceInMs = sourceOutMs - 1`** to indicate "freeze on last frame." ffmpeg respects this because the clip is sliced to 1ms and the segment duration is longer — effectively a still.
- **The forced-alignment token walker** in `lib/sections.ts:63` tolerates ~30% mismatch via the 8-token search window. If the script and voiceover diverge wildly, sections will be misaligned silently. Garbage-in, garbage-out.
- **Two real session folders ate ~1 GB locally** before the orphan-cleanup change landed. If you see disk pressure in dev, that's why.

---

## 18. Things you probably should NOT do

- Switch the upload handler to `req.formData()`.
- Move `jobStore` to a separate process / worker / function.
- Deploy to a serverless platform (Vercel, Cloudflare Workers, Netlify Functions). The architecture is server-shaped.
- Add a database. The filesystem layout *is* the database; adding Postgres for a single-user one-session-at-a-time tool would be Stockholm-syndrome engineering.
- Bundle ffmpeg via `@ffmpeg-installer/ffmpeg`. That npm package's binaries are old, slow, and miss filters. Use the system ffmpeg from nixpacks.
- Add backwards-compat shims for renamed env vars or moved files. There's one user (you). Just edit the code.

---

## 19. The mental model in one paragraph

> A user dumps videos + a voiceover + a tagged script into a folder on disk. A 7-phase pipeline streams progress over SSE: ffmpeg cuts frames, Gemini describes them, ElevenLabs aligns the voiceover word-for-word, a section mapper figures out which time-range each script section occupies, Gemini picks and trims clips, and a small CPU pass fills any visual gaps. The user reviews the AI's choices in an editor, optionally tweaks, and exports MP4 or FCPXML. The whole thing runs as one Next.js process on a Railway container with a small persistent volume; there is no database, no queue, no worker, no second service. Auth is a cookie. The product is single-user; the disk holds exactly one session at a time. ffmpeg is the heavy machinery; Gemini is the brain; ElevenLabs is the ear; Next.js is glue.
