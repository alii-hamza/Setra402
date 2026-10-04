use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

use crate::execute::hash_canonical;
use crate::provider::{provider_definitions, ProviderDefinitionV1};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceDefinition {
    pub id: String,
    pub name: String,
    pub capability: String,
    pub price_base_units: String,
    pub timeout_seconds: i64,
    pub verification_policy: Value,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_exposure")]
    pub exposure: String,
    #[serde(default = "default_privacy")]
    pub privacy_support: bool,
    #[serde(default)]
    pub provider_connector_ref: String,
    #[serde(default = "default_provider_type")]
    pub provider_type: String,
    #[serde(default)]
    pub policy_hash: String,
    #[serde(skip)]
    pub is_local: bool,
}
fn default_exposure() -> String {
    "both".into()
}
fn default_privacy() -> bool {
    true
}
fn default_provider_type() -> String {
    "LOCAL_FIXTURE".into()
}

pub fn load_services(
    overlay: Option<&std::path::Path>,
    price: u64,
    timeout: i64,
) -> Vec<ServiceDefinition> {
    let mut baseline = services().to_vec();
    for service in &mut baseline {
        service.price_base_units = price.to_string();
        service.timeout_seconds = timeout;
        service.description = service.name.clone();
        service.provider_connector_ref = if service.id == "lead-scraper-demo" {
            "fixture-lead"
        } else {
            "fixture-echo"
        }
        .into();
        service.provider_type = profile_definition(&service.provider_connector_ref)
            .expect("baseline provider profile")
            .connector_type
            .as_str()
            .into();
        service.policy_hash = policy_hash(service);
    }
    let Some(path) = overlay else {
        return baseline;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return baseline;
    };
    if bytes.len() > 1_048_576 {
        return baseline;
    }
    let Ok(mut local) = serde_json::from_slice::<Vec<ServiceDefinition>>(&bytes) else {
        return baseline;
    };
    if local.len() > 500 {
        return baseline;
    }
    let mut ids: std::collections::HashSet<String> =
        baseline.iter().map(|s| s.id.clone()).collect();
    for service in &mut local {
        let price = service.price_base_units.parse::<u64>().unwrap_or(0);
        let policy = hash_canonical(&service.verification_policy);
        if !ids.insert(service.id.clone())
            || service.id.is_empty()
            || service.id.len() > 64
            || service.id.starts_with('-')
            || service.id.ends_with('-')
            || service.id.contains("--")
            || !service
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || service.name.trim().is_empty()
            || price == 0
            || !(5..=3600).contains(&service.timeout_seconds)
            || !["rest", "mcp", "both"].contains(&service.exposure.as_str())
            || !profile_definition(&service.provider_connector_ref).is_some_and(|profile| {
                profile.active
                    && profile.capabilities.contains(&service.capability)
                    && (!service.privacy_support || profile.privacy_support)
            })
            || !matches!(service.verification_policy["level"].as_u64(), Some(1 | 2))
            || policy.as_ref().ok() != Some(&service.policy_hash)
        {
            return baseline;
        }
        service.is_local = true;
    }
    baseline.extend(local);
    baseline
}

static SERVICES: OnceLock<Vec<ServiceDefinition>> = OnceLock::new();

pub fn profile_definition(profile_id: &str) -> Option<&'static ProviderDefinitionV1> {
    provider_definitions()
        .iter()
        .find(|profile| profile.provider_id == profile_id)
}

pub fn services() -> &'static [ServiceDefinition] {
    SERVICES
        .get_or_init(|| {
            serde_json::from_str(include_str!("../config/services.json"))
                .expect("checked-in service registry must be valid JSON")
        })
        .as_slice()
}

pub fn find_service(id: &str) -> Option<&'static ServiceDefinition> {
    services().iter().find(|service| service.id == id)
}

pub fn policy_hash(service: &ServiceDefinition) -> String {
    hash_canonical(&service.verification_policy)
        .expect("checked-in verification policies must use canonical V1 values")
}

#[cfg(test)]
mod overlay_tests {
    use super::*;
    fn local() -> Value {
        let mut service = serde_json::to_value(&services()[0]).unwrap();
        service["id"] = Value::String("overlay-service".into());
        service["description"] = Value::String("Local fixture".into());
        service["provider_connector_ref"] = Value::String("fixture-echo".into());
        service["policy_hash"] = Value::String(policy_hash(&services()[0]));
        service
    }
    fn check(value: Value) -> Vec<ServiceDefinition> {
        let path = std::env::temp_dir().join(format!(
            "setra-overlay-{}.json",
            solana_pubkey::Pubkey::new_unique()
        ));
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let result = load_services(Some(&path), 99, 17);
        std::fs::remove_file(path).unwrap();
        result
    }
    #[test]
    fn merges_without_mutating_baseline() {
        let result = check(serde_json::json!([local()]));
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].price_base_units, "99");
        assert_eq!(services()[0].price_base_units, "1500000");
        assert!(result[2].is_local);
    }
    #[test]
    fn duplicate_baseline_fails_closed() {
        let mut service = local();
        service["id"] = Value::String("legacy-rest".into());
        assert_eq!(check(serde_json::json!([service])).len(), 2);
    }
    #[test]
    fn duplicate_local_fails_closed() {
        assert_eq!(check(serde_json::json!([local(), local()])).len(), 2);
    }
    #[test]
    fn malformed_overlay_keeps_baseline() {
        assert_eq!(check(serde_json::json!({"bad":true})).len(), 2);
    }
    #[test]
    fn policy_hash_mismatch_fails_closed() {
        let mut service = local();
        service["policy_hash"] = Value::String("0".repeat(64));
        assert_eq!(check(serde_json::json!([service])).len(), 2);
    }
    #[test]
    fn shell_configuration_fails_closed() {
        let mut service = local();
        service["command"] = Value::String("bash".into());
        assert_eq!(check(serde_json::json!([service])).len(), 2);
    }
}
