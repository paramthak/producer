import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 select-none", className)}>
      <div className="relative grid size-9 place-items-center rounded-xl bg-aurora shadow-[0_8px_24px_-6px_hsl(322_90%_50%_/_0.6)]">
        <svg viewBox="0 0 24 24" className="size-4 text-white drop-shadow" aria-hidden="true">
          <path d="M8 5v14l11-7z" fill="currentColor" />
        </svg>
        <span className="pointer-events-none absolute -inset-px rounded-xl ring-1 ring-white/20" aria-hidden="true" />
      </div>
      <div className="leading-tight">
        <div className="font-display text-xl font-semibold tracking-tight">
          Producer<span className="ml-0.5 grad-text">Studio</span>
        </div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">AI Reel Assembler</div>
      </div>
    </div>
  );
}
