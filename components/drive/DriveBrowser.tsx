"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  Clock,
  Film,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  LogOut,
  Search,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SECTION_LABEL, type SectionId, type SourceClip } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  isVideo: boolean;
  isImage: boolean;
  sizeBytes?: number;
  durationMs?: number;
  thumbnailLink?: string;
}
type Status = { configured: boolean; connected: boolean; email?: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  section: SectionId;
  onImported: (clip: SourceClip) => void;
}

export function DriveBrowser({ open, onOpenChange, sessionId, section, onImported }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<"recent" | "browse">("recent");
  const [stack, setStack] = useState<{ id: string; name: string }[]>([{ id: "root", name: "My Drive" }]);
  const [search, setSearch] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const popupRef = useRef<Window | null>(null);

  const refreshStatus = useCallback(async () => {
    const r = await fetch("/api/drive/status");
    setStatus((await r.json()) as Status);
  }, []);

  useEffect(() => {
    if (open) { void refreshStatus(); setSelected(new Set()); }
  }, [open, refreshStatus]);

  // Listen for the OAuth popup finishing.
  useEffect(() => {
    if (!open) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "producer-drive") { void refreshStatus(); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [open, refreshStatus]);

  const connected = status?.connected;
  const folderId = stack[stack.length - 1]?.id ?? "root";

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

  useEffect(() => { if (open && connected) void load(); }, [open, connected, load]);
  // Debounce search.
  useEffect(() => {
    if (!open || !connected) return;
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = () => {
    popupRef.current = window.open("/api/drive/auth", "producer-drive", "width=520,height=680");
  };
  const switchAccount = async () => {
    await fetch("/api/drive/logout", { method: "POST" });
    setFiles([]);
    await refreshStatus();
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const importSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setImporting({ done: 0, total: ids.length });
    let ok = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        const r = await fetch("/api/drive/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, section, fileId: ids[i] }),
        });
        const j = (await r.json()) as { clip?: SourceClip; error?: string };
        if (!r.ok || !j.clip) throw new Error(j.error || "import failed");
        onImported(j.clip);
        ok++;
      } catch (e) {
        toast.error(`Import failed: ${e instanceof Error ? e.message : "unknown"}`);
      }
      setImporting({ done: i + 1, total: ids.length });
    }
    setImporting(null);
    setSelected(new Set());
    if (ok) toast.success(`Imported ${ok} file${ok === 1 ? "" : "s"} to ${SECTION_LABEL[section]}`);
    if (ok === ids.length) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-2xl">
        <DialogTitle className="flex items-center gap-2 font-display text-lg">
          <HardDrive className="size-4 text-primary" /> Import from Google Drive
          <span className="ml-1 text-xs font-normal text-muted-foreground">→ {SECTION_LABEL[section]}</span>
        </DialogTitle>

        {/* Not configured */}
        {status && !status.configured && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Google Drive isn&apos;t configured on the server yet.
          </p>
        )}

        {/* Not connected */}
        {status && status.configured && !status.connected && (
          <div className="flex flex-col items-center gap-4 py-10">
            <p className="text-sm text-muted-foreground">Connect a Google account to browse its Drive.</p>
            <Button onClick={connect} className="gap-2">
              <HardDrive className="size-4" /> Connect Google Drive
            </Button>
          </div>
        )}

        {/* Connected browser */}
        {status?.connected && (
          <div className="flex flex-col gap-3">
            {/* account row */}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate">Connected{status.email ? ` · ${status.email}` : ""}</span>
              <button onClick={switchAccount} className="inline-flex items-center gap-1 hover:text-foreground">
                <LogOut className="size-3" /> Switch account
              </button>
            </div>

            {/* tabs + search */}
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-muted/60 p-0.5 text-xs font-medium">
                <button
                  onClick={() => { setTab("recent"); setSearch(""); }}
                  className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1", tab === "recent" && !search ? "bg-background shadow-sm" : "text-muted-foreground")}
                >
                  <Clock className="size-3.5" /> Recent
                </button>
                <button
                  onClick={() => { setTab("browse"); setSearch(""); setStack([{ id: "root", name: "My Drive" }]); }}
                  className={cn("inline-flex items-center gap-1 rounded-md px-2.5 py-1", tab === "browse" && !search ? "bg-background shadow-sm" : "text-muted-foreground")}
                >
                  <Folder className="size-3.5" /> My Drive
                </button>
              </div>
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search Drive…"
                  className="h-8 w-full rounded-lg border border-border bg-background pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            {/* breadcrumb when browsing */}
            {tab === "browse" && !search && (
              <div className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
                {stack.map((s, i) => (
                  <span key={s.id} className="inline-flex items-center gap-0.5">
                    {i > 0 && <ChevronRight className="size-3" />}
                    <button
                      onClick={() => setStack(stack.slice(0, i + 1))}
                      className={cn("rounded px-1 hover:text-foreground", i === stack.length - 1 && "text-foreground")}
                    >
                      {s.name}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* file grid */}
            <div className="max-h-[46vh] min-h-[16rem] overflow-y-auto rounded-lg border border-border bg-background/40 p-2">
              {loading ? (
                <div className="grid h-40 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
              ) : files.length === 0 ? (
                <p className="grid h-40 place-items-center text-xs text-muted-foreground">Nothing here.</p>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {files.map((f) =>
                    f.isFolder ? (
                      <button
                        key={f.id}
                        onClick={() => { setStack((s) => [...s, { id: f.id, name: f.name }]); setTab("browse"); setSearch(""); }}
                        className="flex flex-col items-center gap-1 rounded-md border border-border/60 p-2 text-center hover:bg-muted/40"
                        title={f.name}
                      >
                        <Folder className="size-8 text-primary/70" />
                        <span className="line-clamp-2 text-[10px] leading-tight">{f.name}</span>
                      </button>
                    ) : (
                      <button
                        key={f.id}
                        onClick={() => toggle(f.id)}
                        title={f.name}
                        className={cn(
                          "group relative flex flex-col overflow-hidden rounded-md border text-left",
                          selected.has(f.id) ? "border-primary ring-2 ring-primary/40" : "border-border/60 hover:border-border",
                        )}
                      >
                        <div className="relative aspect-video w-full bg-muted">
                          {f.thumbnailLink ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={f.thumbnailLink} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                          ) : null}
                          <div className="absolute inset-0 grid place-items-center">
                            {f.isImage ? <ImageIcon className="size-6 text-muted-foreground/50" /> : <Film className="size-6 text-muted-foreground/50" />}
                          </div>
                          {selected.has(f.id) && (
                            <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-primary text-[9px] text-primary-foreground">✓</span>
                          )}
                          {f.durationMs ? (
                            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 font-mono text-[8px] text-white/90">{formatDuration(f.durationMs)}</span>
                          ) : null}
                        </div>
                        <span className="line-clamp-1 px-1.5 py-1 text-[10px]">{f.name}</span>
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {selected.size > 0 ? `${selected.size} selected` : "Select videos/images to import"}
              </span>
              <Button onClick={importSelected} disabled={!selected.size || !!importing} className="gap-2">
                {importing ? <><Loader2 className="size-4 animate-spin" /> Importing {importing.done}/{importing.total}…</> : `Import ${selected.size || ""}`}
              </Button>
            </div>
          </div>
        )}

        {!status && <div className="grid h-40 place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
      </DialogContent>
    </Dialog>
  );
}
