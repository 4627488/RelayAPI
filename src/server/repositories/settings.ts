import "server-only";

import { eq } from "drizzle-orm";

import { getMainOrm } from "@/src/server/db/sqlite";
import { settings } from "@/src/server/db/schema";

export function getSettingValue(key: string) {
  const row = getMainOrm()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.value;
}

export function upsertSettingValue(key: string, value: string) {
  const now = new Date().toISOString();
  getMainOrm()
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

export function deleteSettingValue(key: string) {
  const existing = getSettingValue(key);
  if (existing === undefined) {
    return false;
  }
  getMainOrm()
    .delete(settings)
    .where(eq(settings.key, key))
    .run();
  return true;
}

export function getSettingUpdatedAt(key: string) {
  const row = getMainOrm()
    .select({ updatedAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.updatedAt || null;
}
