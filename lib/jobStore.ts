import { EventEmitter } from "node:events";
import type { JobState, PhaseId, PhaseState } from "@/lib/types";
import { PHASES } from "@/lib/types";

declare global {
  // eslint-disable-next-line no-var
  var __PRODUCER_JOB_STORE__: JobStore | undefined;
}

class JobStore {
  private jobs = new Map<string, JobState>();
  private aborters = new Map<string, AbortController>();
  private bus = new EventEmitter();

  create(jobId: string, sessionId: string, overridePrompt?: string): JobState {
    const phases: PhaseState[] = PHASES.map((id) => ({ id, status: "pending" }));
    const job: JobState = {
      id: jobId,
      sessionId,
      startedAt: Date.now(),
      phases,
      currentPhase: phases[0].id,
      status: "running",
      overridePrompt,
    };
    this.jobs.set(jobId, job);
    this.aborters.set(jobId, new AbortController());
    return job;
  }

  get(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  signal(jobId: string): AbortSignal | undefined {
    return this.aborters.get(jobId)?.signal;
  }

  abort(jobId: string): void {
    this.aborters.get(jobId)?.abort();
    const j = this.jobs.get(jobId);
    if (j && j.status === "running") {
      j.status = "stopped";
      j.finishedAt = Date.now();
      this.bus.emit(jobId, j);
    }
  }

  updatePhase(jobId: string, id: PhaseId, patch: Partial<PhaseState>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const phase = job.phases.find((p) => p.id === id);
    if (!phase) return;
    Object.assign(phase, patch);
    if (patch.status === "running") job.currentPhase = id;
    this.bus.emit(jobId, job);
  }

  finish(jobId: string, status: "complete" | "failed", error?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    if (error) job.error = error;
    job.finishedAt = Date.now();
    this.bus.emit(jobId, job);
  }

  subscribe(jobId: string, listener: (job: JobState) => void): () => void {
    this.bus.on(jobId, listener);
    return () => this.bus.off(jobId, listener);
  }
}

export const jobStore: JobStore =
  globalThis.__PRODUCER_JOB_STORE__ ?? (globalThis.__PRODUCER_JOB_STORE__ = new JobStore());
