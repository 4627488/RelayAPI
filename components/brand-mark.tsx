import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-7", className)}
      viewBox="0 0 64 64"
    >
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <path
        d="M15 19h8c6 0 8 5 8 13s2 13 8 13h10"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <path
        d="M15 45h8c6 0 8-5 8-13s2-13 8-13h10"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeLinecap="round"
        strokeWidth="6"
      />
      <circle cx="32" cy="32" r="5" fill="var(--primary-foreground)" />
    </svg>
  );
}
