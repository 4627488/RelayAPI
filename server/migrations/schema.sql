PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  max_api_keys INTEGER,
  token_limit_daily INTEGER,
  rate_limit_per_minute INTEGER,
  model_allowlist_json TEXT NOT NULL DEFAULT '[]',
  channel_allowlist_json TEXT NOT NULL DEFAULT '[]',
  allow_custom_proxy INTEGER NOT NULL DEFAULT 0,
  allow_custom_user_agent INTEGER NOT NULL DEFAULT 0,
  proxy_json TEXT,
  user_agent TEXT,
  expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'owner',
  enabled INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  scopes_json TEXT NOT NULL DEFAULT '["relay"]',
  model_allowlist_json TEXT NOT NULL DEFAULT '[]',
  channel_allowlist_json TEXT NOT NULL DEFAULT '[]',
  token_limit_daily INTEGER,
  rate_limit_per_minute INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS codex_credentials (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  plan_type TEXT NOT NULL DEFAULT '',
  token_ciphertext TEXT NOT NULL,
  token_expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  user_agent TEXT,
  upstream_transport TEXT NOT NULL DEFAULT 'http',
  proxy_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_refresh_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_id TEXT REFERENCES codex_credentials(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  weight INTEGER NOT NULL DEFAULT 1,
  model_allowlist_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'healthy',
  health_score INTEGER NOT NULL DEFAULT 100,
  cooldown_until TEXT,
  last_error TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_credentials (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES codex_credentials(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, credential_id)
);

CREATE TABLE IF NOT EXISTS proxy_pool (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_pending_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_quota_cache (
  credential_id TEXT PRIMARY KEY REFERENCES codex_credentials(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  cache_json TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_type TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  api_key_id TEXT,
  api_key_prefix TEXT,
  channel_id TEXT,
  credential_id TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  request_body_text TEXT,
  upstream_body_text TEXT,
  timing_json TEXT
);

CREATE TABLE IF NOT EXISTS request_log_details (
  request_log_id TEXT PRIMARY KEY REFERENCES request_logs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  request_headers_json TEXT,
  request_body_text TEXT,
  forwarded_body_text TEXT,
  upstream_headers_json TEXT,
  upstream_body_text TEXT,
  error_details_json TEXT,
  stage_timings_json TEXT
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  request_log_id TEXT,
  api_key_id TEXT,
  api_key_prefix TEXT,
  api_key_name TEXT,
  tenant_id TEXT,
  tenant_name TEXT,
  channel_id TEXT,
  credential_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  request_type TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily_buckets (
  day TEXT NOT NULL,
  api_key_id TEXT,
  tenant_id TEXT,
  model TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, api_key_id, tenant_id, model)
);

CREATE TABLE IF NOT EXISTS request_daily_buckets (
  day TEXT NOT NULL,
  api_key_id TEXT,
  tenant_id TEXT,
  status_code INTEGER NOT NULL DEFAULT 0,
  request_type TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, api_key_id, tenant_id, status_code, request_type)
);

CREATE TABLE IF NOT EXISTS channel_health_events (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  credential_id TEXT,
  status TEXT NOT NULL,
  status_code INTEGER,
  message TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  operation TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_channels_routing ON channels(enabled, status, priority, weight);
CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_expires ON oauth_pending_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_started ON request_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key ON request_logs(api_key_id, started_at);
CREATE INDEX IF NOT EXISTS idx_proxy_pool_enabled ON proxy_pool(enabled, updated_at);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant ON tenant_invites(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_api_key ON usage_records(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_tenant ON usage_records(tenant_id, created_at);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (1, 'initial_rust_rewrite_schema');
