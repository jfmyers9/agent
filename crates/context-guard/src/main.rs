mod security_policy;
mod session_store;

use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::types::Value;
use rusqlite::{Connection, Transaction, TransactionBehavior, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Clone, Default, Serialize)]
struct OperationMetrics {
    #[serde(rename = "rawBytes")]
    raw_bytes: usize,
    #[serde(rename = "indexedBytes")]
    indexed_bytes: usize,
    #[serde(rename = "returnedBytes")]
    returned_bytes: usize,
    #[serde(rename = "omittedBytes")]
    omitted_bytes: usize,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
    success: bool,
}

struct ExecutionOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    raw_bytes: usize,
    elapsed_ms: u64,
}

const MAX_INLINE_OUTPUT_BYTES: usize = 20_000;
const MAX_FAILURE_PREVIEW_BYTES: usize = 2_000;
const MAX_CAPTURE_BYTES_PER_STREAM: usize = 2 * 1024 * 1024;
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(100);
const MAX_FILE_CONTENT_ENV_BYTES: usize = 64 * 1024;
const MAX_MARKDOWN_CHUNK_BYTES: usize = 12_000;
const MAX_FETCH_PREVIEW_CHARS: usize = 3_000;
const MAX_FETCH_BODY_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_FETCH_CONNECT_TIMEOUT_MS: u64 = 10_000;
const MAX_SEARCH_SNIPPET_CHARS: usize = 500;
const MAX_STATUS_SOURCES: usize = 5;
const FETCH_CACHE_TTL_HOURS: i64 = 24;
const EXECUTION_RETENTION_DAYS: i64 = 14;
const MAX_EXECUTION_INDEX_BYTES: i64 = 64 * 1024 * 1024;
const CONTEXT_SCHEMA_VERSION: i64 = 2;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_millis(750);
#[derive(Deserialize)]
struct CoreRequest {
    command: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Deserialize)]
struct RunParams {
    language: String,
    code: String,
    timeout: Option<u64>,
    background: Option<bool>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
}

#[derive(Deserialize)]
struct ProcessFileParams {
    path: String,
    language: String,
    code: String,
    timeout: Option<u64>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
}

#[derive(Deserialize)]
struct IndexParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    content: Option<String>,
    path: Option<String>,
    source: Option<String>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
}

#[derive(Deserialize)]
struct SearchParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    query: Option<String>,
    queries: Option<Vec<String>>,
    limit: Option<usize>,
    source: Option<String>,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
    sort: Option<String>,
}

#[derive(Deserialize)]
struct PurgeParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    #[serde(rename = "sessionDbPath")]
    session_db_path: Option<String>,
    confirm: bool,
    scope: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Clone, Deserialize)]
struct BatchCommand {
    label: String,
    command: String,
}

#[derive(Deserialize)]
struct BatchParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    commands: Vec<BatchCommand>,
    queries: Option<Vec<String>>,
    timeout: Option<u64>,
    concurrency: Option<usize>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
}

#[derive(Deserialize)]
struct FetchParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    url: Option<String>,
    source: Option<String>,
    requests: Option<Vec<FetchRequest>>,
    concurrency: Option<usize>,
    force: Option<bool>,
    timeout: Option<u64>,
}

#[derive(Deserialize)]
struct FetchRequest {
    url: String,
    source: Option<String>,
}

#[derive(Deserialize)]
struct StatusParams {
    #[serde(rename = "dbPath")]
    db_path: String,
    #[serde(rename = "sessionDbPath")]
    session_db_path: Option<String>,
    #[serde(rename = "sessionsDir")]
    sessions_dir: Option<String>,
    version: Option<String>,
    cwd: Option<String>,
}

#[derive(Clone)]
struct Chunk {
    title: String,
    content: String,
    has_code: bool,
}

struct IndexDocument {
    label: String,
    text: String,
    file_path: Option<String>,
    content_hash: Option<String>,
}

struct IndexSummary {
    total_chunks: usize,
    code_chunks: usize,
}

struct SearchMatch {
    origin: String,
    source: String,
    title: String,
    content: String,
    timestamp: Option<String>,
}

struct LegacyChunk {
    source: String,
    title: String,
    content: String,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| format!("failed to read request: {err}"))?;

    let request: CoreRequest =
        serde_json::from_str(&input).map_err(|err| format!("invalid request JSON: {err}"))?;

    match request.command.as_str() {
        "check" => write_text_response("context-guard check\n\n[OK] Rust core: available", false),
        "run" => run_command(request.params),
        "process_file" => process_file_command(request.params),
        "index" => index_command(request.params),
        "search" => search_command(request.params),
        "purge" => purge_command(request.params),
        "batch" => batch_command(request.params),
        "fetch" => fetch_command(request.params),
        "status" => status_command(request.params),
        "session" => session_store::command(request.params),
        command => Err(format!("unsupported command: {command}")),
    }
}

fn maybe_deny_shell_command(command: &str, project_dir: Option<&str>) -> Option<String> {
    let policies = security_policy::read_bash_policies(project_dir);
    security_policy::evaluate_command_deny_only(command, &policies, cfg!(windows)).map(|pattern| {
        format!("Command blocked by security policy: matches deny pattern {pattern}")
    })
}

fn maybe_deny_embedded_shell(
    code: &str,
    language: &str,
    project_dir: Option<&str>,
) -> Option<String> {
    let commands = security_policy::extract_shell_commands(code, language);
    if commands.is_empty() {
        return None;
    }
    let policies = security_policy::read_bash_policies(project_dir);
    for command in commands {
        if let Some(pattern) =
            security_policy::evaluate_command_deny_only(&command, &policies, cfg!(windows))
        {
            return Some(format!(
                "Command blocked by security policy: embedded shell command \"{command}\" matches deny pattern {pattern}"
            ));
        }
    }
    None
}

fn maybe_deny_file_path(file_path: &str, project_dir: Option<&str>) -> Option<String> {
    let deny_globs = security_policy::read_tool_deny_patterns("Read", project_dir);
    security_policy::evaluate_file_path(file_path, &deny_globs, cfg!(windows), project_dir).map(
        |pattern| {
            format!(
                "File access blocked by security policy: path matches Read deny pattern {pattern}"
            )
        },
    )
}

fn run_command(params: serde_json::Value) -> Result<(), String> {
    let params: RunParams =
        serde_json::from_value(params).map_err(|err| format!("invalid run params: {err}"))?;
    let deny = if params.language == "shell" {
        maybe_deny_shell_command(&params.code, params.project_dir.as_deref())
    } else {
        maybe_deny_embedded_shell(
            &params.code,
            &params.language,
            params.project_dir.as_deref(),
        )
    };
    if let Some(message) = deny {
        return write_text_response(&message, true);
    }
    match execute_code(
        &params.language,
        &params.code,
        None,
        params.timeout,
        params.background.unwrap_or(false),
    ) {
        Ok(output) => write_execution_response("Command", output),
        Err(err) => write_text_response(
            &format!("failed to execute {} command: {err}", params.language),
            true,
        ),
    }
}

fn process_file_command(params: serde_json::Value) -> Result<(), String> {
    let params: ProcessFileParams = serde_json::from_value(params)
        .map_err(|err| format!("invalid process_file params: {err}"))?;
    let resolved_path = if Path::new(&params.path).is_absolute() {
        params.path.clone()
    } else if let Some(project_dir) = params.project_dir.as_deref() {
        Path::new(project_dir)
            .join(&params.path)
            .to_string_lossy()
            .into_owned()
    } else {
        params.path.clone()
    };
    if let Some(message) = maybe_deny_file_path(&resolved_path, params.project_dir.as_deref()) {
        return write_text_response(&message, true);
    }
    let deny = if params.language == "shell" {
        maybe_deny_shell_command(&params.code, params.project_dir.as_deref())
    } else {
        maybe_deny_embedded_shell(
            &params.code,
            &params.language,
            params.project_dir.as_deref(),
        )
    };
    if let Some(message) = deny {
        return write_text_response(&message, true);
    }
    let file_content = fs::read_to_string(&resolved_path)
        .map_err(|err| format!("failed to read {}: {err}", resolved_path))?;
    let file_bytes = file_content.len();
    match execute_code(
        &params.language,
        &params.code,
        Some(file_content),
        params.timeout,
        false,
    ) {
        Ok(mut output) => {
            output.raw_bytes = output.raw_bytes.saturating_add(file_bytes);
            write_execution_response("File processor", output)
        }
        Err(err) => write_text_response(
            &format!("failed to execute {} processor: {err}", params.language),
            true,
        ),
    }
}

fn execute_code(
    language: &str,
    code: &str,
    file_content: Option<String>,
    timeout_ms: Option<u64>,
    background: bool,
) -> Result<ExecutionOutput, String> {
    let file_content_path = file_content
        .as_ref()
        .map(|content| write_temp_file_content(content))
        .transpose()?;
    let mut command = match language {
        "shell" => {
            let mut command = Command::new("sh");
            command.arg("-c").arg(code);
            command
        }
        "javascript" => {
            let mut command = Command::new("node");
            command.arg("-e").arg(format!(
                "const fs = require('node:fs');\nconst FILE_CONTENT = process.env.FILE_CONTENT_PATH ? fs.readFileSync(process.env.FILE_CONTENT_PATH, 'utf8') : (process.env.FILE_CONTENT ?? \"\");\n{code}"
            ));
            command
        }
        "typescript" => {
            let mut command = Command::new("node");
            command
                .arg("--experimental-strip-types")
                .arg("-e")
                .arg(format!(
                    "const fs = require('node:fs');\nconst FILE_CONTENT = process.env.FILE_CONTENT_PATH ? fs.readFileSync(process.env.FILE_CONTENT_PATH, 'utf8') : (process.env.FILE_CONTENT ?? \"\");\n{code}"
                ));
            command
        }
        "python" => {
            let mut command = Command::new("python3");
            command.arg("-c").arg(format!(
                "import os\nFILE_CONTENT = open(os.environ['FILE_CONTENT_PATH'], encoding='utf-8').read() if os.environ.get('FILE_CONTENT_PATH') else os.environ.get('FILE_CONTENT', '')\n{code}"
            ));
            command
        }
        other => return Err(format!("unsupported language in Rust core: {other}")),
    };

    command.env_clear();
    command.envs(build_safe_env());
    if let Some(path) = file_content_path.as_deref() {
        command.env("FILE_CONTENT_PATH", path);
        if let Some(content) = file_content.as_ref()
            && content.len() <= MAX_FILE_CONTENT_ENV_BYTES
        {
            command.env("FILE_CONTENT", content);
        }
    } else if let Some(content) = file_content {
        command.env("FILE_CONTENT", content);
    }

    let output = run_with_timeout(command, timeout_ms, background);
    if let Some(path) = file_content_path {
        let _ = fs::remove_file(path);
    }
    output
}

fn write_temp_file_content(content: &str) -> Result<String, String> {
    let path = env::temp_dir().join(format!(
        "context-guard-file-content-{}-{}.txt",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("system time before epoch: {err}"))?
            .as_nanos()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|err| {
        format!(
            "failed to write temporary FILE_CONTENT at {}: {err}",
            path.to_string_lossy()
        )
    })?;
    file.write_all(content.as_bytes()).map_err(|err| {
        format!(
            "failed to populate temporary FILE_CONTENT at {}: {err}",
            path.to_string_lossy()
        )
    })?;
    Ok(path.to_string_lossy().into_owned())
}

fn build_safe_env() -> HashMap<String, String> {
    let denied: HashSet<&'static str> = HashSet::from([
        "BASH_ENV",
        "ENV",
        "PROMPT_COMMAND",
        "PS4",
        "SHELLOPTS",
        "BASHOPTS",
        "CDPATH",
        "INPUTRC",
        "BASH_XTRACEFD",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONSTARTUP",
        "PYTHONHOME",
        "PYTHONWARNINGS",
        "PYTHONBREAKPOINT",
        "PYTHONINSPECT",
        "RUBYOPT",
        "RUBYLIB",
        "PERL5OPT",
        "PERL5LIB",
        "PERLLIB",
        "PERL5DB",
        "GOFLAGS",
        "CGO_CFLAGS",
        "CGO_LDFLAGS",
        "RUSTC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "CARGO_BUILD_RUSTC",
        "CARGO_BUILD_RUSTC_WRAPPER",
        "RUSTFLAGS",
        "PHPRC",
        "PHP_INI_SCAN_DIR",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "OPENSSL_CONF",
        "OPENSSL_ENGINES",
        "CC",
        "CXX",
        "AR",
        "GIT_TEMPLATE_DIR",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_EXEC_PATH",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_ASKPASS",
    ]);

    let mut safe = HashMap::new();
    for (key, value) in env::vars() {
        if denied.contains(key.as_str())
            || key.starts_with("BASH_FUNC_")
            || key.to_ascii_lowercase().starts_with("complus_")
        {
            continue;
        }
        safe.insert(key, value);
    }

    let tmpdir = env::temp_dir().to_string_lossy().to_string();
    let real_home = safe
        .get("HOME")
        .cloned()
        .or_else(|| safe.get("USERPROFILE").cloned())
        .unwrap_or_else(|| tmpdir.clone());

    safe.insert("TMPDIR".to_string(), tmpdir);
    safe.insert("HOME".to_string(), real_home);
    safe.insert("LANG".to_string(), "en_US.UTF-8".to_string());
    safe.insert("PYTHONDONTWRITEBYTECODE".to_string(), "1".to_string());
    safe.insert("PYTHONUNBUFFERED".to_string(), "1".to_string());
    safe.insert("PYTHONUTF8".to_string(), "1".to_string());
    safe.insert("NO_COLOR".to_string(), "1".to_string());

    if cfg!(windows) {
        if !safe.contains_key("PATH") {
            if let Some(path) = safe.get("Path").cloned() {
                safe.insert("PATH".to_string(), path);
            } else {
                safe.insert("PATH".to_string(), String::new());
            }
        }
    } else if !safe.contains_key("PATH") {
        safe.insert(
            "PATH".to_string(),
            "/usr/local/bin:/usr/bin:/bin".to_string(),
        );
    }

    safe
}

fn run_with_timeout(
    mut command: Command,
    timeout_ms: Option<u64>,
    background: bool,
) -> Result<ExecutionOutput, String> {
    if background {
        return run_background_command(command, timeout_ms);
    }

    let started = Instant::now();
    configure_child_process_group(&mut command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to spawn process: {err}"))?;
    let stdout_reader = drain_output(child.stdout.take().expect("stdout was piped"));
    let stderr_reader = drain_output(child.stderr.take().expect("stderr was piped"));
    let deadline =
        timeout_ms.and_then(|timeout| Instant::now().checked_add(Duration::from_millis(timeout)));

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // A completed foreground command must not leave descendants holding
                // capture pipes open. Long-lived work belongs in background mode.
                terminate_process_group(child.id());
                return collect_output(status, stdout_reader, stderr_reader, started);
            }
            Ok(None) if deadline.is_some_and(|deadline| Instant::now() >= deadline) => {
                let timeout_ms = timeout_ms.expect("deadline requires timeout");
                let status = terminate_child_tree(&mut child)?;
                let partial = collect_output(status, stdout_reader, stderr_reader, started).ok();
                return Err(format_timeout_error(timeout_ms, partial.as_ref()));
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(err) => {
                let _ = terminate_child_tree(&mut child);
                return Err(format!("failed to wait for process: {err}"));
            }
        }
    }
}

fn run_background_command(
    mut command: Command,
    timeout_ms: Option<u64>,
) -> Result<ExecutionOutput, String> {
    let started = Instant::now();
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to spawn process: {err}"))?;
    let deadline =
        timeout_ms.and_then(|timeout| Instant::now().checked_add(Duration::from_millis(timeout)));

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(ExecutionOutput {
                    status,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    raw_bytes: 0,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
            Ok(None) if deadline.is_some_and(|deadline| Instant::now() >= deadline) => {
                return Ok(backgrounded_output(
                    timeout_ms.expect("deadline requires timeout"),
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(5)),
            Err(err) => return Err(format!("failed to wait for background process: {err}")),
        }
    }
}

struct StreamCapture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total_bytes: usize,
}

impl StreamCapture {
    fn new() -> Self {
        Self {
            head: Vec::with_capacity(MAX_CAPTURE_BYTES_PER_STREAM / 2),
            tail: VecDeque::with_capacity(MAX_CAPTURE_BYTES_PER_STREAM / 2),
            total_bytes: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        let head_limit = MAX_CAPTURE_BYTES_PER_STREAM / 2;
        let tail_limit = MAX_CAPTURE_BYTES_PER_STREAM - head_limit;
        let head_bytes = (head_limit - self.head.len()).min(bytes.len());
        self.head.extend_from_slice(&bytes[..head_bytes]);
        self.tail.extend(&bytes[head_bytes..]);
        if self.tail.len() > tail_limit {
            self.tail.drain(..self.tail.len() - tail_limit);
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        let retained = self.head.len() + self.tail.len();
        let mut output = Vec::with_capacity(retained + 128);
        output.extend_from_slice(&self.head);
        if self.total_bytes > retained {
            output.extend_from_slice(
                format!(
                    "\n[Context Guard truncated {} bytes from this stream]\n",
                    self.total_bytes - retained
                )
                .as_bytes(),
            );
        }
        output.extend(self.tail.iter().copied());
        output
    }
}

struct OutputReader {
    capture: Arc<Mutex<StreamCapture>>,
    handle: thread::JoinHandle<io::Result<()>>,
}

struct StreamSnapshot {
    bytes: Vec<u8>,
    total_bytes: usize,
}

fn drain_output<R: Read + Send + 'static>(mut reader: R) -> OutputReader {
    let capture = Arc::new(Mutex::new(StreamCapture::new()));
    let writer_capture = Arc::clone(&capture);
    let handle = thread::spawn(move || {
        let mut buffer = [0; 8 * 1024];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(bytes_read) => {
                    writer_capture
                        .lock()
                        .map_err(|_| io::Error::other("output capture lock poisoned"))?
                        .push(&buffer[..bytes_read]);
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(err),
            }
        }
    });
    OutputReader { capture, handle }
}

fn collect_output(
    status: ExitStatus,
    stdout_reader: OutputReader,
    stderr_reader: OutputReader,
    started: Instant,
) -> Result<ExecutionOutput, String> {
    let drain_deadline = Instant::now() + OUTPUT_DRAIN_GRACE;
    while !(stdout_reader.handle.is_finished() && stderr_reader.handle.is_finished())
        && Instant::now() < drain_deadline
    {
        thread::sleep(Duration::from_millis(2));
    }
    let stdout = finish_output_reader("stdout", stdout_reader)?;
    let stderr = finish_output_reader("stderr", stderr_reader)?;
    Ok(ExecutionOutput {
        status,
        raw_bytes: stdout.total_bytes.saturating_add(stderr.total_bytes),
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn finish_output_reader(stream_name: &str, reader: OutputReader) -> Result<StreamSnapshot, String> {
    if reader.handle.is_finished() {
        reader
            .handle
            .join()
            .map_err(|_| format!("{stream_name} reader panicked"))?
            .map_err(|err| format!("failed to collect process {stream_name}: {err}"))?;
    }
    let capture = reader
        .capture
        .lock()
        .map_err(|_| format!("failed to snapshot process {stream_name}"))?;
    Ok(StreamSnapshot {
        bytes: capture.snapshot(),
        total_bytes: capture.total_bytes,
    })
}

#[cfg(unix)]
fn configure_child_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_child_process_group(_command: &mut Command) {}

fn terminate_child_tree(child: &mut Child) -> Result<ExitStatus, String> {
    terminate_process_group(child.id());
    let _ = child.kill();
    child
        .wait()
        .map_err(|err| format!("failed to reap timed-out process: {err}"))
}

#[cfg(unix)]
fn terminate_process_group(process_id: u32) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    if let Ok(process_group) = i32::try_from(process_id) {
        // The child is placed in a process group whose id equals its pid.
        let _ = unsafe { kill(-process_group, SIGKILL) };
    }
}

#[cfg(windows)]
fn terminate_process_group(process_id: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn format_timeout_error(timeout_ms: u64, partial: Option<&ExecutionOutput>) -> String {
    let mut message = format!("timed out after {timeout_ms}ms");
    let Some(partial) = partial else {
        return message;
    };
    let stdout = String::from_utf8_lossy(&partial.stdout);
    let stderr = String::from_utf8_lossy(&partial.stderr);
    if !stdout.is_empty() {
        message.push_str("\n\npartial stdout:\n");
        message.push_str(&stdout);
    }
    if !stderr.is_empty() {
        message.push_str("\n\npartial stderr:\n");
        message.push_str(&stderr);
    }
    message
}

#[cfg(unix)]
fn success_exit_status() -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(0)
}

#[cfg(windows)]
fn success_exit_status() -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(0)
}

fn backgrounded_output(timeout_ms: u64) -> ExecutionOutput {
    ExecutionOutput {
        status: success_exit_status(),
        stdout: format!("Process backgrounded after {timeout_ms}ms.\n").into_bytes(),
        stderr: Vec::new(),
        raw_bytes: 0,
        elapsed_ms: timeout_ms,
    }
}

fn write_execution_response(label: &str, output: ExecutionOutput) -> Result<(), String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = if output.status.success() {
        match (stdout.is_empty(), stderr.is_empty()) {
            (false, true) => stdout.to_string(),
            (true, false) => format!("stderr:\n{stderr}"),
            (false, false) => format!("{stdout}\n\nstderr:\n{stderr}"),
            (true, true) => String::new(),
        }
    } else {
        format!(
            "{label} exited {}\n\nstdout:\n{}\n\nstderr:\n{}",
            output.status.code().unwrap_or(-1),
            stdout,
            stderr
        )
    };

    let text = if combined.is_empty() {
        "(no output)".to_string()
    } else {
        truncate_output_for_response(&combined)
    };
    let metrics = OperationMetrics {
        raw_bytes: output.raw_bytes,
        returned_bytes: text.len(),
        omitted_bytes: output.raw_bytes.saturating_sub(text.len()),
        elapsed_ms: output.elapsed_ms,
        success: output.status.success(),
        ..OperationMetrics::default()
    };
    write_text_response_with_details(
        &text,
        !output.status.success(),
        json!({ "metrics": metrics }),
    )
}

fn truncate_output_for_response(text: &str) -> String {
    if text.len() <= MAX_INLINE_OUTPUT_BYTES {
        return text.to_string();
    }
    let marker = format!(
        "\n\n[Context Guard omitted {} bytes; full captured output was indexed when this command ran through batch mode]\n\n",
        text.len() - MAX_INLINE_OUTPUT_BYTES
    );
    let payload_budget = MAX_INLINE_OUTPUT_BYTES.saturating_sub(marker.len());
    let head_end = floor_char_boundary(text, payload_budget / 2);
    let tail_start = ceil_char_boundary(text, text.len() - (payload_budget - head_end));
    format!("{}{}{}", &text[..head_end], marker, &text[tail_start..])
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn open_context_db(db_path: &str) -> Result<Connection, String> {
    if let Some(parent) = Path::new(db_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create db directory {}: {err}", parent.display()))?;
    }
    let mut conn =
        Connection::open(db_path).map_err(|err| format!("failed to open {db_path}: {err}"))?;
    configure_sqlite_connection(&conn, db_path)?;
    ensure_context_schema(&mut conn)?;
    Ok(conn)
}

fn configure_sqlite_connection(conn: &Connection, db_path: &str) -> Result<(), String> {
    conn.busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|err| format!("failed to set busy timeout for {db_path}: {err}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    )
    .map_err(|err| format!("failed to configure sqlite database {db_path}: {err}"))?;
    Ok(())
}

fn ensure_context_schema(conn: &mut Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|err| format!("failed to read content store schema version: {err}"))?;
    if version >= CONTEXT_SCHEMA_VERSION {
        return Ok(());
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start content store migration: {err}"))?;
    let legacy_rows = if is_legacy_chunks_table(&tx)? {
        Some(load_legacy_chunks(&tx)?)
    } else {
        None
    };

    if legacy_rows.is_some() {
        tx.execute_batch("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS chunks_trigram;")
            .map_err(|err| format!("failed to reset legacy schema: {err}"))?;
    }

    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL UNIQUE,
            display_label TEXT NOT NULL DEFAULT '',
            chunk_count INTEGER NOT NULL DEFAULT 0,
            code_chunk_count INTEGER NOT NULL DEFAULT 0,
            indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
            file_path TEXT,
            content_hash TEXT
        );
        CREATE TABLE IF NOT EXISTS search_usage (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            window_started_at INTEGER NOT NULL DEFAULT 0,
            call_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO search_usage(id, window_started_at, call_count) VALUES (1, 0, 0);
        CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            timestamp UNINDEXED,
            tokenize='porter unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            timestamp UNINDEXED,
            tokenize='trigram'
        );
        ",
    )
    .map_err(|err| format!("failed to initialize content store schema: {err}"))?;

    ensure_sources_metadata_columns(&tx)?;

    if let Some(rows) = legacy_rows {
        migrate_legacy_chunks(&tx, rows)?;
    }

    tx.pragma_update(None, "user_version", CONTEXT_SCHEMA_VERSION)
        .map_err(|err| format!("failed to record content store schema version: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit content store migration: {err}"))?;

    Ok(())
}

fn ensure_sources_metadata_columns(conn: &Connection) -> Result<(), String> {
    for statement in [
        "ALTER TABLE sources ADD COLUMN file_path TEXT",
        "ALTER TABLE sources ADD COLUMN content_hash TEXT",
        "ALTER TABLE sources ADD COLUMN code_chunk_count INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE sources ADD COLUMN display_label TEXT NOT NULL DEFAULT ''",
    ] {
        match conn.execute_batch(statement) {
            Ok(()) => {}
            Err(err) if err.to_string().contains("duplicate column name") => {}
            Err(err) => return Err(format!("failed to update sources schema: {err}")),
        }
    }
    Ok(())
}

fn is_legacy_chunks_table(conn: &Connection) -> Result<bool, String> {
    if !table_exists(conn, "chunks")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "chunks")?;
    Ok(columns.iter().any(|name| name == "source")
        && !columns.iter().any(|name| name == "source_id"))
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
            params![table],
            |row| row.get(0),
        )
        .map_err(|err| format!("failed to inspect sqlite schema: {err}"))?;
    Ok(count > 0)
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let pragma = format!("PRAGMA table_xinfo('{table}')");
    let mut stmt = conn
        .prepare(&pragma)
        .map_err(|err| format!("failed to inspect table {table}: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("failed to inspect columns for {table}: {err}"))?;

    let mut columns = Vec::new();
    for row in rows {
        columns.push(row.map_err(|err| format!("failed to read schema row for {table}: {err}"))?);
    }
    Ok(columns)
}

fn load_legacy_chunks(conn: &Connection) -> Result<Vec<LegacyChunk>, String> {
    let mut stmt = conn
        .prepare("SELECT source, title, content FROM chunks")
        .map_err(|err| format!("failed to read legacy chunks: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LegacyChunk {
                source: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
            })
        })
        .map_err(|err| format!("failed to iterate legacy chunks: {err}"))?;

    let mut chunks = Vec::new();
    for row in rows {
        chunks.push(row.map_err(|err| format!("failed to decode legacy chunk: {err}"))?);
    }
    Ok(chunks)
}

fn migrate_legacy_chunks(tx: &Transaction<'_>, rows: Vec<LegacyChunk>) -> Result<(), String> {
    let mut by_source: HashMap<String, Vec<Chunk>> = HashMap::new();
    for row in rows {
        by_source.entry(row.source).or_default().push(Chunk {
            title: if row.title.trim().is_empty() {
                "Untitled".to_string()
            } else {
                row.title
            },
            has_code: row.content.contains("```") || looks_like_code(&row.content),
            content: row.content,
        });
    }

    for (source, chunks) in by_source {
        replace_source_chunks_in_transaction(tx, &source, &source, &chunks, None, None)?;
    }

    Ok(())
}

fn index_command(params: serde_json::Value) -> Result<(), String> {
    let started = Instant::now();
    let params: IndexParams =
        serde_json::from_value(params).map_err(|err| format!("invalid index params: {err}"))?;
    if let Some(path) = params.path.as_deref()
        && let Some(message) = maybe_deny_file_path(path, params.project_dir.as_deref())
    {
        return write_text_response(&message, true);
    }
    let mut conn = open_context_db(&params.db_path)?;
    let document = resolve_index_document(
        params.content,
        params.path,
        params.source,
        params.project_dir.as_deref(),
    )?;
    let summary = index_markdown_source(
        &mut conn,
        &document.label,
        &document.text,
        document.file_path.as_deref(),
        document.content_hash.as_deref(),
    )?;

    let text = format!(
        "Indexed {} sections ({} with code) into Context Guard core. Use cg_search(queries: [\"...\"]) to query this content.",
        summary.total_chunks, summary.code_chunks
    );
    let raw_bytes = document.text.len();
    write_text_response_with_details(
        &text,
        false,
        json!({ "metrics": OperationMetrics {
            raw_bytes,
            indexed_bytes: raw_bytes,
            returned_bytes: text.len(),
            omitted_bytes: raw_bytes.saturating_sub(text.len()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            success: true,
        }}),
    )
}

fn resolve_index_document(
    content: Option<String>,
    path: Option<String>,
    source: Option<String>,
    project_dir: Option<&str>,
) -> Result<IndexDocument, String> {
    if content.is_some() && path.is_some() {
        return Err("Provide exactly one of content or path, not both".to_string());
    }
    let resolved_path = path
        .as_deref()
        .map(|value| resolve_project_path(project_dir, value));
    let file_path = resolved_path.clone();
    let text = match (content, resolved_path) {
        (Some(_), Some(_)) => unreachable!("content/path exclusivity checked above"),
        (Some(content), None) => content,
        (None, Some(path)) => {
            fs::read_to_string(&path).map_err(|err| format!("failed to read {path}: {err}"))?
        }
        (None, None) => return Err("Either content or path must be provided".to_string()),
    };

    let label = source
        .or_else(|| file_path.clone())
        .unwrap_or_else(|| "inline-content".to_string());
    let content_hash = file_path.as_ref().map(|_| sha256_hex(text.as_bytes()));

    Ok(IndexDocument {
        label,
        text,
        file_path,
        content_hash,
    })
}

fn resolve_project_path(project_dir: Option<&str>, raw_path: &str) -> String {
    let path = Path::new(raw_path);
    if path.is_absolute() {
        return raw_path.to_string();
    }
    if let Some(project_dir) = project_dir {
        return Path::new(project_dir)
            .join(path)
            .to_string_lossy()
            .to_string();
    }
    raw_path.to_string()
}

fn index_markdown_source(
    conn: &mut Connection,
    label: &str,
    text: &str,
    file_path: Option<&str>,
    content_hash: Option<&str>,
) -> Result<IndexSummary, String> {
    let chunks = chunk_markdown(text, MAX_MARKDOWN_CHUNK_BYTES);
    replace_source_chunks(conn, label, label, &chunks, file_path, content_hash)
}

fn index_single_chunk_source(
    conn: &mut Connection,
    label: &str,
    display_label: &str,
    title: &str,
    content: &str,
) -> Result<IndexSummary, String> {
    let chunk = Chunk {
        title: if title.trim().is_empty() {
            first_nonempty_line(content).unwrap_or_else(|| "Untitled".to_string())
        } else {
            title.trim().to_string()
        },
        content: content.to_string(),
        has_code: looks_like_code(content),
    };
    replace_source_chunks(conn, label, display_label, &[chunk], None, None)
}

fn replace_source_chunks(
    conn: &mut Connection,
    label: &str,
    display_label: &str,
    chunks: &[Chunk],
    file_path: Option<&str>,
    content_hash: Option<&str>,
) -> Result<IndexSummary, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start transaction for {label}: {err}"))?;
    let summary = replace_source_chunks_in_transaction(
        &tx,
        label,
        display_label,
        chunks,
        file_path,
        content_hash,
    )?;
    tx.commit()
        .map_err(|err| format!("failed to commit source {label}: {err}"))?;
    Ok(summary)
}

fn replace_source_chunks_in_transaction(
    tx: &Transaction<'_>,
    label: &str,
    display_label: &str,
    chunks: &[Chunk],
    file_path: Option<&str>,
    content_hash: Option<&str>,
) -> Result<IndexSummary, String> {
    let code_chunks = chunks.iter().filter(|chunk| chunk.has_code).count();
    tx.execute(
        "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?1)",
        params![label],
    )
    .map_err(|err| format!("failed to clear previous porter chunks for {label}: {err}"))?;
    tx.execute(
        "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?1)",
        params![label],
    )
    .map_err(|err| format!("failed to clear previous trigram chunks for {label}: {err}"))?;
    tx.execute("DELETE FROM sources WHERE label = ?1", params![label])
        .map_err(|err| format!("failed to clear previous source metadata for {label}: {err}"))?;
    tx.execute(
        "INSERT INTO sources(label, display_label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![label, display_label, chunks.len() as i64, code_chunks as i64, file_path, content_hash],
    )
    .map_err(|err| format!("failed to insert source metadata for {label}: {err}"))?;

    let source_id = tx.last_insert_rowid();
    for chunk in chunks {
        let content_type = if chunk.has_code { "code" } else { "prose" };
        tx.execute(
            "INSERT INTO chunks(title, content, source_id, content_type, timestamp) VALUES (?1, ?2, ?3, ?4, datetime('now'))",
            params![&chunk.title, &chunk.content, source_id, content_type],
        )
        .map_err(|err| format!("failed to insert porter chunk for {label}: {err}"))?;
        tx.execute(
            "INSERT INTO chunks_trigram(title, content, source_id, content_type, timestamp) VALUES (?1, ?2, ?3, ?4, datetime('now'))",
            params![&chunk.title, &chunk.content, source_id, content_type],
        )
        .map_err(|err| format!("failed to insert trigram chunk for {label}: {err}"))?;
    }

    Ok(IndexSummary {
        total_chunks: chunks.len(),
        code_chunks,
    })
}

fn search_command(params: serde_json::Value) -> Result<(), String> {
    let started = Instant::now();
    let params: SearchParams =
        serde_json::from_value(params).map_err(|err| format!("invalid search params: {err}"))?;

    let mut queries = params.queries.unwrap_or_default();
    if let Some(query) = params.query {
        queries.push(query);
    }
    if queries.is_empty() {
        return write_text_response("Error: provide query or queries.", true);
    }

    let mut conn = open_context_db(&params.db_path)?;
    let refreshed = refresh_stale_file_sources(&mut conn)?;
    let source_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
        .map_err(|err| format!("failed to inspect index: {err}"))?;
    if source_count == 0 {
        return write_text_response(
            "Knowledge base is empty — no content has been indexed yet.",
            true,
        );
    }

    let limit = params.limit.unwrap_or(3).clamp(1, 20);
    let context = SearchContext {
        limit,
        source_filter: params.source.as_deref(),
        content_type: params.content_type.as_deref(),
        sort: params.sort.as_deref().unwrap_or("relevance"),
        refreshed_count: refreshed,
    };
    let output = render_search(&conn, &queries, &context)?;
    write_text_response_with_details(
        &output,
        false,
        json!({ "metrics": OperationMetrics {
            raw_bytes: output.len(),
            returned_bytes: output.len(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            success: true,
            ..OperationMetrics::default()
        }}),
    )
}

struct SearchContext<'a> {
    limit: usize,
    source_filter: Option<&'a str>,
    content_type: Option<&'a str>,
    sort: &'a str,
    refreshed_count: usize,
}

fn refresh_stale_file_sources(conn: &mut Connection) -> Result<usize, String> {
    let mut stmt = conn
        .prepare("SELECT label, file_path, content_hash FROM sources WHERE file_path IS NOT NULL")
        .map_err(|err| format!("failed to inspect file-backed sources: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|err| format!("failed to read file-backed sources: {err}"))?;

    let mut sources = Vec::new();
    for row in rows {
        sources.push(row.map_err(|err| format!("failed to decode file-backed source: {err}"))?);
    }
    drop(stmt);

    let mut refreshed = 0usize;
    for (label, file_path, old_hash) in sources {
        let path = Path::new(&file_path);
        if !path.is_file() {
            deactivate_source(conn, &label)?;
            refreshed += 1;
            continue;
        }

        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(_) => {
                deactivate_source(conn, &label)?;
                refreshed += 1;
                continue;
            }
        };
        let new_hash = sha256_hex(text.as_bytes());
        if old_hash.as_deref() == Some(new_hash.as_str()) {
            continue;
        }

        index_markdown_source(conn, &label, &text, Some(&file_path), Some(&new_hash))?;
        refreshed += 1;
    }

    Ok(refreshed)
}

fn deactivate_source(conn: &mut Connection, label: &str) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start stale-source transaction for {label}: {err}"))?;
    tx.execute(
        "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?1)",
        params![label],
    )
    .map_err(|err| format!("failed to deactivate stale porter chunks for {label}: {err}"))?;
    tx.execute(
        "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?1)",
        params![label],
    )
    .map_err(|err| format!("failed to deactivate stale trigram chunks for {label}: {err}"))?;
    tx.execute(
        "UPDATE sources SET chunk_count = 0, code_chunk_count = 0, content_hash = NULL WHERE label = ?1",
        params![label],
    )
    .map_err(|err| format!("failed to deactivate stale source {label}: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit stale-source deactivation for {label}: {err}"))
}

fn render_search(
    conn: &Connection,
    queries: &[String],
    context: &SearchContext<'_>,
) -> Result<String, String> {
    let mut sections = Vec::new();
    if context.refreshed_count > 0 {
        sections.push(format!(
            "Note: updated {} stale file-backed source(s) before search.",
            context.refreshed_count
        ));
    }

    for query in queries {
        let matches = if context.sort == "timeline" {
            search_timeline(conn, query, context)?
        } else {
            search_with_fallback(
                conn,
                query,
                context.limit,
                context.source_filter,
                context.content_type,
            )?
        };
        if matches.is_empty() {
            sections.push(format!("## {query}\nNo results found."));
            continue;
        }

        let rendered = matches
            .into_iter()
            .map(|result| {
                let snippet = truncate_chars(&result.content, MAX_SEARCH_SNIPPET_CHARS);
                format!(
                    "--- [{} | {}] ---\n### {}\n{}",
                    result.origin, result.source, result.title, snippet
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("## {query}\n{rendered}"));
    }
    Ok(sections.join("\n\n"))
}

fn search_with_fallback(
    conn: &Connection,
    query: &str,
    limit: usize,
    source_filter: Option<&str>,
    content_type: Option<&str>,
) -> Result<Vec<SearchMatch>, String> {
    let porter = search_matches(
        conn,
        "chunks",
        &fts_or_query(query),
        limit,
        source_filter,
        content_type,
    )?;
    if !porter.is_empty() {
        return Ok(porter);
    }

    let trigram_query = trigram_fts_query(query);
    if trigram_query.is_empty() {
        return Ok(Vec::new());
    }
    search_matches(
        conn,
        "chunks_trigram",
        &trigram_query,
        limit,
        source_filter,
        content_type,
    )
}

fn search_timeline(
    conn: &Connection,
    query: &str,
    context: &SearchContext<'_>,
) -> Result<Vec<SearchMatch>, String> {
    let mut results = search_with_fallback(
        conn,
        query,
        context.limit,
        context.source_filter,
        context.content_type,
    )?;

    normalize_timestamps(&mut results);
    results.sort_by(|left, right| {
        left.timestamp
            .as_deref()
            .unwrap_or("")
            .cmp(right.timestamp.as_deref().unwrap_or(""))
    });
    results.truncate(context.limit);
    Ok(results)
}

fn search_matches(
    conn: &Connection,
    table: &str,
    query: &str,
    limit: usize,
    source_filter: Option<&str>,
    content_type: Option<&str>,
) -> Result<Vec<SearchMatch>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut sql = format!(
        "SELECT {table}.title, {table}.content, COALESCE(NULLIF(sources.display_label, ''), sources.label), {table}.timestamp, bm25({table}, 5.0, 1.0) AS rank \
         FROM {table} \
         JOIN sources ON sources.id = {table}.source_id \
         WHERE {table} MATCH ?1"
    );
    let mut values = vec![Value::Text(query.to_string())];

    if let Some(source) = source_filter {
        sql.push_str(" AND (sources.label LIKE ? OR sources.display_label LIKE ?)");
        values.push(Value::Text(format!("%{source}%")));
        values.push(Value::Text(format!("%{source}%")));
    }
    if let Some(kind) = content_type {
        sql.push_str(&format!(" AND {table}.content_type = ?"));
        values.push(Value::Text(kind.to_string()));
    }

    sql.push_str(" ORDER BY rank LIMIT ?");
    values.push(Value::Integer(limit as i64));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("failed to prepare search on {table}: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |row| {
            Ok(SearchMatch {
                origin: "current-session".to_string(),
                title: row.get(0)?,
                content: row.get(1)?,
                source: row.get(2)?,
                timestamp: row.get(3)?,
            })
        })
        .map_err(|err| format!("failed to search {table}: {err}"))?;

    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|err| format!("failed to read search row from {table}: {err}"))?);
    }
    Ok(matches)
}

fn normalize_timestamps(results: &mut [SearchMatch]) {
    for result in results {
        if let Some(timestamp) = result
            .timestamp
            .as_ref()
            .filter(|timestamp| !timestamp.contains('T'))
        {
            result.timestamp = Some(timestamp.replace(' ', "T") + "Z");
        }
    }
}

fn fts_or_query(query: &str) -> String {
    let terms = query_terms(query)
        .into_iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();

    if terms.is_empty() {
        "\"\"".to_string()
    } else {
        terms.join(" OR ")
    }
}

fn trigram_fts_query(query: &str) -> String {
    let cleaned = query_terms(query)
        .into_iter()
        .filter(|term| term.len() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();

    if cleaned.is_empty() {
        String::new()
    } else {
        cleaned.join(" OR ")
    }
}

fn query_terms(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|term| !term.is_empty())
        .map(|term| term.to_lowercase())
        .collect()
}

fn purge_command(params: serde_json::Value) -> Result<(), String> {
    let params: PurgeParams =
        serde_json::from_value(params).map_err(|err| format!("invalid purge params: {err}"))?;
    if !params.confirm {
        return write_text_response("Purge cancelled. Pass confirm: true to proceed.", false);
    }
    if params.session_id.is_some() && params.scope.as_deref() == Some("project") {
        return write_text_response(
            "Ambiguous purge: sessionId implies scope:'session', cannot combine with scope:'project'. Use scope:'project' WITHOUT sessionId for the legacy whole-project wipe.",
            true,
        );
    }

    let effective_scope = params.scope.clone().unwrap_or_else(|| {
        if params.session_id.is_some() {
            "session".to_string()
        } else {
            "project".to_string()
        }
    });

    if effective_scope == "session" {
        let Some(session_id) = params.session_id.as_deref() else {
            return write_text_response("Session-scoped purge requires sessionId.", true);
        };
        if let Some(session_db_path) = params.session_db_path.as_deref() {
            let deleted = session_store::purge_rows(session_db_path, session_id)?;
            let text = if deleted > 0 {
                format!("Purged: session rows for {session_id}.")
            } else {
                format!("Purged: session rows for {session_id} (no matching rows found).")
            };
            return write_text_response(&text, false);
        }
        return write_text_response(
            "Session-scoped purge requires sessionDbPath in the Rust core.",
            true,
        );
    }

    remove_sqlite_database(&params.db_path)?;
    if let Some(session_db_path) = params.session_db_path.as_deref() {
        remove_sqlite_database(session_db_path)?;
    }
    write_text_response("Purged: project index and session database.", false)
}

fn remove_sqlite_database(db_path: &str) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let path = format!("{db_path}{suffix}");
        if Path::new(&path).exists() {
            fs::remove_file(&path).map_err(|err| format!("failed to remove {path}: {err}"))?;
        }
    }
    Ok(())
}

fn batch_command(params: serde_json::Value) -> Result<(), String> {
    let started = Instant::now();
    let params: BatchParams =
        serde_json::from_value(params).map_err(|err| format!("invalid batch params: {err}"))?;
    for command in &params.commands {
        if let Some(message) =
            maybe_deny_shell_command(&command.command, params.project_dir.as_deref())
        {
            return write_text_response(&message, true);
        }
    }
    let mut output = String::new();
    let mut conn = open_context_db(&params.db_path)?;
    let concurrency = params.concurrency.unwrap_or(1).clamp(1, 8);
    let results = if concurrency <= 1 {
        execute_batch_sequential(
            &params.commands,
            params.timeout,
            params.project_dir.as_deref(),
        )?
    } else {
        execute_batch_parallel(
            &params.commands,
            concurrency,
            params.timeout,
            params.project_dir.as_deref(),
        )?
    };

    for result in &results {
        index_single_chunk_source(
            &mut conn,
            &execution_source_id(&result.command, &result.section),
            &result.label,
            &result.label,
            &result.section,
        )?;
    }
    cleanup_execution_sources(&mut conn)?;

    output.push_str(&format!("Executed {} commands.\n", params.commands.len()));
    output.push_str(&format!(
        "Concurrency: {}.\n\n",
        concurrency.min(params.commands.len().max(1))
    ));
    output.push_str("### Command inventory\n");
    for result in &results {
        output.push_str(&format!("- {}: {}\n", result.label, result.summary));
    }
    output.push('\n');
    let queries = params.queries.unwrap_or_default();
    if queries.is_empty() {
        for result in &results {
            let returned = batch_result_response(result);
            output.push_str(&format!("## {}\n{}\n\n", result.label, returned));
        }
        while output.ends_with('\n') {
            output.pop();
        }
    } else {
        let search_context = SearchContext {
            limit: 5,
            source_filter: None,
            content_type: None,
            sort: "relevance",
            refreshed_count: 0,
        };
        let search_response = render_search(&conn, &queries, &search_context)?;
        output.push_str(&search_response);
    }

    let failed_count = results
        .iter()
        .filter(|result| result.exit_code != Some(0))
        .count();
    let raw_bytes = results.iter().map(|result| result.raw_bytes).sum::<usize>();
    let indexed_bytes = results
        .iter()
        .map(|result| result.section.len())
        .sum::<usize>();
    let metrics = OperationMetrics {
        raw_bytes,
        indexed_bytes,
        returned_bytes: output.len(),
        omitted_bytes: raw_bytes.saturating_sub(output.len()),
        elapsed_ms: started.elapsed().as_millis() as u64,
        success: failed_count == 0,
    };
    let response = json!({
        "ok": failed_count == 0,
        "isError": failed_count > 0,
        "content": [{
            "type": "text",
            "text": output,
        }],
        "details": {
            "commandCount": params.commands.len(),
            "failedCount": failed_count,
            "concurrency": concurrency.min(params.commands.len().max(1)),
            "queries": queries,
            "metrics": metrics,
            "results": results.iter().map(|result| json!({
                "label": result.label,
                "command": result.command,
                "output": batch_result_response(result),
                "summary": result.summary,
                "exitCode": result.exit_code,
                "metrics": {
                    "rawBytes": result.raw_bytes,
                    "indexedBytes": result.section.len(),
                    "elapsedMs": result.elapsed_ms,
                    "success": result.exit_code == Some(0),
                },
            })).collect::<Vec<_>>(),
        }
    });
    println!(
        "{}",
        serde_json::to_string(&response)
            .map_err(|err| format!("failed to serialize batch response: {err}"))?
    );
    Ok(())
}

struct BatchCommandResult {
    label: String,
    command: String,
    section: String,
    summary: String,
    exit_code: Option<i32>,
    raw_bytes: usize,
    elapsed_ms: u64,
}

fn execution_source_id(command: &str, output: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let digest = sha256_hex(format!("{command}\0{output}").as_bytes());
    format!("__context_guard_exec_v1__{timestamp}_{}", &digest[..16])
}

fn cleanup_execution_sources(conn: &mut Connection) -> Result<usize, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start execution retention transaction: {err}"))?;
    let mut stmt = tx
        .prepare(
            "SELECT sources.id, COALESCE(SUM(LENGTH(chunks.content)), 0), \
                    datetime(sources.indexed_at) < datetime('now', ?1) \
             FROM sources LEFT JOIN chunks ON chunks.source_id = sources.id \
             WHERE sources.label LIKE '__context_guard_exec_v1__%' \
             GROUP BY sources.id ORDER BY datetime(sources.indexed_at) DESC, sources.id DESC",
        )
        .map_err(|err| format!("failed to prepare execution retention query: {err}"))?;
    let rows = stmt
        .query_map(
            params![format!("-{EXECUTION_RETENTION_DAYS} days")],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .map_err(|err| format!("failed to query execution retention: {err}"))?;
    let mut retained_bytes = 0i64;
    let mut delete_ids = Vec::new();
    for row in rows {
        let (id, bytes, expired) =
            row.map_err(|err| format!("failed to read execution retention row: {err}"))?;
        if expired || retained_bytes.saturating_add(bytes) > MAX_EXECUTION_INDEX_BYTES {
            delete_ids.push(id);
        } else {
            retained_bytes = retained_bytes.saturating_add(bytes);
        }
    }
    drop(stmt);

    for id in &delete_ids {
        tx.execute("DELETE FROM chunks WHERE source_id = ?1", params![id])
            .map_err(|err| format!("failed to delete retained porter chunks: {err}"))?;
        tx.execute(
            "DELETE FROM chunks_trigram WHERE source_id = ?1",
            params![id],
        )
        .map_err(|err| format!("failed to delete retained trigram chunks: {err}"))?;
        tx.execute("DELETE FROM sources WHERE id = ?1", params![id])
            .map_err(|err| format!("failed to delete retained source: {err}"))?;
    }
    tx.commit()
        .map_err(|err| format!("failed to commit execution retention: {err}"))?;
    conn.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);")
        .map_err(|err| format!("failed to maintain content store: {err}"))?;
    Ok(delete_ids.len())
}

fn batch_result_response(result: &BatchCommandResult) -> String {
    if result.section.len() <= MAX_INLINE_OUTPUT_BYTES {
        return result.section.clone();
    }
    let omitted = result.section.len();
    let mut response = format!(
        "Output indexed ({omitted} bytes). Use cg_search with source {:?} for details.",
        result.label
    );
    if result.exit_code != Some(0) {
        let tail_start = ceil_char_boundary(
            &result.section,
            result
                .section
                .len()
                .saturating_sub(MAX_FAILURE_PREVIEW_BYTES),
        );
        response.push_str("\n\nFailure tail:\n");
        response.push_str(&result.section[tail_start..]);
    }
    response
}

fn execute_batch_single(
    command: &BatchCommand,
    timeout: Option<u64>,
    cwd: Option<&str>,
) -> BatchCommandResult {
    let mut process = Command::new("sh");
    process.arg("-c").arg(&command.command);
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }

    match run_with_timeout(process, timeout, false) {
        Ok(result) => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let section = match (stdout.is_empty(), stderr.is_empty()) {
                (false, true) => stdout.to_string(),
                (true, false) => stderr.to_string(),
                (false, false) => format!("{stdout}\n\nstderr:\n{stderr}"),
                (true, true) => String::new(),
            };
            let summary = if result.status.success() {
                "ok".to_string()
            } else {
                format!("exit {}", result.status.code().unwrap_or(-1))
            };
            BatchCommandResult {
                label: command.label.clone(),
                command: command.command.clone(),
                section,
                summary,
                exit_code: result.status.code(),
                raw_bytes: result.raw_bytes,
                elapsed_ms: result.elapsed_ms,
            }
        }
        Err(err) => BatchCommandResult {
            label: command.label.clone(),
            command: command.command.clone(),
            section: err.clone(),
            summary: err,
            exit_code: None,
            raw_bytes: 0,
            elapsed_ms: timeout.unwrap_or_default(),
        },
    }
}

fn execute_batch_sequential(
    commands: &[BatchCommand],
    timeout: Option<u64>,
    cwd: Option<&str>,
) -> Result<Vec<BatchCommandResult>, String> {
    let started = Instant::now();
    let mut results = Vec::with_capacity(commands.len());

    for command in commands {
        let remaining = timeout.map(|budget_ms| {
            let elapsed_ms = started.elapsed().as_millis() as u64;
            budget_ms.saturating_sub(elapsed_ms)
        });
        let result = match (timeout, remaining) {
            (Some(budget_ms), Some(0)) => batch_timeout_result(command, budget_ms),
            _ => execute_batch_single(command, remaining, cwd),
        };
        results.push(result);
    }

    Ok(results)
}

fn execute_batch_parallel(
    commands: &[BatchCommand],
    concurrency: usize,
    timeout: Option<u64>,
    cwd: Option<&str>,
) -> Result<Vec<BatchCommandResult>, String> {
    let effective = concurrency.clamp(1, commands.len().max(1));
    let commands = Arc::new(commands.to_vec());
    let cwd = Arc::new(cwd.map(str::to_string));
    let next_idx = Arc::new(Mutex::new(0usize));
    let started = Instant::now();
    let (sender, receiver) = mpsc::channel();
    let mut workers = Vec::with_capacity(effective);

    for _ in 0..effective {
        let commands = Arc::clone(&commands);
        let cwd = Arc::clone(&cwd);
        let next_idx = Arc::clone(&next_idx);
        let sender = sender.clone();
        workers.push(thread::spawn(move || {
            loop {
                let idx = {
                    let mut next = match next_idx.lock() {
                        Ok(next) => next,
                        Err(_) => return,
                    };
                    let idx = *next;
                    *next += 1;
                    idx
                };
                if idx >= commands.len() {
                    return;
                }
                let remaining = timeout.map(|budget_ms| {
                    budget_ms.saturating_sub(started.elapsed().as_millis() as u64)
                });
                let result = match (timeout, remaining) {
                    (Some(budget_ms), Some(0)) => batch_timeout_result(&commands[idx], budget_ms),
                    _ => execute_batch_single(&commands[idx], remaining, cwd.as_ref().as_deref()),
                };
                let _ = sender.send((idx, result));
            }
        }));
    }
    drop(sender);

    let mut results: Vec<Option<BatchCommandResult>> = (0..commands.len()).map(|_| None).collect();
    for (idx, result) in receiver {
        results[idx] = Some(result);
    }

    for worker in workers {
        worker
            .join()
            .map_err(|_| "batch worker thread panicked".to_string())?;
    }

    results
        .into_iter()
        .map(|result| result.ok_or_else(|| "missing batch command result".to_string()))
        .collect()
}

fn batch_timeout_result(command: &BatchCommand, budget_ms: u64) -> BatchCommandResult {
    BatchCommandResult {
        label: command.label.clone(),
        command: command.command.clone(),
        section: format!(
            "timed out after {budget_ms}ms (shared batch timeout exhausted before this command started)"
        ),
        summary: format!("timed out after {budget_ms}ms (shared batch timeout exhausted)"),
        exit_code: None,
        raw_bytes: 0,
        elapsed_ms: budget_ms,
    }
}

fn fetch_command(params: serde_json::Value) -> Result<(), String> {
    let started = Instant::now();
    let params: FetchParams =
        serde_json::from_value(params).map_err(|err| format!("invalid fetch params: {err}"))?;
    let mut conn = open_context_db(&params.db_path)?;
    let requests = if let Some(requests) = params.requests {
        requests
    } else if let Some(url) = params.url {
        vec![FetchRequest {
            url,
            source: params.source,
        }]
    } else {
        return write_text_response(
            "cg_fetch requires either `url` or `requests: [{url, source?}, ...]`.",
            true,
        );
    };

    let force = params.force.unwrap_or(false);
    let concurrency = params.concurrency.unwrap_or(1).clamp(1, 8);
    let timeout_ms = params
        .timeout
        .unwrap_or(DEFAULT_FETCH_TIMEOUT_MS)
        .clamp(100, 300_000);
    let mut lines = Vec::new();
    let mut previews = Vec::new();
    let mut fetched = 0usize;
    let mut cached = 0usize;
    let mut errors = 0usize;
    let mut fetched_sources = Vec::new();
    let mut fetched_chunks = 0usize;
    let mut fetched_bytes = 0usize;

    let mut ordered_results = Vec::with_capacity(requests.len());
    let mut pending = Vec::new();
    for request in requests {
        let source = request.source.as_deref();
        let display_source = source.unwrap_or(&request.url).to_string();
        let cache_key = compose_fetch_cache_key(source, &request.url);
        if !force && source_cached_fresh(&conn, &cache_key)? {
            ordered_results.push(FetchResult::Cached { display_source });
        } else {
            pending.push(FetchJob {
                cache_key,
                display_source,
                url: request.url,
                timeout_ms,
            });
            ordered_results.push(FetchResult::Pending);
        }
    }

    let fetched_results = if concurrency <= 1 {
        execute_fetch_sequential(&pending)
    } else {
        execute_fetch_parallel(&pending, concurrency)?
    };
    let mut fetched_iter = fetched_results.into_iter();

    for result in &mut ordered_results {
        if matches!(result, FetchResult::Pending) {
            *result = fetched_iter
                .next()
                .ok_or_else(|| "missing fetch result".to_string())?;
        }
    }

    for result in ordered_results {
        match result {
            FetchResult::Cached { display_source } => {
                cached += 1;
                lines.push(format!("- [cache] {display_source}"));
            }
            FetchResult::Fetched {
                display_source,
                cache_key,
                body,
            } => {
                let summary = index_markdown_source(&mut conn, &cache_key, &body, None, None)?;
                fetched += 1;
                fetched_sources.push(display_source.clone());
                fetched_chunks += summary.total_chunks;
                fetched_bytes += body.len();
                lines.push(format!("- [new] {display_source}"));
                previews.push(format!(
                    "### {display_source}\n\n{}",
                    truncate_chars(&body, MAX_FETCH_PREVIEW_CHARS)
                ));
            }
            FetchResult::Error { url, err } => {
                errors += 1;
                lines.push(format!("- [err] {url}: {err}"));
            }
            FetchResult::Pending => return Err("fetch result ordering bug".to_string()),
        }
    }

    let mut text = String::new();
    if fetched > 0 {
        text.push_str(&format!(
            "Fetched and indexed {} sections ({:.2}KB) from: {}.",
            fetched_chunks,
            fetched_bytes as f64 / 1024.0,
            fetched_sources.join(", ")
        ));
    }
    if fetched != 1 || cached != 0 || errors != 0 {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&format!(
            "fetched {}. ok={} cache={} err={}.",
            fetched + cached + errors,
            fetched,
            cached,
            errors
        ));
    }
    if !lines.is_empty() {
        text.push_str("\n\n");
        text.push_str(&lines.join("\n"));
    }
    if !previews.is_empty() {
        text.push_str("\n\n---\n\n");
        text.push_str(&previews.join("\n\n"));
    }
    let raw_bytes = fetched_bytes;
    write_text_response_with_details(
        &text,
        errors > 0,
        json!({ "metrics": OperationMetrics {
            raw_bytes,
            indexed_bytes: fetched_bytes,
            returned_bytes: text.len(),
            omitted_bytes: raw_bytes.saturating_sub(text.len()),
            elapsed_ms: started.elapsed().as_millis() as u64,
            success: errors == 0,
        }}),
    )
}

#[derive(Clone)]
struct FetchJob {
    cache_key: String,
    display_source: String,
    url: String,
    timeout_ms: u64,
}

enum FetchResult {
    Pending,
    Cached {
        display_source: String,
    },
    Fetched {
        display_source: String,
        cache_key: String,
        body: String,
    },
    Error {
        url: String,
        err: String,
    },
}

fn execute_fetch_single(job: &FetchJob) -> FetchResult {
    match fetch_http_body(&job.url, job.timeout_ms) {
        Ok(body) => FetchResult::Fetched {
            display_source: job.display_source.clone(),
            cache_key: job.cache_key.clone(),
            body,
        },
        Err(err) => FetchResult::Error {
            url: job.url.clone(),
            err,
        },
    }
}

fn execute_fetch_sequential(jobs: &[FetchJob]) -> Vec<FetchResult> {
    jobs.iter().map(execute_fetch_single).collect()
}

fn execute_fetch_parallel(
    jobs: &[FetchJob],
    concurrency: usize,
) -> Result<Vec<FetchResult>, String> {
    let effective = concurrency.clamp(1, jobs.len().max(1));
    let jobs = Arc::new(jobs.to_vec());
    let next_idx = Arc::new(Mutex::new(0usize));
    let (sender, receiver) = mpsc::channel();
    let mut workers = Vec::with_capacity(effective);

    for _ in 0..effective {
        let jobs = Arc::clone(&jobs);
        let next_idx = Arc::clone(&next_idx);
        let sender = sender.clone();
        workers.push(thread::spawn(move || {
            loop {
                let idx = {
                    let mut next = match next_idx.lock() {
                        Ok(next) => next,
                        Err(_) => return,
                    };
                    let idx = *next;
                    *next += 1;
                    idx
                };
                if idx >= jobs.len() {
                    return;
                }
                let result = execute_fetch_single(&jobs[idx]);
                let _ = sender.send((idx, result));
            }
        }));
    }
    drop(sender);

    let mut results: Vec<Option<FetchResult>> = (0..jobs.len()).map(|_| None).collect();
    for (idx, result) in receiver {
        results[idx] = Some(result);
    }

    for worker in workers {
        worker
            .join()
            .map_err(|_| "fetch worker thread panicked".to_string())?;
    }

    results
        .into_iter()
        .map(|result| result.ok_or_else(|| "missing fetch result".to_string()))
        .collect()
}

fn compose_fetch_cache_key(source: Option<&str>, url: &str) -> String {
    let identity = format!("{}\0{url}", source.unwrap_or(""));
    format!(
        "__context_guard_fetch_v1__{}",
        sha256_hex(identity.as_bytes())
    )
}

fn source_cached_fresh(conn: &Connection, source: &str) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sources WHERE label = ?1 AND indexed_at >= datetime('now', ?2)",
            params![source, format!("-{} hours", FETCH_CACHE_TTL_HOURS)],
            |row| row.get(0),
        )
        .map_err(|err| format!("failed to read fetch cache: {err}"))?;
    Ok(count > 0)
}

fn fetch_http_body(url: &str, timeout_ms: u64) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|err| format!("invalid URL: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "URL scheme `{scheme}` not allowed; use http or https"
            ));
        }
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(
            timeout_ms.min(DEFAULT_FETCH_CONNECT_TIMEOUT_MS),
        ))
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("failed to build HTTP client: {err}"))?;
    let response = client
        .get(parsed)
        .send()
        .map_err(|err| format!("fetch failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP request failed with {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_FETCH_BODY_BYTES as u64)
    {
        return Err(format!(
            "response exceeds the {} byte fetch limit",
            MAX_FETCH_BODY_BYTES
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut body = Vec::new();
    response
        .take((MAX_FETCH_BODY_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|err| format!("failed to read response body: {err}"))?;
    if body.len() > MAX_FETCH_BODY_BYTES {
        return Err(format!(
            "response exceeds the {} byte fetch limit",
            MAX_FETCH_BODY_BYTES
        ));
    }
    let body = String::from_utf8_lossy(&body).into_owned();
    if content_type
        .as_deref()
        .map(|value| value.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false)
    {
        Ok(html_to_readable_text(&body))
    } else {
        Ok(body)
    }
}

fn html_to_readable_text(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    let mut tag = String::new();

    for ch in html.chars() {
        if in_tag {
            if ch == '>' {
                let normalized = tag.trim().to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "br" | "br/"
                        | "/p"
                        | "/div"
                        | "/section"
                        | "/article"
                        | "/li"
                        | "/ul"
                        | "/ol"
                        | "/h1"
                        | "/h2"
                        | "/h3"
                        | "/h4"
                        | "/h5"
                        | "/h6"
                ) && !text.ends_with('\n')
                {
                    text.push('\n');
                }
                tag.clear();
                in_tag = false;
            } else {
                tag.push(ch);
            }
            continue;
        }

        if ch == '<' {
            in_tag = true;
            continue;
        }

        text.push(ch);
    }

    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn status_command(params: serde_json::Value) -> Result<(), String> {
    let params: StatusParams =
        serde_json::from_value(params).map_err(|err| format!("invalid status params: {err}"))?;
    let conn = open_context_db(&params.db_path)?;
    let (sources, chunks, code_chunks): (i64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(chunk_count), 0), COALESCE(SUM(code_chunk_count), 0) FROM sources",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|err| format!("failed to read content-store stats: {err}"))?;
    let recent_sources = load_recent_sources(&conn, MAX_STATUS_SOURCES)?;

    let mut lines = vec![
        "## Context Guard status".to_string(),
        String::new(),
        format!(
            "- Version: {}",
            params.version.unwrap_or_else(|| "unknown".to_string())
        ),
    ];
    if let Some(cwd) = params.cwd {
        lines.push(format!("- Project: {cwd}"));
    }

    lines.push(String::new());
    lines.push("### Current tool runtime".to_string());
    let current_session = params
        .session_db_path
        .as_deref()
        .map(session_store::read_current_status)
        .transpose()?
        .unwrap_or_default();
    lines.push(format!("- Tool calls: {}", current_session.tool_calls));
    lines.push(format!("- Raw bytes: {}", current_session.raw_bytes));
    lines.push(format!(
        "- Indexed bytes: {}",
        current_session.indexed_bytes
    ));
    lines.push(format!(
        "- Returned bytes: {}",
        current_session.returned_bytes
    ));
    lines.push(format!(
        "- Omitted bytes: {}",
        current_session.omitted_bytes
    ));
    lines.push(format!("- Failures: {}", current_session.failures));
    lines.push(format!(
        "- Guard latency: p50={}ms p95={}ms",
        current_session.p50_elapsed_ms, current_session.p95_elapsed_ms
    ));

    lines.push(String::new());
    lines.push("### Project telemetry store".to_string());
    lines.push(format!(
        "- Conversations recorded: {}",
        current_session.sessions
    ));
    if let Some(latest_event_at) = current_session.latest_event_at {
        lines.push(format!("- Latest telemetry: {latest_event_at}"));
    }

    lines.push(String::new());
    lines.push("### Indexed content".to_string());
    lines.push(format!("- Indexed chunks: {chunks}"));
    lines.push(format!("- Indexed sources: {sources}"));
    lines.push(format!("- Indexed code chunks: {code_chunks}"));
    lines.push(format!(
        "- Store size: {} bytes",
        sqlite_database_size(&params.db_path)
    ));
    let stale_sources: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sources WHERE file_path IS NOT NULL AND chunk_count = 0",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    lines.push(format!("- Stale file sources: {stale_sources}"));
    if !recent_sources.is_empty() {
        lines.push(format!("- Recent sources: {}", recent_sources.join(", ")));
    }

    let lifetime = params
        .sessions_dir
        .as_deref()
        .map(session_store::read_lifetime_status)
        .transpose()?;
    if let Some(lifetime) = lifetime {
        lines.push(String::new());
        lines.push("### Lifetime telemetry".to_string());
        lines.push(format!(
            "- Conversations across projects: {}",
            lifetime.total_sessions
        ));
        lines.push(format!(
            "- Projects with session DBs: {}",
            lifetime.distinct_projects
        ));
        lines.push(format!(
            "- Tool calls across projects: {}",
            lifetime.tool_calls
        ));
        lines.push(format!(
            "- Omitted bytes across projects: {}",
            lifetime.omitted_bytes
        ));
    }

    write_text_response(&lines.join("\n"), false)
}

fn sqlite_database_size(path: &str) -> u64 {
    [
        path.to_string(),
        format!("{path}-wal"),
        format!("{path}-shm"),
    ]
    .iter()
    .filter_map(|candidate| fs::metadata(candidate).ok())
    .map(|metadata| metadata.len())
    .sum()
}

fn load_recent_sources(conn: &Connection, limit: usize) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT COALESCE(NULLIF(display_label, ''), label) FROM sources ORDER BY datetime(indexed_at) DESC, id DESC LIMIT ?1")
        .map_err(|err| format!("failed to prepare recent-sources query: {err}"))?;
    let rows = stmt
        .query_map(params![limit as i64], |row| row.get::<_, String>(0))
        .map_err(|err| format!("failed to query recent sources: {err}"))?;

    let mut sources = Vec::new();
    for row in rows {
        sources.push(row.map_err(|err| format!("failed to read recent source: {err}"))?);
    }
    Ok(sources)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn first_nonempty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn looks_like_code(text: &str) -> bool {
    text.contains("```")
        || text.contains("fn ")
        || text.contains("class ")
        || text.contains("=>")
        || text.contains("console.")
        || text.contains("let ")
        || text.contains("const ")
}

fn chunk_markdown(text: &str, max_chunk_bytes: usize) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let lines = text.lines().collect::<Vec<_>>();
    let mut heading_stack: Vec<(usize, String)> = Vec::new();
    let mut current_content: Vec<String> = Vec::new();
    let mut i = 0usize;

    let flush = |chunks: &mut Vec<Chunk>,
                 heading_stack: &[(usize, String)],
                 current_content: &mut Vec<String>| {
        let joined = current_content.join("\n").trim().to_string();
        if joined.is_empty() {
            current_content.clear();
            return;
        }

        let title = build_title(heading_stack);
        let has_code = current_content
            .iter()
            .any(|line| line.trim_start().starts_with("```"));

        if joined.len() <= max_chunk_bytes {
            chunks.push(Chunk {
                title,
                content: joined,
                has_code,
            });
            current_content.clear();
            return;
        }

        let paragraphs = joined.split("\n\n").collect::<Vec<_>>();
        let paragraph_count = paragraphs.len();
        let mut accumulator: Vec<String> = Vec::new();
        let mut part_index = 1usize;

        let flush_accumulator =
            |chunks: &mut Vec<Chunk>, accumulator: &mut Vec<String>, part_index: &mut usize| {
                if accumulator.is_empty() {
                    return;
                }
                let part = accumulator.join("\n\n").trim().to_string();
                if part.is_empty() {
                    accumulator.clear();
                    return;
                }
                let part_title = if paragraph_count > 1 {
                    format!("{} ({})", title, *part_index)
                } else {
                    title.clone()
                };
                *part_index += 1;
                chunks.push(Chunk {
                    title: part_title,
                    has_code: part.contains("```"),
                    content: part,
                });
                accumulator.clear();
            };

        for paragraph in &paragraphs {
            accumulator.push((*paragraph).to_string());
            if accumulator.join("\n\n").len() > max_chunk_bytes && accumulator.len() > 1 {
                let overflow = accumulator.pop().expect("accumulator not empty");
                flush_accumulator(chunks, &mut accumulator, &mut part_index);
                accumulator.push(overflow);
            }
        }
        flush_accumulator(chunks, &mut accumulator, &mut part_index);
        current_content.clear();
    };

    while i < lines.len() {
        let line = lines[i];

        if line.chars().all(|ch| matches!(ch, '-' | '_' | '*')) && line.len() >= 3 {
            flush(&mut chunks, &heading_stack, &mut current_content);
            i += 1;
            continue;
        }

        if let Some((level, heading)) = parse_heading(line) {
            flush(&mut chunks, &heading_stack, &mut current_content);
            while heading_stack
                .last()
                .is_some_and(|(existing_level, _)| *existing_level >= level)
            {
                heading_stack.pop();
            }
            heading_stack.push((level, heading));
            current_content.push(line.to_string());
            i += 1;
            continue;
        }

        if let Some(fence) = parse_fence(line) {
            current_content.push(line.to_string());
            i += 1;
            while i < lines.len() {
                let code_line = lines[i];
                current_content.push(code_line.to_string());
                i += 1;
                if code_line.trim() == fence {
                    break;
                }
            }
            continue;
        }

        current_content.push(line.to_string());
        i += 1;
    }

    flush(&mut chunks, &heading_stack, &mut current_content);
    chunks
}

fn parse_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if !(1..=4).contains(&hashes) {
        return None;
    }
    let rest = trimmed[hashes..].trim();
    if rest.is_empty() {
        return None;
    }
    Some((hashes, rest.to_string()))
}

fn parse_fence(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("```") {
        return None;
    }
    Some(trimmed.split_whitespace().next().unwrap_or("```"))
}

fn build_title(heading_stack: &[(usize, String)]) -> String {
    if heading_stack.is_empty() {
        "Untitled".to_string()
    } else {
        heading_stack
            .iter()
            .map(|(_, heading)| heading.as_str())
            .collect::<Vec<_>>()
            .join(" > ")
    }
}

fn write_text_response(text: &str, is_error: bool) -> Result<(), String> {
    write_text_response_with_details(text, is_error, serde_json::Value::Null)
}

fn write_text_response_with_details(
    text: &str,
    is_error: bool,
    details: serde_json::Value,
) -> Result<(), String> {
    let mut response = json!({
        "ok": !is_error,
        "content": [
            {
                "type": "text",
                "text": text
            }
        ]
    });
    if is_error {
        response["isError"] = json!(true);
    }
    if !details.is_null() {
        response["details"] = details;
    }
    let payload = serde_json::to_string(&response)
        .map_err(|err| format!("failed to serialize response: {err}"))?;
    println!("{payload}");
    Ok(())
}
