use seller_server::secret::{
    assert_secret_versions, required_secrets_available, LocalSecretResolver, SecretResolver,
    SecretSourceRecord,
};
use std::collections::{HashMap, HashSet};

fn resolver() -> LocalSecretResolver {
    LocalSecretResolver::from_records(
        HashSet::from(["orders-api-v1".to_string()]),
        HashMap::from([(
            "orders-api-v1".to_string(),
            SecretSourceRecord {
                value: "private-provider-credential".to_string(),
                version: "2026-10-a".to_string(),
            },
        )]),
    )
    .unwrap()
}

#[test]
fn resolves_only_allowlisted_opaque_refs_without_debugging_the_value() {
    let resolved = resolver().resolve("orders-api-v1").unwrap();
    assert_eq!(resolved.version(), "2026-10-a");
    assert_eq!(resolved.expose(), "private-provider-credential");
    assert!(!format!("{resolved:?}").contains("private-provider-credential"));
    assert!(resolver().resolve("unknown-ref").is_err());
}

#[test]
fn missing_refs_and_missing_values_fail_closed() {
    assert!(LocalSecretResolver::from_records(
        HashSet::from(["orders-api-v1".to_string()]),
        HashMap::new(),
    )
    .unwrap()
    .resolve("orders-api-v1")
    .is_err());
    assert!(LocalSecretResolver::from_records(
        HashSet::from(["orders-api-v1".to_string()]),
        HashMap::from([(
            "orders-api-v1".to_string(),
            SecretSourceRecord {
                value: String::new(),
                version: "v1".to_string(),
            },
        )]),
    )
    .is_err());
}

#[test]
fn rotation_version_mismatch_never_reinterprets_existing_evidence() {
    let bindings = HashMap::from([("orders-api-v1".to_string(), "2026-09-z".to_string())]);
    let error = assert_secret_versions(&resolver(), &bindings).unwrap_err();
    assert_eq!(error.to_string(), "provider credential version mismatch");
    assert!(!error.to_string().contains("private-provider-credential"));
}

#[test]
fn source_records_reject_unknown_refs_and_invalid_versions() {
    assert!(LocalSecretResolver::from_records(
        HashSet::new(),
        HashMap::from([(
            "orders-api-v1".to_string(),
            SecretSourceRecord {
                value: "value".to_string(),
                version: "v1".to_string(),
            },
        )]),
    )
    .is_err());
    assert!(LocalSecretResolver::from_records(
        HashSet::from(["orders-api-v1".to_string()]),
        HashMap::from([(
            "orders-api-v1".to_string(),
            SecretSourceRecord {
                value: "value".to_string(),
                version: "bad version".to_string(),
            },
        )]),
    )
    .is_err());
}

#[test]
fn missing_required_secret_makes_provider_unavailable() {
    let resolver = LocalSecretResolver::from_records(
        HashSet::from(["orders-api-v1".to_string()]),
        HashMap::new(),
    )
    .unwrap();

    assert!(!required_secrets_available(
        &resolver,
        &["orders-api-v1".to_string()],
    ));
}
