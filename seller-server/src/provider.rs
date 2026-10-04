use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConnectorType {
    LocalFixture,
    RestApi,
    McpTool,
}

impl ConnectorType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LocalFixture => "LOCAL_FIXTURE",
            Self::RestApi => "REST_API",
            Self::McpTool => "MCP_TOOL",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IdempotencySupport {
    None,
    Keyed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryCapabilitiesV1 {
    pub idempotency: IdempotencySupport,
    pub execution_id: bool,
    pub status_query: bool,
    pub durable_receipt: bool,
    pub deterministic_replay: bool,
    pub may_produce_non_idempotent_external_effect: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDefinitionV1 {
    pub version: String,
    pub provider_id: String,
    pub display_name: String,
    pub connector_type: ConnectorType,
    pub execution_profile: String,
    pub capabilities: Vec<String>,
    pub privacy_support: bool,
    pub active: bool,
    pub recovery_capabilities: RecoveryCapabilitiesV1,
    pub secret_refs: Vec<String>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn capability(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !value.ends_with(['.', '-'])
        && !value.contains("..")
        && !value.contains("--")
}

impl ProviderDefinitionV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != "1" {
            return Err("unknown provider definition version");
        }
        if !identifier(&self.provider_id) || !identifier(&self.execution_profile) {
            return Err("invalid provider identifier");
        }
        if self.display_name.trim().is_empty() || self.display_name.len() > 120 {
            return Err("invalid provider display name");
        }
        if self.capabilities.is_empty()
            || self.capabilities.len() > 100
            || self.capabilities.iter().any(|value| !capability(value))
            || self.capabilities.iter().collect::<HashSet<_>>().len() != self.capabilities.len()
        {
            return Err("invalid provider capabilities");
        }
        if self.secret_refs.len() > 16
            || self.secret_refs.iter().any(|value| !identifier(value))
            || self.secret_refs.iter().collect::<HashSet<_>>().len() != self.secret_refs.len()
        {
            return Err("invalid provider secret refs");
        }
        let recovery = &self.recovery_capabilities;
        if recovery.status_query && !recovery.execution_id {
            return Err("status query requires execution ID");
        }
        if recovery.durable_receipt && !recovery.execution_id && !recovery.deterministic_replay {
            return Err("durable receipt requires execution ID or deterministic replay");
        }
        if recovery.deterministic_replay && recovery.idempotency != IdempotencySupport::Keyed {
            return Err("deterministic replay requires keyed idempotency");
        }
        if recovery.deterministic_replay && recovery.may_produce_non_idempotent_external_effect {
            return Err("non-idempotent effect cannot claim deterministic replay");
        }
        Ok(())
    }
}

pub fn parse_provider_definitions(bytes: &[u8]) -> Result<Vec<ProviderDefinitionV1>, &'static str> {
    let definitions: Vec<ProviderDefinitionV1> =
        serde_json::from_slice(bytes).map_err(|_| "invalid provider registry JSON")?;
    if definitions.len() > 500 {
        return Err("provider registry capacity exceeded");
    }
    let mut ids = HashSet::new();
    for definition in &definitions {
        definition.validate()?;
        if !ids.insert(definition.provider_id.as_str()) {
            return Err("duplicate provider ID");
        }
    }
    Ok(definitions)
}

pub fn load_provider_definitions(
    path: Option<&Path>,
) -> Result<Vec<ProviderDefinitionV1>, &'static str> {
    match path {
        Some(path) => {
            let bytes = std::fs::read(path).map_err(|_| "provider registry unavailable")?;
            if bytes.len() > 1_048_576 {
                return Err("provider registry too large");
            }
            parse_provider_definitions(&bytes)
        }
        None => parse_provider_definitions(include_bytes!("../config/provider-profiles.json")),
    }
}

pub fn provider_definitions() -> &'static [ProviderDefinitionV1] {
    static DEFINITIONS: OnceLock<Vec<ProviderDefinitionV1>> = OnceLock::new();
    DEFINITIONS
        .get_or_init(|| load_provider_definitions(None).expect("checked-in provider definitions"))
        .as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definition() -> serde_json::Value {
        json!({
            "version":"1",
            "provider_id":"rest-orders",
            "display_name":"REST orders",
            "connector_type":"REST_API",
            "execution_profile":"orders-v1",
            "capabilities":["orders.create"],
            "privacy_support":false,
            "active":true,
            "recovery_capabilities":{
                "idempotency":"KEYED",
                "execution_id":true,
                "status_query":true,
                "durable_receipt":true,
                "deterministic_replay":true,
                "may_produce_non_idempotent_external_effect":false
            },
            "secret_refs":["orders-api-v1"]
        })
    }

    #[test]
    fn checked_in_fixture_contracts_are_valid() {
        let definitions = provider_definitions();
        assert_eq!(definitions.len(), 4);
        assert!(definitions.iter().all(|definition| {
            definition.active
                && definition.connector_type == ConnectorType::LocalFixture
                && definition.secret_refs.is_empty()
        }));
    }

    #[test]
    fn versions_types_ids_duplicates_and_combinations_fail_closed() {
        for (field, value) in [
            ("version", json!("2")),
            ("provider_id", json!("Bad Provider")),
            ("connector_type", json!("SHELL")),
        ] {
            let mut invalid = definition();
            invalid[field] = value;
            assert!(
                parse_provider_definitions(&serde_json::to_vec(&vec![invalid]).unwrap()).is_err()
            );
        }
        assert!(parse_provider_definitions(
            &serde_json::to_vec(&vec![definition(), definition()]).unwrap()
        )
        .is_err());
        let mut invalid = definition();
        invalid["recovery_capabilities"]["execution_id"] = json!(false);
        assert!(parse_provider_definitions(&serde_json::to_vec(&vec![invalid]).unwrap()).is_err());
    }
}
