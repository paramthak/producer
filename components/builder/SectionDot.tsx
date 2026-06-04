import { SECTION_DOT_VAR, type SectionId } from "@/lib/types";
import { cn } from "@/lib/utils";

export function SectionDot({ section, className }: { section: SectionId; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full", className)}
      style={{ background: `hsl(var(${SECTION_DOT_VAR[section]}))` }}
      aria-hidden="true"
    />
  );
}
