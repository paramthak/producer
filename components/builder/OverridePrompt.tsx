"use client";
import { Sparkles } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  value: string;
  onChange: (v: string) => void;
  variant?: "builder" | "editor";
}

export function OverridePrompt({ value, onChange, variant = "builder" }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-accent" aria-hidden="true" />
        <h4 className="text-xs uppercase tracking-wider text-muted-foreground">
          Override prompt <span className="normal-case tracking-normal">— optional</span>
        </h4>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          variant === "builder"
            ? "Optional — e.g. \"open on the airport clip\", \"keep the dashboard shot longer\"."
            : "Edit and re-run to nudge the AI's choices."
        }
        className="min-h-[5rem]"
      />
    </div>
  );
}
