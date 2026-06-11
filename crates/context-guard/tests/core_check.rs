use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

fn call_core(request: &[u8]) -> serde_json::Value {
    call_core_with_env(request, &[])
}

fn call_core_with_env(request: &[u8], envs: &[(&str, &str)]) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_context-guard"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .envs(envs.iter().copied())
        .spawn()
        .expect("spawn context-guard binary");

    child
        .stdin
        .as_mut()
        .expect("open stdin")
        .write_all(request)
        .expect("write request");

    let output = child.wait_with_output().expect("read response");

    assert!(output.status.success());

    serde_json::from_slice(&output.stdout).expect("response is JSON")
}

fn response_text(response: &serde_json::Value) -> String {
    response["content"][0]["text"]
        .as_str()
        .expect("text response")
        .to_string()
}

fn response_text_json(response: &serde_json::Value) -> serde_json::Value {
    serde_json::from_str(&response_text(response)).expect("nested json response")
}

fn temp_db_path(name: &str) -> String {
    let path = std::env::temp_dir().join(format!(
        "context-guard-{name}-{}.db",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    path.to_string_lossy().into_owned()
}

fn temp_file_path(name: &str, ext: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "context-guard-{name}-{}.{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos(),
        ext
    ))
}

fn serve_http_once(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    });
    format!("http://{addr}")
}

fn serve_http_once_delayed(body: &'static str, delay_ms: u64) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind delayed test server");
    let addr = listener.local_addr().expect("delayed local addr");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept delayed request");
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request);
        thread::sleep(std::time::Duration::from_millis(delay_ms));
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write delayed response");
    });
    format!("http://{addr}")
}

fn serve_http_once_with_content_type(body: &'static str, content_type: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind content-type test server");
    let addr = listener.local_addr().expect("content-type local addr");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept content-type request");
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            content_type,
            body.len(),
            body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write content-type response");
    });
    format!("http://{addr}")
}

#[test]
fn check_command_returns_plain_text_status() {
    let response = call_core(br#"{"command":"check","params":{}}"#);

    assert_eq!(response["ok"], true);
    assert_eq!(
        response["content"][0]["text"],
        "context-guard check\n\n[OK] Rust core: available"
    );
}

#[test]
fn run_shell_command_returns_stdout() {
    let response =
        call_core(br#"{"command":"run","params":{"language":"shell","code":"printf hello"}}"#);

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "hello");
}

#[test]
fn run_javascript_command_returns_stdout() {
    let response = call_core(
        br#"{"command":"run","params":{"language":"javascript","code":"console.log('hello from js')","timeout":1000}}"#,
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "hello from js\n");
}

#[test]
fn run_javascript_command_scrubs_node_options_from_parent_env() {
    let marker_path = temp_file_path("node-options-hijack", "txt");
    let hijack_path = temp_file_path("node-options-hijack", "js");
    std::fs::write(
        &hijack_path,
        format!(
            "require('node:fs').writeFileSync({}, 'hijacked')",
            serde_json::to_string(&marker_path.to_string_lossy()).expect("marker path json")
        ),
    )
    .expect("write hijack module");

    let response = call_core_with_env(
        br#"{"command":"run","params":{"language":"javascript","code":"console.log('clean js')","timeout":1000}}"#,
        &[("NODE_OPTIONS", &format!("--require={}", hijack_path.to_string_lossy()))],
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "clean js\n");
    assert!(
        !marker_path.exists(),
        "NODE_OPTIONS hijack should be scrubbed"
    );
}

#[test]
fn run_python_command_returns_stdout() {
    let response = call_core(
        br#"{"command":"run","params":{"language":"python","code":"print('hello from python')","timeout":1000}}"#,
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "hello from python\n");
}

#[test]
fn run_typescript_command_strips_types() {
    let response = call_core(
        br#"{"command":"run","params":{"language":"typescript","code":"const value: string = 'hello from ts'; console.log(value)","timeout":1000}}"#,
    );

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "hello from ts\n");
}

#[test]
fn run_command_honors_timeout() {
    let response = call_core(
        br#"{"command":"run","params":{"language":"shell","code":"sleep 2; printf done","timeout":50}}"#,
    );

    assert_eq!(response["ok"], false);
    assert!(response["isError"].as_bool().unwrap_or(false));
    let text = response["content"][0]["text"]
        .as_str()
        .expect("text response");
    assert!(text.contains("timed out after 50ms"));
}

#[test]
fn run_command_can_background_on_timeout_and_continue_side_effects() {
    let marker_path = temp_file_path("run-background", "txt");
    let code = format!("sleep 0.1; printf done > {}", marker_path.to_string_lossy());
    let request = serde_json::json!({
        "command": "run",
        "params": {
            "language": "shell",
            "code": code,
            "timeout": 20,
            "background": true
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"]
        .as_str()
        .expect("background text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("backgrounded after 20ms"));

    thread::sleep(std::time::Duration::from_millis(250));
    let marker = std::fs::read_to_string(&marker_path).expect("read background marker");
    assert_eq!(marker, "done");
}

#[test]
fn run_shell_command_shields_large_stdout() {
    let response = call_core(
        br#"{"command":"run","params":{"language":"shell","code":"perl -e 'print \"x\" x 25000'"}}"#,
    );

    assert_eq!(response["ok"], true);
    let text = response["content"][0]["text"]
        .as_str()
        .expect("text response");
    assert!(text.contains("Output exceeded 20000 bytes"));
    assert!(text.len() < 1000);
}

#[test]
fn process_file_shell_command_receives_file_content() {
    let path = std::env::temp_dir().join(format!(
        "context-guard-process-file-{}.txt",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::write(&path, "alpha\nbeta\n").expect("write input file");

    let request = serde_json::json!({
        "command": "process_file",
        "params": {
            "path": path,
            "language": "shell",
            "code": "printf \"%s\" \"$FILE_CONTENT\" | wc -l | tr -d ' '"
        }
    });
    let response = call_core(request.to_string().as_bytes());

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "2\n");
}

#[test]
fn process_file_javascript_receives_file_content_variable() {
    let path = std::env::temp_dir().join(format!(
        "context-guard-process-file-js-{}.txt",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::write(&path, "alpha\nbeta\n").expect("write input file");

    let request = serde_json::json!({
        "command": "process_file",
        "params": {
            "path": path,
            "language": "javascript",
            "code": "console.log(FILE_CONTENT.split('\\n').filter(Boolean).length)",
            "timeout": 1000
        }
    });
    let response = call_core(request.to_string().as_bytes());

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "2\n");
}

#[test]
fn process_file_python_receives_file_content_variable() {
    let path = std::env::temp_dir().join(format!(
        "context-guard-process-file-python-{}.txt",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::write(&path, "alpha\nbeta\n").expect("write input file");

    let request = serde_json::json!({
        "command": "process_file",
        "params": {
            "path": path,
            "language": "python",
            "code": "print(len([line for line in FILE_CONTENT.split('\\n') if line]))",
            "timeout": 1000
        }
    });
    let response = call_core(request.to_string().as_bytes());

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "2\n");
}

#[test]
fn process_file_handles_large_file_content_without_env_limit() {
    let path = temp_file_path("large-process-file", "txt");
    let content = "large-file-needle\n".repeat(200_000);
    std::fs::write(&path, content).expect("write large input file");

    let request = serde_json::json!({
        "command": "process_file",
        "params": {
            "path": path,
            "language": "python",
            "code": "print(FILE_CONTENT.count('large-file-needle'))",
            "timeout": 5000
        }
    });
    let response = call_core(request.to_string().as_bytes());

    assert_eq!(response["ok"], true);
    assert_eq!(response["content"][0]["text"], "200000\n");
}

#[test]
fn index_then_search_returns_indexed_content() {
    let db_path = temp_db_path("search");
    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "source": "test-doc",
            "content": "## Alpha\nNeedle lives in this paragraph."
        }
    });
    let index_response = call_core(index_request.to_string().as_bytes());
    assert_eq!(index_response["ok"], true);
    assert!(
        index_response["content"][0]["text"]
            .as_str()
            .expect("index text")
            .contains("Indexed")
    );

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "queries": ["Needle"]
        }
    });
    let search_response = call_core(search_request.to_string().as_bytes());
    let text = search_response["content"][0]["text"]
        .as_str()
        .expect("search text");

    assert_eq!(search_response["ok"], true);
    assert!(text.contains("Needle lives"));
    assert!(text.contains("test-doc"));
}

#[test]
fn purge_removes_indexed_content() {
    let db_path = temp_db_path("purge");
    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "source": "purge-doc",
            "content": "temporary searchable content"
        }
    });
    assert_eq!(call_core(index_request.to_string().as_bytes())["ok"], true);

    let purge_request = serde_json::json!({
        "command": "purge",
        "params": {
            "dbPath": db_path,
            "confirm": true,
            "scope": "project"
        }
    });
    let purge_response = call_core(purge_request.to_string().as_bytes());
    assert_eq!(purge_response["ok"], true);
    assert!(
        purge_response["content"][0]["text"]
            .as_str()
            .expect("purge text")
            .contains("Purged")
    );

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "queries": ["temporary"]
        }
    });
    let search_response = call_core(search_request.to_string().as_bytes());
    assert!(
        search_response["content"][0]["text"]
            .as_str()
            .expect("search text")
            .contains("Knowledge base is empty")
    );
}

#[test]
fn purge_rejects_ambiguous_project_scope_with_session_id() {
    let db_path = temp_db_path("purge-ambiguous");
    let purge_request = serde_json::json!({
        "command": "purge",
        "params": {
            "dbPath": db_path,
            "confirm": true,
            "scope": "project",
            "sessionId": "session-123"
        }
    });
    let purge_response = call_core(purge_request.to_string().as_bytes());
    let text = response_text(&purge_response);

    assert_eq!(purge_response["ok"], false);
    assert!(text.contains("Ambiguous purge"));
}

#[test]
fn index_resolves_relative_paths_against_project_dir() {
    let root = temp_file_path("index-relative-project-dir-root", "dir");
    std::fs::create_dir_all(&root).expect("create root dir");
    let docs_dir = root.join("docs");
    std::fs::create_dir_all(&docs_dir).expect("create docs dir");
    let file_path = docs_dir.join("guide.md");
    std::fs::write(&file_path, "# Guide\n\nrelative path needle\n").expect("write file");

    let db_path = temp_db_path("index-relative-project-dir");
    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "path": "docs/guide.md",
            "projectDir": root.to_string_lossy(),
            "source": "relative-guide"
        }
    });
    let index_response = call_core(index_request.to_string().as_bytes());
    assert_eq!(index_response["ok"], true);

    let conn = Connection::open(&db_path).expect("open indexed db");
    let stored_path: String = conn
        .query_row(
            "SELECT file_path FROM sources WHERE label = ?1",
            ["relative-guide"],
            |row| row.get(0),
        )
        .expect("read stored file_path");
    assert_eq!(stored_path, file_path.to_string_lossy());
}

#[test]
fn batch_runs_commands_indexes_output_and_searches() {
    let db_path = temp_db_path("batch");
    let request = serde_json::json!({
        "command": "batch",
        "params": {
            "dbPath": db_path,
            "commands": [
                { "label": "cmd-one", "command": "printf batchneedle" }
            ],
            "queries": ["batchneedle"]
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("batch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Executed 1 commands"));
    assert!(text.contains("batchneedle"));
    assert!(text.contains("cmd-one"));
}

#[test]
fn batch_runs_commands_in_project_dir() {
    let db_path = temp_db_path("batch-project-dir");
    let project_dir = std::env::temp_dir().join(format!(
        "context-guard-batch-project-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&project_dir).expect("create project dir");
    std::fs::write(project_dir.join("needle.txt"), "project-dir-needle").expect("write fixture");
    let request = serde_json::json!({
        "command": "batch",
        "params": {
            "dbPath": db_path,
            "projectDir": project_dir,
            "commands": [
                { "label": "project-dir-ls", "command": "cat needle.txt" }
            ],
            "queries": ["project-dir-needle"]
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("batch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("project-dir-needle"));
}

#[test]
fn batch_isolates_timed_out_commands_and_keeps_fast_results_searchable() {
    let db_path = temp_db_path("batch-timeout");
    let request = serde_json::json!({
        "command": "batch",
        "params": {
            "dbPath": db_path,
            "commands": [
                { "label": "fast-cmd", "command": "printf fastneedle" },
                { "label": "slow-cmd", "command": "sleep 0.2; printf slowneedle" }
            ],
            "queries": ["fastneedle"],
            "timeout": 50,
            "concurrency": 2
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("batch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Executed 2 commands"));
    assert!(text.contains("fast-cmd"));
    assert!(text.contains("fastneedle"));
    assert!(text.contains("slow-cmd"));
    assert!(text.contains("timed out after 50ms"));
}

#[test]
fn batch_uses_a_shared_timeout_budget_when_concurrency_is_one() {
    let db_path = temp_db_path("batch-shared-timeout");
    let request = serde_json::json!({
        "command": "batch",
        "params": {
            "dbPath": db_path,
            "commands": [
                { "label": "slow-cmd", "command": "sleep 0.2; printf should-not-finish" },
                { "label": "after-timeout", "command": "printf should-never-run" }
            ],
            "queries": ["should-never-run"],
            "timeout": 50,
            "concurrency": 1
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("batch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Executed 2 commands"));
    assert!(text.contains("slow-cmd"));
    assert!(text.contains("timed out after 50ms"));
    assert!(text.contains("after-timeout"));
    assert!(text.contains("shared batch timeout exhausted"));
    assert!(text.contains("No results found."));
}

#[test]
fn fetch_indexes_http_response_and_returns_preview() {
    let db_path = temp_db_path("fetch");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once("fetchneedle response body"),
            "source": "local-http"
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("fetch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Fetched and indexed"));
    assert!(text.contains("fetchneedle"));
}

#[test]
fn fetch_success_response_reports_indexed_sections_and_source_label() {
    let db_path = temp_db_path("fetch-format");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once("format fetch body"),
            "source": "format-source"
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("fetch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Fetched and indexed 1 sections"));
    assert!(text.contains("from: format-source"));
    assert!(text.contains("format fetch body"));
}

#[test]
fn fetch_converts_simple_html_responses_to_readable_text() {
    let db_path = temp_db_path("fetch-html");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once_with_content_type(
                "<html><body><h1>Hello</h1><p>World</p></body></html>",
                "text/html; charset=utf-8"
            ),
            "source": "html-source"
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"]
        .as_str()
        .expect("html fetch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Hello"));
    assert!(text.contains("World"));
    assert!(!text.contains("<html>"));
}

#[test]
fn fetch_preserves_json_response_bodies() {
    let db_path = temp_db_path("fetch-json");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once_with_content_type(
                "{\"hello\":\"json\"}",
                "application/json"
            ),
            "source": "json-source"
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"]
        .as_str()
        .expect("json fetch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("{\"hello\":\"json\"}"));
}

#[test]
fn fetch_accepts_batch_requests_and_indexes_each_response() {
    let db_path = temp_db_path("fetch-batch");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "requests": [
                { "url": serve_http_once("batch fetch alpha"), "source": "fetch-alpha" },
                { "url": serve_http_once("batch fetch beta"), "source": "fetch-beta" }
            ],
            "concurrency": 2
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"].as_str().expect("fetch text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("ok=2"));
    assert!(text.contains("batch fetch alpha"));
    assert!(text.contains("batch fetch beta"));
}

#[test]
fn fetch_honors_batch_concurrency_for_independent_requests() {
    let sequential_db_path = temp_db_path("fetch-batch-concurrency-sequential");
    let sequential_request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": sequential_db_path,
            "requests": [
                { "url": serve_http_once_delayed("delay alpha sequential", 700), "source": "delay-alpha-sequential" },
                { "url": serve_http_once_delayed("delay beta sequential", 700), "source": "delay-beta-sequential" }
            ],
            "concurrency": 1
        }
    });
    let sequential_started = std::time::Instant::now();
    let sequential_response = call_core(sequential_request.to_string().as_bytes());
    let sequential_elapsed_ms = sequential_started.elapsed().as_millis() as u64;

    let concurrent_db_path = temp_db_path("fetch-batch-concurrency-concurrent");
    let concurrent_request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": concurrent_db_path,
            "requests": [
                { "url": serve_http_once_delayed("delay alpha concurrent", 700), "source": "delay-alpha-concurrent" },
                { "url": serve_http_once_delayed("delay beta concurrent", 700), "source": "delay-beta-concurrent" }
            ],
            "concurrency": 2
        }
    });
    let concurrent_started = std::time::Instant::now();
    let concurrent_response = call_core(concurrent_request.to_string().as_bytes());
    let concurrent_elapsed_ms = concurrent_started.elapsed().as_millis() as u64;
    let concurrent_text = concurrent_response["content"][0]["text"]
        .as_str()
        .expect("fetch text");

    assert_eq!(sequential_response["ok"], true);
    assert_eq!(concurrent_response["ok"], true);
    assert!(concurrent_text.contains("delay alpha concurrent"));
    assert!(concurrent_text.contains("delay beta concurrent"));
    assert!(
        concurrent_elapsed_ms + 250 < sequential_elapsed_ms,
        "expected concurrent fetches to beat sequential timing by a clear margin; sequential={sequential_elapsed_ms}ms concurrent={concurrent_elapsed_ms}ms"
    );
}

#[test]
fn fetch_uses_cache_unless_force_is_true() {
    let db_path = temp_db_path("fetch-cache");
    let url = serve_http_once("cache first body");
    let first = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": url,
            "source": "fetch-cache-source"
        }
    });
    assert_eq!(call_core(first.to_string().as_bytes())["ok"], true);

    let cached = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": url,
            "source": "fetch-cache-source"
        }
    });
    let cached_response = call_core(cached.to_string().as_bytes());
    let cached_text = cached_response["content"][0]["text"]
        .as_str()
        .expect("cached text");
    assert_eq!(cached_response["ok"], true);
    assert!(cached_text.contains("[cache] fetch-cache-source"));

    let forced = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once("cache forced body"),
            "source": "fetch-cache-source",
            "force": true
        }
    });
    let forced_response = call_core(forced.to_string().as_bytes());
    let forced_text = forced_response["content"][0]["text"]
        .as_str()
        .expect("forced text");
    assert_eq!(forced_response["ok"], true);
    assert!(forced_text.contains("cache forced body"));
}

#[test]
fn fetch_does_not_collide_cache_entries_for_different_urls_sharing_a_source_label() {
    let db_path = temp_db_path("fetch-cache-key");
    let first = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once("cache key first body"),
            "source": "shared-docs"
        }
    });
    assert_eq!(call_core(first.to_string().as_bytes())["ok"], true);

    let second = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": serve_http_once("cache key second body"),
            "source": "shared-docs"
        }
    });
    let second_response = call_core(second.to_string().as_bytes());
    let second_text = second_response["content"][0]["text"]
        .as_str()
        .expect("second fetch text");

    assert_eq!(second_response["ok"], true);
    assert!(second_text.contains("cache key second body"));
    assert!(!second_text.contains("[cache] shared-docs"));
}

#[test]
fn fetch_refetches_when_the_cached_entry_is_older_than_the_ttl_window() {
    let db_path = temp_db_path("fetch-cache-ttl");
    let url = serve_http_once("fresh body");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": url,
            "source": "ttl-source"
        }
    });
    assert_eq!(call_core(request.to_string().as_bytes())["ok"], true);

    let conn = Connection::open(&db_path).expect("open fetch db");
    conn.execute(
        "UPDATE sources SET indexed_at = '2000-01-01 00:00:00' WHERE label = ?1",
        rusqlite::params![format!("ttl-source::{url}")],
    )
    .expect("age cached source row");

    let expired = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": url,
            "source": "ttl-source"
        }
    });
    let expired_response = call_core(expired.to_string().as_bytes());
    let expired_text = expired_response["content"][0]["text"]
        .as_str()
        .expect("expired fetch text");

    assert_eq!(expired_response["ok"], false);
    assert!(!expired_text.contains("[cache] ttl-source"));
}

#[test]
fn fetch_cache_hits_emit_session_telemetry_when_session_db_is_provided() {
    let db_path = temp_db_path("fetch-cache-telemetry");
    let session_db_path = temp_db_path("fetch-cache-session");
    let url = serve_http_once("cache telemetry body");

    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-fetch",
            "projectDir": "/tmp/project-fetch"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let first = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "sessionDbPath": session_db_path,
            "url": url,
            "source": "fetch-telemetry-source"
        }
    });
    assert_eq!(call_core(first.to_string().as_bytes())["ok"], true);

    let second = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "sessionDbPath": session_db_path,
            "url": url,
            "source": "fetch-telemetry-source"
        }
    });
    let second_response = call_core(second.to_string().as_bytes());
    let second_text = second_response["content"][0]["text"]
        .as_str()
        .expect("cached fetch text");
    assert_eq!(second_response["ok"], true);
    assert!(second_text.contains("[cache] fetch-telemetry-source"));

    let query_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "query",
            "sessionDbPath": session_db_path,
            "sessionId": "session-fetch",
            "limit": 20
        }
    });
    let query_response = call_core(query_request.to_string().as_bytes());
    let query_text = query_response["content"][0]["text"]
        .as_str()
        .expect("session query text");
    let query_json: serde_json::Value =
        serde_json::from_str(query_text).expect("session query json");
    let events = query_json["events"].as_array().expect("events array");

    assert!(events.iter().any(|event| {
        event["type"] == "cache-hit"
            && event["category"] == "cache"
            && event["data"] == "fetch-telemetry-source"
    }));
}

#[test]
fn fetch_rejects_non_http_schemes() {
    let db_path = temp_db_path("fetch-scheme");
    let request = serde_json::json!({
        "command": "fetch",
        "params": {
            "dbPath": db_path,
            "url": "file:///tmp/nope",
            "source": "bad-scheme"
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response["content"][0]["text"]
        .as_str()
        .expect("scheme text");

    assert_eq!(response["ok"], false);
    assert!(text.contains("URL scheme `file` not allowed"));
}

#[test]
fn status_reports_core_context_store_counts() {
    let db_path = temp_db_path("status");
    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "source": "status-doc",
            "content": "status searchable content"
        }
    });
    assert_eq!(call_core(index_request.to_string().as_bytes())["ok"], true);

    let status_request = serde_json::json!({
        "command": "status",
        "params": {
            "dbPath": db_path,
            "version": "test-version"
        }
    });
    let response = call_core(status_request.to_string().as_bytes());
    let text = response["content"][0]["text"]
        .as_str()
        .expect("status text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("Context Guard status"));
    assert!(text.contains("test-version"));
    assert!(text.contains("Indexed chunks: 1"));
}

#[test]
fn index_file_backed_markdown_tracks_metadata_and_status_lists_sources() {
    let db_path = temp_db_path("file-backed-index");
    let file_path = temp_file_path("file-backed-index", "md");
    std::fs::write(
        &file_path,
        "# Guide\n\nAlpha prose needle.\n\n## Usage\n\n```js\nconsole.log('hello from code');\n```\n",
    )
    .expect("write markdown input");

    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "path": file_path,
            "source": "docs-alpha"
        }
    });
    let index_response = call_core(index_request.to_string().as_bytes());
    let index_text = index_response["content"][0]["text"]
        .as_str()
        .expect("index text");

    assert_eq!(index_response["ok"], true);
    assert!(index_text.contains("Indexed 2 sections (1 with code)"));

    let conn = Connection::open(&db_path).expect("open indexed db");
    let row = conn
        .query_row(
            "SELECT chunk_count, code_chunk_count, file_path, content_hash FROM sources WHERE label = ?1",
            ["docs-alpha"],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .expect("read source metadata");

    assert_eq!(row.0, 2);
    assert_eq!(row.1, 1);
    assert_eq!(row.2, file_path.to_string_lossy());
    assert_eq!(row.3.len(), 64);

    let status_request = serde_json::json!({
        "command": "status",
        "params": {
            "dbPath": db_path,
            "version": "test-version"
        }
    });
    let status_response = call_core(status_request.to_string().as_bytes());
    let status_text = status_response["content"][0]["text"]
        .as_str()
        .expect("status text");

    assert_eq!(status_response["ok"], true);
    assert!(status_text.contains("Indexed chunks: 2"));
    assert!(status_text.contains("Indexed sources: 1"));
    assert!(status_text.contains("Indexed code chunks: 1"));
    assert!(status_text.contains("Recent sources: docs-alpha"));
}

#[test]
fn search_refreshes_stale_file_sources_and_filters_by_source_and_content_type() {
    let db_path = temp_db_path("stale-refresh");
    let file_path = temp_file_path("stale-refresh", "md");
    std::fs::write(
        &file_path,
        "# Guide\n\nOriginal prose.\n\n## Usage\n\n```js\nconsole.log('before');\n```\n",
    )
    .expect("write initial markdown input");

    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "path": file_path,
            "source": "docs-alpha"
        }
    });
    assert_eq!(call_core(index_request.to_string().as_bytes())["ok"], true);

    std::fs::write(
        &file_path,
        "# Guide\n\nUpdated prose.\n\n## Usage\n\n```js\nconsole.info('after needle');\n```\n",
    )
    .expect("rewrite markdown input");

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "queries": ["after needle"],
            "source": "alpha",
            "contentType": "code"
        }
    });
    let search_response = call_core(search_request.to_string().as_bytes());
    let search_text = search_response["content"][0]["text"]
        .as_str()
        .expect("search text");

    assert_eq!(search_response["ok"], true);
    assert!(search_text.contains("docs-alpha"));
    assert!(search_text.contains("after needle"));
    assert!(!search_text.contains("console.log('before')"));
}

#[test]
fn search_migrates_legacy_chunks_table_and_uses_trigram_fallback() {
    let db_path = temp_db_path("legacy-migration");
    let conn = Connection::open(&db_path).expect("open legacy db");
    conn.execute_batch(
        "CREATE VIRTUAL TABLE chunks USING fts5(source, title, content);\n         INSERT INTO chunks(source, title, content) VALUES ('legacy-doc', 'Legacy title', 'searchability migration target');",
    )
    .expect("create legacy schema");
    drop(conn);

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "queries": ["earchabi"]
        }
    });
    let search_response = call_core(search_request.to_string().as_bytes());
    let search_text = search_response["content"][0]["text"]
        .as_str()
        .expect("search text");

    assert_eq!(search_response["ok"], true);
    assert!(search_text.contains("legacy-doc"));
    assert!(search_text.contains("searchability migration target"));

    let conn = Connection::open(&db_path).expect("re-open migrated db");
    let sources: i64 = conn
        .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
        .expect("count migrated sources");
    let has_source_id: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_xinfo('chunks') WHERE name = 'source_id'",
            [],
            |row| row.get(0),
        )
        .expect("inspect migrated chunk schema");

    assert_eq!(sources, 1);
    assert_eq!(has_source_id, 1);
}

#[test]
fn search_timeline_merges_current_session_prior_session_and_auto_memory() {
    let db_path = temp_db_path("timeline-search");
    let session_db_path = temp_db_path("timeline-session");
    let project_dir = temp_file_path("timeline-project", "dir");
    let config_dir = temp_file_path("timeline-config", "dir");
    std::fs::create_dir_all(&project_dir).expect("create project dir");
    std::fs::create_dir_all(config_dir.join("memory")).expect("create memory dir");

    std::fs::write(
        project_dir.join("AGENTS.md"),
        "Project instruction with memoryneedle and commonneedle.",
    )
    .expect("write project memory");
    std::fs::write(
        config_dir.join("memory").join("notes.md"),
        "User memory note with memoryneedle and commonneedle.",
    )
    .expect("write config memory");

    let session_conn = Connection::open(&session_db_path).expect("open session db");
    session_conn
        .execute_batch(
            "CREATE TABLE session_events (\n                id INTEGER PRIMARY KEY AUTOINCREMENT,\n                session_id TEXT NOT NULL,\n                category TEXT NOT NULL,\n                type TEXT NOT NULL,\n                data TEXT NOT NULL,\n                created_at TEXT NOT NULL,\n                project_dir TEXT NOT NULL\n            );",
        )
        .expect("create session_events");
    session_conn
        .execute(
            "INSERT INTO session_events(session_id, category, type, data, created_at, project_dir) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                "session-1",
                "decision",
                "summary",
                "Prior session carries sessionneedle and commonneedle.",
                "2024-01-01 00:00:00",
                project_dir.to_string_lossy().to_string()
            ],
        )
        .expect("insert prior-session event");

    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "source": "current-doc",
            "content": "# Current\n\nCurrent session holds currentneedle only."
        }
    });
    assert_eq!(call_core(index_request.to_string().as_bytes())["ok"], true);

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "sessionDbPath": session_db_path,
            "projectDir": project_dir,
            "configDir": config_dir,
            "sort": "timeline",
            "limit": 5,
            "queries": ["currentneedle", "sessionneedle", "memoryneedle", "commonneedle"]
        }
    });
    let search_response = call_core(search_request.to_string().as_bytes());
    let search_text = search_response["content"][0]["text"]
        .as_str()
        .expect("search text");

    assert_eq!(search_response["ok"], true);
    assert!(search_text.contains("current-doc"));
    assert!(search_text.contains("Prior session carries sessionneedle"));
    assert!(search_text.contains("[auto-memory]"));

    let prior_idx = search_text
        .find("prior-session")
        .expect("prior-session result present");
    let memory_idx = search_text
        .find("[auto-memory]")
        .expect("auto-memory result present");
    assert!(
        prior_idx < memory_idx,
        "timeline results should sort chronologically"
    );
}

#[test]
fn search_reports_stale_refresh_and_progressively_throttles_results() {
    let db_path = temp_db_path("search-throttle");
    let file_path = temp_file_path("search-throttle", "md");
    std::fs::write(&file_path, "# Alpha\n\ncommonneedle first version\n")
        .expect("write initial file-backed source");

    for (source, content) in [
        ("file-backed", String::new()),
        (
            "inline-two",
            "# Beta\n\ncommonneedle second source\n".to_string(),
        ),
        (
            "inline-three",
            "# Gamma\n\ncommonneedle third source\n".to_string(),
        ),
    ] {
        let params = if source == "file-backed" {
            serde_json::json!({
                "dbPath": db_path,
                "path": file_path,
                "source": source,
            })
        } else {
            serde_json::json!({
                "dbPath": db_path,
                "source": source,
                "content": content,
            })
        };
        let request = serde_json::json!({ "command": "index", "params": params });
        assert_eq!(call_core(request.to_string().as_bytes())["ok"], true);
    }

    std::fs::write(&file_path, "# Alpha\n\ncommonneedle refreshed version\n")
        .expect("refresh file-backed source");

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "queries": ["commonneedle"],
            "limit": 5,
        }
    });

    let first = call_core(search_request.to_string().as_bytes());
    let first_text = first["content"][0]["text"]
        .as_str()
        .expect("first search text");
    assert_eq!(first["ok"], true);
    assert!(first_text.contains("auto-refreshed 1 stale file-backed source"));
    assert_eq!(first_text.matches("--- [current-session").count(), 2);

    let second = call_core(search_request.to_string().as_bytes());
    assert_eq!(second["ok"], true);
    let third = call_core(search_request.to_string().as_bytes());
    assert_eq!(third["ok"], true);

    let fourth = call_core(search_request.to_string().as_bytes());
    let fourth_text = fourth["content"][0]["text"]
        .as_str()
        .expect("fourth search text");
    assert_eq!(fourth["ok"], true);
    assert_eq!(fourth_text.matches("--- [current-session").count(), 1);

    for _ in 0..4 {
        let response = call_core(search_request.to_string().as_bytes());
        assert_eq!(response["ok"], true);
    }

    let blocked = call_core(search_request.to_string().as_bytes());
    let blocked_text = blocked["content"][0]["text"]
        .as_str()
        .expect("blocked search text");
    assert_eq!(blocked["ok"], false);
    assert!(blocked_text.contains("BLOCKED: 9 search calls in"));
}

#[test]
fn status_reports_session_and_lifetime_stats_from_session_dbs() {
    let db_path = temp_db_path("status-session");
    let sessions_dir = temp_file_path("status-sessions", "dir");
    let config_dir = temp_file_path("status-config", "dir");
    std::fs::create_dir_all(&sessions_dir).expect("create sessions dir");
    std::fs::create_dir_all(config_dir.join("memory").join("project-a"))
        .expect("create memory project dir");
    std::fs::write(
        config_dir
            .join("memory")
            .join("project-a")
            .join("feedback_note.md"),
        "Long-term project memory",
    )
    .expect("write memory file");

    let current_session_db = sessions_dir.join("current.db");
    let current = Connection::open(&current_session_db).expect("open current session db");
    current
        .execute_batch(
            "CREATE TABLE session_events (\n                id INTEGER PRIMARY KEY AUTOINCREMENT,\n                session_id TEXT NOT NULL,\n                type TEXT NOT NULL,\n                category TEXT NOT NULL,\n                priority INTEGER NOT NULL DEFAULT 2,\n                data TEXT NOT NULL,\n                project_dir TEXT NOT NULL DEFAULT '',\n                attribution_source TEXT NOT NULL DEFAULT 'unknown',\n                attribution_confidence REAL NOT NULL DEFAULT 0,\n                bytes_avoided INTEGER NOT NULL DEFAULT 0,\n                bytes_returned INTEGER NOT NULL DEFAULT 0,\n                source_hook TEXT NOT NULL DEFAULT 'test',\n                created_at TEXT NOT NULL DEFAULT (datetime('now')),\n                data_hash TEXT NOT NULL DEFAULT ''\n            );\n            CREATE TABLE session_meta (\n                session_id TEXT PRIMARY KEY,\n                project_dir TEXT NOT NULL,\n                started_at TEXT NOT NULL,\n                last_event_at TEXT,\n                event_count INTEGER NOT NULL DEFAULT 0,\n                compact_count INTEGER NOT NULL DEFAULT 0\n            );\n            CREATE TABLE session_resume (\n                id INTEGER PRIMARY KEY AUTOINCREMENT,\n                session_id TEXT NOT NULL UNIQUE,\n                snapshot TEXT NOT NULL,\n                event_count INTEGER NOT NULL,\n                created_at TEXT NOT NULL DEFAULT (datetime('now')),\n                consumed INTEGER NOT NULL DEFAULT 0\n            );\n            CREATE TABLE tool_calls (\n                session_id TEXT NOT NULL,\n                tool TEXT NOT NULL,\n                calls INTEGER NOT NULL DEFAULT 0,\n                bytes_returned INTEGER NOT NULL DEFAULT 0,\n                updated_at TEXT NOT NULL DEFAULT (datetime('now')),\n                PRIMARY KEY (session_id, tool)\n            );",
        )
        .expect("create current session schema");
    current
        .execute(
            "INSERT INTO session_meta(session_id, project_dir, started_at, last_event_at, event_count, compact_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-current", "/tmp/project-a", "2024-01-01 00:00:00", "2024-01-01 00:10:00", 2, 1],
        )
        .expect("insert current meta");
    current
        .execute(
            "INSERT INTO session_events(session_id, type, category, data, project_dir, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-current", "summary", "decision", "event one", "/tmp/project-a", "2024-01-01 00:05:00"],
        )
        .expect("insert current event one");
    current
        .execute(
            "INSERT INTO session_events(session_id, type, category, data, project_dir, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params!["session-current", "summary", "memory", "event two", "/tmp/project-a", "2024-01-01 00:10:00"],
        )
        .expect("insert current event two");
    current
        .execute(
            "INSERT INTO session_resume(session_id, snapshot, event_count) VALUES (?1, ?2, ?3)",
            rusqlite::params!["session-current", "snapshot body", 2],
        )
        .expect("insert current resume");
    current
        .execute(
            "INSERT INTO tool_calls(session_id, tool, calls, bytes_returned) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["session-current", "cg_search", 3, 512],
        )
        .expect("insert tool calls");

    let other_session_db = sessions_dir.join("other.db");
    let other = Connection::open(&other_session_db).expect("open other session db");
    other
        .execute_batch(
            "CREATE TABLE session_events (\n                id INTEGER PRIMARY KEY AUTOINCREMENT,\n                session_id TEXT NOT NULL,\n                type TEXT NOT NULL,\n                category TEXT NOT NULL,\n                priority INTEGER NOT NULL DEFAULT 2,\n                data TEXT NOT NULL,\n                project_dir TEXT NOT NULL DEFAULT '',\n                attribution_source TEXT NOT NULL DEFAULT 'unknown',\n                attribution_confidence REAL NOT NULL DEFAULT 0,\n                bytes_avoided INTEGER NOT NULL DEFAULT 0,\n                bytes_returned INTEGER NOT NULL DEFAULT 0,\n                source_hook TEXT NOT NULL DEFAULT 'test',\n                created_at TEXT NOT NULL DEFAULT (datetime('now')),\n                data_hash TEXT NOT NULL DEFAULT ''\n            );\n            CREATE TABLE session_meta (\n                session_id TEXT PRIMARY KEY,\n                project_dir TEXT NOT NULL,\n                started_at TEXT NOT NULL,\n                last_event_at TEXT,\n                event_count INTEGER NOT NULL DEFAULT 0,\n                compact_count INTEGER NOT NULL DEFAULT 0\n            );\n            CREATE TABLE session_resume (\n                id INTEGER PRIMARY KEY AUTOINCREMENT,\n                session_id TEXT NOT NULL UNIQUE,\n                snapshot TEXT NOT NULL,\n                event_count INTEGER NOT NULL,\n                created_at TEXT NOT NULL DEFAULT (datetime('now')),\n                consumed INTEGER NOT NULL DEFAULT 0\n            );",
        )
        .expect("create other session schema");
    other
        .execute(
            "INSERT INTO session_meta(session_id, project_dir, started_at, event_count, compact_count) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params!["session-other", "/tmp/project-b", "2024-01-02 00:00:00", 3, 0],
        )
        .expect("insert other meta");
    for idx in 0..3 {
        other
            .execute(
                "INSERT INTO session_events(session_id, type, category, data, project_dir, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params!["session-other", "summary", "decision", format!("event {idx}"), "/tmp/project-b", "2024-01-02 00:00:00"],
            )
            .expect("insert other event");
    }
    other
        .execute(
            "INSERT INTO session_resume(session_id, snapshot, event_count) VALUES (?1, ?2, ?3)",
            rusqlite::params!["session-other", "other snapshot", 3],
        )
        .expect("insert other resume");

    let status_request = serde_json::json!({
        "command": "status",
        "params": {
            "dbPath": db_path,
            "sessionDbPath": current_session_db,
            "sessionsDir": sessions_dir,
            "configDir": config_dir,
            "version": "test-version",
            "cwd": "/tmp/project-a"
        }
    });
    let response = call_core(status_request.to_string().as_bytes());
    let text = response["content"][0]["text"]
        .as_str()
        .expect("status text");

    assert_eq!(response["ok"], true);
    assert!(text.contains("test-version"));
    assert!(text.contains("Tool calls: 3"));
    assert!(text.contains("Events captured: 2"));
    assert!(text.contains("Conversations recorded: 1"));
    assert!(text.contains("Compactions recorded: 1"));
    assert!(text.contains("Resume snapshots: 1"));
    assert!(text.contains("Events across projects: 5"));
    assert!(text.contains("Conversations across projects: 2"));
    assert!(text.contains("Projects with session DBs: 2"));
    assert!(text.contains("Resume snapshots across projects: 2"));
    assert!(text.contains("Auto-memory files: 1 across 1 projects"));
}

#[test]
fn purge_session_scope_removes_only_target_session_rows() {
    let db_path = temp_db_path("purge-session-content");
    let session_db_path = temp_db_path("purge-session-db");

    let index_request = serde_json::json!({
        "command": "index",
        "params": {
            "dbPath": db_path,
            "source": "persisted-doc",
            "content": "searchable content survives session purge"
        }
    });
    assert_eq!(call_core(index_request.to_string().as_bytes())["ok"], true);

    let conn = Connection::open(&session_db_path).expect("open session db");
    conn.execute_batch(
        "CREATE TABLE session_events (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT NOT NULL,\n            type TEXT NOT NULL,\n            category TEXT NOT NULL,\n            priority INTEGER NOT NULL DEFAULT 2,\n            data TEXT NOT NULL,\n            project_dir TEXT NOT NULL DEFAULT '',\n            attribution_source TEXT NOT NULL DEFAULT 'unknown',\n            attribution_confidence REAL NOT NULL DEFAULT 0,\n            bytes_avoided INTEGER NOT NULL DEFAULT 0,\n            bytes_returned INTEGER NOT NULL DEFAULT 0,\n            source_hook TEXT NOT NULL DEFAULT 'test',\n            created_at TEXT NOT NULL DEFAULT (datetime('now')),\n            data_hash TEXT NOT NULL DEFAULT ''\n        );\n        CREATE TABLE session_meta (\n            session_id TEXT PRIMARY KEY,\n            project_dir TEXT NOT NULL,\n            started_at TEXT NOT NULL DEFAULT (datetime('now')),\n            last_event_at TEXT,\n            event_count INTEGER NOT NULL DEFAULT 0,\n            compact_count INTEGER NOT NULL DEFAULT 0\n        );\n        CREATE TABLE session_resume (\n            id INTEGER PRIMARY KEY AUTOINCREMENT,\n            session_id TEXT NOT NULL UNIQUE,\n            snapshot TEXT NOT NULL,\n            event_count INTEGER NOT NULL,\n            created_at TEXT NOT NULL DEFAULT (datetime('now')),\n            consumed INTEGER NOT NULL DEFAULT 0\n        );\n        CREATE TABLE tool_calls (\n            session_id TEXT NOT NULL,\n            tool TEXT NOT NULL,\n            calls INTEGER NOT NULL DEFAULT 0,\n            bytes_returned INTEGER NOT NULL DEFAULT 0,\n            updated_at TEXT NOT NULL DEFAULT (datetime('now')),\n            PRIMARY KEY (session_id, tool)\n        );",
    )
    .expect("create session schema");

    for session_id in ["session-a", "session-b"] {
        conn.execute(
            "INSERT INTO session_meta(session_id, project_dir) VALUES (?1, ?2)",
            rusqlite::params![session_id, "/tmp/project"],
        )
        .expect("insert session meta");
        conn.execute(
            "INSERT INTO session_events(session_id, type, category, data, project_dir) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![session_id, "summary", "decision", format!("event for {session_id}"), "/tmp/project"],
        )
        .expect("insert session event");
        conn.execute(
            "INSERT INTO session_resume(session_id, snapshot, event_count) VALUES (?1, ?2, ?3)",
            rusqlite::params![session_id, format!("snapshot for {session_id}"), 1],
        )
        .expect("insert session resume");
        conn.execute(
            "INSERT INTO tool_calls(session_id, tool, calls, bytes_returned) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, "cg_search", 1, 64],
        )
        .expect("insert tool calls");
    }

    let purge_request = serde_json::json!({
        "command": "purge",
        "params": {
            "dbPath": db_path,
            "sessionDbPath": session_db_path,
            "confirm": true,
            "scope": "session",
            "sessionId": "session-a"
        }
    });
    let purge_response = call_core(purge_request.to_string().as_bytes());
    let purge_text = purge_response["content"][0]["text"]
        .as_str()
        .expect("purge text");

    assert_eq!(purge_response["ok"], true);
    assert!(purge_text.contains("session rows for session-a"));

    let remaining_a: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE session_id = 'session-a'",
            [],
            |row| row.get(0),
        )
        .expect("count remaining session-a rows");
    let remaining_b: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE session_id = 'session-b'",
            [],
            |row| row.get(0),
        )
        .expect("count remaining session-b rows");
    assert_eq!(remaining_a, 0);
    assert_eq!(remaining_b, 1);

    let search_request = serde_json::json!({
        "command": "search",
        "params": {
            "dbPath": db_path,
            "queries": ["survives"]
        }
    });
    let search_response = call_core(search_request.to_string().as_bytes());
    assert_eq!(search_response["ok"], true);
}

#[test]
fn session_command_persists_runtime_side_effects_and_query_state() {
    let session_db_path = temp_db_path("session-command");

    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-a",
            "projectDir": "/tmp/project-a",
            "maxAgeDays": 7
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let event_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "events",
            "sessionDbPath": session_db_path,
            "sourceHook": "cg-server",
            "events": [{
                "type": "sandbox-execute",
                "category": "sandbox",
                "data": "exec_command.batch",
                "priority": 1,
                "bytesReturned": 64
            }]
        }
    });
    assert_eq!(call_core(event_request.to_string().as_bytes())["ok"], true);

    let tool_call_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "increment_tool_call",
            "sessionDbPath": session_db_path,
            "toolName": "exec_command.batch",
            "bytesReturned": 64
        }
    });
    assert_eq!(
        call_core(tool_call_request.to_string().as_bytes())["ok"],
        true
    );

    let resume_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "upsert_resume",
            "sessionDbPath": session_db_path,
            "sessionId": "session-a",
            "snapshot": "<resume>carry forward</resume>",
            "eventCount": 1
        }
    });
    assert_eq!(call_core(resume_request.to_string().as_bytes())["ok"], true);

    let query_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "query",
            "sessionDbPath": session_db_path,
            "latestSessionId": true,
            "limit": 10,
            "includeStats": true,
            "includeResume": true,
            "includeEventCount": true,
            "includeToolCallStats": true
        }
    });
    let query_response = call_core(query_request.to_string().as_bytes());
    let query_text = query_response["content"][0]["text"]
        .as_str()
        .expect("session query text");
    let query_json: serde_json::Value =
        serde_json::from_str(query_text).expect("session query json");

    assert_eq!(query_response["ok"], true);
    assert_eq!(query_json["latestSessionId"], "session-a");
    assert_eq!(query_json["eventCount"], 1);
    assert_eq!(
        query_json["events"].as_array().map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(query_json["events"][0]["type"], "sandbox-execute");
    assert_eq!(query_json["events"][0]["data"], "exec_command.batch");
    assert_eq!(query_json["toolCallStats"]["totalCalls"], 1);
    assert_eq!(
        query_json["toolCallStats"]["byTool"]["exec_command.batch"]["bytesReturned"],
        64
    );
    assert_eq!(query_json["resume"]["consumed"], false);

    let consume_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "mark_resume_consumed",
            "sessionDbPath": session_db_path,
            "sessionId": "session-a"
        }
    });
    assert_eq!(
        call_core(consume_request.to_string().as_bytes())["ok"],
        true
    );

    let consumed_query = call_core(query_request.to_string().as_bytes());
    let consumed_text = consumed_query["content"][0]["text"]
        .as_str()
        .expect("consumed query text");
    let consumed_json: serde_json::Value =
        serde_json::from_str(consumed_text).expect("consumed query json");
    assert_eq!(consumed_json["resume"]["consumed"], true);
}

#[test]
fn session_record_tool_telemetry_updates_tool_calls_and_events() {
    let session_db_path = temp_db_path("session-record-tool-telemetry");
    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-telemetry",
            "projectDir": "/tmp/project-telemetry"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let telemetry_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "record_tool_telemetry",
            "sessionDbPath": session_db_path,
            "toolName": "exec_command.batch",
            "bytesReturned": 64,
            "source": "inline-doc",
            "bytesAvoided": 32
        }
    });
    assert_eq!(
        call_core(telemetry_request.to_string().as_bytes())["ok"],
        true
    );

    let query_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "query",
            "sessionDbPath": session_db_path,
            "sessionId": "session-telemetry",
            "includeToolCallStats": true,
            "limit": 20,
            "minPriority": 1
        }
    });
    let query_response = call_core(query_request.to_string().as_bytes());
    let query_json = response_text_json(&query_response);
    let events = query_json["events"].as_array().expect("events array");

    assert_eq!(query_response["ok"], true);
    assert_eq!(
        query_json["toolCallStats"]["byTool"]["exec_command.batch"]["calls"],
        1
    );
    assert_eq!(
        query_json["toolCallStats"]["byTool"]["exec_command.batch"]["bytesReturned"],
        64
    );
    assert!(
        events
            .iter()
            .any(|event| { event["type"] == "sandbox-execute" && event["bytes_returned"] == 64 })
    );
    assert!(events.iter().any(|event| {
        event["type"] == "index-write"
            && event["data"] == "inline-doc"
            && event["bytes_avoided"] == 32
    }));
}

#[test]
fn session_extract_hook_events_returns_rule_and_file_events() {
    let db_path = temp_db_path("session-extract-hook-events");
    let request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "extract_hook_events",
            "sessionDbPath": db_path,
            "sessionId": "sess-1",
            "hookInput": {
                "tool_name": "Read",
                "tool_input": { "file_path": "/tmp/AGENTS.md" },
                "tool_response": "Always use rust first"
            },
            "fallbackToolName": "read"
        }
    });

    let response = call_core(request.to_string().as_bytes());
    assert_eq!(response["ok"], true);
    let events = response_text_json(&response)
        .as_array()
        .cloned()
        .expect("events array");

    assert!(events.iter().any(|event| {
        event["type"] == "rule" && event["category"] == "rule" && event["data"] == "/tmp/AGENTS.md"
    }));
    assert!(events.iter().any(|event| {
        event["type"] == "rule_content"
            && event["category"] == "rule"
            && event["data"] == "Always use rust first"
    }));
    assert!(events.iter().any(|event| {
        event["type"] == "file_read"
            && event["category"] == "file"
            && event["data"] == "/tmp/AGENTS.md"
    }));
}

#[test]
fn session_extract_hook_events_normalizes_pi_ls_to_glob() {
    let db_path = temp_db_path("session-extract-ls");
    let request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "extract_hook_events",
            "sessionDbPath": db_path,
            "sessionId": "sess-ls",
            "hookInput": {
                "tool_name": "ls",
                "tool_input": { "pattern": "src/**/*.ts" }
            },
            "fallbackToolName": "ls"
        }
    });

    let response = call_core(request.to_string().as_bytes());
    assert_eq!(response["ok"], true);
    let events = response_text_json(&response)
        .as_array()
        .cloned()
        .expect("events array");

    assert!(events.iter().any(|event| {
        event["type"] == "file_glob"
            && event["category"] == "file"
            && event["data"] == "src/**/*.ts"
    }));
}

#[test]
fn session_extract_hook_events_persists_iteration_loop_state() {
    let db_path = temp_db_path("session-iteration-loop");
    let request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "extract_hook_events",
            "sessionDbPath": db_path,
            "sessionId": "sess-2",
            "hookInput": {
                "tool_name": "Bash",
                "tool_input": { "command": "cargo test" }
            },
            "fallbackToolName": "bash"
        }
    });

    let first = call_core(request.to_string().as_bytes());
    let second = call_core(request.to_string().as_bytes());
    let third = call_core(request.to_string().as_bytes());

    let first_events = response_text_json(&first)
        .as_array()
        .cloned()
        .expect("first array");
    let second_events = response_text_json(&second)
        .as_array()
        .cloned()
        .expect("second array");
    let third_events = response_text_json(&third)
        .as_array()
        .cloned()
        .expect("third array");

    assert!(
        !first_events
            .iter()
            .any(|event| event["type"] == "retry_detected")
    );
    assert!(
        !second_events
            .iter()
            .any(|event| event["type"] == "retry_detected")
    );
    assert!(third_events.iter().any(|event| {
        event["type"] == "retry_detected"
            && event["category"] == "iteration-loop"
            && event["data"]
                .as_str()
                .unwrap_or_default()
                .contains("Bash called 3 times")
    }));
}

#[test]
fn session_extract_user_events_returns_intent_for_questions() {
    let db_path = temp_db_path("session-extract-user-events");
    let request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "extract_user_events",
            "sessionDbPath": db_path,
            "message": "Why is cargo test failing?"
        }
    });

    let response = call_core(request.to_string().as_bytes());
    assert_eq!(response["ok"], true);
    let events = response_text_json(&response)
        .as_array()
        .cloned()
        .expect("events array");
    assert!(events.iter().any(|event| {
        event["type"] == "intent" && event["category"] == "intent" && event["data"] == "investigate"
    }));
}

#[test]
fn session_build_resume_snapshot_returns_xml() {
    let db_path = temp_db_path("session-build-resume-snapshot");
    let request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "build_resume_snapshot",
            "sessionDbPath": db_path,
            "compactCount": 2,
            "events": [
                { "type": "file_read", "category": "file", "data": "src/pi/extension.ts", "priority": 1 },
                { "type": "decision", "category": "decision", "data": "keep the rust path", "priority": 2 },
                { "type": "intent", "category": "intent", "data": "implement", "priority": 4 },
                { "type": "user_prompt", "category": "user-prompt", "data": "please continue the port", "priority": 4 }
            ]
        }
    });

    let response = call_core(request.to_string().as_bytes());
    assert_eq!(response["ok"], true);
    let snapshot =
        serde_json::from_str::<String>(&response_text(&response)).expect("snapshot string");

    assert!(snapshot.contains("<session_resume"));
    assert!(snapshot.contains("compact_count=\"2\""));
    assert!(snapshot.contains("<files count=\"1\">"));
    assert!(snapshot.contains("<decisions count=\"1\">"));
    assert!(snapshot.contains("<intent mode=\"implement\"/>"));
    assert!(snapshot.contains("<recent_user_messages count=\"1\">"));
}

#[test]
fn run_shell_command_respects_bash_deny_patterns_from_project_settings() {
    let project_dir = std::env::temp_dir().join(format!(
        "context-guard-policy-shell-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(project_dir.join(".pi")).expect("create project .pi");
    std::fs::write(
        project_dir.join(".pi/settings.local.json"),
        r#"{"permissions":{"deny":["Bash(sudo *)"]}}"#,
    )
    .expect("write settings");

    let request = serde_json::json!({
        "command": "run",
        "params": {
            "language": "shell",
            "code": "sudo rm -rf /tmp/example",
            "projectDir": project_dir,
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response_text(&response);

    assert_eq!(response["ok"], false);
    assert!(text.contains("Command blocked by security policy"));
}

#[test]
fn run_shell_command_denies_bare_command_when_deny_glob_ends_with_star() {
    let project_dir = std::env::temp_dir().join(format!(
        "context-guard-policy-shell-bare-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(project_dir.join(".pi")).expect("create project .pi");
    std::fs::write(
        project_dir.join(".pi/settings.local.json"),
        r#"{"permissions":{"deny":["Bash(sudo *)"]}}"#,
    )
    .expect("write settings");

    let request = serde_json::json!({
        "command": "run",
        "params": {
            "language": "shell",
            "code": "sudo",
            "projectDir": project_dir,
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response_text(&response);

    assert_eq!(response["ok"], false);
    assert!(text.contains("Command blocked by security policy"));
}

#[test]
fn run_javascript_command_respects_embedded_shell_deny_patterns() {
    let project_dir = std::env::temp_dir().join(format!(
        "context-guard-policy-js-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(project_dir.join(".pi")).expect("create project .pi");
    std::fs::write(
        project_dir.join(".pi/settings.local.json"),
        r#"{"permissions":{"deny":["Bash(rm -rf *)"]}}"#,
    )
    .expect("write settings");

    let request = serde_json::json!({
        "command": "run",
        "params": {
            "language": "javascript",
            "code": "require('node:child_process').execSync('rm -rf /tmp/example'); console.log('unsafe');",
            "projectDir": project_dir,
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response_text(&response);

    assert_eq!(response["ok"], false);
    assert!(text.contains("embedded shell command"));
}

#[test]
fn process_file_respects_read_deny_patterns() {
    let project_dir = std::env::temp_dir().join(format!(
        "context-guard-policy-read-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(project_dir.join(".pi")).expect("create project .pi");
    std::fs::write(
        project_dir.join(".pi/settings.local.json"),
        r#"{"permissions":{"deny":["Read(secret/**)"]}}"#,
    )
    .expect("write settings");

    let denied_path = project_dir.join("secret/data.txt");
    std::fs::create_dir_all(denied_path.parent().expect("parent dir")).expect("create secret dir");
    std::fs::write(&denied_path, "top secret").expect("write denied file");

    let request = serde_json::json!({
        "command": "process_file",
        "params": {
            "path": denied_path,
            "language": "shell",
            "code": "printf ok",
            "projectDir": project_dir,
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let text = response_text(&response);

    assert_eq!(response["ok"], false);
    assert!(text.contains("File access blocked by security policy"));
}

#[test]
fn session_prepare_before_agent_start_returns_active_memory_and_consumes_resume() {
    let session_db_path = temp_db_path("session-before-agent-start");

    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-b",
            "projectDir": "/tmp/project"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let events_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "events",
            "sessionDbPath": session_db_path,
            "sessionId": "session-b",
            "projectDir": "/tmp/project",
            "sourceHook": "PostToolUse",
            "events": [
                { "type": "role", "category": "role", "data": "You are a senior engineer", "priority": 3 },
                { "type": "decision", "category": "decision", "data": "Prefer the Rust boundary", "priority": 3 },
                { "type": "skill", "category": "skill", "data": "sym", "priority": 3 },
                { "type": "intent", "category": "intent", "data": "implement", "priority": 4 }
            ]
        }
    });
    assert_eq!(call_core(events_request.to_string().as_bytes())["ok"], true);

    let resume_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "upsert_resume",
            "sessionDbPath": session_db_path,
            "sessionId": "session-b",
            "snapshot": "<resume>carry this forward</resume>",
            "eventCount": 4
        }
    });
    assert_eq!(call_core(resume_request.to_string().as_bytes())["ok"], true);

    let prepare_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "prepare_before_agent_start",
            "sessionDbPath": session_db_path,
            "sessionId": "session-b",
            "projectDir": "/tmp/project",
            "message": "please keep going",
            "systemPrompt": "base prompt"
        }
    });
    let prepare_response = call_core(prepare_request.to_string().as_bytes());
    let prepare_json = response_text_json(&prepare_response);
    let active_memory = prepare_json["activeMemory"]
        .as_str()
        .expect("active memory");
    let resume_snapshot = prepare_json["resumeSnapshot"]
        .as_str()
        .expect("resume snapshot");
    let system_prompt = prepare_json["systemPrompt"]
        .as_str()
        .expect("system prompt");

    assert_eq!(prepare_response["ok"], true);
    assert!(active_memory.contains("<behavioral_directive>"));
    assert!(active_memory.contains("Prefer the Rust boundary"));
    assert!(active_memory.contains("<active_skills>"));
    assert!(active_memory.contains("<session_mode>implement</session_mode>"));
    assert_eq!(resume_snapshot, "<resume>carry this forward</resume>");
    assert!(system_prompt.contains("base prompt"));
    assert!(system_prompt.contains("<context_window_protection>"));
    assert!(system_prompt.contains("Prefer the Rust boundary"));
    assert!(system_prompt.contains("<resume>carry this forward</resume>"));

    let query_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "query",
            "sessionDbPath": session_db_path,
            "sessionId": "session-b",
            "includeResume": true,
            "includeEventCount": true,
            "limit": 20
        }
    });
    let query_response = call_core(query_request.to_string().as_bytes());
    let query_json = response_text_json(&query_response);
    assert_eq!(query_json["resume"]["consumed"], true);
    assert_eq!(query_json["eventCount"], 6);
    assert!(
        query_json["events"]
            .as_array()
            .expect("events array")
            .iter()
            .any(|event| {
                event["category"] == "user-prompt"
                    && event["type"] == "user_prompt"
                    && event["data"] == "please keep going"
            })
    );
}

#[test]
fn session_prepare_before_agent_start_uses_recent_high_priority_events() {
    let session_db_path = temp_db_path("session-before-agent-start-recent");
    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-c",
            "projectDir": "/tmp/project"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let events = (0..60)
        .map(|index| {
            serde_json::json!({
                "type": "role",
                "category": "role",
                "data": format!("role {index}"),
                "priority": 3
            })
        })
        .collect::<Vec<_>>();
    let events_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "events",
            "sessionDbPath": session_db_path,
            "sessionId": "session-c",
            "projectDir": "/tmp/project",
            "sourceHook": "PostToolUse",
            "events": events
        }
    });
    assert_eq!(call_core(events_request.to_string().as_bytes())["ok"], true);

    let prepare_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "prepare_before_agent_start",
            "sessionDbPath": session_db_path,
            "sessionId": "session-c",
            "projectDir": "/tmp/project",
            "message": "",
            "systemPrompt": "base prompt"
        }
    });
    let prepare_response = call_core(prepare_request.to_string().as_bytes());
    let prepare_json = response_text_json(&prepare_response);
    let active_memory = prepare_json["activeMemory"]
        .as_str()
        .expect("active memory");
    let system_prompt = prepare_json["systemPrompt"]
        .as_str()
        .expect("system prompt");

    assert_eq!(prepare_response["ok"], true);
    assert!(active_memory.contains("role 59"));
    assert!(!active_memory.contains("role 0"));
    assert!(system_prompt.contains("<context_window_protection>"));
    assert!(system_prompt.contains("role 59"));
}

#[test]
fn session_record_provider_response_persists_event() {
    let session_db_path = temp_db_path("session-provider-response");
    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-d",
            "projectDir": "/tmp/project"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let record_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "record_provider_response",
            "sessionDbPath": session_db_path,
            "sessionId": "session-d",
            "projectDir": "/tmp/project",
            "providerMeta": {
                "model": "gpt-test",
                "provider": "openai",
                "latencyMs": 12
            }
        }
    });
    assert_eq!(call_core(record_request.to_string().as_bytes())["ok"], true);

    let query_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "query",
            "sessionDbPath": session_db_path,
            "sessionId": "session-d",
            "limit": 10
        }
    });
    let query_response = call_core(query_request.to_string().as_bytes());
    let query_json = response_text_json(&query_response);
    assert!(
        query_json["events"]
            .as_array()
            .expect("events array")
            .iter()
            .any(|event| {
                event["type"] == "provider_response"
                    && event["category"] == "pi"
                    && event["data"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("\"model\":\"gpt-test\"")
            })
    );
}

#[test]
fn session_prepare_before_compact_upserts_resume_snapshot() {
    let session_db_path = temp_db_path("session-before-compact");
    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-e",
            "projectDir": "/tmp/project"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let events_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "events",
            "sessionDbPath": session_db_path,
            "sessionId": "session-e",
            "projectDir": "/tmp/project",
            "sourceHook": "PostToolUse",
            "events": [
                { "type": "file_read", "category": "file", "data": "src/pi/extension.ts", "priority": 1 },
                { "type": "intent", "category": "intent", "data": "implement", "priority": 4 }
            ]
        }
    });
    assert_eq!(call_core(events_request.to_string().as_bytes())["ok"], true);

    let prepare_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "prepare_before_compact",
            "sessionDbPath": session_db_path,
            "sessionId": "session-e"
        }
    });
    let prepare_response = call_core(prepare_request.to_string().as_bytes());
    let prepare_json = response_text_json(&prepare_response);
    assert_eq!(prepare_response["ok"], true);
    assert_eq!(prepare_json["eventCount"], 2);
    assert!(
        prepare_json["snapshot"]
            .as_str()
            .unwrap_or_default()
            .contains("<session_resume")
    );

    let query_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "query",
            "sessionDbPath": session_db_path,
            "sessionId": "session-e",
            "includeResume": true
        }
    });
    let query_response = call_core(query_request.to_string().as_bytes());
    let query_json = response_text_json(&query_response);
    assert!(
        query_json["resume"]["snapshot"]
            .as_str()
            .unwrap_or_default()
            .contains("<session_resume")
    );
}

#[test]
fn session_check_tool_call_blocks_inline_http_bash_commands() {
    let request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "check_tool_call",
            "sessionDbPath": temp_db_path("session-check-tool-call"),
            "hookInput": {
                "tool_name": "bash",
                "tool_input": {
                    "command": "curl https://example.com"
                }
            }
        }
    });
    let response = call_core(request.to_string().as_bytes());
    let json = response_text_json(&response);

    assert_eq!(response["ok"], true);
    assert_eq!(json["block"], true);
    assert!(
        json["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("inline HTTP clients")
    );
}

#[test]
fn session_build_pi_check_renders_session_summary() {
    let session_db_path = temp_db_path("session-build-pi-check");
    let init_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "init",
            "sessionDbPath": session_db_path,
            "sessionId": "session-f",
            "projectDir": "/tmp/project"
        }
    });
    assert_eq!(call_core(init_request.to_string().as_bytes())["ok"], true);

    let events_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "events",
            "sessionDbPath": session_db_path,
            "sessionId": "session-f",
            "projectDir": "/tmp/project",
            "sourceHook": "PostToolUse",
            "events": [
                { "type": "intent", "category": "intent", "data": "implement", "priority": 4 }
            ]
        }
    });
    assert_eq!(call_core(events_request.to_string().as_bytes())["ok"], true);

    let compact_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "prepare_before_compact",
            "sessionDbPath": session_db_path,
            "sessionId": "session-f"
        }
    });
    assert_eq!(
        call_core(compact_request.to_string().as_bytes())["ok"],
        true
    );

    let db_path = temp_db_path("session-build-pi-check-db");
    std::fs::write(&db_path, "").expect("touch db path");
    let check_request = serde_json::json!({
        "command": "session",
        "params": {
            "action": "build_pi_check",
            "sessionDbPath": session_db_path,
            "sessionId": "session-f",
            "dbPath": db_path,
            "pluginRoot": "/tmp/plugin",
            "projectDir": "/tmp/project"
        }
    });
    let response = call_core(check_request.to_string().as_bytes());
    let text = response_text(&response);

    assert_eq!(response["ok"], true);
    assert!(text.contains("## cg-check (Pi)"));
    assert!(text.contains("- DB exists: true"));
    assert!(text.contains("- Session ID: `session-"));
    assert!(text.contains("- Events: 1"));
    assert!(text.contains("- Resume snapshot: available"));
}
