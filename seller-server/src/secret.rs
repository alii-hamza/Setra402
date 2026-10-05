//! Narrow local/hackathon secret resolution. This is not a production KMS.
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;
use zeroize::Zeroize;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretSourceRecord {
    pub value: String,
    pub version: String,
}

impl Drop for SecretSourceRecord {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretFileV1 {
    version: String,
    secrets: HashMap<String, SecretSourceRecord>,
}

pub struct SecretValue {
    value: String,
    version: String,
}

impl SecretValue {
    pub fn expose(&self) -> &str {
        &self.value
    }
    pub fn version(&self) -> &str {
        &self.version
    }
}

impl fmt::Debug for SecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecretValue")
            .field("value", &"<redacted>")
            .field("version", &self.version)
            .finish()
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretError(&'static str);

impl fmt::Display for SecretError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for SecretError {}

pub trait SecretResolver: Send + Sync {
    fn resolve(&self, secret_ref: &str) -> Result<SecretValue, SecretError>;
}

#[derive(Clone)]
pub struct LocalSecretResolver {
    allowed: HashSet<String>,
    records: HashMap<String, SecretSourceRecord>,
}

fn valid_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn env_key(secret_ref: &str, version: bool) -> String {
    let name = secret_ref.to_ascii_uppercase().replace('-', "_");
    if version {
        format!("SETRA_PROVIDER_SECRET_{name}_VERSION")
    } else {
        format!("SETRA_PROVIDER_SECRET_{name}")
    }
}

impl LocalSecretResolver {
    pub fn empty() -> Self {
        Self {
            allowed: HashSet::new(),
            records: HashMap::new(),
        }
    }

    pub fn from_records(
        allowed: HashSet<String>,
        records: HashMap<String, SecretSourceRecord>,
    ) -> Result<Self, SecretError> {
        if allowed.iter().any(|secret_ref| !valid_ref(secret_ref))
            || records
                .keys()
                .any(|secret_ref| !allowed.contains(secret_ref))
            || records.values().any(|record| {
                record.value.is_empty()
                    || record.value.len() > 16_384
                    || !valid_version(&record.version)
            })
        {
            return Err(SecretError("invalid provider secret configuration"));
        }
        Ok(Self { allowed, records })
    }

    pub fn from_env_and_file(
        allowed: HashSet<String>,
        file: Option<&Path>,
    ) -> Result<Self, SecretError> {
        let mut records = if let Some(path) = file {
            let bytes =
                std::fs::read(path).map_err(|_| SecretError("provider secret file unavailable"))?;
            if bytes.len() > 1_048_576 {
                return Err(SecretError("provider secret file too large"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(path)
                    .map_err(|_| SecretError("provider secret file unavailable"))?
                    .permissions()
                    .mode();
                if mode & 0o077 != 0 {
                    return Err(SecretError(
                        "provider secret file permissions are too broad",
                    ));
                }
            }
            let parsed: SecretFileV1 = serde_json::from_slice(&bytes)
                .map_err(|_| SecretError("invalid provider secret file"))?;
            if parsed.version != "1" {
                return Err(SecretError("unknown provider secret file version"));
            }
            parsed.secrets
        } else {
            HashMap::new()
        };

        for secret_ref in &allowed {
            let value = std::env::var(env_key(secret_ref, false)).ok();
            let version = std::env::var(env_key(secret_ref, true)).ok();
            match (value, version) {
                (None, None) => {}
                (Some(value), Some(version)) => {
                    if records.contains_key(secret_ref) {
                        return Err(SecretError("duplicate provider secret source"));
                    }
                    records.insert(secret_ref.clone(), SecretSourceRecord { value, version });
                }
                _ => return Err(SecretError("incomplete provider secret environment")),
            }
        }
        Self::from_records(allowed, records)
    }
}

impl SecretResolver for LocalSecretResolver {
    fn resolve(&self, secret_ref: &str) -> Result<SecretValue, SecretError> {
        if !self.allowed.contains(secret_ref) {
            return Err(SecretError("provider secret ref is not allowlisted"));
        }
        let record = self
            .records
            .get(secret_ref)
            .ok_or(SecretError("required provider secret is unavailable"))?;
        Ok(SecretValue {
            value: record.value.clone(),
            version: record.version.clone(),
        })
    }
}

pub fn required_secrets_available(resolver: &dyn SecretResolver, refs: &[String]) -> bool {
    refs.iter()
        .all(|secret_ref| resolver.resolve(secret_ref).is_ok())
}

pub fn secret_version_bindings(
    resolver: &dyn SecretResolver,
    refs: &[String],
) -> Result<HashMap<String, String>, SecretError> {
    refs.iter()
        .map(|secret_ref| {
            resolver
                .resolve(secret_ref)
                .map(|value| (secret_ref.clone(), value.version().to_string()))
        })
        .collect()
}

pub fn assert_secret_versions(
    resolver: &dyn SecretResolver,
    expected: &HashMap<String, String>,
) -> Result<(), SecretError> {
    for (secret_ref, version) in expected {
        if resolver.resolve(secret_ref)?.version() != version {
            return Err(SecretError("provider credential version mismatch"));
        }
    }
    Ok(())
}
