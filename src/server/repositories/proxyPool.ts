import "server-only";

import { desc, eq } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import { proxyPool } from "@/src/server/db/schema";
import {
  decryptJson,
  encryptJson,
  randomId,
} from "@/src/server/services/crypto";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
  ProxyPoolRecord,
  ProxyPoolRecordWithSecret,
} from "@/src/shared/types/entities";

type ProxyPoolRow = typeof proxyPool.$inferSelect;

export interface SaveProxyPoolItemInput {
  name: string;
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  password?: string;
  notes: string;
}

export function listProxyPoolItems(): ProxyPoolRecord[] {
  const rows = getMainOrm()
    .select()
    .from(proxyPool)
    .orderBy(desc(proxyPool.enabled), desc(proxyPool.updatedAt))
    .all();
  return rows.map(toPublicProxyPoolRecord);
}

export function getProxyPoolItemById(id: string): ProxyPoolRecord | null {
  const row = getProxyPoolRow(id);
  return row ? toPublicProxyPoolRecord(row) : null;
}

export function getProxyPoolItemWithSecret(
  id: string,
): ProxyPoolRecordWithSecret | null {
  const row = getProxyPoolRow(id);
  return row ? toProxyPoolRecordWithSecret(row) : null;
}

export function createProxyPoolItem(input: SaveProxyPoolItemInput) {
  const now = new Date().toISOString();
  const id = randomId("proxy");
  getMainOrm()
    .insert(proxyPool)
    .values({
      id,
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username,
      passwordEnvelope: input.password ? encryptJson(input.password) : null,
      enabled: input.enabled ? 1 : 0,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    })
    .run();
  return getProxyPoolItemById(id);
}

export function updateProxyPoolItem(
  id: string,
  input: Partial<SaveProxyPoolItemInput>,
) {
  const existing = getProxyPoolRow(id);
  if (!existing) {
    return null;
  }
  const now = new Date().toISOString();
  const passwordEnvelope = Object.hasOwn(input, "password")
    ? input.password
      ? encryptJson(input.password)
      : null
    : existing.passwordEnvelope;

  getMainOrm()
    .update(proxyPool)
    .set({
      name: input.name ?? existing.name,
      type: input.type ?? normalizeProxyType(existing.type),
      host: input.host ?? existing.host,
      port: input.port ?? existing.port,
      username: input.username ?? existing.username,
      passwordEnvelope,
      enabled:
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      notes: input.notes ?? existing.notes,
      updatedAt: now,
    })
    .where(eq(proxyPool.id, id))
    .run();
  return getProxyPoolItemById(id);
}

export function deleteProxyPoolItem(id: string) {
  const existing = getProxyPoolRow(id);
  if (!existing) {
    return false;
  }
  getMainOrm()
    .delete(proxyPool)
    .where(eq(proxyPool.id, id))
    .run();
  return true;
}

export function markProxyPoolItemUsed(id: string) {
  const now = new Date().toISOString();
  getMainOrm()
    .update(proxyPool)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(proxyPool.id, id))
    .run();
}

export function proxyPoolItemToCredentialProxy(
  item: ProxyPoolRecordWithSecret,
): CredentialProxyConfig {
  return {
    enabled: item.enabled,
    type: item.type,
    host: item.host,
    port: item.port,
    username: item.username,
    password: item.password,
  };
}

function getProxyPoolRow(id: string) {
  return getMainOrm()
    .select()
    .from(proxyPool)
    .where(eq(proxyPool.id, id))
    .get();
}

function toPublicProxyPoolRecord(row: ProxyPoolRow): ProxyPoolRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    type: normalizeProxyType(row.type),
    host: row.host,
    port: row.port,
    username: row.username,
    passwordSet: Boolean(row.passwordEnvelope),
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function toProxyPoolRecordWithSecret(row: ProxyPoolRow): ProxyPoolRecordWithSecret {
  return {
    ...toPublicProxyPoolRecord(row),
    password: row.passwordEnvelope
      ? decryptJson<string>(row.passwordEnvelope)
      : "",
  };
}

function normalizeProxyType(value: string): CredentialProxyType {
  return value === "socks5" ? "socks5" : "socks5h";
}
