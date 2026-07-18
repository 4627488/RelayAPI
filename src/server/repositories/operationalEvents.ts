import "server-only";

import { getLogOrm } from "@/src/server/db/sqlite";
import { auditLogs, channelHealthEvents } from "@/src/server/db/schema";
import { jsonStringify, randomId } from "@/src/server/services/crypto";

export function appendChannelHealthEvent(input: {
  channelId: string;
  channelName?: string;
  credentialId?: string | null;
  eventType: string;
  statusCode?: number | null;
  healthScore?: number | null;
  cooldownUntil?: string | null;
  message?: string | null;
}) {
  getLogOrm().insert(channelHealthEvents).values({
    id: randomId("chevt"),
    createdAt: new Date().toISOString(),
    channelId: input.channelId,
    channelName: input.channelName || "",
    credentialId: input.credentialId || null,
    eventType: input.eventType,
    statusCode: input.statusCode ?? null,
    healthScore: input.healthScore ?? null,
    cooldownUntil: input.cooldownUntil || null,
    message: input.message || null,
  }).run();
}

export function appendAuditLog(input: {
  action: string;
  actorType?: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}) {
  getLogOrm().insert(auditLogs).values({
    id: randomId("audit"),
    createdAt: new Date().toISOString(),
    actorType: input.actorType || "system",
    actorId: input.actorId || null,
    action: input.action,
    targetType: input.targetType || null,
    targetId: input.targetId || null,
    detailJson: jsonStringify(input.detail || {}),
  }).run();
}
