"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Download,
  FileVideo,
  Loader2,
  RotateCw,
  Sparkles,
  Square,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/branding/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { SectionBucket } from "@/components/builder/SectionBucket";
import { ScriptPane } from "@/components/builder/ScriptPane";
import { VoiceoverSlot } from "@/components/builder/VoiceoverSlot";
import { OverridePrompt } from "@/components/builder/OverridePrompt";
import { PhaseStrip } from "@/components/processing/PhaseStrip";
import { ElapsedTimer } from "@/components/processing/ElapsedTimer";
import { Preview } from "@/components/editor/Preview";
import { Timeline } from "@/components/editor/Timeline";
import { useSessionManifest } from "@/lib/builderStore";
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

interface EditorData {
  manifest: {
    sessionId: string;
    clips: SourceClip[];
    voiceover: { filename: string; relPath: string; url: string; sizeBytes: number } | null;
    overridePrompt: string;
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
  const [exporting, setExporting] = useState<"none" | "mp4" | "fcpxml">("none");
  const [seekReq, setSeekReq] = useState<{ ms: number; nonce: number } | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const seekNonceRef = useRef(0);

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

  const exportFile = async (kind: "mp4" | "fcpxml") => {
    if (!sessionId) return;
    setExporting(kind);
    try {
      const res = await fetch(`/api/export/${kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Export failed. Try again.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `producer-${sessionId.slice(0, 6)}.${kind === "mp4" ? "mp4" : "fcpxml"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(kind === "mp4" ? "Downloaded MP4" : "Downloaded Premiere FCPXML");
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
            {mode === "edit" && editor && (
              <>
                <Button variant="outline" onClick={() => exportFile("fcpxml")} disabled={exporting !== "none"}>
                  {exporting === "fcpxml" ? <Loader2 className="size-4 animate-spin" /> : <FileVideo className="size-4" />}
                  Premiere
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

      <main className="container py-8">
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
}: EditViewProps) {
  const totalMs = plan.totalDurationMs || editor.alignment.durationMs;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[22rem_1fr_22rem]">
        <aside className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Steering</CardTitle>
              <CardDescription>Tweak and Re-run — cached frames & alignment make it fast.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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
            <CardHeader>
              <CardTitle>Reel stats</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-3 text-center">
              <Stat label="Segments" value={plan.segments.length.toString()} />
              <Stat label="Duration" value={formatDuration(totalMs)} />
              <Stat label="Clips" value={editor.manifest.clips.length.toString()} />
            </CardContent>
          </Card>
        </aside>

        <section className="flex flex-col items-center justify-start gap-3">
          <Card className="w-full">
            <CardContent className="p-4">
              <Preview
                segments={plan.segments}
                clips={clipsMap}
                voiceoverUrl={editor.manifest.voiceover!.url}
                totalDurationMs={totalMs}
                seekRequest={seekReq}
                onTime={onTime}
              />
            </CardContent>
          </Card>
        </section>

        <aside className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Tips</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground leading-relaxed">
              <p>· Click the timeline ruler to scrub.</p>
              <p>· Hover a clip card to see why this clip was picked.</p>
              <p>· Drag the edges to re-trim. Drag the body to reorder within a section.</p>
              <p>· Use ⇄ on a card to swap with another clip from its section.</p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <h2 className="font-display text-lg font-semibold tracking-tight">Timeline</h2>
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
                <h2 className="font-display text-2xl font-semibold leading-tight">
                  {isDone ? "Cut's ready — opening editor…" :
                   isTerminal && job?.status === "failed" ? "Hit a snag" :
                   isTerminal ? "Stopped" :
                   "Cooking your reel"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {job?.status === "running"
                    ? `${PHASE_LABEL[job.currentPhase]} — typically 1–3 min total.`
                    : job?.status === "failed"
                      ? job.error ?? "Something went wrong."
                      : job?.status === "stopped"
                        ? "Whatever was analysed has been kept."
                        : "Loading…"}
                </p>
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

// Avoid unused warning for ArrowRight import (kept for future "next step" CTAs)
const _ArrowRight = ArrowRight;
