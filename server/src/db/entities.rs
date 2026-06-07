pub mod api_keys {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "api_keys")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub tenant_id: Option<String>,
        pub name: String,
        pub key_hash: String,
        pub prefix: String,
        pub enabled: i32,
        pub scopes_json: String,
        pub model_allowlist_json: String,
        pub channel_allowlist_json: String,
        pub token_limit_daily: Option<i64>,
        pub rate_limit_per_minute: Option<i64>,
        pub expires_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        pub last_used_at: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod app_settings {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "app_settings")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub key: String,
        pub value: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod channels {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "channels")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub name: String,
        pub base_url: String,
        pub credential_id: Option<String>,
        pub enabled: i32,
        pub priority: i32,
        pub weight: i32,
        pub model_allowlist_json: String,
        pub status: String,
        pub health_score: i32,
        pub cooldown_until: Option<String>,
        pub last_error: Option<String>,
        pub last_used_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod codex_credentials {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "codex_credentials")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub label: String,
        pub email: String,
        pub account_id: String,
        pub plan_type: String,
        pub token_ciphertext: String,
        pub token_expires_at: Option<String>,
        pub enabled: i32,
        pub priority: i32,
        pub weight: i32,
        pub user_agent: Option<String>,
        pub upstream_transport: String,
        pub proxy_json: Option<String>,
        pub metadata_json: String,
        pub last_refresh_at: Option<String>,
        pub last_used_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod codex_quota_cache {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "codex_quota_cache")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub credential_id: String,
        pub status: String,
        pub cache_json: String,
        pub retrieved_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod oauth_pending_states {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "oauth_pending_states")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub state: String,
        pub provider: String,
        pub code_verifier: String,
        pub code_challenge: String,
        pub redirect_uri: String,
        pub created_at: String,
        pub expires_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod request_logs {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "request_logs")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub started_at: String,
        pub completed_at: String,
        pub method: String,
        pub path: String,
        pub request_type: String,
        pub stream: i32,
        pub model: String,
        pub status_code: i32,
        pub latency_ms: i64,
        pub api_key_id: Option<String>,
        pub api_key_prefix: Option<String>,
        pub channel_id: Option<String>,
        pub credential_id: Option<String>,
        pub prompt_tokens: i64,
        pub completion_tokens: i64,
        pub total_tokens: i64,
        pub error_code: Option<String>,
        pub error_message: Option<String>,
        pub request_body_text: Option<String>,
        pub upstream_body_text: Option<String>,
        pub timing_json: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod tenants {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "tenants")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub name: String,
        pub owner_email: String,
        pub enabled: i32,
        pub max_api_keys: Option<i64>,
        pub token_limit_daily: Option<i64>,
        pub rate_limit_per_minute: Option<i64>,
        pub model_allowlist_json: String,
        pub channel_allowlist_json: String,
        pub allow_custom_proxy: i32,
        pub allow_custom_user_agent: i32,
        pub proxy_json: Option<String>,
        pub user_agent: Option<String>,
        pub expires_at: Option<String>,
        pub metadata_json: String,
        pub created_at: String,
        pub updated_at: String,
        pub deleted_at: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod channel_credentials {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_credentials")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub channel_id: String,
        #[sea_orm(primary_key, auto_increment = false)]
        pub credential_id: String,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod proxy_pool {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "proxy_pool")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub name: String,
        pub r#type: String,
        pub host: String,
        pub port: i32,
        pub username: String,
        pub password_ciphertext: Option<String>,
        pub enabled: i32,
        pub notes: String,
        pub created_at: String,
        pub updated_at: String,
        pub last_used_at: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod tenant_users {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "tenant_users")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub tenant_id: String,
        pub email: String,
        pub display_name: String,
        pub role: String,
        pub enabled: i32,
        pub password_hash: Option<String>,
        pub last_login_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod tenant_invites {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "tenant_invites")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub tenant_id: String,
        pub user_id: String,
        pub email: String,
        pub token_hash: String,
        pub expires_at: String,
        pub accepted_at: Option<String>,
        pub revoked_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod request_log_details {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "request_log_details")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub request_log_id: String,
        pub created_at: String,
        pub updated_at: String,
        pub request_headers_json: Option<String>,
        pub request_body_text: Option<String>,
        pub forwarded_body_text: Option<String>,
        pub upstream_headers_json: Option<String>,
        pub upstream_body_text: Option<String>,
        pub error_details_json: Option<String>,
        pub stage_timings_json: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod usage_records {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "usage_records")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub request_log_id: Option<String>,
        pub api_key_id: Option<String>,
        pub api_key_prefix: Option<String>,
        pub api_key_name: Option<String>,
        pub tenant_id: Option<String>,
        pub tenant_name: Option<String>,
        pub channel_id: Option<String>,
        pub credential_id: Option<String>,
        pub model: String,
        pub request_type: String,
        pub prompt_tokens: i64,
        pub completion_tokens: i64,
        pub total_tokens: i64,
        pub cached_tokens: i64,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod channel_health_events {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_health_events")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub channel_id: String,
        pub credential_id: Option<String>,
        pub status: String,
        pub status_code: Option<i32>,
        pub message: Option<String>,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

#[allow(dead_code)]
pub mod audit_logs {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "audit_logs")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: String,
        pub actor_type: String,
        pub actor_id: Option<String>,
        pub operation: String,
        pub target_type: Option<String>,
        pub target_id: Option<String>,
        pub metadata_json: String,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
