"use client";
import { useEffect, useState } from "react";

export function ElapsedTimer({ startedAt, finishedAt }: { startedAt: number; finishedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (finishedAt) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [finishedAt]);
  const end = finishedAt ?? now;
  const totalSec = Math.max(0, Math.round((end - startedAt) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return (
    <div className="font-mono text-xs tabular-nums text-muted-foreground">
      {m}:{s.toString().padStart(2, "0")}
    </div>
  );
}
