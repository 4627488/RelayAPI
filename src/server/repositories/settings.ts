import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";

type SettingRow = {
  key: string;
  value: string;
  updated_at: string;
};

export function getSettingValue(key: string) {
  const row = getMainDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as Pick<SettingRow, "value"> | undefined;
  return row?.value;
}

export function upsertSettingValue(key: string, value: string) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(key, value, now);
}

export function deleteSettingValue(key: string) {
  const result = getMainDb()
    .prepare("DELETE FROM settings WHERE key = ?")
    .run(key);
  return result.changes > 0;
}

export function getSettingUpdatedAt(key: string) {
  const row = getMainDb()
    .prepare("SELECT updated_at FROM settings WHERE key = ?")
    .get(key) as Pick<SettingRow, "updated_at"> | undefined;
  return row?.updated_at || null;
}
