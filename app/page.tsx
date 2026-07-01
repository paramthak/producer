"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Captions,
  Download,
  FileVideo,
  HardDrive,
  Loader2,
  LogOut,
  Plus,
  Redo2,
  RotateCw,
  Sparkles,
  Square,
  Undo2,
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
import { SubtitleScriptBox } from "@/components/editor/SubtitleScriptBox";
import { resetSession, uploadClip, useSessionManifest } from "@/lib/builderStore";
import { applySplit, applyDelete, addFromLibrary } from "@/lib/planEdit";
import { DriveBrowser } from "@/components/drive/DriveBrowser";
import {
  PHASE_LABEL,
  SECTIONS,
  SECTION_LABEL,
  SECTION_DOT_VAR,
  type Caption,
  type EditPlan,
  type JobState,
  type SectionId,
  type SectionWindow,
  type SourceClip,
  type SubtitleState,
  type SubtitleStyle,
  type WordTimestamp,
} from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

type Mode = "setup" | "edit";
type ExportKind = "mp4";

interface EditorData {
  manifest: {
    sessionId: string;
    clips: SourceClip[];
    voiceover: { filename: string; relPath: string; url: string; sizeBytes: number } | null;
    overridePrompt: string;
    costs?: {
      totalUsd: number;
      breakdown: {
        describe: { calls: number; inputTokens: number; outputTokens: number; usd: number };
        match: { calls: number; inputTokens: number; outputTokens: number; usd: number };
        align: { calls: number; audioMs: number; usd: number };
        caption?: { calls: number; inputTokens: number; outputTokens: number; usd: number };
      };
    };
  };
  plan: EditPlan;
  sections: { windows: SectionWindow[]; totalDurationMs: number };
  alignment: { words: WordTimestamp[]; durationMs: number };
  subtitles?: SubtitleState | null;
}

export default function StudioPage() {
  const router = useRouter();
  const { sessionId, manifest, setManifest, refresh, patch, loading } = useSessionManifest();

  const [mode, setMode] = useState<Mode>("setup");
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editor, setEditor] = useState<EditorData | null>(null);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleState | null>(null);
  const [overridePrompt, setOverridePrompt] = useState("");
  const [exporting, setExporting] = useState<"none" | ExportKind>("none");
  const [mp4ModalOpen, setMp4ModalOpen] = useState(false);
  const [generatingSubs, setGeneratingSubs] = useState(false);
  const [seekReq, setSeekReq] = useState<{ ms: number; nonce: number } | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const seekNonceRef = useRef(0);
  // Timeline interaction state
  const [selectedSegId, setSelectedSegId] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(36);
  const [planPast, setPlanPast] = useState<EditPlan[]>([]);
  const [planFuture, setPlanFuture] = useState<EditPlan[]>([]);
  const currentMsRef = useRef(0);
  useEffect(() => { currentMsRef.current = currentMs; }, [currentMs]);

  // If a session already has a saved edit plan on disk, jump straight into edit mode.
  useEffect(() => {
    if (!sessionId) return;
    (async () => {
      const res = await fetch(`/api/editor?sessionId=${sessionId}`);
      if (res.ok) {
        const j = (await res.json()) as EditorData;
        setEditor(j);
        setPlan(j.plan);
        setSubtitles(j.subtitles ?? null);
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
            setSubtitles(j.subtitles ?? null);
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

  // Refs mirror the latest plan/history so the edit handlers can read current
  // values and call all setters FLATLY (never setState inside another setState
  // updater — that triggers "update while rendering" warnings).
  const planRef = useRef<EditPlan | null>(null);
  const pastRef = useRef<EditPlan[]>([]);
  const futureRef = useRef<EditPlan[]>([]);
  useEffect(() => { planRef.current = plan; }, [plan]);
  useEffect(() => { pastRef.current = planPast; }, [planPast]);
  useEffect(() => { futureRef.current = planFuture; }, [planFuture]);

  // History-tracked plan commit (one entry per edit gesture).
  const commitPlan = useCallback(
    (next: EditPlan) => {
      const cur = planRef.current;
      setPlanPast(cur ? [...pastRef.current.slice(-49), cur] : pastRef.current);
      setPlanFuture([]);
      setPlan(next);
      savePlanDebounced(next);
    },
    [savePlanDebounced],
  );

  const undo = useCallback(() => {
    const past = pastRef.current;
    if (!past.length) return;
    const prev = past[past.length - 1];
    const cur = planRef.current;
    if (cur) setPlanFuture([cur, ...futureRef.current]);
    setPlan(prev);
    setPlanPast(past.slice(0, -1));
    savePlanDebounced(prev);
  }, [savePlanDebounced]);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (!future.length) return;
    const nxt = future[0];
    const cur = planRef.current;
    if (cur) setPlanPast([...pastRef.current, cur]);
    setPlan(nxt);
    setPlanFuture(future.slice(1));
    savePlanDebounced(nxt);
  }, [savePlanDebounced]);

  const onPlanChange = commitPlan;

  // Timeline edit ops — all read planRef and commit flatly.
  const doSplit = useCallback(() => {
    const cur = planRef.current;
    if (!cur) return;
    const next = applySplit(cur, currentMsRef.current);
    if (next === cur) return;
    commitPlan(next);
  }, [commitPlan]);

  const doDeleteSelected = useCallback(() => {
    const cur = planRef.current;
    if (!cur || !selectedSegId) return;
    commitPlan(applyDelete(cur, selectedSegId));
    setSelectedSegId(null);
  }, [selectedSegId, commitPlan]);

  const doAddClip = useCallback(
    (clipId: string, ms: number) => {
      const cur = planRef.current;
      const clip = manifest?.clips.find((c) => c.id === clipId);
      if (!cur || !clip) return;
      commitPlan(addFromLibrary(cur, clip, ms));
    },
    [manifest, commitPlan],
  );

  const saveSubtitlesDebounced = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return (next: SubtitleState) => {
      if (!sessionId) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        void fetch("/api/subtitles", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, subtitles: next }),
        });
      }, 300);
    };
  }, [sessionId]);

  // Subtitle edits update local state instantly (live preview) and persist
  // debounced. Downloads read the persisted state, so the export always
  // reflects the finalized look.
  const onSubtitleStyleChange = useCallback(
    (style: SubtitleStyle) => {
      setSubtitles((prev) => {
        const base = prev ?? (subtitles as SubtitleState | null);
        if (!base) return prev;
        const next = { ...base, style };
        saveSubtitlesDebounced(next);
        return next;
      });
    },
    [subtitles, saveSubtitlesDebounced],
  );

  const onCaptionsChange = useCallback(
    (captions: Caption[]) => {
      setSubtitles((prev) => {
        if (!prev) return prev;
        const next = { ...prev, captions };
        saveSubtitlesDebounced(next);
        return next;
      });
    },
    [saveSubtitlesDebounced],
  );

  const onSeek = useCallback((ms: number) => {
    seekNonceRef.current += 1;
    setSeekReq({ ms, nonce: seekNonceRef.current });
  }, []);

  // Editor keyboard shortcuts (Premiere-style). Ignored while typing.
  useEffect(() => {
    if (mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (meta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
      if (e.key === "s" || e.key === "S") { e.preventDefault(); doSplit(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); doDeleteSelected(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); onSeek(Math.max(0, currentMsRef.current - (e.shiftKey ? 1000 : 100))); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); onSeek(currentMsRef.current + (e.shiftKey ? 1000 : 100)); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, undo, redo, doSplit, doDeleteSelected, onSeek]);

  // Render-on-demand MP4 download for one mode. Returns true on success.
  const fetchMp4 = useCallback(
    async (mode: "clean" | "burned" | "greenscreen", suffix: string) => {
      if (!sessionId) return false;
      const res = await fetch("/api/export/mp4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, mode }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Export failed. Try again.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; // REQUIRED — without it the click is a silent no-op.
      a.download = `producer-${sessionId.slice(0, 6)}${suffix}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15_000);
      return true;
    },
    [sessionId],
  );

  // Download options: clean reel · burned-in captions · clean + a separate
  // green-screen subtitle file (two downloads fired together; no zip).
  const downloadMp4 = useCallback(
    async (choice: "clean" | "burned" | "clean+greenscreen") => {
      if (!sessionId) return;
      setExporting("mp4");
      try {
        if (choice === "clean") {
          await fetchMp4("clean", "");
          toast.success("Downloaded MP4");
        } else if (choice === "burned") {
          await fetchMp4("burned", "-subtitled");
          toast.success("Downloaded MP4 (subtitles burned in)");
        } else {
          await fetchMp4("clean", "");
          await fetchMp4("greenscreen", "-subtitles-greenscreen");
          toast.success("Downloaded MP4 + green-screen subtitles");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Export failed");
      } finally {
        setExporting("none");
      }
    },
    [sessionId, fetchMp4],
  );

  const generateSubtitles = useCallback(async () => {
    if (!sessionId) return;
    setGeneratingSubs(true);
    try {
      const res = await fetch("/api/subtitles/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not generate subtitles");
      }
      const j = (await res.json()) as { subtitles: SubtitleState };
      setSubtitles(j.subtitles);
      toast.success("Subtitles generated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate subtitles");
    } finally {
      setGeneratingSubs(false);
    }
  }, [sessionId]);

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
              variant="ghost"
              size="sm"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
                window.location.href = "/login";
              }}
              className="gap-1.5"
              title="Log out of Producer and disconnect Google Drive"
            >
              <LogOut className="size-3.5" /> Log out
            </Button>
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
                {!subtitles && (
                  <Button variant="outline" onClick={generateSubtitles} disabled={generatingSubs} title="Chunk the voiceover into captions">
                    {generatingSubs ? <Loader2 className="size-4 animate-spin" /> : <Captions className="size-4" />}
                    Generate subtitles
                  </Button>
                )}
                <Button onClick={() => setMp4ModalOpen(true)} disabled={exporting !== "none"} size="lg">
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
              sessionId={sessionId}
              clipsBySection={clipsBySection}
              clipsMap={clipsMap}
              onClipsChanged={refresh}
              overridePrompt={overridePrompt}
              setOverridePrompt={setOverridePrompt}
              currentMs={currentMs}
              onTime={setCurrentMs}
              seekReq={seekReq}
              onSeek={onSeek}
              onPlanChange={onPlanChange}
              selectedId={selectedSegId}
              onSelect={setSelectedSegId}
              pxPerSec={pxPerSec}
              onZoom={setPxPerSec}
              onSplit={doSplit}
              onDeleteSelected={doDeleteSelected}
              onAddClipAt={doAddClip}
              onUndo={undo}
              onRedo={redo}
              canUndo={planPast.length > 0}
              canRedo={planFuture.length > 0}
              voiceoverUrl={editor.manifest.voiceover?.url ?? null}
              onRerun={() => startJob({ overridePrompt })}
              onBackToSetup={() => { setMode("setup"); setEditor(null); setPlan(null); }}
              subtitleState={subtitles}
              onSubtitleStyleChange={onSubtitleStyleChange}
              onCaptionsChange={onCaptionsChange}
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
      <Mp4DownloadModal
        open={mp4ModalOpen}
        busy={exporting === "mp4"}
        hasSubtitles={!!(subtitles?.captions?.length && subtitles.style.enabled)}
        onCancel={() => setMp4ModalOpen(false)}
        onPick={(choice) => {
          setMp4ModalOpen(false);
          void downloadMp4(choice);
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
  sessionId: string | null;
  clipsBySection: Record<SectionId, SourceClip[]>;
  clipsMap: Record<string, SourceClip>;
  onClipsChanged: () => void;
  overridePrompt: string;
  setOverridePrompt: (v: string) => void;
  currentMs: number;
  onTime: (ms: number) => void;
  seekReq: { ms: number; nonce: number } | null;
  onSeek: (ms: number) => void;
  onPlanChange: (p: EditPlan) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  pxPerSec: number;
  onZoom: (v: number) => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  onAddClipAt: (clipId: string, ms: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  voiceoverUrl: string | null;
  onRerun: () => void;
  onBackToSetup: () => void;
  subtitleState: SubtitleState | null;
  onSubtitleStyleChange: (s: SubtitleStyle) => void;
  onCaptionsChange: (c: Caption[]) => void;
}

function EditView({
  editor,
  plan,
  sessionId,
  clipsBySection,
  clipsMap,
  onClipsChanged,
  overridePrompt,
  setOverridePrompt,
  currentMs,
  onTime,
  seekReq,
  onSeek,
  onPlanChange,
  selectedId,
  onSelect,
  pxPerSec,
  onZoom,
  onSplit,
  onDeleteSelected,
  onAddClipAt,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  voiceoverUrl,
  onRerun,
  onBackToSetup,
  subtitleState,
  onSubtitleStyleChange,
  onCaptionsChange,
}: EditViewProps) {
  const totalMs = plan.totalDurationMs || editor.alignment.durationMs;
  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100vh-5.5rem)]">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[22rem_1fr_22rem]">
        <aside className="flex min-h-0 flex-col gap-3 overflow-hidden">
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

          <ClipLibrary
            sessionId={sessionId}
            clipsBySection={clipsBySection}
            currentMs={currentMs}
            onAddClipAt={onAddClipAt}
            onClipsChanged={onClipsChanged}
          />
        </aside>

        <section className="flex min-h-0 flex-col items-center justify-start overflow-y-auto">
          <Card className="w-full">
            <CardContent className="p-3">
              <Preview
                clips={clipsMap}
                segments={plan.segments}
                totalDurationMs={plan.totalDurationMs}
                voiceoverUrl={voiceoverUrl}
                voiceoverDurationMs={editor.alignment.durationMs}
                seekRequest={seekReq}
                onTime={onTime}
                captions={subtitleState?.captions}
                subtitleStyle={subtitleState?.style ?? null}
                onSubtitleStyleChange={onSubtitleStyleChange}
              />
            </CardContent>
          </Card>
        </section>

        <aside className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardContent className="min-h-0 flex-1 overflow-y-auto p-4">
              {subtitleState ? (
                <SubtitleScriptBox
                  style={subtitleState.style}
                  captions={subtitleState.captions}
                  onStyleChange={onSubtitleStyleChange}
                  onCaptionsChange={onCaptionsChange}
                />
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Click <span className="font-medium text-foreground">Generate subtitles</span> in the header to add captions.
                </p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5">
        <div className="flex items-center gap-2 px-1">
          <h2 className="font-display text-base font-semibold tracking-tight">Timeline</h2>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" className="size-7 disabled:opacity-40" onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">
              <Undo2 className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 disabled:opacity-40" onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z)">
              <Redo2 className="size-3.5" />
            </Button>
          </div>
        </div>
        <Timeline
          plan={plan}
          clips={clipsMap}
          voiceoverUrl={voiceoverUrl}
          captions={subtitleState?.captions}
          currentTimeMs={currentMs}
          selectedId={selectedId}
          pxPerSec={pxPerSec}
          onZoom={onZoom}
          onSeek={onSeek}
          onSelect={onSelect}
          onChange={onPlanChange}
          onSplit={onSplit}
          onDeleteSelected={onDeleteSelected}
          onAddClipAt={onAddClipAt}
        />
      </div>
    </div>
  );
}

/* ============================== CLIP LIBRARY ============================== */

function ClipLibrary({
  sessionId,
  clipsBySection,
  currentMs,
  onAddClipAt,
  onClipsChanged,
}: {
  sessionId: string | null;
  clipsBySection: Record<SectionId, SourceClip[]>;
  currentMs: number;
  onAddClipAt: (clipId: string, ms: number) => void;
  onClipsChanged: () => void;
}) {
  const [uploadingTo, setUploadingTo] = useState<SectionId | null>(null);
  const [driveSection, setDriveSection] = useState<SectionId | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingSectionRef = useRef<SectionId | null>(null);

  const anyPending = SECTIONS.some((s) => (clipsBySection[s] ?? []).some((c) => c.proxyReady === false));
  // Poll the manifest while any proxy is still transcoding.
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => onClipsChanged(), 2000);
    return () => clearInterval(t);
  }, [anyPending, onClipsChanged]);

  const pickFor = (section: SectionId) => {
    pendingSectionRef.current = section;
    fileRef.current?.click();
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const section = pendingSectionRef.current;
    e.target.value = "";
    if (!file || !section || !sessionId) return;
    setUploadingTo(section);
    try {
      await uploadClip(sessionId, section, file);
      onClipsChanged();
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploadingTo(null);
    }
  };

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Clip library</CardTitle>
        <CardDescription className="text-xs">Drag a clip onto the timeline, or use + to drop it at the playhead.</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-3 overflow-y-auto p-4 pt-2">
        <input ref={fileRef} type="file" accept="video/*,image/*" hidden onChange={onFile} />
        {SECTIONS.map((section) => {
          const clips = clipsBySection[section] ?? [];
          return (
            <div key={section}>
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: `hsl(var(${SECTION_DOT_VAR[section]}))` }} />
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{SECTION_LABEL[section]}</span>
                <button
                  type="button"
                  onClick={() => setDriveSection(section)}
                  title="Import from Google Drive"
                  className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <HardDrive className="size-3" /> Drive
                </button>
                <button
                  type="button"
                  onClick={() => pickFor(section)}
                  disabled={uploadingTo === section}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  {uploadingTo === section ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} Add
                </button>
              </div>
              {clips.length === 0 ? (
                <p className="pb-1 text-[11px] text-muted-foreground/70">No clips.</p>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {clips.map((c) => (
                    <LibraryClip key={c.id} clip={c} onAdd={() => onAddClipAt(c.id, currentMs)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
      {sessionId && (
        <DriveBrowser
          open={driveSection !== null}
          onOpenChange={(o) => { if (!o) setDriveSection(null); }}
          sessionId={sessionId}
          section={driveSection ?? "hook"}
          onImported={() => onClipsChanged()}
        />
      )}
    </Card>
  );
}

function LibraryClip({ clip, onAdd }: { clip: SourceClip; onAdd: () => void }) {
  const ready = clip.proxyReady !== false;
  // Never use a video URL as an <img> (broken thumbnail). Posters are jpgs;
  // images use their own url; videos without a poster yet show a placeholder.
  const base = clip.url.slice(0, clip.url.length - clip.relPath.length);
  const posterUrl = clip.posterRelPath ? base + clip.posterRelPath : clip.kind === "image" ? clip.url : null;
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div
      draggable={ready}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/clip-id", clip.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={clip.filename}
      className={cn(
        "group relative aspect-[9/16] overflow-hidden rounded-md border border-border bg-secondary",
        ready ? "cursor-grab active:cursor-grabbing" : "opacity-60",
      )}
    >
      {posterUrl && !imgFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={posterUrl} alt="" draggable={false} onError={() => setImgFailed(true)} className="pointer-events-none h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center bg-secondary">
          <FileVideo className="size-4 text-muted-foreground/50" />
        </div>
      )}
      {!ready && (
        <div className="absolute inset-0 grid place-items-center bg-background/50">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        </div>
      )}
      {ready && (
        <button
          type="button"
          onClick={onAdd}
          className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-background/85 text-foreground opacity-0 transition-opacity group-hover:opacity-100"
          title="Add at playhead"
        >
          <Plus className="size-3" />
        </button>
      )}
      {clip.durationMs > 0 && (
        <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 font-mono text-[8px] tabular-nums text-white/90">
          {formatDuration(clip.durationMs)}
        </span>
      )}
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
    caption?: { calls: number; inputTokens: number; outputTokens: number; usd: number };
  };
}) {
  const tooltip = breakdown
    ? [
        `Gemini describe: $${breakdown.describe.usd.toFixed(4)} (${breakdown.describe.calls} calls, ${breakdown.describe.inputTokens.toLocaleString()} in / ${breakdown.describe.outputTokens.toLocaleString()} out tokens)`,
        `Gemini match: $${breakdown.match.usd.toFixed(4)} (${breakdown.match.calls} calls, ${breakdown.match.inputTokens.toLocaleString()} in / ${breakdown.match.outputTokens.toLocaleString()} out tokens)`,
        `ElevenLabs align: $${breakdown.align.usd.toFixed(4)} (${breakdown.align.calls} calls, ${(breakdown.align.audioMs / 1000).toFixed(1)}s audio)`,
        ...(breakdown.caption
          ? [`Gemini captions: $${breakdown.caption.usd.toFixed(4)} (${breakdown.caption.calls} calls)`]
          : []),
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

/* ============================== MP4 DOWNLOAD MODAL ============================== */

function Mp4DownloadModal({
  open,
  busy,
  hasSubtitles,
  onCancel,
  onPick,
}: {
  open: boolean;
  busy: boolean;
  hasSubtitles: boolean;
  onCancel: () => void;
  onPick: (choice: "clean" | "burned" | "clean+greenscreen") => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="!max-w-md">
        <DialogTitle className="font-display text-lg font-semibold leading-tight">
          Download MP4
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground leading-relaxed">
          {hasSubtitles
            ? "Choose how to export. The reel renders at full 1080×1920."
            : "No captions generated yet — the MP4 will export clean. Use “Generate subtitles” first to enable caption options."}
        </DialogDescription>
        <div className="mt-5 flex flex-col gap-2">
          <Button variant="outline" className="justify-start" onClick={() => onPick("clean")} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <FileVideo className="size-4" />}
            Without subtitles
          </Button>
          <Button variant="outline" className="justify-start" onClick={() => onPick("burned")} disabled={busy || !hasSubtitles}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            With subtitles (burned in)
          </Button>
          <Button variant="outline" className="justify-start" onClick={() => onPick("clean+greenscreen")} disabled={busy || !hasSubtitles}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Clean MP4 + green-screen subtitles file
          </Button>
        </div>
        <div className="mt-4 flex items-center justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Avoid unused warning for ArrowRight import (kept for future "next step" CTAs)
const _ArrowRight = ArrowRight;
