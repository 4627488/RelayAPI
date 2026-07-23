export type CodexPlanKind = "plus" | "pro_5x" | "pro_20x" | "other";

export function codexPlanKind(planType: string): CodexPlanKind {
  const plan = String(planType || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (plan === "plus") return "plus";
  if (plan === "prolite" || plan === "pro5x" || plan === "pro5") return "pro_5x";
  if (plan === "pro" || plan === "pro20x" || plan === "pro20") return "pro_20x";
  return "other";
}

export function codexPlanShares(planType: string) {
  const kind = codexPlanKind(planType);
  if (kind === "pro_5x") return 5;
  if (kind === "pro_20x") return 20;
  return 1;
}

export function codexPlanLabel(planType: string) {
  const normalized = String(planType || "").trim().toLowerCase();
  if (normalized === "free") return "Free";
  if (normalized === "team") return "Team";
  const kind = codexPlanKind(planType);
  if (kind === "plus") return "Plus";
  if (kind === "pro_5x") return "Pro 5x";
  if (kind === "pro_20x") return "Pro 20x";
  return String(planType || "").trim() || "未知";
}
