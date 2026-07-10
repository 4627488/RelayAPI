import "server-only";

import Database, {
  type Database as BetterSqliteDatabase,
  type RunResult,
  type Statement,
} from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "@/src/server/config/env";
import { logSchema, mainSchema } from "@/src/server/db/schema";
import {
  DEFAULT_TIME_ZONE,
  instantToDateKey,
  isValidTimeZone,
} from "@/src/shared/time";

type SqliteStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
};

type SqliteDatabase = {
  client: BetterSqliteDatabase;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
};

let sqliteTimeZone = DEFAULT_TIME_ZONE;

let mainDb: SqliteDatabase | null = null;
let logDb: SqliteDatabase | null = null;
let mainOrm: BetterSQLite3Database<typeof mainSchema> | null = null;
let logOrm: BetterSQLite3Database<typeof logSchema> | null = null;
let initialized = false;

export function getMainOrm() {
  ensureInitialized();
  if (!mainOrm) {
    throw new Error("Main ORM is not initialized");
  }
  return mainOrm;
}

export function getLogOrm() {
  ensureInitialized();
  if (!logOrm) {
    throw new Error("Log ORM is not initialized");
  }
  return logOrm;
}

export function ensureInitialized() {
  if (initialized) {
    return;
  }
  fs.mkdirSync(serverConfig.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(serverConfig.mainDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(serverConfig.logDbPath), { recursive: true });

  mainDb = openDatabase(serverConfig.mainDbPath, true);
  logDb = openDatabase(serverConfig.logDbPath, true);
  migrateMainDb(mainDb);
  const storedTimeZone = mainDb
    .prepare("SELECT value FROM settings WHERE key = 'time_zone'")
    .get() as { value?: string } | undefined;
  sqliteTimeZone = isValidTimeZone(storedTimeZone?.value)
    ? storedTimeZone.value
    : DEFAULT_TIME_ZONE;
  logDb.client.function("relay_date_key", (value: unknown) =>
    instantToDateKey(String(value || ""), sqliteTimeZone),
  );
  migrateLogDb(logDb);
  mainOrm = drizzle(mainDb.client, { schema: mainSchema });
  logOrm = drizzle(logDb.client, { schema: logSchema });
  initialized = true;
}

function openDatabase(filePath: string, foreignKeys: boolean) {
  const db = openSqliteDatabase(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${serverConfig.sqliteBusyTimeoutMs}`);
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return db;
}

function openSqliteDatabase(filePath: string): SqliteDatabase {
  const database = new Database(filePath, {
    timeout: serverConfig.sqliteBusyTimeoutMs,
  });
  return {
    client: database,
    exec: (sql) => database.exec(sql),
    prepare: (sql) => database.prepare(sql) as Statement,
  };
}

function applyMigration(
  db: SqliteDatabase,
  name: string,
  migration: string | ((db: SqliteDatabase) => void),
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const existing = db
    .prepare("SELECT name FROM schema_migrations WHERE name = ?")
    .get(name);
  if (existing) {
    return;
  }
  db.exec("BEGIN");
  try {
    if (typeof migration === "string") {
      db.exec(migration);
    } else {
      migration(db);
    }
    db.prepare(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
    ).run(name, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateMainDb(db: SqliteDatabase) {
  applyMigration(
    db,
    "001_main_foundation",
    `
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        model_allowlist_json TEXT NOT NULL,
        channel_allowlist_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        token_limit_daily INTEGER,
        rate_limit_per_minute INTEGER,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

      CREATE TABLE IF NOT EXISTS codex_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'codex',
        email TEXT NOT NULL DEFAULT '',
        account_id TEXT NOT NULL DEFAULT '',
        plan_type TEXT NOT NULL DEFAULT '',
        token_envelope TEXT NOT NULL,
        proxy_envelope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        last_refresh_at TEXT,
        last_used_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex',
        base_url TEXT NOT NULL,
        credential_id TEXT NOT NULL,
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
        updated_at TEXT NOT NULL,
        FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channels_credential
        ON channels(credential_id);
      CREATE INDEX IF NOT EXISTS idx_channels_routing
        ON channels(enabled, status, priority, weight);

      CREATE TABLE IF NOT EXISTS channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channel_credentials_credential
        ON channel_credentials(credential_id);

      CREATE TABLE IF NOT EXISTS codex_quota_cache (
        credential_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'unknown',
        cache_json TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  );

  applyMigration(db, "002_remove_codex_credential_status", (database) => {
    const columns = database
      .prepare("PRAGMA table_info(codex_credentials)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "status")) {
      return;
    }
    database.exec("DROP INDEX IF EXISTS idx_codex_credentials_status");
    database.exec("ALTER TABLE codex_credentials DROP COLUMN status");
  });

  applyMigration(
    db,
    "003_oauth_pending_states",
    `
      CREATE TABLE IF NOT EXISTS oauth_pending_states (
        state TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_expires
        ON oauth_pending_states(expires_at);
    `,
  );

  applyMigration(db, "004_routing_credentials", (database) => {
    addColumnIfMissing(
      database,
      "codex_credentials",
      "enabled",
      "INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))",
    );
    addColumnIfMissing(
      database,
      "codex_credentials",
      "priority",
      "INTEGER NOT NULL DEFAULT 100",
    );
    addColumnIfMissing(
      database,
      "codex_credentials",
      "weight",
      "INTEGER NOT NULL DEFAULT 1",
    );
    addColumnIfMissing(database, "codex_credentials", "last_used_at", "TEXT");
    database.exec(`
      CREATE TABLE IF NOT EXISTS channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
        FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channel_credentials_credential
        ON channel_credentials(credential_id);

      INSERT OR IGNORE INTO channel_credentials (channel_id, credential_id, created_at)
      SELECT id, credential_id, created_at
      FROM channels
      WHERE credential_id IS NOT NULL AND credential_id <> '';
    `);
  });

  applyMigration(db, "005_credential_proxy", (database) => {
    addColumnIfMissing(database, "codex_credentials", "proxy_envelope", "TEXT");
  });

  applyMigration(
    db,
    "006_proxy_pool",
    `
      CREATE TABLE IF NOT EXISTS proxy_pool (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('socks5', 'socks5h')),
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        password_envelope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_proxy_pool_enabled
        ON proxy_pool(enabled, updated_at);
    `,
  );

  applyMigration(db, "007_tenants", (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        max_api_keys INTEGER,
        token_limit_daily INTEGER,
        rate_limit_per_minute INTEGER,
        model_allowlist_json TEXT NOT NULL DEFAULT '[]',
        channel_allowlist_json TEXT NOT NULL DEFAULT '[]',
        allow_custom_proxy INTEGER NOT NULL DEFAULT 0 CHECK (allow_custom_proxy IN (0, 1)),
        allow_custom_user_agent INTEGER NOT NULL DEFAULT 0 CHECK (allow_custom_user_agent IN (0, 1)),
        proxy_envelope TEXT,
        user_agent TEXT,
        expires_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tenants_enabled
        ON tenants(enabled, created_at);
      CREATE INDEX IF NOT EXISTS idx_tenants_owner_email
        ON tenants(owner_email);

      CREATE TABLE IF NOT EXISTS tenant_users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'owner',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        password_hash TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant
        ON tenant_users(tenant_id);

      CREATE TABLE IF NOT EXISTS tenant_invites (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES tenant_users(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant
        ON tenant_invites(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tenant_invites_token
        ON tenant_invites(token_hash);
    `);

    addColumnIfMissing(database, "api_keys", "tenant_id", "TEXT");
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
        ON api_keys(tenant_id, created_at);
    `);
  });

  applyMigration(db, "008_api_key_tenant_foreign_key", (database) => {
    const foreignKeys = database
      .prepare("PRAGMA foreign_key_list(api_keys)")
      .all() as Array<{ table: string; from: string }>;
    if (
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "tenants" && foreignKey.from === "tenant_id",
      )
    ) {
      return;
    }

    database.exec(`
      CREATE TABLE api_keys_next (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        model_allowlist_json TEXT NOT NULL,
        channel_allowlist_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        token_limit_daily INTEGER CHECK (token_limit_daily IS NULL OR token_limit_daily > 0),
        rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) STRICT;

      INSERT INTO api_keys_next (
        id, tenant_id, name, key_hash, prefix, scopes_json,
        model_allowlist_json, channel_allowlist_json, enabled,
        token_limit_daily, rate_limit_per_minute, expires_at,
        created_at, updated_at, last_used_at
      )
      SELECT
        api_keys.id,
        CASE
          WHEN tenants.id IS NULL THEN NULL
          ELSE api_keys.tenant_id
        END,
        api_keys.name,
        api_keys.key_hash,
        api_keys.prefix,
        api_keys.scopes_json,
        api_keys.model_allowlist_json,
        api_keys.channel_allowlist_json,
        api_keys.enabled,
        api_keys.token_limit_daily,
        api_keys.rate_limit_per_minute,
        api_keys.expires_at,
        api_keys.created_at,
        api_keys.updated_at,
        api_keys.last_used_at
      FROM api_keys
      LEFT JOIN tenants ON tenants.id = api_keys.tenant_id;

      DROP TABLE api_keys;
      ALTER TABLE api_keys_next RENAME TO api_keys;

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
      CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
        ON api_keys(tenant_id, created_at);
    `);
  });

  applyMigration(db, "009_unbound_tenant_invites", (database) => {
    const columns = database
      .prepare("PRAGMA table_info(tenant_invites)")
      .all() as Array<{ name: string; notnull: number }>;
    const userId = columns.find((column) => column.name === "user_id");
    const email = columns.find((column) => column.name === "email");
    if (userId?.notnull === 0 && email?.notnull === 1) {
      return;
    }

    database.exec(`
      DROP INDEX IF EXISTS tenant_invites_token_hash_unique;
      DROP INDEX IF EXISTS idx_tenant_invites_tenant;
      DROP INDEX IF EXISTS idx_tenant_invites_token;

      CREATE TABLE tenant_invites_next (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT,
        email TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES tenant_users(id) ON DELETE CASCADE
      ) STRICT;

      INSERT INTO tenant_invites_next (
        id, tenant_id, user_id, email, token_hash, expires_at,
        accepted_at, revoked_at, created_at, updated_at
      )
      SELECT
        id,
        tenant_id,
        NULLIF(user_id, ''),
        COALESCE(email, ''),
        token_hash,
        expires_at,
        accepted_at,
        revoked_at,
        created_at,
        updated_at
      FROM tenant_invites;

      DROP TABLE tenant_invites;
      ALTER TABLE tenant_invites_next RENAME TO tenant_invites;

      CREATE UNIQUE INDEX IF NOT EXISTS tenant_invites_token_hash_unique
        ON tenant_invites(token_hash);
      CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant
        ON tenant_invites(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tenant_invites_token
        ON tenant_invites(token_hash);
    `);
  });

  applyMigration(db, "010_tenant_account_operations", (database) => {
    addColumnIfMissing(database, "tenant_users", "password_changed_at", "TEXT");
    addColumnIfMissing(database, "tenant_users", "session_version", "INTEGER NOT NULL DEFAULT 1");
    database.exec(`
      CREATE TABLE IF NOT EXISTS tenant_password_resets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES tenant_users(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tenant_password_resets_tenant
        ON tenant_password_resets(tenant_id, created_at);
    `);
  });

  applyMigration(db, "011_tenant_quota_accounting", (database) => {
    addColumnIfMissing(database, "tenants", "quota_shares_milli", "INTEGER");
    database.exec(`
      CREATE TABLE IF NOT EXISTS tenant_quota_windows (
        tenant_id TEXT NOT NULL,
        window_kind TEXT NOT NULL CHECK (window_kind IN ('5h', '7d')),
        started_at TEXT NOT NULL,
        resets_at TEXT NOT NULL,
        limit_nano_usd TEXT NOT NULL,
        settled_nano_usd TEXT NOT NULL DEFAULT '0',
        reserved_nano_usd TEXT NOT NULL DEFAULT '0',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, window_kind),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tenant_quota_windows_reset
        ON tenant_quota_windows(resets_at);

      CREATE TABLE IF NOT EXISTS quota_reservations (
        request_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        reserve_nano_usd TEXT NOT NULL,
        actual_nano_usd TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'released', 'expired')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settled_at TEXT,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_quota_reservations_tenant_status
        ON quota_reservations(tenant_id, status);
    `);
  });
}

export function setSqliteTimeZone(timeZone: string) {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError("A valid IANA timezone is required");
  }
  sqliteTimeZone = timeZone;
}

function migrateLogDb(db: SqliteDatabase) {
  applyMigration(
    db,
    "001_log_foundation",
    `
      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_type TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0 CHECK (stream IN (0, 1)),
        model TEXT NOT NULL DEFAULT '',
        status_code INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        api_key_id TEXT,
        api_key_prefix TEXT,
        api_key_name TEXT,
        channel_id TEXT,
        channel_name TEXT,
        credential_id TEXT,
        credential_email TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_request_logs_started
        ON request_logs(started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_api_key
        ON request_logs(api_key_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_channel
        ON request_logs(channel_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_credential
        ON request_logs(credential_id, started_at);

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        api_key_id TEXT,
        api_key_prefix TEXT,
        api_key_name TEXT,
        channel_id TEXT,
        channel_name TEXT,
        credential_id TEXT,
        credential_email TEXT,
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_usage_records_created
        ON usage_records(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_api_key
        ON usage_records(api_key_id, created_at);

      CREATE TABLE IF NOT EXISTS usage_daily_buckets (
        bucket_date TEXT NOT NULL,
        api_key_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT '',
        credential_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bucket_date, api_key_id, channel_id, credential_id, model)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS channel_health_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL DEFAULT '',
        credential_id TEXT,
        event_type TEXT NOT NULL,
        status_code INTEGER,
        health_score REAL,
        cooldown_until TEXT,
        message TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channel_health_events_channel
        ON channel_health_events(channel_id, created_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created
        ON audit_logs(created_at);
    `,
  );

  applyMigration(db, "002_api_key_name_log_columns", (database) => {
    addColumnIfMissing(database, "request_logs", "api_key_name", "TEXT");
    addColumnIfMissing(database, "usage_records", "api_key_name", "TEXT");
  });

  applyMigration(
    db,
    "003_request_logs_credential_index",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_credential ON request_logs(credential_id, started_at);",
  );

  applyMigration(
    db,
    "004_request_log_details",
    `
      CREATE TABLE IF NOT EXISTS request_log_details (
        request_log_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_headers_json TEXT,
        request_body_text TEXT,
        request_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (request_body_truncated IN (0, 1)),
        request_body_bytes INTEGER NOT NULL DEFAULT 0,
        forwarded_body_text TEXT,
        forwarded_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (forwarded_body_truncated IN (0, 1)),
        forwarded_body_bytes INTEGER NOT NULL DEFAULT 0,
        upstream_status_code INTEGER,
        upstream_headers_json TEXT,
        upstream_body_text TEXT,
        upstream_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (upstream_body_truncated IN (0, 1)),
        upstream_body_bytes INTEGER NOT NULL DEFAULT 0,
        error_name TEXT,
        error_message TEXT,
        error_stack TEXT,
        error_cause_json TEXT,
        detail_json TEXT,
        stage_timings_json TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_request_log_details_updated
        ON request_log_details(updated_at);
      CREATE INDEX IF NOT EXISTS idx_request_log_details_created
        ON request_log_details(created_at);
    `,
  );

  applyMigration(db, "005_request_log_stage_timings", (database) => {
    addColumnIfMissing(
      database,
      "request_log_details",
      "stage_timings_json",
      "TEXT",
    );
  });

  applyMigration(
    db,
    "006_request_log_dashboard_indexes",
    `
      CREATE INDEX IF NOT EXISTS idx_request_logs_status_started
        ON request_logs(status_code, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_model_started
        ON request_logs(model, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_request_type_started
        ON request_logs(request_type, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_started_latency
        ON request_logs(started_at, latency_ms);
      CREATE INDEX IF NOT EXISTS idx_usage_daily_buckets_updated
        ON usage_daily_buckets(updated_at);
      CREATE INDEX IF NOT EXISTS idx_channel_health_events_created
        ON channel_health_events(created_at);
    `,
  );

  applyMigration(db, "007_cached_token_usage", (database) => {
    addColumnIfMissing(
      database,
      "request_logs",
      "cached_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      database,
      "usage_records",
      "cached_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      database,
      "usage_daily_buckets",
      "cached_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
  });

  applyMigration(db, "008_tenant_log_scope", (database) => {
    addColumnIfMissing(database, "request_logs", "tenant_id", "TEXT");
    addColumnIfMissing(database, "request_logs", "tenant_name", "TEXT");
    addColumnIfMissing(database, "usage_records", "tenant_id", "TEXT");
    addColumnIfMissing(database, "usage_records", "tenant_name", "TEXT");
    addColumnIfMissing(database, "usage_daily_buckets", "tenant_id", "TEXT");
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_request_logs_tenant
        ON request_logs(tenant_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_tenant
        ON usage_records(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_daily_buckets_tenant
        ON usage_daily_buckets(tenant_id, bucket_date);
    `);
  });

  applyMigration(db, "009_request_metric_buckets", (database) => {
    recreateRequestLogDetailsForeignKey(database);

    database.exec(`
      DELETE FROM request_log_details
      WHERE NOT EXISTS (
        SELECT 1 FROM request_logs
        WHERE request_logs.id = request_log_details.request_log_id
      );

      CREATE TABLE IF NOT EXISTS request_daily_buckets (
        bucket_date TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '',
        api_key_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT '',
        credential_id TEXT NOT NULL DEFAULT '',
        request_type TEXT NOT NULL DEFAULT '',
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
        success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
        error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
        stream_count INTEGER NOT NULL DEFAULT 0 CHECK (stream_count >= 0),
        prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
        completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
        total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
        cached_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
        total_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_latency_ms >= 0),
        first_request_at TEXT,
        last_request_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          bucket_date, tenant_id, api_key_id, model,
          channel_id, credential_id, request_type
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_request_daily_buckets_tenant_date
        ON request_daily_buckets(tenant_id, bucket_date);
      CREATE INDEX IF NOT EXISTS idx_request_daily_buckets_api_key_date
        ON request_daily_buckets(api_key_id, bucket_date);
      CREATE INDEX IF NOT EXISTS idx_request_daily_buckets_model_date
        ON request_daily_buckets(model, bucket_date);
      CREATE INDEX IF NOT EXISTS idx_request_daily_buckets_channel_date
        ON request_daily_buckets(channel_id, bucket_date);
      CREATE INDEX IF NOT EXISTS idx_request_daily_buckets_credential_date
        ON request_daily_buckets(credential_id, bucket_date);
      CREATE INDEX IF NOT EXISTS idx_request_daily_buckets_request_type_date
        ON request_daily_buckets(request_type, bucket_date);

      DELETE FROM request_daily_buckets;

      INSERT INTO request_daily_buckets (
        bucket_date, tenant_id, api_key_id, model, channel_id, credential_id,
        request_type, request_count, success_count, error_count, stream_count,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens,
        total_latency_ms, first_request_at, last_request_at, updated_at
      )
      SELECT
        relay_date_key(started_at) AS bucket_date,
        COALESCE(tenant_id, '') AS tenant_id,
        COALESCE(api_key_id, '') AS api_key_id,
        COALESCE(model, '') AS model,
        COALESCE(channel_id, '') AS channel_id,
        COALESCE(credential_id, '') AS credential_id,
        COALESCE(request_type, '') AS request_type,
        COUNT(*) AS request_count,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        SUM(stream) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
        MIN(started_at) AS first_request_at,
        MAX(started_at) AS last_request_at,
        MAX(completed_at) AS updated_at
      FROM request_logs
      GROUP BY
        relay_date_key(started_at),
        COALESCE(tenant_id, ''),
        COALESCE(api_key_id, ''),
        COALESCE(model, ''),
        COALESCE(channel_id, ''),
        COALESCE(credential_id, ''),
        COALESCE(request_type, '')
    `);

    recreateRequestMetricTriggers(database);
  });

  applyMigration(db, "010_configurable_time_zone_buckets", (database) => {
    recreateRequestMetricTriggers(database);
    database.exec(`
      DELETE FROM request_daily_buckets;
      INSERT INTO request_daily_buckets (
        bucket_date, tenant_id, api_key_id, model, channel_id, credential_id,
        request_type, request_count, success_count, error_count, stream_count,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens,
        total_latency_ms, first_request_at, last_request_at, updated_at
      )
      SELECT
        relay_date_key(started_at),
        COALESCE(tenant_id, ''),
        COALESCE(api_key_id, ''),
        COALESCE(model, ''),
        COALESCE(channel_id, ''),
        COALESCE(credential_id, ''),
        COALESCE(request_type, ''),
        COUNT(*),
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END),
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END),
        SUM(stream),
        COALESCE(SUM(prompt_tokens), 0),
        COALESCE(SUM(completion_tokens), 0),
        COALESCE(SUM(total_tokens), 0),
        COALESCE(SUM(cached_tokens), 0),
        COALESCE(SUM(latency_ms), 0),
        MIN(started_at),
        MAX(started_at),
        MAX(completed_at)
      FROM request_logs
      GROUP BY
        relay_date_key(started_at), tenant_id, api_key_id, model,
        channel_id, credential_id, request_type;

      DELETE FROM usage_daily_buckets;
      INSERT INTO usage_daily_buckets (
        bucket_date, tenant_id, api_key_id, channel_id, credential_id, model,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens,
        request_count, updated_at
      )
      SELECT
        relay_date_key(created_at),
        COALESCE(tenant_id, ''),
        COALESCE(api_key_id, ''),
        COALESCE(channel_id, ''),
        COALESCE(credential_id, ''),
        COALESCE(model, ''),
        COALESCE(SUM(prompt_tokens), 0),
        COALESCE(SUM(completion_tokens), 0),
        COALESCE(SUM(total_tokens), 0),
        COALESCE(SUM(cached_tokens), 0),
        COUNT(*),
        MAX(created_at)
      FROM usage_records
      GROUP BY
        relay_date_key(created_at), tenant_id, api_key_id,
        channel_id, credential_id, model;
    `);
  });
}

function recreateRequestLogDetailsForeignKey(db: SqliteDatabase) {
  const foreignKeys = db
    .prepare("PRAGMA foreign_key_list(request_log_details)")
    .all() as Array<{ table: string; from: string; on_delete: string }>;
  if (
    foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === "request_logs" &&
        foreignKey.from === "request_log_id" &&
        foreignKey.on_delete.toUpperCase() === "CASCADE",
    )
  ) {
    return;
  }

  db.exec(`
    CREATE TABLE request_log_details_next (
      request_log_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      request_headers_json TEXT,
      request_body_text TEXT,
      request_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (request_body_truncated IN (0, 1)),
      request_body_bytes INTEGER NOT NULL DEFAULT 0 CHECK (request_body_bytes >= 0),
      forwarded_body_text TEXT,
      forwarded_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (forwarded_body_truncated IN (0, 1)),
      forwarded_body_bytes INTEGER NOT NULL DEFAULT 0 CHECK (forwarded_body_bytes >= 0),
      upstream_status_code INTEGER,
      upstream_headers_json TEXT,
      upstream_body_text TEXT,
      upstream_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (upstream_body_truncated IN (0, 1)),
      upstream_body_bytes INTEGER NOT NULL DEFAULT 0 CHECK (upstream_body_bytes >= 0),
      error_name TEXT,
      error_message TEXT,
      error_stack TEXT,
      error_cause_json TEXT,
      detail_json TEXT,
      stage_timings_json TEXT,
      FOREIGN KEY (request_log_id) REFERENCES request_logs(id) ON DELETE CASCADE
    ) STRICT;

    INSERT INTO request_log_details_next (
      request_log_id, created_at, updated_at, request_headers_json,
      request_body_text, request_body_truncated, request_body_bytes,
      forwarded_body_text, forwarded_body_truncated, forwarded_body_bytes,
      upstream_status_code, upstream_headers_json, upstream_body_text,
      upstream_body_truncated, upstream_body_bytes, error_name,
      error_message, error_stack, error_cause_json, detail_json,
      stage_timings_json
    )
    SELECT
      request_log_details.request_log_id,
      request_log_details.created_at,
      request_log_details.updated_at,
      request_log_details.request_headers_json,
      request_log_details.request_body_text,
      request_log_details.request_body_truncated,
      request_log_details.request_body_bytes,
      request_log_details.forwarded_body_text,
      request_log_details.forwarded_body_truncated,
      request_log_details.forwarded_body_bytes,
      request_log_details.upstream_status_code,
      request_log_details.upstream_headers_json,
      request_log_details.upstream_body_text,
      request_log_details.upstream_body_truncated,
      request_log_details.upstream_body_bytes,
      request_log_details.error_name,
      request_log_details.error_message,
      request_log_details.error_stack,
      request_log_details.error_cause_json,
      request_log_details.detail_json,
      request_log_details.stage_timings_json
    FROM request_log_details
    INNER JOIN request_logs ON request_logs.id = request_log_details.request_log_id;

    DROP TABLE request_log_details;
    ALTER TABLE request_log_details_next RENAME TO request_log_details;

    CREATE INDEX IF NOT EXISTS idx_request_log_details_updated
      ON request_log_details(updated_at);
    CREATE INDEX IF NOT EXISTS idx_request_log_details_created
      ON request_log_details(created_at);
  `);
}

function recreateRequestMetricTriggers(db: SqliteDatabase) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_request_logs_metric_ai;
    DROP TRIGGER IF EXISTS trg_request_logs_metric_ad;
    DROP TRIGGER IF EXISTS trg_request_logs_metric_au;

    CREATE TRIGGER trg_request_logs_metric_ai
    AFTER INSERT ON request_logs
    BEGIN
      INSERT INTO request_daily_buckets (
        bucket_date, tenant_id, api_key_id, model, channel_id, credential_id,
        request_type, request_count, success_count, error_count, stream_count,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens,
        total_latency_ms, first_request_at, last_request_at, updated_at
      ) VALUES (
        relay_date_key(NEW.started_at),
        COALESCE(NEW.tenant_id, ''),
        COALESCE(NEW.api_key_id, ''),
        COALESCE(NEW.model, ''),
        COALESCE(NEW.channel_id, ''),
        COALESCE(NEW.credential_id, ''),
        COALESCE(NEW.request_type, ''),
        1,
        CASE WHEN NEW.status_code >= 200 AND NEW.status_code < 400 THEN 1 ELSE 0 END,
        CASE WHEN NEW.status_code >= 400 THEN 1 ELSE 0 END,
        NEW.stream,
        NEW.prompt_tokens,
        NEW.completion_tokens,
        NEW.total_tokens,
        NEW.cached_tokens,
        NEW.latency_ms,
        NEW.started_at,
        NEW.started_at,
        NEW.completed_at
      )
      ON CONFLICT (
        bucket_date, tenant_id, api_key_id, model,
        channel_id, credential_id, request_type
      ) DO UPDATE SET
        request_count = request_daily_buckets.request_count + 1,
        success_count = request_daily_buckets.success_count + excluded.success_count,
        error_count = request_daily_buckets.error_count + excluded.error_count,
        stream_count = request_daily_buckets.stream_count + excluded.stream_count,
        prompt_tokens = request_daily_buckets.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = request_daily_buckets.completion_tokens + excluded.completion_tokens,
        total_tokens = request_daily_buckets.total_tokens + excluded.total_tokens,
        cached_tokens = request_daily_buckets.cached_tokens + excluded.cached_tokens,
        total_latency_ms = request_daily_buckets.total_latency_ms + excluded.total_latency_ms,
        first_request_at = CASE
          WHEN request_daily_buckets.first_request_at IS NULL
            OR excluded.first_request_at < request_daily_buckets.first_request_at
          THEN excluded.first_request_at
          ELSE request_daily_buckets.first_request_at
        END,
        last_request_at = CASE
          WHEN request_daily_buckets.last_request_at IS NULL
            OR excluded.last_request_at > request_daily_buckets.last_request_at
          THEN excluded.last_request_at
          ELSE request_daily_buckets.last_request_at
        END,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER trg_request_logs_metric_ad
    AFTER DELETE ON request_logs
    BEGIN
      UPDATE request_daily_buckets
      SET
        request_count = MAX(request_count - 1, 0),
        success_count = MAX(
          success_count - CASE WHEN OLD.status_code >= 200 AND OLD.status_code < 400 THEN 1 ELSE 0 END,
          0
        ),
        error_count = MAX(
          error_count - CASE WHEN OLD.status_code >= 400 THEN 1 ELSE 0 END,
          0
        ),
        stream_count = MAX(stream_count - OLD.stream, 0),
        prompt_tokens = MAX(prompt_tokens - OLD.prompt_tokens, 0),
        completion_tokens = MAX(completion_tokens - OLD.completion_tokens, 0),
        total_tokens = MAX(total_tokens - OLD.total_tokens, 0),
        cached_tokens = MAX(cached_tokens - OLD.cached_tokens, 0),
        total_latency_ms = MAX(total_latency_ms - OLD.latency_ms, 0),
        updated_at = datetime('now')
      WHERE
        bucket_date = relay_date_key(OLD.started_at)
        AND tenant_id = COALESCE(OLD.tenant_id, '')
        AND api_key_id = COALESCE(OLD.api_key_id, '')
        AND model = COALESCE(OLD.model, '')
        AND channel_id = COALESCE(OLD.channel_id, '')
        AND credential_id = COALESCE(OLD.credential_id, '')
        AND request_type = COALESCE(OLD.request_type, '');

      DELETE FROM request_daily_buckets
      WHERE request_count <= 0;
    END;

    CREATE TRIGGER trg_request_logs_metric_au
    AFTER UPDATE OF
      started_at, completed_at, tenant_id, api_key_id, model, channel_id,
      credential_id, request_type, status_code, stream, prompt_tokens,
      completion_tokens, total_tokens, cached_tokens, latency_ms
    ON request_logs
    BEGIN
      UPDATE request_daily_buckets
      SET
        request_count = MAX(request_count - 1, 0),
        success_count = MAX(
          success_count - CASE WHEN OLD.status_code >= 200 AND OLD.status_code < 400 THEN 1 ELSE 0 END,
          0
        ),
        error_count = MAX(
          error_count - CASE WHEN OLD.status_code >= 400 THEN 1 ELSE 0 END,
          0
        ),
        stream_count = MAX(stream_count - OLD.stream, 0),
        prompt_tokens = MAX(prompt_tokens - OLD.prompt_tokens, 0),
        completion_tokens = MAX(completion_tokens - OLD.completion_tokens, 0),
        total_tokens = MAX(total_tokens - OLD.total_tokens, 0),
        cached_tokens = MAX(cached_tokens - OLD.cached_tokens, 0),
        total_latency_ms = MAX(total_latency_ms - OLD.latency_ms, 0),
        updated_at = datetime('now')
      WHERE
        bucket_date = relay_date_key(OLD.started_at)
        AND tenant_id = COALESCE(OLD.tenant_id, '')
        AND api_key_id = COALESCE(OLD.api_key_id, '')
        AND model = COALESCE(OLD.model, '')
        AND channel_id = COALESCE(OLD.channel_id, '')
        AND credential_id = COALESCE(OLD.credential_id, '')
        AND request_type = COALESCE(OLD.request_type, '');

      DELETE FROM request_daily_buckets
      WHERE request_count <= 0;

      INSERT INTO request_daily_buckets (
        bucket_date, tenant_id, api_key_id, model, channel_id, credential_id,
        request_type, request_count, success_count, error_count, stream_count,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens,
        total_latency_ms, first_request_at, last_request_at, updated_at
      ) VALUES (
        relay_date_key(NEW.started_at),
        COALESCE(NEW.tenant_id, ''),
        COALESCE(NEW.api_key_id, ''),
        COALESCE(NEW.model, ''),
        COALESCE(NEW.channel_id, ''),
        COALESCE(NEW.credential_id, ''),
        COALESCE(NEW.request_type, ''),
        1,
        CASE WHEN NEW.status_code >= 200 AND NEW.status_code < 400 THEN 1 ELSE 0 END,
        CASE WHEN NEW.status_code >= 400 THEN 1 ELSE 0 END,
        NEW.stream,
        NEW.prompt_tokens,
        NEW.completion_tokens,
        NEW.total_tokens,
        NEW.cached_tokens,
        NEW.latency_ms,
        NEW.started_at,
        NEW.started_at,
        NEW.completed_at
      )
      ON CONFLICT (
        bucket_date, tenant_id, api_key_id, model,
        channel_id, credential_id, request_type
      ) DO UPDATE SET
        request_count = request_daily_buckets.request_count + 1,
        success_count = request_daily_buckets.success_count + excluded.success_count,
        error_count = request_daily_buckets.error_count + excluded.error_count,
        stream_count = request_daily_buckets.stream_count + excluded.stream_count,
        prompt_tokens = request_daily_buckets.prompt_tokens + excluded.prompt_tokens,
        completion_tokens = request_daily_buckets.completion_tokens + excluded.completion_tokens,
        total_tokens = request_daily_buckets.total_tokens + excluded.total_tokens,
        cached_tokens = request_daily_buckets.cached_tokens + excluded.cached_tokens,
        total_latency_ms = request_daily_buckets.total_latency_ms + excluded.total_latency_ms,
        first_request_at = CASE
          WHEN request_daily_buckets.first_request_at IS NULL
            OR excluded.first_request_at < request_daily_buckets.first_request_at
          THEN excluded.first_request_at
          ELSE request_daily_buckets.first_request_at
        END,
        last_request_at = CASE
          WHEN request_daily_buckets.last_request_at IS NULL
            OR excluded.last_request_at > request_daily_buckets.last_request_at
          THEN excluded.last_request_at
          ELSE request_daily_buckets.last_request_at
        END,
        updated_at = excluded.updated_at;
    END;
  `);
}

function addColumnIfMissing(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
