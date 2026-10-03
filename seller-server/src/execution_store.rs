//! Flush execution intent before dispatch; publish only complete checked results.
use crate::config::TaskResult;
use crate::execute::hash_canonical;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredResult {
    version: u8,
    checksum: String,
    result: TaskResult,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionIntent {
    pub version: u8,
    pub input_hash: String,
    pub service_id: String,
    pub state: String,
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn checksum(result: &TaskResult) -> io::Result<String> {
    hash_canonical(&serde_json::to_value(result).map_err(|_| invalid("result encoding"))?)
        .map_err(invalid)
}
fn validate(result: &TaskResult) -> io::Result<()> {
    if result.version != "1"
        || result.task_id.parse::<u64>().is_err()
        || result.completed_at_unix < 0
        || hash_canonical(&result.input).map_err(invalid)? != result.output_hash
        || hash_canonical(&result.result).map_err(invalid)? != result.result_hash
    {
        return Err(invalid("corrupt result commitments"));
    }
    Ok(())
}
fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        for ancestor in path.ancestors() {
            if !ancestor.as_os_str().is_empty() {
                fs::File::open(ancestor)?.sync_all()?;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
pub fn claim(path: &Path, input_hash: &str, service: &str) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| invalid("missing parent"))?;
    fs::create_dir_all(parent)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(json!({"version":1,"input_hash":input_hash,"service_id":service,"state":"UNKNOWN_EXTERNAL_EFFECT"}).to_string().as_bytes())?;
    file.sync_all()?;
    sync_directory(parent)
}
/// Read-only Phase 4A.3 evidence. Absence of an intent is not proof that a
/// provider effect did not occur (the store may have been moved or restored).
pub fn load_intent(path: &Path) -> io::Result<Option<ExecutionIntent>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let intent: ExecutionIntent =
        serde_json::from_slice(&bytes).map_err(|_| invalid("malformed execution intent"))?;
    if intent.version != 1
        || intent.state != "UNKNOWN_EXTERNAL_EFFECT"
        || intent.service_id.is_empty()
        || intent.input_hash.len() != 64
        || !intent
            .input_hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid("invalid execution intent"));
    }
    Ok(Some(intent))
}
pub fn load(path: &Path) -> io::Result<Option<TaskResult>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let raw: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid("malformed persisted result"))?;
    let result = if raw.get("checksum").is_some() {
        let record: StoredResult =
            serde_json::from_value(raw).map_err(|_| invalid("malformed result journal"))?;
        if record.version != 1 || checksum(&record.result)? != record.checksum {
            return Err(invalid("corrupt result journal checksum"));
        }
        record.result
    } else {
        serde_json::from_value(raw).map_err(|_| invalid("malformed legacy result"))?
    };
    validate(&result)?;
    Ok(Some(result))
}
pub fn save(path: &Path, result: &TaskResult) -> io::Result<()> {
    save_inner(path, result, |_| Ok(()))
}
fn save_inner(
    path: &Path,
    result: &TaskResult,
    fault: impl Fn(&str) -> io::Result<()>,
) -> io::Result<()> {
    validate(result)?;
    let parent = path.parent().ok_or_else(|| invalid("missing parent"))?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let record = StoredResult {
        version: 1,
        checksum: checksum(result)?,
        result: result.clone(),
    };
    fault("before_temp_write")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(&record).map_err(|_| invalid("result encoding"))?)?;
    fault("after_temp_write")?;
    fault("before_fsync")?;
    file.sync_all()?;
    fault("after_fsync")?;
    drop(file);
    fault("before_rename")?;
    fs::rename(&temporary, path)?;
    sync_directory(parent)?;
    fault("after_rename")?;
    let saved = load(path)?.ok_or_else(|| invalid("result disappeared after publication"))?;
    if checksum(&saved)? != checksum(result)? {
        return Err(invalid("result read-back mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> TaskResult {
        let input = json!({"work":1});
        TaskResult {
            input: input.clone(),
            output_hash: hash_canonical(&input).unwrap(),
            version: "1".into(),
            task_id: "35".into(),
            service_id: "legacy-rest".into(),
            result: input.clone(),
            result_hash: hash_canonical(&input).unwrap(),
            evidence: vec![],
            completed_at_unix: 1,
        }
    }
    fn directory() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "setra35-store-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            solana_pubkey::Pubkey::new_unique()
        ));
        fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn partial_result_write_failures_never_publish_completion() {
        for point in [
            "before_temp_write",
            "after_temp_write",
            "before_fsync",
            "after_fsync",
            "before_rename",
        ] {
            let dir = directory();
            let path = dir.join("result.json");
            claim(&dir.join("execution.intent"), "input", "service").unwrap();
            assert!(save_inner(&path, &fixture(), |p| if p == point {
                Err(io::Error::new(io::ErrorKind::Other, "injected disk full"))
            } else {
                Ok(())
            })
            .is_err());
            assert!(load(&path).unwrap().is_none());
            assert!(claim(&dir.join("execution.intent"), "input", "service").is_err());
        }
    }
    #[test]
    fn crash_after_rename_recovers_the_complete_result() {
        let path = directory().join("result.json");
        assert!(save_inner(&path, &fixture(), |p| if p == "after_rename" {
            Err(io::Error::new(io::ErrorKind::Other, "crash"))
        } else {
            Ok(())
        })
        .is_err());
        assert_eq!(load(&path).unwrap(), Some(fixture()));
    }
    #[test]
    fn process_dies_after_execution_before_result_persistence() {
        const FLAG: &str = "SETRA35_STORE_TEST_CHILD";
        if let Ok(dir) = std::env::var(FLAG) {
            let dir = std::path::PathBuf::from(dir);
            claim(&dir.join("execution.intent"), "input", "service").unwrap();
            let mut effect = fs::File::create(dir.join("effect.receipt")).unwrap();
            effect.write_all(b"executed once").unwrap();
            effect.sync_all().unwrap();
            std::process::exit(73);
        }
        let dir = directory();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "execution_store::tests::process_dies_after_execution_before_result_persistence",
                "--nocapture",
            ])
            .env(FLAG, &dir)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73));
        assert!(load(&dir.join("result.json")).unwrap().is_none());
        assert!(dir.join("effect.receipt").exists());
        assert!(claim(&dir.join("execution.intent"), "input", "service").is_err());
    }
}
