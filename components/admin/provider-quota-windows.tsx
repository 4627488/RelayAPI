import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ProviderQuotaWindowView } from "@/src/shared/providerQuota";

export function ProviderQuotaWindows({ windows }: { windows: ProviderQuotaWindowView[] }) {
  return (
    <div className="flex flex-col gap-3">
      {windows.map((window, index) => {
        const remaining = window.remainingPercent;
        return (
          <div key={`${window.id}-${index}`} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-medium text-foreground">{window.label}</span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">{window.resetLabel || "-"}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Progress className="min-w-0 flex-1 **:data-[slot=progress-track]:h-2" value={remaining === null ? 0 : clamp(remaining)} />
              <span className={cn("w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground", window.exhausted && "text-destructive")}>
                {remaining === null ? "未知" : `${Math.round(remaining)}%`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function clamp(value: number) {
  return Math.min(100, Math.max(0, value));
}
