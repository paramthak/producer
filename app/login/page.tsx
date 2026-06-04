"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Loader2, Lock, User, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/branding/Logo";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = params.get("next") || "/";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Both fields required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Sign in failed");
      }
      toast.success("Welcome back");
      router.replace(nextPath);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden p-6">
      {/* Aurora glow behind the card */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[42rem] w-[42rem] -translate-x-1/2 rounded-full opacity-50 blur-3xl"
        style={{ background: "var(--grad-aurora)" }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 right-0 -z-10 h-[28rem] w-[28rem] rounded-full opacity-30 blur-3xl"
        style={{ background: "var(--grad-cool)" }}
      />

      <div className="grad-border surface w-full max-w-[26rem] rounded-3xl p-1">
        <div className="rounded-[calc(theme(borderRadius.3xl)-4px)] bg-card/80 p-7 backdrop-blur-xl">
          <Logo className="mb-7" />

          <div className="mb-6 flex items-start gap-3">
            <span className="mt-1 inline-flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Sparkles className="size-3.5" />
            </span>
            <div>
              <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight">
                Sign in to <span className="grad-text">Producer</span>
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Internal access only. Ask your pod lead if you don&apos;t have credentials.
              </p>
            </div>
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-3" autoComplete="on">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Username
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="editor"
                  className="h-11 pl-10"
                  disabled={submitting}
                  autoFocus
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="h-11 pl-10"
                  disabled={submitting}
                />
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <Button type="submit" size="lg" disabled={submitting} className="mt-1 h-12 w-full text-base font-semibold">
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Signing in…
                </>
              ) : (
                <>
                  Enter the studio <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </form>

          <p className="mt-6 text-center text-[11px] text-muted-foreground">
            AI Reel Assembler · Internal tool
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
