import "server-only";

import { and, desc, eq, gte } from "drizzle-orm";

import { credentialQuotaResetEvents } from "@/src/server/db/schema";
import { getMainOrm } from "@/src/server/db/sqlite";
import { randomId } from "@/src/server/services/crypto";

export type CredentialQuotaResetSource = "natural" | "reset_credit";
export type CredentialQuotaResetWindow = "5h" | "7d" | "all";

export interface CredentialQuotaResetEvent {
  id: string;
  credentialId: string;
  windowKind: CredentialQuotaResetWindow;
  source: CredentialQuotaResetSource;
  previousResetsAt: string | null;
  nextResetsAt: string | null;
  previousUsedPercent: number | null;
  windowsReset: number | null;
  occurredAt: string;
}

export function insertCredentialQuotaResetEvent(input: Omit<CredentialQuotaResetEvent, "id">) {
  const row = { id: randomId("reset"), ...input, createdAt: new Date().toISOString() };
  getMainOrm().insert(credentialQuotaResetEvents).values(row).run();
  return toEvent(row);
}

export function listCredentialQuotaResetEvents(credentialId: string, limit = 100) {
  return getMainOrm().select().from(credentialQuotaResetEvents)
    .where(eq(credentialQuotaResetEvents.credentialId, credentialId))
    .orderBy(desc(credentialQuotaResetEvents.occurredAt)).limit(Math.min(Math.max(limit, 1), 200)).all()
    .map(toEvent);
}

export function recordNaturalCredentialQuotaReset(input: {
  credentialId: string;
  windowKind: Exclude<CredentialQuotaResetWindow, "all">;
  previousResetsAt: string;
  nextResetsAt: string;
  previousUsedPercent: number | null;
  occurredAt: string;
}) {
  const previousResetAt = Date.parse(input.previousResetsAt);
  const nextResetAt = Date.parse(input.nextResetsAt);
  if (
    !Number.isFinite(previousResetAt) ||
    !Number.isFinite(nextResetAt) ||
    nextResetAt - previousResetAt <= 60_000
  ) {
    return null;
  }
  const occurredAt = Date.parse(input.occurredAt);
  const since = new Date(
    (Number.isFinite(occurredAt) ? occurredAt : Date.now()) - 10 * 60 * 1000,
  ).toISOString();
  if (hasRecentResetCreditEvent(input.credentialId, since)) return null;
  return insertCredentialQuotaResetEvent({
    ...input,
    source: "natural",
    windowsReset: 1,
  });
}

export function hasRecentResetCreditEvent(credentialId: string, since: string) {
  return Boolean(getMainOrm().select({ id: credentialQuotaResetEvents.id }).from(credentialQuotaResetEvents)
    .where(and(eq(credentialQuotaResetEvents.credentialId, credentialId), eq(credentialQuotaResetEvents.source, "reset_credit"), gte(credentialQuotaResetEvents.occurredAt, since))).get());
}

function toEvent(row: typeof credentialQuotaResetEvents.$inferSelect): CredentialQuotaResetEvent {
  return {
    id: row.id, credentialId: row.credentialId,
    windowKind: row.windowKind as CredentialQuotaResetWindow,
    source: row.source as CredentialQuotaResetSource,
    previousResetsAt: row.previousResetsAt, nextResetsAt: row.nextResetsAt,
    previousUsedPercent: row.previousUsedPercent, windowsReset: row.windowsReset,
    occurredAt: row.occurredAt,
  };
}
