//! MVP stand-in for real compute (architecture doc, Section 3.2). Hashes a
//! canonical form of the task input rather than doing real work, so the
//! verifier can recompute the exact same result independently without the
//! two of them needing to agree on anything more complicated than "SHA-256
//! of this JSON."
//!
//! This depends on one property of `serde_json::Value`: as long as nothing
//! in the dependency tree enables its `preserve_order` feature, its object
//! type is backed by a `BTreeMap`, so `to_string()` always emits keys in
//! sorted order — no hand-written canonicalizer needed on this side. The
//! TypeScript verifier has to reproduce that sorted-key ordering itself
//! (recursive key sort before `JSON.stringify`) for the hashes to match.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn execute_task(input: &Value) -> String {
    // Reject floating-point numbers to prevent cross-language hash mismatches
    // (Rust serde_json vs JavaScript JSON.stringify handle floats differently)
    if contains_floats(input) {
        panic!("floating-point numbers not supported in task input");
    }
    
    let canonical = serde_json::to_string(input).expect("Value serialization cannot fail");
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

fn contains_floats(value: &Value) -> bool {
    match value {
        Value::Number(n) => n.is_f64(),
        Value::Array(arr) => arr.iter().any(contains_floats),
        Value::Object(obj) => obj.values().any(contains_floats),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn is_deterministic_for_the_same_input() {
        let input = json!({"job": "resize", "width": 128, "height": 128});
        assert_eq!(execute_task(&input), execute_task(&input));
    }

    #[test]
    fn key_order_in_the_source_json_does_not_matter() {
        let a = json!({"width": 128, "job": "resize", "height": 128});
        let b = json!({"job": "resize", "height": 128, "width": 128});
        assert_eq!(
            execute_task(&a),
            execute_task(&b),
            "differently-ordered-but-equal objects must hash the same, or the \
             verifier (which sorts keys independently) can never agree with us"
        );
    }

    #[test]
    fn different_input_gives_a_different_hash() {
        let a = json!({"job": "resize", "width": 128});
        let b = json!({"job": "resize", "width": 256});
        assert_ne!(execute_task(&a), execute_task(&b));
    }

    #[test]
    fn matches_a_hand_computed_reference_value() {
        // sha256("{}") — a fixed point independent of this crate's own logic,
        // so this test would catch a canonicalization change that silently
        // breaks compatibility with the TypeScript verifier.
        let expected = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
        assert_eq!(execute_task(&json!({})), expected);
    }

    #[test]
    #[should_panic(expected = "floating-point numbers not supported")]
    fn rejects_floating_point_numbers() {
        execute_task(&json!({"value": 1.5}));
    }

    #[test]
    #[should_panic(expected = "floating-point numbers not supported")]
    fn rejects_nested_floats() {
        execute_task(&json!({"nested": {"value": 2.0}}));
    }

    #[test]
    fn accepts_integers() {
        // Integers should work fine
        execute_task(&json!({"value": 42}));
    }
}
