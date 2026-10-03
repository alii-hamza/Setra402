//! Durable, exact-request evidence for private blind-sign issuance.
//! An intent without a completed response is deliberately not replayable.
use crate::execute::hash_canonical;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IssuanceIntent {
    pub version: u8,
    pub buyer: String,
    pub task_id: u64,
    pub blinded_point: String,
    pub mint_pubkey: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IssuanceReceipt {
    pub version: u8,
    pub buyer: String,
    pub task_id: u64,
    pub blinded_point: String,
    pub mint_pubkey: String,
    pub blind_signature: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    version: u8,
    checksum: String,
    value: T,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn checksum<T: Serialize>(value: &T) -> io::Result<String> {
    hash_canonical(&serde_json::to_value(value).map_err(|_| invalid("issuance encoding"))?)
        .map_err(invalid)
}

fn read<T: for<'de> Deserialize<'de> + Serialize>(path: &Path) -> io::Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let record: Envelope<T> =
        serde_json::from_slice(&bytes).map_err(|_| invalid("malformed issuance journal"))?;
    if record.version != 1 || checksum(&record.value)? != record.checksum {
        return Err(invalid("invalid issuance version or checksum"));
    }
    Ok(Some(record.value))
}

fn sync_parent(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn publish<T: Serialize>(path: &Path, value: &T) -> io::Result<bool> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("missing issuance parent"))?;
    fs::create_dir_all(parent)?;
    let record = json!({"version":1,"checksum":checksum(value)?,"value":value});
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(record.to_string().as_bytes())?;
        file.sync_all()?;
        drop(file);
        match fs::hard_link(&temporary, path) {
            Ok(()) => {
                sync_parent(parent)?;
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

pub fn paths(root: &Path, task_pda: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let directory = root.join("mint-issuance");
    (
        directory.join(format!("{task_pda}.intent")),
        directory.join(format!("{task_pda}.receipt")),
    )
}

pub fn load(
    intent_path: &Path,
    receipt_path: &Path,
) -> io::Result<(Option<IssuanceIntent>, Option<IssuanceReceipt>)> {
    let intent: Option<IssuanceIntent> = read(intent_path)?;
    let receipt: Option<IssuanceReceipt> = read(receipt_path)?;
    if let Some(i) = &intent {
        if i.version != 1 || i.blinded_point.len() != 64 || i.mint_pubkey.len() != 64 {
            return Err(invalid("invalid issuance intent"));
        }
    }
    if let Some(r) = &receipt {
        if r.version != 1
            || r.blinded_point.len() != 64
            || r.mint_pubkey.len() != 64
            || r.blind_signature.len() != 64
        {
            return Err(invalid("invalid issuance receipt"));
        }
        let i = intent
            .as_ref()
            .ok_or_else(|| invalid("orphan issuance receipt"))?;
        if i.buyer != r.buyer
            || i.task_id != r.task_id
            || i.blinded_point != r.blinded_point
            || i.mint_pubkey != r.mint_pubkey
        {
            return Err(invalid("issuance binding conflict"));
        }
    }
    Ok((intent, receipt))
}

pub fn claim(path: &Path, intent: &IssuanceIntent) -> io::Result<bool> {
    publish(path, intent)
}
pub fn complete(path: &Path, receipt: &IssuanceReceipt) -> io::Result<bool> {
    publish(path, receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, IssuanceIntent, IssuanceReceipt) {
        let root = std::env::temp_dir().join(format!(
            "setra-mint-store-{}-{}",
            std::process::id(),
            solana_pubkey::Pubkey::new_unique()
        ));
        let intent = IssuanceIntent {
            version: 1,
            buyer: solana_pubkey::Pubkey::new_unique().to_string(),
            task_id: 35,
            blinded_point: "a".repeat(64),
            mint_pubkey: "b".repeat(64),
        };
        let receipt = IssuanceReceipt {
            version: 1,
            buyer: intent.buyer.clone(),
            task_id: 35,
            blinded_point: intent.blinded_point.clone(),
            mint_pubkey: intent.mint_pubkey.clone(),
            blind_signature: "c".repeat(64),
        };
        (root, intent, receipt)
    }
    #[test]
    fn intent_without_receipt_stays_unresolved_and_exclusive() {
        let (root, intent, _) = fixture();
        let (i, r) = paths(&root, "task");
        assert!(claim(&i, &intent).unwrap());
        assert!(!claim(&i, &intent).unwrap());
        assert_eq!(load(&i, &r).unwrap(), (Some(intent), None));
    }
    #[test]
    fn orphan_and_conflicting_receipts_fail_closed() {
        let (root, intent, mut receipt) = fixture();
        let (i, r) = paths(&root, "task");
        complete(&r, &receipt).unwrap();
        assert!(load(&i, &r).is_err());
        claim(&i, &intent).unwrap();
        receipt.blinded_point = "d".repeat(64);
        assert!(load(&i, &r).is_ok());
        let second = paths(&root, "other");
        claim(&second.0, &intent).unwrap();
        complete(&second.1, &receipt).unwrap();
        assert!(load(&second.0, &second.1).is_err());
    }
    #[test]
    fn checksum_corruption_and_future_version_fail_closed() {
        let (root, intent, _) = fixture();
        let (i, r) = paths(&root, "task");
        claim(&i, &intent).unwrap();
        let original = fs::read_to_string(&i).unwrap();
        fs::write(&i, original.replace("\"version\":1", "\"version\":2")).unwrap();
        assert!(load(&i, &r).is_err());
        fs::write(&i, "{\"version\":1").unwrap();
        assert!(load(&i, &r).is_err());
    }
}
