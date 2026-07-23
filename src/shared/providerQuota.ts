export type ProviderQuotaWindowView = {
  id: string;
  label: string;
  remainingPercent: number | null;
  resetLabel: string;
  exhausted?: boolean;
};

export type CodexQuotaStatus =
  | "unknown"
  | "exhausted"
  | "low"
  | "medium"
  | "high"
  | "full"
  | "not_cached";

export type CodexQuotaWindow = {
  id: string;
  label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
  resets_at: string | null;
  exhausted: boolean;
};

export type CodexQuotaCoreReport = {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: CodexQuotaStatus;
  windows: CodexQuotaWindow[];
  additional_windows: CodexQuotaWindow[];
  retrieved_at: string;
  raw?: unknown;
};

export type CodexQuotaReport = CodexQuotaCoreReport & {
  cached: boolean;
  cache_state: "cached" | "fresh" | "missing";
  message?: string;
};

export type GrokQuotaWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  label: string;
};

export type GrokQuotaReport = {
  status: "available" | "partial" | "unavailable";
  fetchedAt: string;
  planType: string | null;
  weekly: GrokQuotaWindow | null;
  monthly: GrokQuotaWindow | null;
  productUsage: GrokQuotaWindow[];
  rateLimit: GrokQuotaWindow | null;
};

export function codexQuotaWindowViews(
  report: Pick<CodexQuotaReport, "windows" | "additional_windows">,
): ProviderQuotaWindowView[] {
  return [...report.windows, ...report.additional_windows].map((window) => ({
    id: window.id,
    label: window.label,
    remainingPercent: window.remaining_percent,
    resetLabel: window.reset_label,
    exhausted: window.exhausted,
  }));
}

export function grokQuotaWindowViews(
  report: Pick<GrokQuotaReport, "weekly" | "monthly" | "productUsage" | "rateLimit">,
  formatReset: (value: string) => string,
): ProviderQuotaWindowView[] {
  return [report.weekly, ...report.productUsage, report.monthly, report.rateLimit]
    .filter(
      (window): window is GrokQuotaWindow =>
        Boolean(
          window &&
            (window.usedPercent !== null || window.remainingPercent !== null),
        ),
    )
    .map((window, index) => ({
      id: `${window.label}-${index}`,
      label: window.label,
      remainingPercent: window.remainingPercent,
      resetLabel: window.resetsAt ? formatReset(window.resetsAt) : "-",
      exhausted: window.remainingPercent === 0,
    }));
}
