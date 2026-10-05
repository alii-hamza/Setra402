//! Durable provider dispatch identity and bounded observations. The dispatch
//! intent is created before network I/O and is never replaced by a new identity.
use crate::execute::hash_canonical;
use crate::provider_connector::ProviderObservationV1;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderDispatchIntentV1 {
    pub version: u8,
    pub provider_id: String,
    pub connector_type: String,
    pub execution_profile: String,
    pub execution_identity: String,
    pub task_state_pda: String,
    pub task_id: String,
    pub service_id: String,
    pub input_hash: String,
    pub secret_versions: std::collections::HashMap<String, String>,
    pub state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProviderObservationRecordV1 {
    pub version: u8,
    pub intent_commitment: String,
    pub observation: ProviderObservationV1,
}

pub fn paths(directory: &Path, task_key: &str) -> (PathBuf, PathBuf) {
    (
        directory.join(format!("{task_key}.provider-intent")),
        directory.join(format!("{task_key}.provider-observation")),
    )
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn hex_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_intent(intent: &ProviderDispatchIntentV1) -> io::Result<()> {
    if intent.version != 1
        || intent.state != "UNKNOWN_EXTERNAL_EFFECT"
        || intent.provider_id.is_empty()
        || intent.execution_profile.is_empty()
        || !matches!(
            intent.connector_type.as_str(),
            "LOCAL_FIXTURE" | "REST_API" | "MCP_TOOL"
        )
        || !hex_hash(&intent.execution_identity)
        || !hex_hash(&intent.input_hash)
        || intent.task_state_pda.is_empty()
        || intent.task_id.parse::<u64>().is_err()
        || intent.service_id.is_empty()
        || intent
            .secret_versions
            .iter()
            .any(|(secret_ref, version)| secret_ref.is_empty() || version.is_empty())
    {
        return Err(invalid("invalid provider dispatch intent"));
    }
    Ok(())
}

fn intent_commitment(intent: &ProviderDispatchIntentV1) -> io::Result<String> {
    hash_canonical(&serde_json::to_value(intent).map_err(|_| invalid("provider intent encoding"))?)
        .map_err(invalid)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn claim(path: &Path, intent: &ProviderDispatchIntentV1) -> io::Result<()> {
    validate_intent(intent)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("provider store parent missing"))?;
    fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec(intent).map_err(|_| invalid("provider intent encoding"))?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    sync_directory(parent)
}

pub fn load_intent(path: &Path) -> io::Result<Option<ProviderDispatchIntentV1>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if bytes.len() > 64 * 1024 {
        return Err(invalid("provider intent too large"));
    }
    let intent = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("malformed provider dispatch intent"))?;
    validate_intent(&intent)?;
    Ok(Some(intent))
}

fn validate_observation(observation: &ProviderObservationV1) -> io::Result<()> {
    if !matches!(
        observation.status.as_str(),
        "PENDING" | "SUCCEEDED" | "FAILED"
    ) || !hex_hash(&observation.response_commitment)
        || observation
            .receipt_hash
            .as_deref()
            .is_some_and(|value| !hex_hash(value))
        || observation.observed_at_unix < 0
        || (observation.status == "SUCCEEDED") != observation.result.is_some()
        || observation
            .result
            .as_ref()
            .is_some_and(|value| hash_canonical(value).is_err())
    {
        return Err(invalid("invalid provider observation"));
    }
    Ok(())
}

pub fn complete(
    path: &Path,
    intent: &ProviderDispatchIntentV1,
    observation: &ProviderObservationV1,
) -> io::Result<()> {
    validate_intent(intent)?;
    validate_observation(observation)?;
    if intent.secret_versions != observation.secret_versions {
        return Err(invalid("provider credential version mismatch"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("provider store parent missing"))?;
    fs::create_dir_all(parent)?;
    let record = ProviderObservationRecordV1 {
        version: 1,
        intent_commitment: intent_commitment(intent)?,
        observation: observation.clone(),
    };
    let bytes =
        serde_json::to_vec(&record).map_err(|_| invalid("provider observation encoding"))?;
    if bytes.len() > 1_048_576 {
        return Err(invalid("provider observation too large"));
    }
    let temporary = path.with_extension(format!("provider.tmp.{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    sync_directory(parent)?;
    let loaded = load_observation(path, intent)?
        .ok_or_else(|| invalid("provider observation disappeared"))?;
    if loaded != *observation {
        return Err(invalid("provider observation read-back mismatch"));
    }
    Ok(())
}

pub fn load_observation(
    path: &Path,
    intent: &ProviderDispatchIntentV1,
) -> io::Result<Option<ProviderObservationV1>> {
    validate_intent(intent)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if bytes.len() > 1_048_576 {
        return Err(invalid("provider observation too large"));
    }
    let record: ProviderObservationRecordV1 =
        serde_json::from_slice(&bytes).map_err(|_| invalid("malformed provider observation"))?;
    if record.version != 1 || record.intent_commitment != intent_commitment(intent)? {
        return Err(invalid("provider observation binding mismatch"));
    }
    validate_observation(&record.observation)?;
    if record.observation.secret_versions != intent.secret_versions {
        return Err(invalid("provider credential version mismatch"));
    }
    Ok(Some(record.observation))
}

pub fn bounded_evidence(observation: &ProviderObservationV1) -> Value {
    serde_json::json!({
        "type":"provider_execution",
        "execution_id":observation.execution_id,
        "status":observation.status,
        "receipt_hash":observation.receipt_hash,
        "response_commitment":observation.response_commitment,
        "observed_at_unix":observation.observed_at_unix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn directory() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "setra-provider-store-{}-{}",
            std::process::id(),
            solana_pubkey::Pubkey::new_unique()
        ));
        fs::create_dir(&directory).unwrap();
        directory
    }

    fn intent() -> ProviderDispatchIntentV1 {
        ProviderDispatchIntentV1 {
            version: 1,
            provider_id: "rest-orders".into(),
            connector_type: "REST_API".into(),
            execution_profile: "rest-orders-v1".into(),
            execution_identity: "a".repeat(64),
            task_state_pda: "task-pda".into(),
            task_id: "7".into(),
            service_id: "orders".into(),
            input_hash: "b".repeat(64),
            secret_versions: HashMap::from([("orders-token".into(), "v1".into())]),
            state: "UNKNOWN_EXTERNAL_EFFECT".into(),
        }
    }

    fn observation() -> ProviderObservationV1 {
        ProviderObservationV1 {
            execution_id: Some("execution-7".into()),
            status: "SUCCEEDED".into(),
            result: Some(serde_json::json!({"ok":true})),
            receipt_hash: Some("c".repeat(64)),
            response_commitment: "d".repeat(64),
            observed_at_unix: 7,
            secret_versions: HashMap::from([("orders-token".into(), "v1".into())]),
        }
    }

    #[test]
    fn persists_exact_dispatch_and_observation_across_restart() {
        let directory = directory();
        let (intent_path, observation_path) = paths(&directory, "task");
        let intent = intent();
        claim(&intent_path, &intent).unwrap();
        complete(&observation_path, &intent, &observation()).unwrap();
        let loaded_intent = load_intent(&intent_path).unwrap().unwrap();
        assert_eq!(loaded_intent, intent);
        assert_eq!(
            load_observation(&observation_path, &loaded_intent)
                .unwrap()
                .unwrap(),
            observation()
        );
        assert!(claim(&intent_path, &intent).is_err());
    }

    #[test]
    fn changed_binding_corruption_and_rotation_fail_closed() {
        let directory = directory();
        let (intent_path, observation_path) = paths(&directory, "task");
        let original = intent();
        claim(&intent_path, &original).unwrap();
        complete(&observation_path, &original, &observation()).unwrap();
        let mut changed = original.clone();
        changed.provider_id = "other-provider".into();
        assert!(load_observation(&observation_path, &changed).is_err());
        let mut rotated = observation();
        rotated
            .secret_versions
            .insert("orders-token".into(), "v2".into());
        assert!(complete(&directory.join("rotated"), &original, &rotated).is_err());
        fs::write(&observation_path, b"{}").unwrap();
        assert!(load_observation(&observation_path, &original).is_err());
    }
}
