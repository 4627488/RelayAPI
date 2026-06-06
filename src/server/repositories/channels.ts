import "server-only";

import { asc, desc, eq, inArray, or } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import {
  channelCredentials,
  channels as channelsTable,
} from "@/src/server/db/schema";
import type { ChannelRecord, ChannelStatus } from "@/src/shared/types/entities";
import { jsonStringify, safeJsonParse } from "@/src/server/services/crypto";

type ChannelRow = typeof channelsTable.$inferSelect;

export interface SaveChannelInput {
  id: string;
  name: string;
  baseUrl: string;
  credentialId?: string;
  credentialIds?: string[];
  enabled: boolean;
  priority: number;
  weight: number;
  modelAllowlist: string[];
  status?: ChannelStatus;
}

export function listChannels(): ChannelRecord[] {
  const rows = getMainOrm()
    .select()
    .from(channelsTable)
    .orderBy(desc(channelsTable.priority), asc(channelsTable.createdAt))
    .all();
  const credentialIdsByChannelId = channelCredentialIdsByChannelId(
    rows.map((row) => row.id),
  );
  return rows.map((row: ChannelRow) =>
    toChannelRecord(row, credentialIdsByChannelId.get(row.id)),
  );
}

export function getChannelById(id: string): ChannelRecord | null {
  const row = getMainOrm()
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.id, id))
    .get();
  return row ? toChannelRecord(row) : null;
}

export function getChannelByCredentialId(credentialId: string) {
  const row = getMainOrm()
    .select({ channel: channelsTable })
    .from(channelsTable)
    .leftJoin(
      channelCredentials,
      eq(channelCredentials.channelId, channelsTable.id),
    )
    .where(
      or(
        eq(channelsTable.credentialId, credentialId),
        eq(channelCredentials.credentialId, credentialId),
      ),
    )
    .orderBy(asc(channelsTable.createdAt))
    .limit(1)
    .get()?.channel;
  return row ? toChannelRecord(row) : null;
}

export function insertChannel(input: SaveChannelInput) {
  const now = new Date().toISOString();
  const credentialIds = normalizeCredentialIds(input);
  const primaryCredentialId = credentialIds[0] || "";
  getMainOrm()
    .insert(channelsTable)
    .values({
      id: input.id,
      name: input.name,
      provider: "codex",
      baseUrl: input.baseUrl,
      credentialId: primaryCredentialId,
      enabled: input.enabled ? 1 : 0,
      priority: input.priority,
      weight: input.weight,
      modelAllowlistJson: jsonStringify(input.modelAllowlist),
      status: input.status || "healthy",
      healthScore: 100,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  setChannelCredentialIds(input.id, credentialIds);
  return getChannelById(input.id);
}

export function updateChannel(
  id: string,
  patch: Partial<
    Pick<
      ChannelRecord,
      | "name"
      | "baseUrl"
      | "credentialId"
      | "credentialIds"
      | "enabled"
      | "priority"
      | "weight"
      | "modelAllowlist"
      | "status"
      | "healthScore"
      | "cooldownUntil"
      | "lastError"
      | "lastUsedAt"
    >
  >,
) {
  const existing = getChannelById(id);
  if (!existing) {
    return null;
  }
  const nextCredentialIds =
    patch.credentialIds !== undefined
      ? normalizeCredentialIds({ credentialIds: patch.credentialIds })
      : patch.credentialId !== undefined
        ? normalizeCredentialIds({ credentialId: patch.credentialId })
        : normalizeCredentialIds({ credentialIds: existing.credentialIds });
  const primaryCredentialId = nextCredentialIds[0] || "";
  const next = {
    ...existing,
    ...patch,
    credentialId: primaryCredentialId,
    credentialIds: nextCredentialIds,
  };
  getMainOrm()
    .update(channelsTable)
    .set({
      name: next.name,
      baseUrl: next.baseUrl,
      credentialId: next.credentialId,
      enabled: next.enabled ? 1 : 0,
      priority: next.priority,
      weight: next.weight,
      modelAllowlistJson: jsonStringify(next.modelAllowlist),
      status: next.status,
      healthScore: next.healthScore,
      cooldownUntil: next.cooldownUntil,
      lastError: next.lastError,
      lastUsedAt: next.lastUsedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(channelsTable.id, id))
    .run();
  setChannelCredentialIds(id, nextCredentialIds);
  return getChannelById(id);
}

export function deleteChannel(id: string) {
  const existing = getChannelById(id);
  if (!existing) {
    return false;
  }
  getMainOrm().delete(channelsTable).where(eq(channelsTable.id, id)).run();
  return true;
}

export function detachCredentialFromChannels(credentialId: string) {
  for (const channel of listChannels()) {
    if (!channel.credentialIds.includes(credentialId)) {
      continue;
    }
    const remainingCredentialIds = channel.credentialIds.filter(
      (id) => id !== credentialId,
    );
    if (remainingCredentialIds.length > 0) {
      updateChannel(channel.id, { credentialIds: remainingCredentialIds });
    }
  }
}

export function markChannelUsed(id: string) {
  updateChannel(id, { lastUsedAt: new Date().toISOString() });
}

export function getChannelCredentialIds(
  channelId: string,
  fallbackCredentialId?: string,
) {
  const ids = channelCredentialIdsByChannelId([channelId]).get(channelId) || [];
  return ids.length > 0 || !fallbackCredentialId ? ids : [fallbackCredentialId];
}

function channelCredentialIdsByChannelId(channelIds: string[]) {
  const uniqueIds = [...new Set(channelIds.filter(Boolean))];
  const result = new Map<string, string[]>();
  for (const channelId of uniqueIds) {
    result.set(channelId, []);
  }
  if (uniqueIds.length === 0) {
    return result;
  }

  const rows = getMainOrm()
    .select({
      channelId: channelCredentials.channelId,
      credentialId: channelCredentials.credentialId,
    })
    .from(channelCredentials)
    .where(inArray(channelCredentials.channelId, uniqueIds))
    .orderBy(
      asc(channelCredentials.channelId),
      asc(channelCredentials.createdAt),
      asc(channelCredentials.credentialId),
    )
    .all();
  for (const row of rows) {
    if (!row.credentialId) {
      continue;
    }
    const ids = result.get(row.channelId) || [];
    ids.push(row.credentialId);
    result.set(row.channelId, ids);
  }
  return result;
}

export function setChannelCredentialIds(
  channelId: string,
  credentialIds: string[],
) {
  const now = new Date().toISOString();
  const uniqueIds = cleanUniqueStrings(credentialIds);
  const db = getMainOrm();
  db.delete(channelCredentials)
    .where(eq(channelCredentials.channelId, channelId))
    .run();
  if (uniqueIds.length > 0) {
    db.insert(channelCredentials)
      .values(
        uniqueIds.map((credentialId) => ({
          channelId,
          credentialId,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
      .run();
  }
}

function toChannelRecord(
  row: ChannelRow,
  credentialIds = getChannelCredentialIds(row.id, row.credentialId),
): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    provider: "codex",
    baseUrl: row.baseUrl,
    credentialId: row.credentialId,
    credentialIds:
      credentialIds.length > 0
        ? credentialIds
        : [row.credentialId].filter(Boolean),
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    modelAllowlist: safeJsonParse<string[]>(row.modelAllowlistJson, []),
    status: normalizeStatus(row.status),
    healthScore: row.healthScore,
    cooldownUntil: row.cooldownUntil,
    lastError: row.lastError,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeCredentialIds(input: {
  credentialId?: string;
  credentialIds?: string[];
}) {
  return cleanUniqueStrings([
    ...(Array.isArray(input.credentialIds) ? input.credentialIds : []),
    ...(input.credentialId ? [input.credentialId] : []),
  ]);
}

function cleanUniqueStrings(values: unknown[]) {
  return [
    ...new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

function normalizeStatus(value: string): ChannelStatus {
  if (
    value === "healthy" ||
    value === "degraded" ||
    value === "cooling_down" ||
    value === "disabled"
  ) {
    return value;
  }
  return "healthy";
}
