"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Download,
  FileArchive,
  FileVideo,
  Loader2,
  Plus,
  RotateCw,
  Sparkles,
  Square,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/branding/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { SectionBucket } from "@/components/builder/SectionBucket";
import { ScriptPane } from "@/components/builder/ScriptPane";
import { VoiceoverSlot } from "@/components/builder/VoiceoverSlot";
import { OverridePrompt } from "@/components/builder/OverridePrompt";
import { PhaseStrip } from "@/components/processing/PhaseStrip";
import { ElapsedTimer } from "@/components/processing/ElapsedTimer";
import { Preview } from "@/components/editor/Preview";
import { Timeline } from "@/components/editor/Timeline";
import { resetSession, useSessionManifest } from "@/lib/builderStore";
import { hashPlan } from "@/lib/planHash";
import {
  PHASE_LABEL,
  SECTIONS,
  type EditPlan,
  type JobState,
  type SectionId,
  type SectionWindow,
  type SourceClip,
  type WordTimestamp,
} from "@/lib/types";
import { formatDuration } from "@/lib/utils";

type Mode = "setup" | "edit";
type ExportKind = "mp4" | "xml" | "bundle";

interface EditorData {
  manifest: {
    sessionId: string;
    clips: SourceClip[];
    voiceover: { filename: string; relPath: string; url: string; sizeBytes: number } | null;
    overridePrompt: string;
    preview?: {
      filename: string;
      planHash: string;
      renderedAt: number;
    };
    costs?: {
      totalUsd: number;
      breakdown: {
        describe: { calls: number; inputTokens: number; outputTokens: number; usd: number };
        match: { calls: number; inputTokens: number; outputTokens: number; usd: number };
        align: { calls: number; audioMs: number; usd: number };
      };
    };
  };
  plan: EditPlan;
  sections: { windows: SectionWindow[]; totalDurationMs: number };
  alignment: { words: WordTimestamp[]; durationMs: number };
}

export default function StudioPage() {
  const router = useRouter();
  const { sessionId, manifest, setManifest, refresh, patch, loading } = useSessionManifest();

  const [mode, setMode] = useState<Mode>("setup");
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editor, setEditor] = useState<EditorData | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [overridePrompt, setOverridePrompt] = useState("");
  const [exporting, setExporting] = useState<"none" | ExportKind>("none");
  const [seekReq, setSeekReq] = useState<{ ms: number; nonce: number } | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Render-only job (re-render preview MP4 after editing). Subscribed to the
  // same /api/job/[id] SSE stream as the main pipeline; on complete we
  // refetch the editor bundle so manifest.preview reflects the new render.
  const [renderJobId, setRenderJobId] = useState<string | null>(null);
  const seekNonceRef = useRef(0);

  // Current plan's hash, compared against manifest.preview.planHash to know
  // if the cached preview MP4 is stale.
  const currentPlanHash = useMemo(() => (plan ? hashPlan(plan) : null), [plan]);
  const cachedPreview = editor?.manifest.preview ?? null;
  const isPreviewStale = !!(
    cachedPreview && currentPlanHash && cachedPreview.planHash !== currentPlanHash
  );
  const previewMp4Url = useMemo(() => {
    if (!sessionId || !cachedPreview) return null;
    return `/api/media/${sessionId}/output/${cachedPreview.filename}`;
  }, [sessionId, cachedPreview]);
  const isRendering = renderJobId !== null;

  // If a session already has a saved edit plan on disk, jump straight into edit mode.
  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const res = await fetch(`/api/editor?sessionId=${sessionId}`);
      if (res.ok) {
        const j = (await res.json()) as EditorData;
        setEditor(j);
        setPlan(j.plan);
        setOverridePrompt(j.manifest.overridePrompt ?? "");
        setMode("edit");
      }
    })();
  }, [sessionId]);

  const clipsBySection = useMemo(() => {
    const map: Record<SectionId, SourceClip[]> = { hook: [], bridge: [], body: [], outro: [], cta: [] };
    if (manifest) manifest.clips.forEach((c) => map[c.section].push(c));
    return map;
  }, [manifest]);

  const clipsMap = useMemo<Record<string, SourceClip>>(() => {
    if (!manifest) return {};
    return Object.fromEntries(manifest.clips.map((c) => [c.id, c]));
  }, [manifest]);

  const validation = useMemo(() => {
    if (!manifest) return { canGenerate: false, reason: "Loading…" };
    const linesWithText = manifest.script.filter((l) => l.text.trim().length > 0);
    const untagged = linesWithText.filter((l) => !l.section).length;
    if (manifest.clips.length === 0) return { canGenerate: false, reason: "Add at least one clip or image before generating." };
    if (!manifest.voiceover) return { canGenerate: false, reason: "Upload a voiceover before generating." };
    if (!linesWithText.length) return { canGenerate: false, reason: "Paste your script before generating." };
    if (untagged > 0) return { canGenerate: false, reason: "Tag every line to a section before generating." };
    return { canGenerate: true, reason: "Ready to roll." };
  }, [manifest]);

  // Pipeline kickoff
  const startJob = useCallback(
    async (mutator?: { overridePrompt?: string }) => {
      if (!sessionId || !manifest) return;
      setSubmitting(true);
      try {
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId,
            overridePrompt: mutator?.overridePrompt ?? manifest.overridePrompt,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `Generate failed (${res.status})`);
        }
        const j = (await res.json()) as { jobId: string };
        setActiveJob({
          id: j.jobId,
          sessionId,
          startedAt: Date.now(),
          phases: [],
          currentPhase: "upload",
          status: "running",
        } as JobState);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not start generation");
      } finally {
        setSubmitting(false);
      }
    },
    [sessionId, manifest],
  );

  const stopJob = useCallback(async () => {
    if (!activeJob) return;
    await fetch(`/api/job/${activeJob.id}/stop`, { method: "POST" }).catch(() => {});
  }, [activeJob]);

  // Subscribe to the active job's SSE stream
  useEffect(() => {
    if (!activeJob) return;
    const es = new EventSource(`/api/job/${activeJob.id}`, { withCredentials: false });
    es.onmessage = async (ev) => {
      try {
        const data = JSON.parse(ev.data) as JobState | { error: string };
        if ("error" in data) {
          toast.error(data.error);
          es.close();
          setActiveJob(null);
          return;
        }
        setActiveJob(data);
        if (data.status === "complete") {
          es.close();
          const res = await fetch(`/api/editor?sessionId=${data.sessionId}`);
          if (res.ok) {
            const j = (await res.json()) as EditorData;
            setEditor(j);
            setPlan(j.plan);
            setOverridePrompt(j.manifest.overridePrompt ?? "");
            setMode("edit");
          }
          setActiveJob(null);
        } else if (data.status === "failed" || data.status === "stopped") {
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [activeJob?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePlanDebounced = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return (next: EditPlan) => {
      if (!sessionId) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        void fetch("/api/editor", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, plan: next }),
        });
      }, 250);
    };
  }, [sessionId]);

  const onPlanChange = (next: EditPlan) => {
    setPlan(next);
    savePlanDebounced(next);
  };

  const onSeek = (ms: number) => {
    seekNonceRef.current += 1;
    setSeekReq({ ms, nonce: seekNonceRef.current });
  };

  // Fire /api/render and let the SSE subscriber below pick up progress +
  // completion. Reuses the same jobStore + /api/job/[id] mechanism as the
  // main pipeline — no new infra needed client-side.
  const onRequestRerender = useCallback(async () => {
    if (!sessionId || renderJobId) return;
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not start re-render");
      }
      const j = (await res.json()) as { jobId: string };
      setRenderJobId(j.jobId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-render failed to start");
    }
  }, [sessionId, renderJobId]);

  // Subscribe to the render job's SSE stream — refresh editor bundle on
  // completion so manifest.preview points at the freshly rendered MP4 and
  // the Preview reloads it.
  useEffect(() => {
    if (!renderJobId || !sessionId) return;
    const es = new EventSource(`/api/job/${renderJobId}`, { withCredentials: false });
    es.onmessage = async (ev) => {
      try {
        const data = JSON.parse(ev.data) as JobState | { error: string };
        if ("error" in data) {
          toast.error(data.error);
          es.close();
          setRenderJobId(null);
          return;
        }
        if (data.status === "complete") {
          es.close();
          const res = await fetch(`/api/editor?sessionId=${sessionId}`);
          if (res.ok) {
            const j = (await res.json()) as EditorData;
            setEditor(j);
          }
          setRenderJobId(null);
          toast.success("Preview rendered");
        } else if (data.status === "failed" || data.status === "stopped") {
          es.close();
          setRenderJobId(null);
          toast.error(data.error ?? "Re-render failed");
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es.close();
      setRenderJobId(null);
    };
    return () => es.close();
  }, [renderJobId, sessionId]);

  const exportFile = async (kind: ExportKind) => {
    if (!sessionId) return;
    setExporting(kind);
    try {
      const res = await fetch(`/api/export/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        // The MP4 cache-passthrough returns 409 when the cached render is
        // stale. Surface that as a clear prompt to re-render rather than a
        // generic export-failed toast.
        if (res.status === 409 && kind === "mp4") {
          const j = (await res.json().catch(() => ({}))) as { error?: string; stale?: boolean };
          toast.error(j.error ?? "Preview is stale — click Re-render in the editor first.");
          return;
        }
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Export failed. Try again.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `producer-${sessionId.slice(0, 6)}.${kind === "bundle" ? "zip" : kind}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const message =
        kind === "mp4"
          ? "Downloaded MP4"
          : kind === "xml"
            ? "Downloaded XML — open in Premiere / Resolve / FCP"
            : "Downloaded project bundle — unzip and open the .xml in Premiere / Resolve / FCP";
      toast.success(message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting("none");
    }
  };

  const tryAgain = useCallback(async () => {
    if (!activeJob) return;
    setActiveJob(null);
    await startJob();
  }, [activeJob, startJob]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/50 bg-background/60 backdrop-blur-xl">
        <div className="container flex h-16 items-center justify-between gap-4">
          <Logo />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetOpen(true)}
              className="gap-1.5"
              title="Start a new session"
            >
              <Plus className="size-3.5" /> New session
            </Button>
            {mode === "edit" && editor && (
              <>
                <CostChip
                  totalUsd={editor.manifest.costs?.totalUsd ?? 0}
                  breakdown={editor.manifest.costs?.breakdown}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => exportFile("xml")}
                  disabled={exporting !== "none"}
                  title="Download just the XML (you'll need to relink media manually)"
                >
                  {exporting === "xml" ? <Loader2 className="size-4 animate-spin" /> : <FileVideo className="size-4" />}
                  XML only
                </Button>
                <Button
                  variant="outline"
                  onClick={() => exportFile("bundle")}
                  disabled={exporting !== "none"}
                  title="Download the XML + all source clips + voiceover as a .zip — Premiere opens it with zero relink"
                >
                  {exporting === "bundle" ? <Loader2 className="size-4 animate-spin" /> : <FileArchive className="size-4" />}
                  Download project (.zip)
                </Button>
                <Button onClick={() => exportFile("mp4")} disabled={exporting !== "none"} size="lg">
                  {exporting === "mp4" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                  Download MP4
                </Button>
              </>
            )}
            {mode === "setup" && (
              <Button
                size="lg"
                onClick={() => startJob()}
                disabled={!validation.canGenerate || submitting}
                className="gap-2"
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                Generate reel
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className={`container ${mode === "edit" ? "pt-3 pb-4" : "py-8"}`}>
        {mode === "setup" ? (
          <SetupView
            sessionId={sessionId}
            manifest={manifest}
            setManifest={setManifest}
            refresh={refresh}
            patch={patch}
            clipsBySection={clipsBySection}
            validation={validation}
          />
        ) : (
          editor && plan && (
            <EditView
              editor={editor}
              plan={plan}
              clipsBySection={clipsBySection}
              clipsMap={clipsMap}
              overridePrompt={overridePrompt}
              setOverridePrompt={setOverridePrompt}
              currentMs={currentMs}
              onTime={setCurrentMs}
              seekReq={seekReq}
              onSeek={onSeek}
              onPlanChange={onPlanChange}
              onRerun={() => startJob({ overridePrompt })}
              onBackToSetup={() => { setMode("setup"); setEditor(null); setPlan(null); }}
              previewMp4Url={previewMp4Url}
              isPreviewStale={isPreviewStale}
              isRendering={isRendering}
              onRequestRerender={onRequestRerender}
            />
          )
        )}

        {loading && (
          <div className="pointer-events-none fixed inset-0 grid place-items-center bg-background/40 backdrop-blur-sm">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        )}
      </main>

      <CookOverlay
        job={activeJob}
        onStop={stopJob}
        onTryAgain={tryAgain}
        onDismiss={() => setActiveJob(null)}
      />
      <ResetConfirm
        open={resetOpen}
        busy={resetting}
        onCancel={() => setResetOpen(false)}
        onConfirm={async () => {
          setResetting(true);
          await resetSession(sessionId);
        }}
      />
      <RouterMirror router={router} mode={mode} />
    </div>
  );
}

// Mirror the current studio mode to the URL hash (purely cosmetic; no nav).
function RouterMirror({ mode }: { router: ReturnType<typeof useRouter>; mode: Mode }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = mode === "edit" ? "#edit" : "";
    if (window.location.hash !== next) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
    }
  }, [mode]);
  return null;
}

/* ============================== SETUP VIEW ============================== */

interface SetupViewProps {
  sessionId: string | null;
  manifest: ReturnType<typeof useSessionManifest>["manifest"];
  setManifest: ReturnType<typeof useSessionManifest>["setManifest"];
  refresh: ReturnType<typeof useSessionManifest>["refresh"];
  patch: ReturnType<typeof useSessionManifest>["patch"];
  clipsBySection: Record<SectionId, SourceClip[]>;
  validation: { canGenerate: boolean; reason: string };
}

function SetupView({
  sessionId,
  manifest,
  setManifest,
  refresh,
  patch,
  clipsBySection,
  validation,
}: SetupViewProps) {
  return (
    <>
      <div className="mb-10 flex flex-col items-start gap-3">
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
          <Wand2 className="size-3" /> Studio
        </span>
        <h1 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight md:text-5xl">
          Build a reel that <span className="grad-text">hits</span>.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground md:text-base">
          Drop clips, paste your script, hand over the voiceover. We match every line to the right
          frame, trim the dead bits, and hand back a near-finished cut in about a minute.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Section footage</CardTitle>
              <CardDescription>
                Five fixed sections in order. Mix video + images freely. Hook → Bridge → Body → Outro → CTA.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {SECTIONS.map((s) => (
                  <SectionBucket
                    key={s}
                    sessionId={sessionId ?? ""}
                    section={s}
                    clips={clipsBySection[s] ?? []}
                    onChange={refresh}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Voiceover</CardTitle>
              <CardDescription>One audio file. This drives every section's timing.</CardDescription>
            </CardHeader>
            <CardContent>
              {sessionId && (
                <VoiceoverSlot sessionId={sessionId} voiceover={manifest?.voiceover ?? null} onChange={refresh} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Script</CardTitle>
              <CardDescription>
                Paste your script. Prefix each chunk with{" "}
                <span className="font-mono text-foreground/80">hook:</span>,{" "}
                <span className="font-mono text-foreground/80">product:</span>,{" "}
                <span className="font-mono text-foreground/80">cta:</span>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScriptPane
                value={manifest?.script ?? []}
                onChange={(lines) => {
                  if (manifest) setManifest({ ...manifest, script: lines });
                  void patch({ script: lines });
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Steering</CardTitle>
              <CardDescription>Boss the AI around — or leave it blank.</CardDescription>
            </CardHeader>
            <CardContent>
              <OverridePrompt
                value={manifest?.overridePrompt ?? ""}
                onChange={(v) => {
                  if (manifest) setManifest({ ...manifest, overridePrompt: v });
                  void patch({ overridePrompt: v });
                }}
              />
            </CardContent>
          </Card>

          <div
            className={`rounded-xl border px-4 py-3 text-xs ${
              validation.canGenerate
                ? "border-primary/30 bg-primary/5 text-foreground/90"
                : "border-border/70 bg-card/60 text-muted-foreground"
            }`}
          >
            {validation.reason}
          </div>
        </aside>
      </div>
    </>
  );
}

/* ============================== EDIT VIEW ============================== */

interface EditViewProps {
  editor: EditorData;
  plan: EditPlan;
  clipsBySection: Record<SectionId, SourceClip[]>;
  clipsMap: Record<string, SourceClip>;
  overridePrompt: string;
  setOverridePrompt: (v: string) => void;
  currentMs: number;
  onTime: (ms: number) => void;
  seekReq: { ms: number; nonce: number } | null;
  onSeek: (ms: number) => void;
  onPlanChange: (p: EditPlan) => void;
  onRerun: () => void;
  onBackToSetup: () => void;
  previewMp4Url: string | null;
  isPreviewStale: boolean;
  isRendering: boolean;
  onRequestRerender: () => void;
}

function EditView({
  editor,
  plan,
  clipsBySection,
  clipsMap,
  overridePrompt,
  setOverridePrompt,
  currentMs,
  onTime,
  seekReq,
  onSeek,
  onPlanChange,
  onRerun,
  onBackToSetup,
  previewMp4Url,
  isPreviewStale,
  isRendering,
  onRequestRerender,
}: EditViewProps) {
  const totalMs = plan.totalDurationMs || editor.alignment.durationMs;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[22rem_1fr_22rem]">
        <aside className="flex flex-col gap-3">
          <Card>
            <CardHeader className="p-4">
              <CardTitle className="text-base">Steering</CardTitle>
              <CardDescription className="text-xs">Tweak and Re-run — cached frames & alignment make it fast.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5 p-4 pt-0">
              <OverridePrompt value={overridePrompt} onChange={setOverridePrompt} variant="editor" />
              <Button variant="primary" onClick={onRerun} className="w-full">
                <RotateCw className="size-4" />
                Re-run match
              </Button>
              <Button variant="ghost" size="sm" onClick={onBackToSetup} className="w-full">
                Edit inputs
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Reel stats</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2 p-4 pt-0 text-center">
              <Stat label="Segments" value={plan.segments.length.toString()} />
              <Stat label="Duration" value={formatDuration(totalMs)} />
              <Stat label="Clips" value={editor.manifest.clips.length.toString()} />
            </CardContent>
          </Card>
        </aside>

        <section className="flex flex-col items-center justify-start">
          <Card className="w-full">
            <CardContent className="p-3">
              <Preview
                previewMp4Url={previewMp4Url}
                isStale={isPreviewStale}
                isRendering={isRendering}
                onRequestRerender={onRequestRerender}
                segments={plan.segments}
                totalDurationMs={totalMs}
                seekRequest={seekReq}
                onTime={onTime}
              />
            </CardContent>
          </Card>
        </section>

        <aside className="flex flex-col gap-3">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Tips</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 p-4 pt-0 text-xs text-muted-foreground leading-relaxed">
              <p>· Click the timeline ruler to scrub.</p>
              <p>· Hover a clip card to see why this clip was picked.</p>
              <p>· Drag the edges to re-trim. Drag the body to reorder within a section.</p>
              <p>· Use ⇄ on a card to swap with another clip from its section.</p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-1">
          <h2 className="font-display text-base font-semibold tracking-tight">Timeline</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatDuration(currentMs)} / {formatDuration(totalMs)}
          </span>
        </div>
        <Timeline
          plan={plan}
          clips={clipsMap}
          clipsBySection={clipsBySection}
          totalDurationMs={totalMs}
          voiceoverWords={editor.alignment.words}
          currentTimeMs={currentMs}
          onSeek={onSeek}
          onChange={onPlanChange}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-2 py-3">
      <div className="font-display text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * Cumulative-cost pill shown next to the export buttons in edit mode.
 * Hovering reveals a per-phase breakdown so the user can see where the
 * dollars went (Gemini describe / match / ElevenLabs alignment).
 */
function CostChip({
  totalUsd,
  breakdown,
}: {
  totalUsd: number;
  breakdown?: {
    describe: { calls: number; inputTokens: number; outputTokens: number; usd: number };
    match: { calls: number; inputTokens: number; outputTokens: number; usd: number };
    align: { calls: number; audioMs: number; usd: number };
  };
}) {
  const tooltip = breakdown
    ? [
        `Gemini describe: $${breakdown.describe.usd.toFixed(4)} (${breakdown.describe.calls} calls, ${breakdown.describe.inputTokens.toLocaleString()} in / ${breakdown.describe.outputTokens.toLocaleString()} out tokens)`,
        `Gemini match: $${breakdown.match.usd.toFixed(4)} (${breakdown.match.calls} calls, ${breakdown.match.inputTokens.toLocaleString()} in / ${breakdown.match.outputTokens.toLocaleString()} out tokens)`,
        `ElevenLabs align: $${breakdown.align.usd.toFixed(4)} (${breakdown.align.calls} calls, ${(breakdown.align.audioMs / 1000).toFixed(1)}s audio)`,
      ].join("\n")
    : "No API spend yet this session";
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 font-mono text-xs tabular-nums text-muted-foreground"
      title={tooltip}
    >
      <span className="text-[10px] uppercase tracking-wider">API</span>
      <span className="font-semibold text-foreground">${totalUsd.toFixed(2)}</span>
    </div>
  );
}

/* ============================== COOK OVERLAY ============================== */

function CookOverlay({
  job,
  onStop,
  onTryAgain,
  onDismiss,
}: {
  job: JobState | null;
  onStop: () => void;
  onTryAgain: () => void;
  onDismiss: () => void;
}) {
  const open = !!job;
  const isRunning = job?.status === "running";
  const isTerminal = job?.status === "failed" || job?.status === "stopped";
  const isDone = job?.status === "complete";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isRunning) onDismiss(); }}>
      <DialogContent className="!max-w-2xl !p-0 overflow-hidden border-primary/30">
        <div className="relative">
          <div className="absolute inset-x-0 top-0 h-1 bg-aurora" aria-hidden="true" />
          <div className="p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <DialogTitle className="font-display text-2xl font-semibold leading-tight">
                  {isDone ? "Cut's ready — opening editor…" :
                   isTerminal && job?.status === "failed" ? "Hit a snag" :
                   isTerminal ? "Stopped" :
                   "Cooking your reel"}
                </DialogTitle>
                <DialogDescription className="mt-1 text-sm text-muted-foreground">
                  {job?.status === "running"
                    ? `${PHASE_LABEL[job.currentPhase]} — typically 1–3 min total.`
                    : job?.status === "failed"
                      ? job.error ?? "Something went wrong."
                      : job?.status === "stopped"
                        ? "Whatever was analysed has been kept."
                        : "Loading…"}
                </DialogDescription>
              </div>
              {job && <ElapsedTimer startedAt={job.startedAt} finishedAt={job.finishedAt} />}
            </div>

            <div className="rounded-xl border border-border/60 bg-background/40 p-5">
              {job ? <PhaseStrip phases={job.phases} /> : <Loader2 className="size-4 animate-spin" />}
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              {isRunning && (
                <Button variant="destructive" onClick={onStop}>
                  <Square className="size-3.5" /> Stop
                </Button>
              )}
              {isTerminal && (
                <>
                  <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
                  <Button onClick={onTryAgain}>
                    <RotateCw className="size-4" /> Try again
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ============================== RESET CONFIRM ============================== */

function ResetConfirm({
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="!max-w-md overflow-hidden border-destructive/40">
        <div className="relative">
          <div className="absolute inset-x-0 top-0 h-1 bg-hot" aria-hidden="true" />
          <div className="pt-2">
            <DialogTitle className="font-display text-xl font-semibold leading-tight">
              Start a new session?
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm text-muted-foreground leading-relaxed">
              All uploaded clips, the voiceover, the script, and the assembled cut will be deleted from
              the server. This can&apos;t be undone.
            </DialogDescription>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
              <Button variant="destructive" onClick={onConfirm} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Yes, new session
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Avoid unused warning for ArrowRight import (kept for future "next step" CTAs)
const _ArrowRight = ArrowRight;
