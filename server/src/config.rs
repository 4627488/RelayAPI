use std::{env, path::PathBuf, time::Duration};

use anyhow::Context;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    pub static_dir: Option<PathBuf>,
    pub database_url: String,
    pub codex_base_url: String,
    pub codex_redirect_uri: String,
    pub codex_default_model: String,
    pub codex_user_agent: String,
    pub codex_originator: String,
    pub request_timeout: Duration,
    pub stream_timeout: Duration,
    pub secure_cookies: bool,
    pub cors_allowed_origins: Vec<String>,
    pub secret: String,
    pub web_access_key_hash: String,
    pub web_session_token: String,
    pub generated_web_access_key: Option<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let data_dir = PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "data".to_string()));
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("create {}", data_dir.display()))?;
        let db_path = env::var("RELAY_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("relay.sqlite"));

        let secret = resolve_secret(&data_dir)?;
        let web_key = resolve_web_access_key(&data_dir)?;
        let web_session_token = sha256_hex(format!("{}:{}", secret, web_key.hash).as_bytes());

        Ok(Self {
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3000),
            data_dir,
            static_dir: env::var("RELAY_STATIC_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from),
            database_url: sqlite_url(db_path),
            codex_base_url: env::var("CODEX_BASE_URL")
                .unwrap_or_else(|_| "https://chatgpt.com/backend-api/codex".to_string())
                .trim_end_matches('/')
                .to_string(),
            codex_redirect_uri: env::var("CODEX_REDIRECT_URI")
                .unwrap_or_else(|_| "http://localhost:1455/auth/callback".to_string()),
            codex_default_model: env::var("CODEX_DEFAULT_MODEL")
                .unwrap_or_else(|_| "gpt-5.3-codex".to_string()),
            codex_user_agent: env::var("CODEX_USER_AGENT").unwrap_or_else(|_| {
                "codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9".to_string()
            }),
            codex_originator: env::var("CODEX_ORIGINATOR")
                .unwrap_or_else(|_| "codex_cli_rs".to_string()),
            request_timeout: Duration::from_millis(env_ms("REQUEST_TIMEOUT_MS", 300_000)),
            stream_timeout: Duration::from_millis(env_ms("STREAM_REQUEST_TIMEOUT_MS", 1_800_000)),
            secure_cookies: env_bool("RELAY_COOKIE_SECURE", true),
            cors_allowed_origins: env::var("RELAY_CORS_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect(),
            secret,
            web_access_key_hash: web_key.hash,
            web_session_token,
            generated_web_access_key: web_key.generated,
        })
    }
}

fn env_bool(name: &str, fallback: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(fallback)
}

struct WebAccessKey {
    hash: String,
    generated: Option<String>,
}

fn sqlite_url(path: PathBuf) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        path.to_string_lossy().replace('\\', "/")
    )
}

fn env_ms(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(fallback)
}

fn resolve_secret(data_dir: &std::path::Path) -> anyhow::Result<String> {
    if let Ok(value) = env::var("RELAY_ENCRYPTION_KEY").or_else(|_| env::var("RELAY_SECRET")) {
        if !value.trim().is_empty() {
            return Ok(value.trim().to_string());
        }
    }
    let path = data_dir.join(".relay-secret");
    if path.exists() {
        let value = std::fs::read_to_string(&path)?.trim().to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let value = random_urlsafe(32);
    std::fs::write(&path, format!("{value}\n"))?;
    Ok(value)
}

fn resolve_web_access_key(data_dir: &std::path::Path) -> anyhow::Result<WebAccessKey> {
    if let Ok(value) = env::var("RELAY_WEB_ACCESS_KEY").or_else(|_| env::var("WEB_ACCESS_KEY")) {
        if !value.trim().is_empty() {
            return Ok(WebAccessKey {
                hash: sha256_hex(value.trim().as_bytes()),
                generated: None,
            });
        }
    }
    let path = data_dir.join(".relay-web-access-key.sha256");
    if path.exists() {
        let hash = std::fs::read_to_string(&path)?.trim().to_string();
        if !hash.is_empty() {
            return Ok(WebAccessKey {
                hash,
                generated: None,
            });
        }
    }
    let key = format!("relay_web_{}", random_urlsafe(32));
    let hash = sha256_hex(key.as_bytes());
    std::fs::write(&path, format!("{hash}\n"))?;
    Ok(WebAccessKey {
        hash,
        generated: Some(key),
    })
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn sha256_hex(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}
