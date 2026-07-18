import type { SqliteDatabase } from "@/src/server/db/sqlite";

export function migrateChannelCredentialRelation(database: SqliteDatabase) {
  const columns = database
    .prepare("PRAGMA table_info(channels)")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "credential_id")) return;

  database.exec(`
    CREATE TABLE channels_next (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'codex',
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      priority INTEGER NOT NULL DEFAULT 100,
      weight INTEGER NOT NULL DEFAULT 1,
      model_allowlist_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'healthy',
      health_score REAL NOT NULL DEFAULT 100,
      cooldown_until TEXT,
      last_error TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO channels_next (
      id, name, provider, base_url, enabled, priority, weight,
      model_allowlist_json, status, health_score, cooldown_until,
      last_error, last_used_at, created_at, updated_at
    )
    SELECT
      id, name, provider, base_url, enabled, priority, weight,
      model_allowlist_json, status, health_score, cooldown_until,
      last_error, last_used_at, created_at, updated_at
    FROM channels;

    CREATE TABLE channel_credentials_next (
      channel_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, credential_id),
      FOREIGN KEY (channel_id) REFERENCES channels_next(id) ON DELETE CASCADE,
      FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
    ) STRICT;

    INSERT INTO channel_credentials_next (channel_id, credential_id, created_at)
    SELECT channel_id, credential_id, created_at FROM channel_credentials;

    DROP TABLE channel_credentials;
    DROP TABLE channels;
    ALTER TABLE channels_next RENAME TO channels;
    ALTER TABLE channel_credentials_next RENAME TO channel_credentials;

    CREATE INDEX idx_channels_routing
      ON channels(enabled, status, priority, weight);
    CREATE INDEX idx_channel_credentials_credential
      ON channel_credentials(credential_id);
  `);
}
