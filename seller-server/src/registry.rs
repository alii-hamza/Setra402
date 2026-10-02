use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::OnceLock;

use crate::execute::hash_canonical;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServiceDefinition {
    pub id: String,
    pub name: String,
    pub capability: String,
    pub price_base_units: String,
    pub timeout_seconds: i64,
    pub verification_policy: Value,
}

static SERVICES: OnceLock<Vec<ServiceDefinition>> = OnceLock::new();

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
