mod security_policy;
mod session_semantics;

use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::types::Value;
use rusqlite::{
    Connection, OptionalExtension, Transaction, TransactionBehavior, params, params_from_iter,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use session_semantics::{
    ExtractorState, HookInput as SessionHookInput, SessionEvent as SemanticSessionEvent,
    StoredEvent as SemanticStoredEvent,
};
use sha2::{Digest, Sha256};

const MAX_INLINE_OUTPUT_BYTES: usize = 20_000;
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
const MAX_EVENTS_PER_SESSION: i64 = 1_000;
const DEDUP_WINDOW: i64 = 5;
const CONTEXT_SCHEMA_VERSION: i64 = 1;
const SESSION_SCHEMA_VERSION: i64 = 1;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_millis(750);
const PI_ROUTING_BLOCK: &str = r#"<context_window_protection>
  <priority_instructions>
    Raw tool output floods context window. MUST use context-guard tools. Keep raw data in sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    0. MEMORY: cg_search(sort: "timeline")
       - After resume, check prior context before asking user.
    1. COMMANDS: exec_command(cmd)
       - Primary command tool. Non-interactive exec_command calls are wrapped by Context Guard automatically.
       - Keeps raw output out of the main context while preserving searchable indexed results.
    2. BATCH RESEARCH: exec_command(mode: "batch", commands, queries)
       - For multi-command research or command+search in one round trip.
       - Each command: {label: "section header", command: "shell command"}
       - label becomes FTS5 chunk title — descriptive labels improve search.
    3. FOLLOW-UP: cg_search(queries: ["q1", "q2", ...])
       - All follow-up questions. ONE call, many queries (default relevance mode).
    4. FILE PROCESSING: cg_process_file(path, language, code)
       - Log analysis and large-file processing without loading raw content into context.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - NO Bash for commands producing >20 lines output.
    - NO Read for analysis — use cg_process_file. Read IS correct for files you intend to Edit.
    - NO WebFetch — use cg_fetch.
    - Bash ONLY for git/mkdir/rm/mv/navigation.
    - NO exec_command or cg_process_file for file creation/modification.
      exec_command is for analysis, inspection, and computation only.
  </forbidden_actions>

  <file_writing_policy>
    ALWAYS use native Write/Edit tools for file creation/modification.
    NEVER use exec_command, cg_process_file, or Bash to write files.
    Applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES. NEVER inline.
      Return only: file path + 1-line description.
    </artifact_policy>
  </output_constraints>
  <session_continuity>
    Skills, roles, and decisions set during this session remain active until the user revokes them.
    Do not drop behavioral directives as context grows.
  </session_continuity>

  <cg_commands>
    "cg status" | "cg-status" | "/cg-status" | context-guard status question
    → Call status tool, display full output verbatim.

    "cg check" | "cg-check" | "/cg-check" | diagnose context-guard
    → Call check tool, display full output verbatim.

    "cg purge" | "cg-purge" | "/cg-purge" | wipe/reset knowledge base
    → Call purge tool with confirm: true. Warn: irreversible.

    After /clear or /compact: knowledge base preserved. Tell user: "Context Guard knowledge base preserved. Use `cg purge` to start fresh."
  </cg_commands>
</context_window_protection>"#;

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
    #[serde(rename = "sessionDbPath")]
    session_db_path: Option<String>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
    #[serde(rename = "configDir")]
    config_dir: Option<String>,
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
    #[serde(rename = "sessionDbPath")]
    session_db_path: Option<String>,
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
    #[serde(rename = "configDir")]
    config_dir: Option<String>,
    version: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct SessionParams {
    action: String,
    #[serde(rename = "sessionDbPath")]
    session_db_path: String,
    #[serde(rename = "dbPath")]
    db_path: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
    #[serde(rename = "pluginRoot")]
    plugin_root: Option<String>,
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
    #[serde(rename = "sourceHook")]
    source_hook: Option<String>,
    events: Option<Vec<SessionEventPayload>>,
    #[serde(rename = "maxAgeDays")]
    max_age_days: Option<i64>,
    #[serde(rename = "minPriority")]
    min_priority: Option<i64>,
    limit: Option<usize>,
    #[serde(rename = "includeStats")]
    include_stats: Option<bool>,
    #[serde(rename = "includeResume")]
    include_resume: Option<bool>,
    #[serde(rename = "includeEventCount")]
    include_event_count: Option<bool>,
    #[serde(rename = "includeToolCallStats")]
    include_tool_call_stats: Option<bool>,
    #[serde(rename = "latestSessionId")]
    latest_session_id: Option<bool>,
    #[serde(rename = "toolName")]
    tool_name: Option<String>,
    source: Option<String>,
    #[serde(rename = "bytesReturned")]
    bytes_returned: Option<i64>,
    #[serde(rename = "bytesAvoided")]
    bytes_avoided: Option<i64>,
    snapshot: Option<String>,
    #[serde(rename = "eventCount")]
    event_count: Option<i64>,
    #[serde(rename = "hookInput")]
    hook_input: Option<SessionHookInput>,
    #[serde(rename = "fallbackToolName")]
    fallback_tool_name: Option<String>,
    message: Option<String>,
    #[serde(rename = "providerMeta")]
    provider_meta: Option<serde_json::Value>,
    #[serde(rename = "compactCount")]
    compact_count: Option<i64>,
    #[serde(rename = "searchTool")]
    search_tool: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct SessionEventPayload {
    r#type: String,
    category: String,
    data: String,
    priority: i64,
    #[serde(rename = "dataHash")]
    data_hash: Option<String>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
    #[serde(rename = "attributionSource")]
    attribution_source: Option<String>,
    #[serde(rename = "attributionConfidence")]
    attribution_confidence: Option<f64>,
    #[serde(rename = "bytesAvoided")]
    bytes_avoided: Option<i64>,
    #[serde(rename = "bytesReturned")]
    bytes_returned: Option<i64>,
}

#[derive(Default, Serialize)]
struct SessionQueryResponse {
    #[serde(rename = "latestSessionId", skip_serializing_if = "Option::is_none")]
    latest_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    events: Option<Vec<SessionStoredEvent>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<SessionMetaRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume: Option<SessionResumeRow>,
    #[serde(rename = "eventCount", skip_serializing_if = "Option::is_none")]
    event_count: Option<i64>,
    #[serde(rename = "toolCallStats", skip_serializing_if = "Option::is_none")]
    tool_call_stats: Option<SessionToolCallStats>,
}

#[derive(Default, Serialize)]
struct SessionBeforeAgentStartResponse {
    #[serde(rename = "activeMemory", skip_serializing_if = "Option::is_none")]
    active_memory: Option<String>,
    #[serde(rename = "resumeSnapshot", skip_serializing_if = "Option::is_none")]
    resume_snapshot: Option<String>,
    #[serde(rename = "systemPrompt", skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
}

#[derive(Serialize)]
struct SessionStoredEvent {
    id: i64,
    session_id: String,
    r#type: String,
    category: String,
    priority: i64,
    data: String,
    project_dir: String,
    attribution_source: String,
    attribution_confidence: f64,
    bytes_avoided: i64,
    bytes_returned: i64,
    source_hook: String,
    created_at: String,
    data_hash: String,
}

#[derive(Serialize)]
struct SessionMetaRow {
    session_id: String,
    project_dir: String,
    started_at: String,
    last_event_at: Option<String>,
    event_count: i64,
    compact_count: i64,
}

#[derive(Serialize)]
struct SessionResumeRow {
    snapshot: String,
    #[serde(rename = "eventCount")]
    event_count: i64,
    consumed: bool,
}

#[derive(Serialize)]
struct SessionToolCallStats {
    #[serde(rename = "totalCalls")]
    total_calls: i64,
    #[serde(rename = "totalBytesReturned")]
    total_bytes_returned: i64,
    #[serde(rename = "byTool")]
    by_tool: HashMap<String, SessionToolCallByTool>,
}

#[derive(Serialize)]
struct SessionToolCallByTool {
    calls: i64,
    #[serde(rename = "bytesReturned")]
    bytes_returned: i64,
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
        "session" => session_command(request.params),
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
    match execute_code(
        &params.language,
        &params.code,
        Some(file_content),
        params.timeout,
        false,
    ) {
        Ok(output) => write_execution_response("File processor", output),
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
) -> Result<Output, String> {
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
) -> Result<Output, String> {
    if background {
        return run_background_command(command, timeout_ms);
    }

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
                return collect_output(status, stdout_reader, stderr_reader);
            }
            Ok(None) if deadline.is_some_and(|deadline| Instant::now() >= deadline) => {
                let timeout_ms = timeout_ms.expect("deadline requires timeout");
                let status = terminate_child_tree(&mut child)?;
                let partial = collect_output(status, stdout_reader, stderr_reader).ok();
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

fn run_background_command(mut command: Command, timeout_ms: Option<u64>) -> Result<Output, String> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to spawn process: {err}"))?;
    let deadline =
        timeout_ms.and_then(|timeout| Instant::now().checked_add(Duration::from_millis(timeout)));

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(Output {
                    status,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
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
) -> Result<Output, String> {
    let drain_deadline = Instant::now() + OUTPUT_DRAIN_GRACE;
    while !(stdout_reader.handle.is_finished() && stderr_reader.handle.is_finished())
        && Instant::now() < drain_deadline
    {
        thread::sleep(Duration::from_millis(2));
    }
    let stdout = finish_output_reader("stdout", stdout_reader)?;
    let stderr = finish_output_reader("stderr", stderr_reader)?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn finish_output_reader(stream_name: &str, reader: OutputReader) -> Result<Vec<u8>, String> {
    if reader.handle.is_finished() {
        reader
            .handle
            .join()
            .map_err(|_| format!("{stream_name} reader panicked"))?
            .map_err(|err| format!("failed to collect process {stream_name}: {err}"))?;
    }
    reader
        .capture
        .lock()
        .map_err(|_| format!("failed to snapshot process {stream_name}"))
        .map(|capture| capture.snapshot())
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

fn format_timeout_error(timeout_ms: u64, partial: Option<&Output>) -> String {
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

fn backgrounded_output(timeout_ms: u64) -> Output {
    Output {
        status: success_exit_status(),
        stdout: format!("Process backgrounded after {timeout_ms}ms.\n").into_bytes(),
        stderr: Vec::new(),
    }
}

fn write_execution_response(label: &str, output: Output) -> Result<(), String> {
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

    if combined.len() > MAX_INLINE_OUTPUT_BYTES {
        return write_text_response(
            &truncate_output_for_response(&combined),
            !output.status.success(),
        );
    }

    write_text_response(
        if combined.is_empty() {
            "(no output)"
        } else {
            combined.as_str()
        },
        !output.status.success(),
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
        replace_source_chunks_in_transaction(tx, &source, &chunks, None, None)?;
    }

    Ok(())
}

fn open_session_db(session_db_path: &str) -> Result<Connection, String> {
    if let Some(parent) = Path::new(session_db_path).parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create session db directory {}: {err}",
                parent.display()
            )
        })?;
    }

    let mut conn = Connection::open(session_db_path)
        .map_err(|err| format!("failed to open session DB {session_db_path}: {err}"))?;
    configure_sqlite_connection(&conn, session_db_path)?;
    ensure_session_schema(&mut conn)?;
    Ok(conn)
}

fn open_existing_session_db(session_db_path: &str) -> Result<Option<Connection>, String> {
    if !Path::new(session_db_path).exists() {
        return Ok(None);
    }
    open_session_db(session_db_path).map(Some)
}

fn ensure_session_schema(conn: &mut Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|err| format!("failed to read session schema version: {err}"))?;
    if version >= SESSION_SCHEMA_VERSION {
        return Ok(());
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start session schema migration: {err}"))?;
    let migrate_generated_hash = session_events_has_generated_hash(&tx)?;
    if migrate_generated_hash {
        tx.execute_batch(
            "
            DROP INDEX IF EXISTS idx_session_events_session;
            DROP INDEX IF EXISTS idx_session_events_type;
            DROP INDEX IF EXISTS idx_session_events_priority;
            DROP INDEX IF EXISTS idx_session_events_project;
            ALTER TABLE session_events RENAME TO session_events_legacy_generated;
            ",
        )
        .map_err(|err| format!("failed to preserve legacy session events: {err}"))?;
    }

    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS session_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            category TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 2,
            data TEXT NOT NULL,
            project_dir TEXT NOT NULL DEFAULT '',
            attribution_source TEXT NOT NULL DEFAULT 'unknown',
            attribution_confidence REAL NOT NULL DEFAULT 0,
            bytes_avoided INTEGER NOT NULL DEFAULT 0,
            bytes_returned INTEGER NOT NULL DEFAULT 0,
            source_hook TEXT NOT NULL DEFAULT 'unknown',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            data_hash TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
        CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);
        CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir);

        CREATE TABLE IF NOT EXISTS session_meta (
            session_id TEXT PRIMARY KEY,
            project_dir TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_event_at TEXT,
            event_count INTEGER NOT NULL DEFAULT 0,
            compact_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS session_resume (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL UNIQUE,
            snapshot TEXT NOT NULL,
            event_count INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            consumed INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tool_calls (
            session_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            calls INTEGER NOT NULL DEFAULT 0,
            bytes_returned INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, tool)
        );

        CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

        CREATE TABLE IF NOT EXISTS session_extractor_state (
            session_id TEXT PRIMARY KEY,
            state_json TEXT NOT NULL DEFAULT '{}'
        );
        ",
    )
    .map_err(|err| format!("failed to initialize session schema: {err}"))?;

    ensure_session_metadata_columns(&tx)?;

    if migrate_generated_hash {
        tx.execute_batch(
            "
            INSERT INTO session_events(
                id, session_id, type, category, priority, data, project_dir,
                attribution_source, attribution_confidence, bytes_avoided,
                bytes_returned, source_hook, created_at, data_hash
            )
            SELECT
                id, session_id, type, category, priority, data, project_dir,
                attribution_source, attribution_confidence, bytes_avoided,
                bytes_returned, source_hook, created_at, data_hash
            FROM session_events_legacy_generated;
            DROP TABLE session_events_legacy_generated;
            ",
        )
        .map_err(|err| format!("failed to migrate legacy session events: {err}"))?;
    }

    tx.pragma_update(None, "user_version", SESSION_SCHEMA_VERSION)
        .map_err(|err| format!("failed to record session schema version: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit session schema migration: {err}"))?;
    Ok(())
}

fn session_events_has_generated_hash(conn: &Connection) -> Result<bool, String> {
    if !table_exists(conn, "session_events")? {
        return Ok(false);
    }

    let mut stmt = conn
        .prepare("PRAGMA table_xinfo('session_events')")
        .map_err(|err| format!("failed to inspect session_events schema: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(6).unwrap_or(0)))
        })
        .map_err(|err| format!("failed to iterate session_events schema: {err}"))?;

    for row in rows {
        let (name, hidden) =
            row.map_err(|err| format!("failed to decode session_events schema row: {err}"))?;
        if name == "data_hash" && hidden != 0 {
            return Ok(true);
        }
    }

    Ok(false)
}

fn ensure_session_metadata_columns(conn: &Connection) -> Result<(), String> {
    for statement in [
        "ALTER TABLE session_events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE session_events ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'unknown'",
        "ALTER TABLE session_events ADD COLUMN attribution_confidence REAL NOT NULL DEFAULT 0",
        "ALTER TABLE session_events ADD COLUMN bytes_avoided INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE session_events ADD COLUMN bytes_returned INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE session_events ADD COLUMN source_hook TEXT NOT NULL DEFAULT 'unknown'",
        "ALTER TABLE session_events ADD COLUMN data_hash TEXT NOT NULL DEFAULT ''",
    ] {
        match conn.execute_batch(statement) {
            Ok(()) => {}
            Err(err) if err.to_string().contains("duplicate column name") => {}
            Err(err) => return Err(format!("failed to update session schema: {err}")),
        }
    }
    Ok(())
}

fn ensure_session_row(
    conn: &Connection,
    session_id: &str,
    project_dir: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO session_meta(session_id, project_dir) VALUES (?1, ?2)",
        params![session_id, project_dir],
    )
    .map_err(|err| format!("failed to ensure session {session_id}: {err}"))?;
    Ok(())
}

fn latest_session_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT session_id FROM session_meta ORDER BY datetime(started_at) DESC, rowid DESC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| format!("failed to read latest session id: {err}"))
}

fn resolve_session_target(
    conn: &Connection,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    match session_id {
        Some(session_id) => Ok(Some(session_id.to_string())),
        None => latest_session_id(conn),
    }
}

fn clamp_nonnegative_i64(value: Option<i64>) -> i64 {
    value.unwrap_or(0).max(0)
}

fn load_session_extractor_state(
    conn: &Connection,
    session_id: &str,
) -> Result<ExtractorState, String> {
    let raw = conn
        .query_row(
            "SELECT state_json FROM session_extractor_state WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("failed to read extractor state for {session_id}: {err}"))?;
    match raw {
        Some(raw) => match serde_json::from_str(&raw) {
            Ok(state) => Ok(state),
            Err(_) => Ok(ExtractorState::default()),
        },
        None => Ok(ExtractorState::default()),
    }
}

fn save_session_extractor_state(
    conn: &Connection,
    session_id: &str,
    state: &ExtractorState,
) -> Result<(), String> {
    let state_json = serde_json::to_string(state)
        .map_err(|err| format!("failed to encode extractor state for {session_id}: {err}"))?;
    conn.execute(
        "INSERT INTO session_extractor_state (session_id, state_json) VALUES (?1, ?2) \
         ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json",
        params![session_id, state_json],
    )
    .map_err(|err| format!("failed to persist extractor state for {session_id}: {err}"))?;
    Ok(())
}

fn semantic_event_to_payload(event: SemanticSessionEvent) -> SessionEventPayload {
    SessionEventPayload {
        r#type: event.event_type,
        category: event.category,
        data: event.data,
        priority: event.priority,
        data_hash: None,
        project_dir: None,
        attribution_source: None,
        attribution_confidence: None,
        bytes_avoided: event.bytes_avoided,
        bytes_returned: None,
    }
}

fn payload_to_semantic_event(event: &SessionEventPayload) -> SemanticStoredEvent {
    SemanticStoredEvent {
        event_type: event.r#type.clone(),
        category: event.category.clone(),
        data: event.data.clone(),
        priority: event.priority,
        created_at: None,
    }
}

fn session_record_events(
    conn: &mut Connection,
    session_id: &str,
    default_project_dir: Option<&str>,
    source_hook: &str,
    events: &[SessionEventPayload],
) -> Result<usize, String> {
    if events.is_empty() {
        return Ok(0);
    }

    ensure_session_row(conn, session_id, default_project_dir.unwrap_or(""))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start session event transaction: {err}"))?;
    let mut inserted = 0usize;

    for event in events {
        let data_hash = event
            .data_hash
            .as_deref()
            .map(str::trim)
            .filter(|hash| !hash.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| sha256_hex(event.data.as_bytes())[..16].to_ascii_uppercase());
        let duplicate = tx
            .query_row(
                "
                SELECT 1 FROM (
                    SELECT type, data_hash FROM session_events
                    WHERE session_id = ?1
                    ORDER BY id DESC
                    LIMIT ?2
                ) recent
                WHERE recent.type = ?3 AND recent.data_hash = ?4
                LIMIT 1
                ",
                params![session_id, DEDUP_WINDOW, event.r#type, data_hash],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| format!("failed to check duplicate session event: {err}"))?;
        if duplicate.is_some() {
            continue;
        }

        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(|err| format!("failed to count session events for {session_id}: {err}"))?;
        if count >= MAX_EVENTS_PER_SESSION {
            tx.execute(
                "
                DELETE FROM session_events
                WHERE id = (
                    SELECT id FROM session_events
                    WHERE session_id = ?1
                    ORDER BY priority ASC, id ASC
                    LIMIT 1
                )
                ",
                params![session_id],
            )
            .map_err(|err| {
                format!("failed to evict oldest session event for {session_id}: {err}")
            })?;
        }

        let project_dir = event
            .project_dir
            .as_deref()
            .or(default_project_dir)
            .unwrap_or("")
            .trim();
        let attribution_source = event.attribution_source.as_deref().unwrap_or("unknown");
        let attribution_confidence = event.attribution_confidence.unwrap_or(0.0).clamp(0.0, 1.0);
        let bytes_avoided = clamp_nonnegative_i64(event.bytes_avoided);
        let bytes_returned = clamp_nonnegative_i64(event.bytes_returned);

        tx.execute(
            "INSERT INTO session_events (\
                session_id, type, category, priority, data,\
                project_dir, attribution_source, attribution_confidence,\
                bytes_avoided, bytes_returned, source_hook, data_hash\
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                session_id,
                event.r#type,
                event.category,
                event.priority,
                event.data,
                project_dir,
                attribution_source,
                attribution_confidence,
                bytes_avoided,
                bytes_returned,
                source_hook,
                data_hash,
            ],
        )
        .map_err(|err| format!("failed to insert session event for {session_id}: {err}"))?;

        tx.execute(
            "UPDATE session_meta SET last_event_at = datetime('now'), event_count = event_count + 1 WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|err| format!("failed to update session meta for {session_id}: {err}"))?;
        inserted += 1;
    }

    tx.commit()
        .map_err(|err| format!("failed to commit session events for {session_id}: {err}"))?;
    Ok(inserted)
}

fn session_load_events(
    conn: &Connection,
    session_id: &str,
    min_priority: Option<i64>,
    limit: usize,
) -> Result<Vec<SessionStoredEvent>, String> {
    let (sql, params_values): (&str, Vec<Value>) = match min_priority {
        Some(min_priority) => (
            "SELECT id, session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, bytes_avoided, bytes_returned, source_hook, created_at, data_hash FROM session_events WHERE session_id = ?1 AND priority >= ?2 ORDER BY id ASC LIMIT ?3",
            vec![
                Value::Text(session_id.to_string()),
                Value::Integer(min_priority),
                Value::Integer(limit as i64),
            ],
        ),
        None => (
            "SELECT id, session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, bytes_avoided, bytes_returned, source_hook, created_at, data_hash FROM session_events WHERE session_id = ?1 ORDER BY id ASC LIMIT ?2",
            vec![
                Value::Text(session_id.to_string()),
                Value::Integer(limit as i64),
            ],
        ),
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("failed to prepare session event query: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(params_values.iter()), |row| {
            Ok(SessionStoredEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                r#type: row.get(2)?,
                category: row.get(3)?,
                priority: row.get(4)?,
                data: row.get(5)?,
                project_dir: row.get(6)?,
                attribution_source: row.get(7)?,
                attribution_confidence: row.get(8)?,
                bytes_avoided: row.get(9)?,
                bytes_returned: row.get(10)?,
                source_hook: row.get(11)?,
                created_at: row.get(12)?,
                data_hash: row.get(13)?,
            })
        })
        .map_err(|err| format!("failed to read session events for {session_id}: {err}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|err| format!("failed to decode session event: {err}"))?);
    }
    Ok(events)
}

fn session_load_recent_events(
    conn: &Connection,
    session_id: &str,
    min_priority: Option<i64>,
    limit: usize,
) -> Result<Vec<SessionStoredEvent>, String> {
    let (sql, params_values): (&str, Vec<Value>) = match min_priority {
        Some(min_priority) => (
            "SELECT id, session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, bytes_avoided, bytes_returned, source_hook, created_at, data_hash FROM session_events WHERE session_id = ?1 AND priority >= ?2 ORDER BY id DESC LIMIT ?3",
            vec![
                Value::Text(session_id.to_string()),
                Value::Integer(min_priority),
                Value::Integer(limit as i64),
            ],
        ),
        None => (
            "SELECT id, session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, bytes_avoided, bytes_returned, source_hook, created_at, data_hash FROM session_events WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2",
            vec![
                Value::Text(session_id.to_string()),
                Value::Integer(limit as i64),
            ],
        ),
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("failed to prepare recent session event query: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(params_values.iter()), |row| {
            Ok(SessionStoredEvent {
                id: row.get(0)?,
                session_id: row.get(1)?,
                r#type: row.get(2)?,
                category: row.get(3)?,
                priority: row.get(4)?,
                data: row.get(5)?,
                project_dir: row.get(6)?,
                attribution_source: row.get(7)?,
                attribution_confidence: row.get(8)?,
                bytes_avoided: row.get(9)?,
                bytes_returned: row.get(10)?,
                source_hook: row.get(11)?,
                created_at: row.get(12)?,
                data_hash: row.get(13)?,
            })
        })
        .map_err(|err| format!("failed to read recent session events for {session_id}: {err}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|err| format!("failed to decode recent session event: {err}"))?);
    }
    events.reverse();
    Ok(events)
}

fn session_event_count(conn: &Connection, session_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
    .map_err(|err| format!("failed to count session events for {session_id}: {err}"))
}

fn session_stats(conn: &Connection, session_id: &str) -> Result<Option<SessionMetaRow>, String> {
    conn.query_row(
        "SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count FROM session_meta WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(SessionMetaRow {
                session_id: row.get(0)?,
                project_dir: row.get(1)?,
                started_at: row.get(2)?,
                last_event_at: row.get(3)?,
                event_count: row.get(4)?,
                compact_count: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to read session stats for {session_id}: {err}"))
}

fn session_resume(conn: &Connection, session_id: &str) -> Result<Option<SessionResumeRow>, String> {
    conn.query_row(
        "SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(SessionResumeRow {
                snapshot: row.get(0)?,
                event_count: row.get(1)?,
                consumed: row.get::<_, i64>(2)? != 0,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to read resume snapshot for {session_id}: {err}"))
}

fn session_tool_call_stats(
    conn: &Connection,
    session_id: &str,
) -> Result<SessionToolCallStats, String> {
    let (total_calls, total_bytes_returned): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(bytes_returned), 0) FROM tool_calls WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| format!("failed to read tool-call totals for {session_id}: {err}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT tool, calls, bytes_returned FROM tool_calls WHERE session_id = ?1 ORDER BY calls DESC",
        )
        .map_err(|err| format!("failed to prepare tool-call stats query: {err}"))?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SessionToolCallByTool {
                    calls: row.get(1)?,
                    bytes_returned: row.get(2)?,
                },
            ))
        })
        .map_err(|err| format!("failed to read tool-call rows for {session_id}: {err}"))?;

    let mut by_tool = HashMap::new();
    for row in rows {
        let (tool, stats) = row.map_err(|err| format!("failed to decode tool-call row: {err}"))?;
        by_tool.insert(tool, stats);
    }

    Ok(SessionToolCallStats {
        total_calls,
        total_bytes_returned,
        by_tool,
    })
}

fn session_delete_rows(conn: &Connection, session_id: &str) -> Result<usize, String> {
    let mut deleted = 0usize;
    for table in [
        "session_events",
        "session_resume",
        "session_meta",
        "tool_calls",
        "session_extractor_state",
    ] {
        if !table_exists(conn, table)? {
            continue;
        }
        let sql = format!("DELETE FROM {table} WHERE session_id = ?1");
        deleted += conn
            .execute(&sql, params![session_id])
            .map_err(|err| format!("failed to delete {table} rows for {session_id}: {err}"))?;
    }
    Ok(deleted)
}

fn session_cleanup_old(
    conn: &mut Connection,
    max_age_days: i64,
    current_session_id: &str,
) -> Result<usize, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start session cleanup transaction: {err}"))?;
    let session_ids = {
        let mut stmt = tx
            .prepare(
                "SELECT session_id FROM session_meta \
                 WHERE session_id <> ?1 \
                   AND COALESCE(last_event_at, started_at) < datetime('now', ?2 || ' days')",
            )
            .map_err(|err| format!("failed to prepare old-session query: {err}"))?;
        let days = format!("-{}", max_age_days.max(0));
        let rows = stmt
            .query_map(params![current_session_id, days], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|err| format!("failed to read old sessions: {err}"))?;

        let mut session_ids = Vec::new();
        for row in rows {
            session_ids.push(row.map_err(|err| format!("failed to decode old session id: {err}"))?);
        }
        session_ids
    };

    for session_id in &session_ids {
        session_delete_rows(&tx, session_id)?;
    }
    tx.commit()
        .map_err(|err| format!("failed to commit session cleanup: {err}"))?;
    Ok(session_ids.len())
}

fn session_command(params: serde_json::Value) -> Result<(), String> {
    let params: SessionParams =
        serde_json::from_value(params).map_err(|err| format!("invalid session params: {err}"))?;

    match params.action.as_str() {
        "init" => {
            let mut conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response("session init requires sessionId", true);
            };
            ensure_session_row(
                &conn,
                session_id,
                params.project_dir.as_deref().unwrap_or(""),
            )?;
            let cleaned =
                session_cleanup_old(&mut conn, params.max_age_days.unwrap_or(7), session_id)?;
            write_text_response(&json!({ "cleaned": cleaned }).to_string(), false)
        }
        "events" => {
            let mut conn = open_session_db(&params.session_db_path)?;
            let session_id = match resolve_session_target(&conn, params.session_id.as_deref())? {
                Some(session_id) => session_id,
                None => {
                    return write_text_response(&json!({ "inserted": 0 }).to_string(), false);
                }
            };
            let inserted = session_record_events(
                &mut conn,
                &session_id,
                params.project_dir.as_deref(),
                params.source_hook.as_deref().unwrap_or("unknown"),
                params.events.as_deref().unwrap_or(&[]),
            )?;
            write_text_response(&json!({ "inserted": inserted }).to_string(), false)
        }
        "increment_tool_call" => {
            let conn = open_session_db(&params.session_db_path)?;
            let session_id = match resolve_session_target(&conn, params.session_id.as_deref())? {
                Some(session_id) => session_id,
                None => {
                    return write_text_response(&json!({ "updated": false }).to_string(), false);
                }
            };
            conn.execute(
                "INSERT INTO tool_calls (session_id, tool, calls, bytes_returned) VALUES (?1, ?2, 1, ?3) \
                 ON CONFLICT(session_id, tool) DO UPDATE SET \
                 calls = calls + 1, \
                 bytes_returned = bytes_returned + excluded.bytes_returned, \
                 updated_at = datetime('now')",
                params![
                    session_id,
                    params.tool_name.as_deref().unwrap_or("unknown"),
                    clamp_nonnegative_i64(params.bytes_returned),
                ],
            )
            .map_err(|err| format!("failed to increment tool-call counter: {err}"))?;
            write_text_response(&json!({ "updated": true }).to_string(), false)
        }
        "record_tool_telemetry" => {
            let mut conn = open_session_db(&params.session_db_path)?;
            let session_id = match resolve_session_target(&conn, params.session_id.as_deref())? {
                Some(session_id) => session_id,
                None => {
                    return write_text_response(
                        &json!({ "updated": false, "inserted": 0 }).to_string(),
                        false,
                    );
                }
            };
            let tool_name = params.tool_name.as_deref().unwrap_or("unknown");
            let bytes_returned = clamp_nonnegative_i64(params.bytes_returned);
            conn.execute(
                "INSERT INTO tool_calls (session_id, tool, calls, bytes_returned) VALUES (?1, ?2, 1, ?3) \
                 ON CONFLICT(session_id, tool) DO UPDATE SET \
                 calls = calls + 1, \
                 bytes_returned = bytes_returned + excluded.bytes_returned, \
                 updated_at = datetime('now')",
                params![session_id, tool_name, bytes_returned],
            )
            .map_err(|err| format!("failed to record tool telemetry: {err}"))?;

            let mut inserted = 0;
            if matches!(tool_name, "exec_command.batch" | "cg_process_file") && bytes_returned > 0 {
                inserted += session_record_events(
                    &mut conn,
                    &session_id,
                    params.project_dir.as_deref(),
                    "cg-server",
                    &[SessionEventPayload {
                        r#type: "sandbox-execute".to_string(),
                        category: "sandbox".to_string(),
                        data: tool_name.to_string(),
                        priority: 1,
                        data_hash: None,
                        project_dir: None,
                        attribution_source: Some("server".to_string()),
                        attribution_confidence: Some(1.0),
                        bytes_avoided: None,
                        bytes_returned: Some(bytes_returned),
                    }],
                )?;
            }

            let bytes_avoided = clamp_nonnegative_i64(params.bytes_avoided);
            if bytes_avoided > 0 {
                inserted += session_record_events(
                    &mut conn,
                    &session_id,
                    params.project_dir.as_deref(),
                    "cg-server",
                    &[SessionEventPayload {
                        r#type: "index-write".to_string(),
                        category: "sandbox".to_string(),
                        data: params
                            .source
                            .clone()
                            .unwrap_or_else(|| "unknown".to_string()),
                        priority: 1,
                        data_hash: None,
                        project_dir: None,
                        attribution_source: Some("server".to_string()),
                        attribution_confidence: Some(1.0),
                        bytes_avoided: Some(bytes_avoided),
                        bytes_returned: None,
                    }],
                )?;
            }

            write_text_response(
                &json!({ "updated": true, "inserted": inserted }).to_string(),
                false,
            )
        }
        "query" => {
            let Some(conn) = open_existing_session_db(&params.session_db_path)? else {
                return write_text_response(
                    &serde_json::to_string(&SessionQueryResponse::default()).map_err(|err| {
                        format!("failed to encode empty session query response: {err}")
                    })?,
                    false,
                );
            };
            let mut response = SessionQueryResponse::default();
            let target_session = resolve_session_target(&conn, params.session_id.as_deref())?;
            if params.latest_session_id.unwrap_or(false) {
                response.latest_session_id = target_session.clone();
            }
            if let Some(session_id) = target_session.as_deref() {
                if params.include_stats.unwrap_or(false) {
                    response.stats = session_stats(&conn, session_id)?;
                }
                if params.include_resume.unwrap_or(false) {
                    response.resume = session_resume(&conn, session_id)?;
                }
                if params.include_event_count.unwrap_or(false) {
                    response.event_count = Some(session_event_count(&conn, session_id)?);
                }
                if params.include_tool_call_stats.unwrap_or(false) {
                    response.tool_call_stats = Some(session_tool_call_stats(&conn, session_id)?);
                }
                let include_events = params.min_priority.is_some() || params.limit.is_some();
                if include_events {
                    response.events = Some(session_load_events(
                        &conn,
                        session_id,
                        params.min_priority,
                        params.limit.unwrap_or(1_000),
                    )?);
                }
            }
            write_text_response(
                &serde_json::to_string(&response)
                    .map_err(|err| format!("failed to encode session query response: {err}"))?,
                false,
            )
        }
        "extract_hook_events" => {
            let conn = open_session_db(&params.session_db_path)?;
            let mut state = match params.session_id.as_deref() {
                Some(session_id) => load_session_extractor_state(&conn, session_id)?,
                None => ExtractorState::default(),
            };
            let hook_input = params.hook_input.unwrap_or_default();
            let events = session_semantics::extract_events(
                hook_input,
                params.fallback_tool_name.as_deref(),
                &mut state,
            )
            .into_iter()
            .map(semantic_event_to_payload)
            .collect::<Vec<_>>();
            if let Some(session_id) = params.session_id.as_deref() {
                ensure_session_row(
                    &conn,
                    session_id,
                    params.project_dir.as_deref().unwrap_or(""),
                )?;
                save_session_extractor_state(&conn, session_id, &state)?;
            }
            write_text_response(
                &serde_json::to_string(&events)
                    .map_err(|err| format!("failed to encode extracted hook events: {err}"))?,
                false,
            )
        }
        "check_tool_call" => {
            let hook_input = params.hook_input.unwrap_or_default();
            let reason = session_semantics::blocked_tool_call_reason(&hook_input);
            write_text_response(
                &serde_json::to_string(&json!({
                    "block": reason.is_some(),
                    "reason": reason,
                }))
                .map_err(|err| format!("failed to encode tool-call check response: {err}"))?,
                false,
            )
        }
        "build_pi_check" => {
            let db_path = params.db_path.as_deref().unwrap_or("");
            let db_exists = !db_path.is_empty() && Path::new(db_path).exists();
            let mut lines = vec![
                "## cg-check (Pi)".to_string(),
                String::new(),
                format!("- DB path: `{db_path}`"),
                format!("- DB exists: {db_exists}"),
                format!(
                    "- Session ID: `{}`",
                    params
                        .session_id
                        .as_deref()
                        .map(|id| format!("{}...", &id[..id.len().min(8)]))
                        .unwrap_or_else(|| "none".to_string())
                ),
                format!(
                    "- Plugin root: `{}`",
                    params.plugin_root.as_deref().unwrap_or("")
                ),
                format!(
                    "- Project dir: `{}`",
                    params.project_dir.as_deref().unwrap_or("")
                ),
            ];
            if let Some(session_id) = params.session_id.as_deref() {
                let conn = open_session_db(&params.session_db_path)?;
                let state = SessionQueryResponse {
                    stats: session_stats(&conn, session_id)?,
                    resume: session_resume(&conn, session_id)?,
                    event_count: Some(session_event_count(&conn, session_id)?),
                    ..SessionQueryResponse::default()
                };
                if state.stats.is_some() || state.resume.is_some() || state.event_count.is_some() {
                    lines.push(format!("- Events: {}", state.event_count.unwrap_or(0)));
                    lines.push(format!(
                        "- Compactions: {}",
                        state
                            .stats
                            .as_ref()
                            .map(|row| row.compact_count)
                            .unwrap_or(0)
                    ));
                    lines.push(format!(
                        "- Resume snapshot: {}",
                        match state.resume.as_ref() {
                            Some(resume) if resume.consumed => "consumed",
                            Some(_) => "available",
                            None => "none",
                        }
                    ));
                } else {
                    lines.push("- DB query error".to_string());
                }
            }
            write_text_response(&lines.join("\n"), false)
        }
        "extract_user_events" => {
            let events = session_semantics::extract_user_events(
                params.message.as_deref().unwrap_or_default(),
            )
            .into_iter()
            .map(semantic_event_to_payload)
            .collect::<Vec<_>>();
            write_text_response(
                &serde_json::to_string(&events)
                    .map_err(|err| format!("failed to encode extracted user events: {err}"))?,
                false,
            )
        }
        "prepare_before_agent_start" => {
            let mut conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response(
                    &serde_json::to_string(&SessionBeforeAgentStartResponse::default()).map_err(
                        |err| format!("failed to encode empty before-agent-start response: {err}"),
                    )?,
                    false,
                );
            };

            if let Some(message) = params.message.as_deref().filter(|value| !value.is_empty()) {
                let events = session_semantics::extract_user_events(message)
                    .into_iter()
                    .map(semantic_event_to_payload)
                    .collect::<Vec<_>>();
                if !events.is_empty() {
                    session_record_events(
                        &mut conn,
                        session_id,
                        params.project_dir.as_deref(),
                        "UserPromptSubmit",
                        &events,
                    )?;
                }
            }

            let active_events = session_load_recent_events(&conn, session_id, Some(3), 50)?
                .into_iter()
                .map(|event| SemanticStoredEvent {
                    event_type: event.r#type,
                    category: event.category,
                    data: event.data,
                    priority: event.priority,
                    created_at: Some(event.created_at),
                })
                .collect::<Vec<_>>();

            let active_memory = session_semantics::build_active_memory(&active_events);
            let resume = session_resume(&conn, session_id)?;
            let mut response = SessionBeforeAgentStartResponse::default();
            if !active_memory.is_empty() {
                response.active_memory = Some(active_memory);
            }
            if let Some(resume) = resume
                && !resume.consumed
                && !resume.snapshot.is_empty()
            {
                conn.execute(
                    "UPDATE session_resume SET consumed = 1 WHERE session_id = ?1",
                    params![session_id],
                )
                .map_err(|err| format!("failed to mark resume consumed for {session_id}: {err}"))?;
                response.resume_snapshot = Some(resume.snapshot);
            }
            response.system_prompt = build_pi_system_prompt(
                params.system_prompt.as_deref(),
                response.active_memory.as_deref(),
                response.resume_snapshot.as_deref(),
            );
            write_text_response(
                &serde_json::to_string(&response).map_err(|err| {
                    format!("failed to encode before-agent-start response: {err}")
                })?,
                false,
            )
        }
        "record_provider_response" => {
            let mut conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response("record_provider_response requires sessionId", true);
            };
            let Some(meta) = params.provider_meta else {
                return write_text_response("{}", false);
            };
            let data = serde_json::to_string(&meta)
                .map_err(|err| format!("failed to encode provider response metadata: {err}"))?;
            let events = vec![SessionEventPayload {
                r#type: "provider_response".to_string(),
                category: "pi".to_string(),
                data,
                priority: 1,
                data_hash: None,
                project_dir: None,
                attribution_source: None,
                attribution_confidence: None,
                bytes_avoided: None,
                bytes_returned: None,
            }];
            session_record_events(
                &mut conn,
                session_id,
                params.project_dir.as_deref(),
                "PostToolUse",
                &events,
            )?;
            write_text_response("{}", false)
        }
        "prepare_before_compact" => {
            let conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response("prepare_before_compact requires sessionId", true);
            };
            let stats = session_stats(&conn, session_id)?;
            let all_events = session_load_events(&conn, session_id, None, 1_000)?
                .into_iter()
                .map(|event| SemanticStoredEvent {
                    event_type: event.r#type,
                    category: event.category,
                    data: event.data,
                    priority: event.priority,
                    created_at: Some(event.created_at),
                })
                .collect::<Vec<_>>();
            if all_events.is_empty() {
                return write_text_response(
                    &serde_json::to_string(&json!({ "eventCount": 0 })).map_err(|err| {
                        format!("failed to encode empty before-compact response: {err}")
                    })?,
                    false,
                );
            }
            let snapshot = session_semantics::build_resume_snapshot(
                &all_events,
                stats.as_ref().map(|row| row.compact_count + 1).unwrap_or(1),
                "cg_search",
            );
            conn.execute(
                "INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET \
                 snapshot = excluded.snapshot, \
                 event_count = excluded.event_count, \
                 created_at = datetime('now'), \
                 consumed = 0",
                params![session_id, snapshot, all_events.len() as i64],
            )
            .map_err(|err| format!("failed to upsert resume for {session_id}: {err}"))?;
            write_text_response(
                &serde_json::to_string(&json!({
                    "snapshot": snapshot,
                    "eventCount": all_events.len(),
                }))
                .map_err(|err| format!("failed to encode before-compact response: {err}"))?,
                false,
            )
        }
        "build_resume_snapshot" => {
            let events = params
                .events
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(payload_to_semantic_event)
                .collect::<Vec<_>>();
            let snapshot = session_semantics::build_resume_snapshot(
                &events,
                params.compact_count.unwrap_or(1),
                params.search_tool.as_deref().unwrap_or("cg_search"),
            );
            write_text_response(
                &serde_json::to_string(&snapshot)
                    .map_err(|err| format!("failed to encode resume snapshot: {err}"))?,
                false,
            )
        }
        "mark_resume_consumed" => {
            let conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response("mark_resume_consumed requires sessionId", true);
            };
            conn.execute(
                "UPDATE session_resume SET consumed = 1 WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|err| format!("failed to mark resume consumed for {session_id}: {err}"))?;
            write_text_response("{}", false)
        }
        "upsert_resume" => {
            let conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response("upsert_resume requires sessionId", true);
            };
            conn.execute(
                "INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET \
                 snapshot = excluded.snapshot, \
                 event_count = excluded.event_count, \
                 created_at = datetime('now'), \
                 consumed = 0",
                params![session_id, params.snapshot.as_deref().unwrap_or(""), params.event_count.unwrap_or(0)],
            )
            .map_err(|err| format!("failed to upsert resume for {session_id}: {err}"))?;
            write_text_response("{}", false)
        }
        "increment_compact_count" => {
            let conn = open_session_db(&params.session_db_path)?;
            let Some(session_id) = params.session_id.as_deref() else {
                return write_text_response("increment_compact_count requires sessionId", true);
            };
            conn.execute(
                "UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|err| format!("failed to increment compact count for {session_id}: {err}"))?;
            write_text_response("{}", false)
        }
        action => write_text_response(&format!("unsupported session action: {action}"), true),
    }
}

fn index_command(params: serde_json::Value) -> Result<(), String> {
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

    write_text_response(
        &format!(
            "Indexed {} sections ({} with code) into Context Guard core. Use cg_search(queries: [\"...\"]) to query this content.",
            summary.total_chunks, summary.code_chunks
        ),
        false,
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

fn build_pi_system_prompt(
    existing_prompt: Option<&str>,
    active_memory: Option<&str>,
    resume_snapshot: Option<&str>,
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(existing_prompt) = existing_prompt.filter(|value| !value.is_empty()) {
        parts.push(existing_prompt.to_string());
    }
    if !existing_prompt.is_some_and(|prompt| prompt.contains("<context_window_protection>")) {
        parts.push(PI_ROUTING_BLOCK.to_string());
    }
    if let Some(active_memory) = active_memory.filter(|value| !value.is_empty()) {
        parts.push(active_memory.to_string());
    }
    if let Some(resume_snapshot) = resume_snapshot.filter(|value| !value.is_empty()) {
        parts.push(resume_snapshot.to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn index_markdown_source(
    conn: &mut Connection,
    label: &str,
    text: &str,
    file_path: Option<&str>,
    content_hash: Option<&str>,
) -> Result<IndexSummary, String> {
    let chunks = chunk_markdown(text, MAX_MARKDOWN_CHUNK_BYTES);
    replace_source_chunks(conn, label, &chunks, file_path, content_hash)
}

fn index_single_chunk_source(
    conn: &mut Connection,
    label: &str,
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
    replace_source_chunks(conn, label, &[chunk], None, None)
}

fn replace_source_chunks(
    conn: &mut Connection,
    label: &str,
    chunks: &[Chunk],
    file_path: Option<&str>,
    content_hash: Option<&str>,
) -> Result<IndexSummary, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start transaction for {label}: {err}"))?;
    let summary =
        replace_source_chunks_in_transaction(&tx, label, chunks, file_path, content_hash)?;
    tx.commit()
        .map_err(|err| format!("failed to commit source {label}: {err}"))?;
    Ok(summary)
}

fn replace_source_chunks_in_transaction(
    tx: &Transaction<'_>,
    label: &str,
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
        "INSERT INTO sources(label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![label, chunks.len() as i64, code_chunks as i64, file_path, content_hash],
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
        session_db_path: params.session_db_path.as_deref(),
        project_dir: params.project_dir.as_deref(),
        config_dir: params.config_dir.as_deref(),
        refreshed_count: refreshed,
    };
    let output = render_search(&conn, &queries, &context)?;
    write_text_response(&output, false)
}

struct SearchContext<'a> {
    limit: usize,
    source_filter: Option<&'a str>,
    content_type: Option<&'a str>,
    sort: &'a str,
    session_db_path: Option<&'a str>,
    project_dir: Option<&'a str>,
    config_dir: Option<&'a str>,
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

    if let (Some(session_db_path), Some(project_dir)) =
        (context.session_db_path, context.project_dir)
    {
        results.extend(search_prior_session_events(
            session_db_path,
            query,
            context.limit,
            project_dir,
            context.source_filter,
        )?);
    }

    if let Some(project_dir) = context.project_dir {
        results.extend(search_auto_memory(
            query,
            context.limit,
            project_dir,
            context.config_dir,
        )?);
    }

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
        "SELECT {table}.title, {table}.content, sources.label, {table}.timestamp, bm25({table}, 5.0, 1.0) AS rank \
         FROM {table} \
         JOIN sources ON sources.id = {table}.source_id \
         WHERE {table} MATCH ?1"
    );
    let mut values = vec![Value::Text(query.to_string())];

    if let Some(source) = source_filter {
        sql.push_str(" AND sources.label LIKE ?");
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

fn search_prior_session_events(
    session_db_path: &str,
    query: &str,
    limit: usize,
    project_dir: &str,
    source_filter: Option<&str>,
) -> Result<Vec<SearchMatch>, String> {
    if !Path::new(session_db_path).exists() {
        return Ok(Vec::new());
    }

    let conn = match Connection::open(session_db_path) {
        Ok(conn) => conn,
        Err(_) => return Ok(Vec::new()),
    };
    if !table_exists(&conn, "session_events")? {
        return Ok(Vec::new());
    }

    let escaped_query = query.replace(['%', '_'], "\\$0");
    let mut sql = String::from(
        "SELECT category, type, data, created_at FROM session_events \
         WHERE project_dir = ?1 \
           AND (data LIKE '%' || ?2 || '%' ESCAPE '\\' OR category LIKE '%' || ?3 || '%' ESCAPE '\\')",
    );
    let mut values = vec![
        Value::Text(project_dir.to_string()),
        Value::Text(escaped_query.clone()),
        Value::Text(escaped_query),
    ];
    if let Some(source) = source_filter {
        sql.push_str(" AND category = ?");
        values.push(Value::Text(source.to_string()));
    }
    sql.push_str(" ORDER BY id ASC LIMIT ?");
    values.push(Value::Integer(limit as i64));

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("failed to prepare prior-session search: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |row| {
            let category: String = row.get(0)?;
            let kind: String = row.get(1)?;
            Ok(SearchMatch {
                origin: "prior-session".to_string(),
                source: "prior-session".to_string(),
                title: format!("[{category}] {kind}"),
                content: row.get(2)?,
                timestamp: row.get(3)?,
            })
        })
        .map_err(|err| format!("failed to search prior-session events: {err}"))?;

    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|err| format!("failed to read prior-session row: {err}"))?);
    }
    Ok(matches)
}

fn search_auto_memory(
    query: &str,
    limit: usize,
    project_dir: &str,
    config_dir: Option<&str>,
) -> Result<Vec<SearchMatch>, String> {
    let mut candidates: Vec<(String, String)> = Vec::new();

    let project_agents = Path::new(project_dir).join("AGENTS.md");
    if project_agents.is_file() {
        candidates.push((
            project_agents.to_string_lossy().into_owned(),
            "project/AGENTS.md".to_string(),
        ));
    }

    if let Some(config_dir) = config_dir {
        if config_dir != project_dir {
            let user_agents = Path::new(config_dir).join("AGENTS.md");
            if user_agents.is_file() {
                candidates.push((
                    user_agents.to_string_lossy().into_owned(),
                    "user/AGENTS.md".to_string(),
                ));
            }
        }

        let memory_dir = Path::new(config_dir).join("memory");
        if memory_dir.is_dir() {
            for entry in fs::read_dir(&memory_dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if let Some(name) = path.file_name().and_then(|name| name.to_str())
                    && name.ends_with(".md")
                {
                    candidates.push((
                        path.to_string_lossy().into_owned(),
                        format!("memory/{name}"),
                    ));
                }
            }
        }
    }

    let mut results = Vec::new();
    for (path, label) in candidates {
        if results.len() >= limit {
            break;
        }

        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.len() <= 1_000_000 => metadata,
            _ => continue,
        };
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let terms = query
            .to_lowercase()
            .split_whitespace()
            .filter(|term| term.len() >= 3)
            .map(str::to_string)
            .collect::<Vec<_>>();
        if terms.is_empty() {
            continue;
        }

        let Some(first_idx) = first_matching_line_offset(&content, &terms) else {
            continue;
        };

        let mut start = floor_char_boundary(&content, first_idx.saturating_sub(200));
        let mut end = ceil_char_boundary(&content, (first_idx + 500).min(content.len()));
        if let Some(prev_blank) = content[..start].rfind("\n\n") {
            start = prev_blank + 2;
        }
        if let Some(next_blank) = content[end..].find("\n\n") {
            end += next_blank;
        }
        let snippet = content[start..end].trim().to_string();
        let timestamp = metadata.modified().ok().and_then(system_time_to_iso);
        results.push(SearchMatch {
            origin: "auto-memory".to_string(),
            source: label.clone(),
            title: format!("[auto-memory] {label}"),
            content: snippet,
            timestamp,
        });
    }

    Ok(results)
}

fn first_matching_line_offset(content: &str, terms: &[String]) -> Option<usize> {
    let mut offset = 0usize;
    for line in content.split_inclusive('\n') {
        let lowercase = line.to_lowercase();
        if terms.iter().any(|term| lowercase.contains(term)) {
            return Some(offset);
        }
        offset += line.len();
    }
    None
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

fn system_time_to_iso(time: SystemTime) -> Option<String> {
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    let secs = duration.as_secs();
    let nanos = duration.subsec_nanos();
    let datetime = chrono::DateTime::from_timestamp(secs as i64, nanos)?;
    Some(datetime.to_rfc3339())
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
            let deleted = purge_session_rows(session_db_path, session_id)?;
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

fn purge_session_rows(session_db_path: &str, session_id: &str) -> Result<usize, String> {
    if !Path::new(session_db_path).exists() {
        return Ok(0);
    }

    let mut conn = Connection::open(session_db_path)
        .map_err(|err| format!("failed to open session DB {session_db_path}: {err}"))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start session purge transaction: {err}"))?;
    let mut deleted = 0usize;

    for table in [
        "session_events",
        "session_resume",
        "session_meta",
        "tool_calls",
        "session_extractor_state",
    ] {
        if !table_exists(&tx, table)? {
            continue;
        }
        let sql = format!("DELETE FROM {table} WHERE session_id = ?1");
        deleted += tx
            .execute(&sql, params![session_id])
            .map_err(|err| format!("failed to purge {table} rows for {session_id}: {err}"))?;
    }

    tx.commit()
        .map_err(|err| format!("failed to commit session purge for {session_id}: {err}"))?;
    Ok(deleted)
}

fn batch_command(params: serde_json::Value) -> Result<(), String> {
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
        index_single_chunk_source(&mut conn, &result.label, &result.label, &result.section)?;
    }

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
            output.push_str(&format!(
                "## {}\n{}\n\n",
                result.label,
                truncate_output_for_response(&result.section)
            ));
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
            session_db_path: None,
            project_dir: None,
            config_dir: None,
            refreshed_count: 0,
        };
        let search_response = render_search(&conn, &queries, &search_context)?;
        output.push_str(&search_response);
    }

    let failed_count = results
        .iter()
        .filter(|result| result.exit_code != Some(0))
        .count();
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
            "results": results.iter().map(|result| json!({
                "label": result.label,
                "command": result.command,
                "output": truncate_output_for_response(&result.section),
                "summary": result.summary,
                "exitCode": result.exit_code,
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
            }
        }
        Err(err) => BatchCommandResult {
            label: command.label.clone(),
            command: command.command.clone(),
            section: err.clone(),
            summary: err,
            exit_code: None,
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
    }
}

fn fetch_command(params: serde_json::Value) -> Result<(), String> {
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
            if let Some(session_db_path) = params.session_db_path.as_deref() {
                let bytes_avoided = source_cached_bytes(&conn, &cache_key).unwrap_or(0);
                let _ = emit_fetch_cache_hit(session_db_path, &display_source, bytes_avoided);
            }
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
    write_text_response(&text, errors > 0)
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

fn source_cached_bytes(conn: &Connection, source: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(chunks.content)), 0) \
         FROM sources \
         JOIN chunks ON chunks.source_id = sources.id \
         WHERE sources.label = ?1",
        params![source],
        |row| row.get(0),
    )
    .map_err(|err| format!("failed to read cached source bytes: {err}"))
}

fn emit_fetch_cache_hit(
    session_db_path: &str,
    source: &str,
    bytes_avoided: i64,
) -> Result<(), String> {
    let Some(mut conn) = open_existing_session_db(session_db_path)? else {
        return Ok(());
    };
    let Some(session_id) = resolve_session_target(&conn, None)? else {
        return Ok(());
    };
    let events = vec![SessionEventPayload {
        r#type: "cache-hit".to_string(),
        category: "cache".to_string(),
        data: source.to_string(),
        priority: 1,
        data_hash: None,
        project_dir: None,
        attribution_source: Some("server".to_string()),
        attribution_confidence: Some(1.0),
        bytes_avoided: Some(bytes_avoided),
        bytes_returned: None,
    }];
    session_record_events(&mut conn, &session_id, None, "cg-server", &events)?;
    Ok(())
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
        .map(read_current_session_status)
        .transpose()?
        .unwrap_or_default();
    lines.push(format!("- Tool calls: {}", current_session.tool_calls));

    lines.push(String::new());
    lines.push("### Session memory".to_string());
    lines.push(format!("- Events captured: {}", current_session.events));
    lines.push(format!(
        "- Conversations recorded: {}",
        current_session.sessions
    ));
    lines.push(format!(
        "- Compactions recorded: {}",
        current_session.compactions
    ));
    lines.push(format!(
        "- Resume snapshots: {}",
        current_session.resume_snapshots
    ));
    if let Some(latest_event_at) = current_session.latest_event_at {
        lines.push(format!("- Latest event: {latest_event_at}"));
    }

    lines.push(String::new());
    lines.push("### Indexed content".to_string());
    lines.push(format!("- Indexed chunks: {chunks}"));
    lines.push(format!("- Indexed sources: {sources}"));
    lines.push(format!("- Indexed code chunks: {code_chunks}"));
    if !recent_sources.is_empty() {
        lines.push(format!("- Recent sources: {}", recent_sources.join(", ")));
    }

    let lifetime = match (params.sessions_dir.as_deref(), params.config_dir.as_deref()) {
        (Some(sessions_dir), Some(config_dir)) => {
            Some(read_lifetime_status(sessions_dir, config_dir)?)
        }
        _ => None,
    };
    if let Some(lifetime) = lifetime {
        lines.push(String::new());
        lines.push("### Durable memory".to_string());
        lines.push(format!(
            "- Events across projects: {}",
            lifetime.total_events
        ));
        lines.push(format!(
            "- Conversations across projects: {}",
            lifetime.total_sessions
        ));
        lines.push(format!(
            "- Projects with session DBs: {}",
            lifetime.distinct_projects
        ));
        lines.push(format!(
            "- Resume snapshots across projects: {}",
            lifetime.resume_snapshots
        ));
        lines.push(format!(
            "- Auto-memory files: {} across {} projects",
            lifetime.auto_memory_count, lifetime.auto_memory_projects
        ));
    }

    write_text_response(&lines.join("\n"), false)
}

#[derive(Default)]
struct CurrentSessionStatus {
    tool_calls: i64,
    events: i64,
    sessions: i64,
    compactions: i64,
    resume_snapshots: i64,
    latest_event_at: Option<String>,
}

fn read_current_session_status(session_db_path: &str) -> Result<CurrentSessionStatus, String> {
    if !Path::new(session_db_path).exists() {
        return Ok(CurrentSessionStatus::default());
    }

    let conn = Connection::open(session_db_path)
        .map_err(|err| format!("failed to open session DB {session_db_path}: {err}"))?;
    if !table_exists(&conn, "session_meta")? {
        return Ok(CurrentSessionStatus::default());
    }

    let latest_session_id: Option<String> = conn
        .query_row(
            "SELECT session_id FROM session_meta ORDER BY datetime(started_at) DESC, rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let tool_calls = latest_session_id
        .as_deref()
        .and_then(|session_id| {
            conn.query_row(
                "SELECT COALESCE(SUM(calls), 0) FROM tool_calls WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .ok()
        })
        .unwrap_or(0);
    let (sessions, compactions): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(compact_count), 0) FROM session_meta",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((0, 0));
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_events", [], |row| row.get(0))
        .unwrap_or(0);
    let resume_snapshots: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_resume", [], |row| row.get(0))
        .unwrap_or(0);
    let latest_event_at: Option<String> = conn
        .query_row("SELECT MAX(created_at) FROM session_events", [], |row| {
            row.get(0)
        })
        .ok()
        .flatten();

    Ok(CurrentSessionStatus {
        tool_calls,
        events,
        sessions,
        compactions,
        resume_snapshots,
        latest_event_at,
    })
}

struct LifetimeStatus {
    total_events: i64,
    total_sessions: i64,
    distinct_projects: i64,
    resume_snapshots: i64,
    auto_memory_count: i64,
    auto_memory_projects: i64,
}

fn read_lifetime_status(sessions_dir: &str, config_dir: &str) -> Result<LifetimeStatus, String> {
    let mut total_events = 0i64;
    let mut total_sessions = 0i64;
    let mut distinct_projects = 0i64;
    let mut resume_snapshots = 0i64;

    if Path::new(sessions_dir).is_dir() {
        for entry in fs::read_dir(sessions_dir)
            .map_err(|err| format!("failed to read sessions dir {sessions_dir}: {err}"))?
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("db") {
                continue;
            }
            let db = match Connection::open(&path) {
                Ok(db) => db,
                Err(_) => continue,
            };
            distinct_projects += 1;
            total_events += db
                .query_row("SELECT COUNT(*) FROM session_events", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0);
            total_sessions += db
                .query_row("SELECT COUNT(*) FROM session_meta", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0);
            resume_snapshots += db
                .query_row("SELECT COUNT(*) FROM session_resume", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0);
        }
    }

    let mut auto_memory_count = 0i64;
    let mut auto_memory_projects = 0i64;
    let memory_root = Path::new(config_dir).join("memory");
    if memory_root.is_dir() {
        for entry in fs::read_dir(&memory_root)
            .map_err(|err| format!("failed to read memory dir {}: {err}", memory_root.display()))?
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let mut project_count = 0i64;
            let Ok(children) = fs::read_dir(&path) else {
                continue;
            };
            for child in children {
                let Ok(child) = child else {
                    continue;
                };
                let child_path = child.path();
                if child_path.is_file()
                    && child_path.extension().and_then(|ext| ext.to_str()) == Some("md")
                {
                    project_count += 1;
                }
            }
            if project_count > 0 {
                auto_memory_projects += 1;
                auto_memory_count += project_count;
            }
        }
    }

    Ok(LifetimeStatus {
        total_events,
        total_sessions,
        distinct_projects,
        resume_snapshots,
        auto_memory_count,
        auto_memory_projects,
    })
}

fn load_recent_sources(conn: &Connection, limit: usize) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT label FROM sources ORDER BY datetime(indexed_at) DESC, id DESC LIMIT ?1")
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
    let payload = serde_json::to_string(&response)
        .map_err(|err| format!("failed to serialize response: {err}"))?;
    println!("{payload}");
    Ok(())
}
