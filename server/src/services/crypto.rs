use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

#[derive(Serialize, Deserialize)]
struct Envelope {
    v: u8,
    nonce: String,
    ciphertext: String,
}

pub fn hash_secret(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn encrypt_json(secret: &str, value: &Value) -> AppResult<String> {
    let plaintext = serde_json::to_vec(value).map_err(anyhow::Error::from)?;
    let key = Sha256::digest(secret.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| {
        AppError::bad_request("invalid_secret", "Invalid RelayAPI encryption secret")
    })?;
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| AppError::bad_request("encryption_failed", "Failed to encrypt value"))?;
    Ok(serde_json::to_string(&Envelope {
        v: 1,
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
    .map_err(anyhow::Error::from)?)
}

pub fn decrypt_json(secret: &str, envelope: &str) -> AppResult<Value> {
    let envelope: Envelope = serde_json::from_str(envelope).map_err(anyhow::Error::from)?;
    let nonce = URL_SAFE_NO_PAD
        .decode(envelope.nonce)
        .map_err(anyhow::Error::from)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(envelope.ciphertext)
        .map_err(anyhow::Error::from)?;
    let key = Sha256::digest(secret.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| {
        AppError::bad_request("invalid_secret", "Invalid RelayAPI encryption secret")
    })?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| AppError::bad_request("decryption_failed", "Failed to decrypt value"))?;
    Ok(serde_json::from_slice(&plaintext).map_err(anyhow::Error::from)?)
}
