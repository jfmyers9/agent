use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn call_core(request: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_context-guard"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn context-guard");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(request.to_string().as_bytes())
        .expect("write request");
    let output = child.wait_with_output().expect("wait for context-guard");
    serde_json::from_slice(&output.stdout).expect("decode response")
}

#[test]
fn replay_corpus_measures_savings_and_retrieval_recall() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let db_path = std::env::temp_dir().join(format!("context-guard-replay-{nonce}.db"));
    let commands = vec![
        json!({"label": "small", "command": "printf 'smallneedle\\n'"}),
        json!({"label": "large-log", "command": "python3 -c \"print('noise' * 25000); print('largeneedle')\""}),
        json!({"label": "long-line", "command": "python3 -c \"print('x' * 30000 + ' longlineneedle')\""}),
        json!({"label": "unicode", "command": "printf '雪だるま unicodeneedle\\n'"}),
        json!({"label": "failure", "command": "printf 'failureneedle\\n'; exit 7"}),
        json!({"label": "mixed-streams", "command": "printf 'stdoutneedle\\n'; printf 'stderrneedle\\n' >&2"}),
        json!({"label": "repeat", "command": "printf 'repeatfirstneedle\\n'"}),
        json!({"label": "repeat", "command": "printf 'repeatsecondneedle\\n'"}),
    ];
    let needles = [
        "smallneedle",
        "largeneedle",
        "longlineneedle",
        "unicodeneedle",
        "failureneedle",
        "stdoutneedle",
        "stderrneedle",
        "repeatfirstneedle",
        "repeatsecondneedle",
    ];
    let response = call_core(json!({
        "command": "batch",
        "params": {
            "dbPath": db_path,
            "commands": commands,
            "queries": needles,
            "concurrency": 3,
            "timeout": 10_000
        }
    }));
    let text = response["content"][0]["text"]
        .as_str()
        .expect("response text");
    let recalled = needles
        .iter()
        .filter(|needle| text.contains(*needle))
        .count();
    let metrics = &response["details"]["metrics"];
    let raw = metrics["rawBytes"].as_u64().expect("raw bytes");
    let indexed = metrics["indexedBytes"].as_u64().expect("indexed bytes");
    let returned = metrics["returnedBytes"].as_u64().expect("returned bytes");
    let omitted = metrics["omittedBytes"].as_u64().expect("omitted bytes");
    let store_bytes = std::fs::metadata(&db_path).expect("content store").len();

    println!(
        "{}",
        json!({
            "cases": commands.len(),
            "recall": recalled as f64 / needles.len() as f64,
            "rawBytes": raw,
            "indexedBytes": indexed,
            "returnedBytes": returned,
            "omittedBytes": omitted,
            "storeBytes": store_bytes,
            "elapsedMs": metrics["elapsedMs"]
        })
    );
    assert_eq!(recalled, needles.len());
    assert!(raw > 100_000);
    assert!(indexed >= raw);
    assert!(omitted > 100_000);
    assert!(returned < raw);
    assert!(store_bytes > 0);
    for path in [
        db_path.clone(),
        db_path.with_extension("db-wal"),
        db_path.with_extension("db-shm"),
    ] {
        let _ = std::fs::remove_file(path);
    }
}
