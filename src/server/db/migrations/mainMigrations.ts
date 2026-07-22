import type { SqliteDatabase } from "@/src/server/db/sqlite";
import { migrateChannelCredentialRelation } from "@/src/server/db/migrations/channelCredentialRelation";

export function migrateMainDb(db: SqliteDatabase) {
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

  applyMigration(db, "013_tenant_subscriptions", (database) => {
    database.exec(`
      DROP TABLE IF EXISTS quota_reservations;
      DROP TABLE IF EXISTS tenant_quota_windows;
      CREATE TABLE tenant_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        name TEXT NOT NULL,
        units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
        units_per_credential INTEGER NOT NULL DEFAULT 20 CHECK (units_per_credential > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        starts_at TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_tenant_subscriptions_tenant ON tenant_subscriptions(tenant_id, enabled);
      CREATE INDEX idx_tenant_subscriptions_credential ON tenant_subscriptions(credential_id, enabled);
      CREATE TABLE subscription_quota_windows (
        subscription_id TEXT NOT NULL,
        window_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        resets_at TEXT NOT NULL,
        limit_nano_usd TEXT NOT NULL,
        settled_nano_usd TEXT NOT NULL DEFAULT '0',
        reserved_nano_usd TEXT NOT NULL DEFAULT '0',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, window_kind)
      ) STRICT;
      CREATE INDEX idx_subscription_quota_windows_reset ON subscription_quota_windows(resets_at);
      CREATE TABLE quota_reservations (
        request_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        reserve_nano_usd TEXT NOT NULL,
        actual_nano_usd TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settled_at TEXT
      ) STRICT;
      CREATE INDEX idx_quota_reservations_subscription_status ON quota_reservations(subscription_id, status);
    `);
  });

  applyMigration(db, "014_fractional_subscription_units", (database) => {
    database.exec(`
      DROP INDEX IF EXISTS idx_tenant_subscriptions_tenant;
      DROP INDEX IF EXISTS idx_tenant_subscriptions_credential;
      ALTER TABLE tenant_subscriptions RENAME TO tenant_subscriptions_integer_units;
      CREATE TABLE tenant_subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        name TEXT NOT NULL,
        units REAL NOT NULL DEFAULT 1 CHECK (units > 0),
        units_per_credential INTEGER NOT NULL DEFAULT 20 CHECK (units_per_credential > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        starts_at TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO tenant_subscriptions (
        id, tenant_id, credential_id, name, units, units_per_credential,
        enabled, priority, starts_at, expires_at, created_at, updated_at
      )
      SELECT
        id, tenant_id, credential_id, name, CAST(units AS REAL), units_per_credential,
        enabled, priority, starts_at, expires_at, created_at, updated_at
      FROM tenant_subscriptions_integer_units;
      DROP TABLE tenant_subscriptions_integer_units;
      CREATE INDEX idx_tenant_subscriptions_tenant ON tenant_subscriptions(tenant_id, enabled);
      CREATE INDEX idx_tenant_subscriptions_credential ON tenant_subscriptions(credential_id, enabled);
    `);
  });

  applyMigration(db, "015_oidc_provider", `
    CREATE TABLE oidc_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      nonce TEXT,
      code_challenge TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_oidc_authorization_codes_expiry
      ON oidc_authorization_codes(expires_at);
  `);

  applyMigration(db, "016_credential_quota_reset_events", `
    CREATE TABLE credential_quota_reset_events (
      id TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      previous_resets_at TEXT,
      next_resets_at TEXT,
      previous_used_percent REAL,
      windows_reset INTEGER,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_credential_quota_reset_events_credential
      ON credential_quota_reset_events(credential_id, occurred_at);
  `);

  applyMigration(db, "017_channel_credential_relation", migrateChannelCredentialRelation);

  applyMigration(db, "018_subscription_estimated_quota", (database) => {
    addColumnIfMissing(database, "tenant_subscriptions", "estimated_5h_nano_usd", "TEXT");
    addColumnIfMissing(database, "tenant_subscriptions", "estimated_7d_nano_usd", "TEXT");
  });

  applyMigration(db, "019_subscription_user_ownership", (database) => {
    addColumnIfMissing(database, "tenant_subscriptions", "tenant_user_id", "TEXT");
    database.exec(`
      UPDATE tenant_subscriptions
      SET tenant_user_id = (
        SELECT tenant_users.id
        FROM tenant_users
        WHERE tenant_users.tenant_id = tenant_subscriptions.tenant_id
          AND tenant_users.role = 'owner'
        ORDER BY tenant_users.created_at ASC
        LIMIT 1
      )
      WHERE tenant_user_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_user
        ON tenant_subscriptions(tenant_user_id, enabled);
    `);
  });

  applyMigration(db, "020_parent_subscription_quota_estimates", (database) => {
    dropColumnIfPresent(database, "tenant_subscriptions", "estimated_5h_nano_usd");
    dropColumnIfPresent(database, "tenant_subscriptions", "estimated_7d_nano_usd");
  });
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
  if (db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(name)) return;
  db.exec("BEGIN");
  try {
    if (typeof migration === "string") db.exec(migration);
    else migration(db);
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run(name, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function addColumnIfMissing(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function dropColumnIfPresent(
  db: SqliteDatabase,
  tableName: string,
  columnName: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
  }
}
