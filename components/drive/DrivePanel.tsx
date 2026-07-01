"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Clock, Film, Folder, HardDrive, Image as ImageIcon, Loader2, LogOut, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatDuration } from "@/lib/utils";

/** Payload dragged onto a section bucket (read there to trigger imports). */
export const DRIVE_DND_TYPE = "application/x-producer-drive";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  isVideo: boolean;
  isImage: boolean;
  durationMs?: number;
  thumbnailLink?: string;
}
type Status = { configured: boolean; connected: boolean; email?: string };
type Nav = { tab: "recent" | "browse"; stack: { id: string; name: string }[] };

const NAV_KEY = "producer.drive.nav";
function loadNav(): Nav {
  if (typeof window === "undefined") return { tab: "recent", stack: [{ id: "root", name: "My Drive" }] };
  try {
    const n = JSON.parse(localStorage.getItem(NAV_KEY) || "");
    if (n?.stack?.length) return n as Nav;
  } catch { /* ignore */ }
  return { tab: "recent", stack: [{ id: "root", name: "My Drive" }] };
}

/**
 * Always-open Google Drive browser for the setup page. Files are DRAGGED onto
 * the section buckets to import (multi-select drags the whole selection). The
 * last-viewed folder/tab persists across reloads.
 */
export function DrivePanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [nav, setNav] = useState<Nav>(() => loadNav());
  const [search, setSearch] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const popupRef = useRef<Window | null>(null);

  const { tab, stack } = nav;
  const folderId = stack[stack.length - 1]?.id ?? "root";
  useEffect(() => { try { localStorage.setItem(NAV_KEY, JSON.stringify(nav)); } catch { /* ignore */ } }, [nav]);

  const refreshStatus = useCallback(async () => {
    const r = await fetch("/api/drive/status");
    setStatus((await r.json()) as Status);
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // OAuth popup completion.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.data?.type === "producer-drive") void refreshStatus(); };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refreshStatus]);

  const connected = status?.connected;
  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      else if (tab === "recent") params.set("recent", "1");
      else params.set("folderId", folderId);
      const r = await fetch(`/api/drive/list?${params.toString()}`);
      if (r.status === 401) { await refreshStatus(); setFiles([]); return; }
      const j = (await r.json()) as { files?: DriveFile[]; error?: string };
      if (!r.ok) throw new Error(j.error || "Failed to list Drive");
      setFiles(j.files ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Drive list failed");
    } finally {
      setLoading(false);
    }
  }, [connected, search, tab, folderId, refreshStatus]);

  useEffect(() => { if (connected) void load(); }, [connected, tab, folderId, load]);
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = () => { popupRef.current = window.open("/api/drive/auth", "producer-drive", "width=520,height=680"); };
  const switchAccount = async () => { await fetch("/api/drive/logout", { method: "POST" }); setFiles([]); setSelected(new Set()); await refreshStatus(); };

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // On drag, carry the whole selection if the dragged file is selected;
  // otherwise just the one grabbed.
  const onDragStart = (f: DriveFile) => (e: React.DragEvent) => {
    const batch = selected.has(f.id) ? files.filter((x) => selected.has(x.id) && !x.isFolder) : [f];
    const payload = batch.map((x) => ({ id: x.id, name: x.name }));
    e.dataTransfer.setData(DRIVE_DND_TYPE, JSON.stringify(payload));
    e.dataTransfer.setData("text/plain", payload.map((p) => p.name).join(", "));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="rounded-xl border border-border bg-card/60 backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <HardDrive className="size-4 text-primary" />
        <h3 className="font-display text-sm font-semibold tracking-tight">Google Drive</h3>
        {status?.connected && (
          <>
            <span className="truncate text-[11px] text-muted-foreground">{status.email ? `· ${status.email}` : ""}</span>
            <button onClick={switchAccount} className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <LogOut className="size-3" /> Switch
            </button>
          </>
        )}
      </div>

      {status && !status.configured && (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground">Google Drive isn&apos;t configured on the server.</p>
      )}

      {status?.configured && !status.connected && (
        <div className="flex flex-col items-center gap-3 px-4 py-8">
          <p className="text-xs text-muted-foreground">Connect a Google account to browse its Drive.</p>
          <Button size="sm" onClick={connect} className="gap-1.5"><HardDrive className="size-3.5" /> Connect Google Drive</Button>
        </div>
      )}

      {status?.connected && (
        <div className="flex flex-col gap-2 p-3">
          {/* tabs + search */}
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-muted/60 p-0.5 text-xs font-medium">
              <button onClick={() => { setNav((n) => ({ ...n, tab: "recent" })); setSearch(""); }}
                className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1", tab === "recent" && !search ? "bg-background shadow-sm" : "text-muted-foreground")}>
                <Clock className="size-3.5" /> Recent
              </button>
              <button onClick={() => { setNav({ tab: "browse", stack: [{ id: "root", name: "My Drive" }] }); setSearch(""); }}
                className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1", tab === "browse" && !search ? "bg-background shadow-sm" : "text-muted-foreground")}>
                <Folder className="size-3.5" /> My Drive
              </button>
            </div>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Drive…"
                className="h-8 w-full rounded-lg border border-border bg-background pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-primary" />
            </div>
          </div>

          {/* breadcrumb */}
          {tab === "browse" && !search && (
            <div className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
              {stack.map((s, i) => (
                <span key={s.id} className="inline-flex items-center gap-0.5">
                  {i > 0 && <ChevronRight className="size-3" />}
                  <button onClick={() => setNav((n) => ({ ...n, stack: n.stack.slice(0, i + 1) }))}
                    className={cn("rounded px-1 hover:text-foreground", i === stack.length - 1 && "text-foreground")}>{s.name}</button>
                </span>
              ))}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected — drag onto a section above` : "Select clips, then drag them onto a section above to import."}
          </p>

          {/* grid */}
          <div className="max-h-[19rem] min-h-[9rem] overflow-y-auto rounded-lg border border-border/60 bg-background/40 p-2">
            {loading ? (
              <div className="grid h-32 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : files.length === 0 ? (
              <p className="grid h-32 place-items-center text-xs text-muted-foreground">Nothing here.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                {files.map((f) =>
                  f.isFolder ? (
                    <button key={f.id} title={f.name}
                      onClick={() => setNav((n) => ({ tab: "browse", stack: [...n.stack, { id: f.id, name: f.name }] }))}
                      className="flex flex-col items-center gap-1 rounded-md border border-border/60 p-2 text-center hover:bg-muted/40">
                      <Folder className="size-7 text-primary/70" />
                      <span className="line-clamp-2 text-[10px] leading-tight">{f.name}</span>
                    </button>
                  ) : (
                    <div key={f.id} draggable onDragStart={onDragStart(f)} onClick={() => toggle(f.id)} title={f.name}
                      className={cn(
                        "group relative flex cursor-grab flex-col overflow-hidden rounded-md border text-left active:cursor-grabbing",
                        selected.has(f.id) ? "border-primary ring-2 ring-primary/40" : "border-border/60 hover:border-border",
                      )}>
                      <div className="relative aspect-video w-full bg-muted">
                        {f.thumbnailLink ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={f.thumbnailLink} alt="" referrerPolicy="no-referrer" draggable={false} className="h-full w-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                        ) : null}
                        <div className="absolute inset-0 grid place-items-center">
                          {f.isImage ? <ImageIcon className="size-5 text-muted-foreground/50" /> : <Film className="size-5 text-muted-foreground/50" />}
                        </div>
                        {selected.has(f.id) && <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-primary text-[9px] text-primary-foreground">✓</span>}
                        {f.durationMs ? <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 font-mono text-[8px] text-white/90">{formatDuration(f.durationMs)}</span> : null}
                      </div>
                      <span className="line-clamp-1 px-1.5 py-1 text-[10px]">{f.name}</span>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!status && <div className="grid h-24 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
    </div>
  );
}
