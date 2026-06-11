use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use chrono::Utc;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const REDACTED: &str = "[REDACTED]";
const TOOL_CALL_PARAMS_BUDGET_BYTES: usize = 2048;
const DECISION_MIN_CHARS: usize = 15;
const DECISION_MAX_CHARS: usize = 500;
const ROLE_MIN_CHARS: usize = 8;
const ROLE_MAX_CHARS: usize = 120;
const IMPERATIVE_MAX_CHARS: usize = 60;
const RECENT_MESSAGES_LIMIT: usize = 3;
const RECENT_MESSAGE_MAX_CHARS: usize = 400;
const MAX_ACTIVE_FILES: usize = 10;
const ACTIVE_MEMORY_BUDGET_TOKENS: usize = 500;

static BASH_ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)exit code [1-9]|error:|fail|failed").expect("bash error regex")
});
static RULE_MEMORY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)[\\/ ]memor(?:y|ies)[\\/][^\\/]+\.md$"
            .replace(' ', "")
            .as_str(),
    )
    .expect("memory rule regex")
});
static PLAN_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[/\\])\.pi[/\\]plans[/\\]").expect("plan path regex"));
static CD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\bcd\s+("([^"]+)"|'([^']+)'|(\S+))"#).expect("cd regex"));
static SECRET_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(authorization|auth_token|access_token|refresh_token|bearer|token|secret|password|passwd|pwd|api[-_]?key|apikey|cookie|set-cookie|signature|private[-_]?key|client[-_]?secret|x[-_]?api[-_]?key)",
    )
    .expect("secret key regex")
});
static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"https?://[^\s)]+").expect("url regex"));
static ISSUE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[^\pL\pN_])#(\d+)").expect("issue regex"));
static CLAUSE_SEPARATOR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[,;，；、،]").expect("clause separator regex"));
static ALPHABETIC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{L}").expect("alphabetic regex"));
static TWO_LEXICAL_TOKENS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{L}+\s+\p{L}+").expect("two lexical tokens regex"));
static CONTINUOUS_LETTER_RUN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{L}{6,}").expect("continuous letter run regex"));
static BLOCKER_MARKERS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Error\s*:|Exception\s*:|Traceback|at\s+\S+\s*\([^)]*:\d+:\d+\)")
        .expect("blocker markers regex")
});
static BLOCKER_RESOLVED_MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(?:fixed|resolved)\s*:").expect("resolved marker regex"));
static FETCH_PREAMBLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Fetched and indexed[^\(]*\(([\d.]+)\s*KB\)").expect("fetch preamble regex")
});
static BLOCKED_BASH_CURL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bcurl\s").expect("blocked curl regex"));
static BLOCKED_BASH_WGET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bwget\s").expect("blocked wget regex"));
static BLOCKED_BASH_FETCH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bfetch\s*\(").expect("blocked fetch regex"));
static BLOCKED_BASH_REQUESTS_GET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\brequests\.get\s*\(").expect("blocked requests.get regex"));
static BLOCKED_BASH_REQUESTS_POST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\brequests\.post\s*\(").expect("blocked requests.post regex"));
static BLOCKED_BASH_HTTP_GET_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bhttp\.get\s*\(").expect("blocked http.get regex"));
static BLOCKED_BASH_HTTP_REQUEST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bhttp\.request\s*\(").expect("blocked http.request regex"));
static BLOCKED_BASH_URLLIB_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\burllib\.request").expect("blocked urllib regex"));
static BLOCKED_BASH_INVOKE_WEB_REQUEST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bInvoke-WebRequest\b").expect("blocked Invoke-WebRequest regex")
});

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub category: String,
    pub data: String,
    pub priority: i64,
    #[serde(rename = "bytesAvoided", skip_serializing_if = "Option::is_none")]
    pub bytes_avoided: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolOutput {
    #[serde(rename = "isError")]
    pub is_error: Option<bool>,
    #[serde(rename = "is_error")]
    pub is_error_snake: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookInput {
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: Map<String, Value>,
    #[serde(default)]
    pub tool_response: Option<String>,
    #[serde(default)]
    pub tool_output: Option<ToolOutput>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub category: String,
    pub data: String,
    pub priority: i64,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractorState {
    pub last_error: Option<LastErrorState>,
    #[serde(default)]
    pub call_history: Vec<CallHistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastErrorState {
    pub tool: String,
    pub error: String,
    pub calls_since: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallHistoryEntry {
    pub tool: String,
    pub input_hash: String,
}

pub fn extract_events(
    raw_input: HookInput,
    fallback_tool_name: Option<&str>,
    state: &mut ExtractorState,
) -> Vec<SessionEvent> {
    let input = normalize_hook_input(raw_input);
    let mut events = Vec::new();

    events.extend(extract_file_and_rule(&input));
    events.extend(extract_cwd(&input));
    events.extend(extract_error(&input));
    events.extend(extract_git(&input));
    events.extend(extract_env(&input));
    events.extend(extract_task(&input));
    events.extend(extract_plan(&input));
    events.extend(extract_skill(&input));
    events.extend(extract_subagent(&input));
    events.extend(extract_tool_invocation(&input));
    events.extend(extract_tool_call(&input));
    events.extend(extract_decision(&input));
    events.extend(extract_constraint(&input));
    events.extend(extract_worktree(&input));
    events.extend(extract_agent_finding(&input));
    events.extend(extract_external_ref(&input));
    events.extend(extract_error_resolution(&input, state));
    events.extend(extract_iteration_loop(&input, state));

    if events.is_empty()
        && let Some(tool_name) = fallback_tool_name.filter(|name| !name.is_empty())
    {
        let payload = json!({
            "tool": tool_name,
            "params": Value::Object(input.tool_input.clone()),
        });
        events.push(SessionEvent {
            event_type: "tool_call".to_string(),
            category: "pi".to_string(),
            data: payload.to_string(),
            priority: 1,
            bytes_avoided: None,
        });
    }

    events
}

pub fn extract_user_events(message: &str) -> Vec<SessionEvent> {
    let mut events = vec![event("user_prompt", "user-prompt", message, 4)];
    events.extend(extract_user_decision(message));
    events.extend(extract_role(message));
    events.extend(extract_intent(message));
    events.extend(extract_blocker(message));
    events.extend(extract_data(message));
    events
}

pub fn build_resume_snapshot(
    events: &[StoredEvent],
    compact_count: i64,
    search_tool: &str,
) -> String {
    let mut file_events = Vec::new();
    let mut task_events = Vec::new();
    let mut rule_events = Vec::new();
    let mut decision_events = Vec::new();
    let mut cwd_events = Vec::new();
    let mut error_events = Vec::new();
    let mut env_events = Vec::new();
    let mut git_events = Vec::new();
    let mut subagent_events = Vec::new();
    let mut intent_events = Vec::new();
    let mut skill_events = Vec::new();
    let mut role_events = Vec::new();
    let mut user_prompt_events = Vec::new();

    for event in events {
        match event.category.as_str() {
            "file" => file_events.push(event.clone()),
            "task" => task_events.push(event.clone()),
            "rule" => rule_events.push(event.clone()),
            "decision" => decision_events.push(event.clone()),
            "cwd" => cwd_events.push(event.clone()),
            "error" => error_events.push(event.clone()),
            "env" => env_events.push(event.clone()),
            "git" => git_events.push(event.clone()),
            "subagent" => subagent_events.push(event.clone()),
            "intent" => intent_events.push(event.clone()),
            "skill" => skill_events.push(event.clone()),
            "role" => role_events.push(event.clone()),
            "user-prompt" => user_prompt_events.push(event.clone()),
            _ => {}
        }
    }

    let mut sections = vec![String::from(
        "  <how_to_search>\n  Each section below contains a summary of prior work.\n  For FULL DETAILS, run the exact tool call shown under each section.\n  Do NOT ask the user to re-explain prior work. Search first.\n  Do NOT invent your own queries — use the ones provided.\n  </how_to_search>",
    )];

    push_nonempty(
        &mut sections,
        build_files_section(&file_events, search_tool),
    );
    push_nonempty(
        &mut sections,
        build_errors_section(&error_events, search_tool),
    );
    push_nonempty(
        &mut sections,
        build_decisions_section(&decision_events, search_tool),
    );
    push_nonempty(
        &mut sections,
        build_rules_section(&rule_events, search_tool),
    );
    push_nonempty(&mut sections, build_git_section(&git_events, search_tool));
    push_nonempty(&mut sections, build_task_section(&task_events, search_tool));
    push_nonempty(
        &mut sections,
        build_environment_section(&cwd_events, &env_events, search_tool),
    );
    push_nonempty(
        &mut sections,
        build_subagents_section(&subagent_events, search_tool),
    );
    push_nonempty(
        &mut sections,
        build_skills_section(&skill_events, search_tool),
    );
    push_nonempty(
        &mut sections,
        build_roles_section(&role_events, search_tool),
    );
    push_nonempty(&mut sections, build_intent_section(&intent_events));
    push_nonempty(
        &mut sections,
        build_recent_messages_section(&user_prompt_events),
    );

    let header = format!(
        "<session_resume events=\"{}\" compact_count=\"{}\" generated_at=\"{}\">",
        events.len(),
        compact_count.max(1),
        Utc::now().to_rfc3339()
    );
    let footer = "</session_resume>";
    let body = sections.join("\n\n");
    if body.is_empty() {
        format!("{header}\n{footer}")
    } else {
        format!("{header}\n\n{body}\n\n{footer}")
    }
}

pub fn build_active_memory(events: &[StoredEvent]) -> String {
    let mut role: Option<&StoredEvent> = None;
    let mut decisions = Vec::new();
    let mut intent: Option<&StoredEvent> = None;
    let mut skills_seen = HashSet::new();
    let mut skills_ordered = Vec::new();

    for event in events {
        match event.category.as_str() {
            "role" => role = Some(event),
            "decision" => decisions.push(event),
            "skill" if skills_seen.insert(event.data.clone()) => {
                skills_ordered.push(event.data.clone());
            }
            "intent" => intent = Some(event),
            _ => {}
        }
    }

    let mut parts = Vec::new();
    let mut budget = ACTIVE_MEMORY_BUDGET_TOKENS as i64;

    if let Some(role) = role {
        let text = format!(
            "<behavioral_directive>\n{}\n</behavioral_directive>",
            truncate_chars(&role.data, 400)
        );
        budget -= estimate_tokens(&text) as i64;
        parts.push(text);
    }

    let recent_decisions = decisions.into_iter().rev().take(5).collect::<Vec<_>>();
    if !recent_decisions.is_empty() {
        let build_rules = |items: &[&StoredEvent]| -> String {
            let lines = items
                .iter()
                .rev()
                .map(|event| format!("- {}", truncate_chars(&event.data, 100)))
                .collect::<Vec<_>>()
                .join("\n");
            format!("<rules>\nFollow these decisions:\n{lines}\n</rules>")
        };

        let candidate = build_rules(&recent_decisions);
        if estimate_tokens(&candidate) as i64 <= budget {
            budget -= estimate_tokens(&candidate) as i64;
            parts.push(candidate);
        } else {
            let reduced = recent_decisions.into_iter().take(3).collect::<Vec<_>>();
            let fallback = build_rules(&reduced);
            budget -= estimate_tokens(&fallback) as i64;
            parts.push(fallback);
        }
    }

    if !skills_ordered.is_empty() && budget > 50 {
        let text = format!(
            "<active_skills>\nRe-invoke if relevant: {}\nTo reload: call the Skill tool with the skill name.\n</active_skills>",
            skills_ordered
                .into_iter()
                .rev()
                .take(10)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(", ")
        );
        budget -= estimate_tokens(&text) as i64;
        parts.push(text);
    }

    if let Some(intent) = intent.filter(|_| budget > 20) {
        parts.push(format!("<session_mode>{}</session_mode>", intent.data));
    }

    if parts.is_empty() {
        String::new()
    } else {
        format!(
            "<session_state source=\"compaction\">\n\n{}\n\n</session_state>",
            parts.join("\n\n")
        )
    }
}

pub fn blocked_tool_call_reason(input: &HookInput) -> Option<String> {
    if !input.tool_name.eq_ignore_ascii_case("bash") {
        return None;
    }
    let command = tool_input_string(input, "command");
    if command.is_empty() {
        return None;
    }
    let blocked = [
        &*BLOCKED_BASH_CURL_RE,
        &*BLOCKED_BASH_WGET_RE,
        &*BLOCKED_BASH_FETCH_RE,
        &*BLOCKED_BASH_REQUESTS_GET_RE,
        &*BLOCKED_BASH_REQUESTS_POST_RE,
        &*BLOCKED_BASH_HTTP_GET_RE,
        &*BLOCKED_BASH_HTTP_REQUEST_RE,
        &*BLOCKED_BASH_URLLIB_RE,
        &*BLOCKED_BASH_INVOKE_WEB_REQUEST_RE,
    ]
    .iter()
    .any(|pattern| pattern.is_match(&command));
    if blocked {
        Some(
            "Use context-guard tools (execute, fetch_and_index) instead of inline HTTP clients. Raw curl/wget/fetch output floods the context window."
                .to_string(),
        )
    } else {
        None
    }
}

fn push_nonempty(out: &mut Vec<String>, value: String) {
    if !value.is_empty() {
        out.push(value);
    }
}

fn normalize_hook_input(mut input: HookInput) -> HookInput {
    let normalized = match input.tool_name.as_str() {
        "bash" => Some("Bash"),
        "read" => Some("Read"),
        "write" => Some("Write"),
        "edit" => Some("Edit"),
        "grep" => Some("Grep"),
        "find" => Some("Glob"),
        "ls" => Some("Glob"),
        _ => None,
    };
    if let Some(name) = normalized {
        input.tool_name = name.to_string();
    }
    input
}

fn is_tool_error(input: &HookInput) -> bool {
    let response = input.tool_response.as_deref().unwrap_or("");
    let is_error_flag = input
        .tool_output
        .as_ref()
        .map(|output| output.is_error == Some(true) || output.is_error_snake == Some(true))
        .unwrap_or(false);
    let is_bash_error = input.tool_name == "Bash" && BASH_ERROR_RE.is_match(response);
    is_error_flag || is_bash_error
}

fn tool_input_string(input: &HookInput, key: &str) -> String {
    match input.tool_input.get(key) {
        Some(Value::String(value)) => value.clone(),
        Some(value) => json_string(value),
        None => String::new(),
    }
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

fn extract_apply_patch_targets(command: &str) -> Vec<(String, String)> {
    if command.is_empty() {
        return Vec::new();
    }
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for line in command.lines() {
        let target = if let Some(path) = line.strip_prefix("*** Add File: ") {
            Some(("file_write", path.trim()))
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            Some(("file_edit", path.trim()))
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            Some(("file_edit", path.trim()))
        } else {
            line.strip_prefix("*** Move to: ")
                .map(|path| ("file_edit", path.trim()))
        };
        if let Some((event_type, path)) = target
            && !path.is_empty()
            && seen.insert(format!("{event_type}:{path}"))
        {
            targets.push((event_type.to_string(), path.to_string()));
        }
    }
    targets
}

fn is_plan_file_path(path: &str) -> bool {
    PLAN_PATH_RE.is_match(path)
}

fn event(event_type: &str, category: &str, data: impl Into<String>, priority: i64) -> SessionEvent {
    SessionEvent {
        event_type: event_type.to_string(),
        category: category.to_string(),
        data: data.into(),
        priority,
        bytes_avoided: None,
    }
}

fn extract_file_and_rule(input: &HookInput) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    match input.tool_name.as_str() {
        "Read" => {
            let file_path = tool_input_string(input, "file_path");
            let is_rule_file = file_path.ends_with("AGENTS.md")
                || file_path.ends_with("AGENTS.override.md")
                || RULE_MEMORY_RE.is_match(&file_path);
            if is_rule_file {
                events.push(event("rule", "rule", file_path.clone(), 1));
                if let Some(response) = input.tool_response.as_ref().filter(|text| !text.is_empty())
                {
                    events.push(event("rule_content", "rule", response.clone(), 1));
                }
            }
            events.push(event("file_read", "file", file_path, 1));
        }
        "Edit" => events.push(event(
            "file_edit",
            "file",
            tool_input_string(input, "file_path"),
            1,
        )),
        "NotebookEdit" => {
            events.push(event(
                "file_edit",
                "file",
                tool_input_string(input, "notebook_path"),
                1,
            ));
        }
        "Write" => events.push(event(
            "file_write",
            "file",
            tool_input_string(input, "file_path"),
            1,
        )),
        "apply_patch" if !is_tool_error(input) => {
            let command = input
                .tool_input
                .get("command")
                .or_else(|| input.tool_input.get("patch"))
                .map(json_string_or_string)
                .unwrap_or_default();
            for (event_type, path) in extract_apply_patch_targets(&command) {
                events.push(event(&event_type, "file", path, 1));
            }
        }
        "Glob" => events.push(event(
            "file_glob",
            "file",
            tool_input_string(input, "pattern"),
            3,
        )),
        "Grep" => {
            let pattern = tool_input_string(input, "pattern");
            let path = tool_input_string(input, "path");
            events.push(event(
                "file_search",
                "file",
                format!("{pattern} in {path}"),
                3,
            ));
        }
        _ => {}
    }
    events
}

fn extract_cwd(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "Bash" {
        return Vec::new();
    }
    let command = tool_input_string(input, "command");
    let Some(captures) = CD_RE.captures(&command) else {
        return Vec::new();
    };
    let dir = captures
        .get(2)
        .or_else(|| captures.get(3))
        .or_else(|| captures.get(4))
        .map(|value| value.as_str().to_string())
        .unwrap_or_default();
    vec![event("cwd", "cwd", dir, 2)]
}

fn extract_error(input: &HookInput) -> Vec<SessionEvent> {
    if !is_tool_error(input) {
        return Vec::new();
    }
    vec![event(
        "error_tool",
        "error",
        input.tool_response.clone().unwrap_or_default(),
        2,
    )]
}

fn extract_git(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "Bash" {
        return Vec::new();
    }
    let command = tool_input_string(input, "command");
    for (needle, operation) in [
        ("git checkout", "branch"),
        ("git commit", "commit"),
        ("git merge", "merge"),
        ("git rebase", "rebase"),
        ("git stash", "stash"),
        ("git push", "push"),
        ("git pull", "pull"),
        ("git log", "log"),
        ("git diff", "diff"),
        ("git status", "status"),
        ("git branch", "branch"),
        ("git reset", "reset"),
        ("git add", "add"),
        ("git cherry-pick", "cherry-pick"),
        ("git tag", "tag"),
        ("git fetch", "fetch"),
        ("git clone", "clone"),
        ("git worktree", "worktree"),
    ] {
        if command.contains(needle) {
            return vec![event("git", "git", operation, 2)];
        }
    }
    Vec::new()
}

fn extract_task(input: &HookInput) -> Vec<SessionEvent> {
    let event_type = match input.tool_name.as_str() {
        "TaskUpdate" => Some("task_update"),
        "TaskCreate" => Some("task_create"),
        "TodoWrite" => Some("task"),
        _ => None,
    };
    event_type
        .map(|kind| {
            vec![event(
                kind,
                "task",
                serde_json::to_string(&Value::Object(input.tool_input.clone())).unwrap_or_default(),
                1,
            )]
        })
        .unwrap_or_default()
}

fn extract_plan(input: &HookInput) -> Vec<SessionEvent> {
    match input.tool_name.as_str() {
        "EnterPlanMode" => vec![event("plan_enter", "plan", "entered plan mode", 2)],
        "ExitPlanMode" => {
            let mut events = Vec::new();
            let detail = match input.tool_input.get("allowedPrompts") {
                Some(Value::Array(values)) if !values.is_empty() => {
                    let prompts = values
                        .iter()
                        .map(|value| {
                            value
                                .get("prompt")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| json_string_or_string(value))
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("exited plan mode (allowed: {prompts})")
                }
                _ => "exited plan mode".to_string(),
            };
            events.push(event("plan_exit", "plan", detail, 2));
            let response = input
                .tool_response
                .as_deref()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if response.contains("approved") || response.contains("approve") {
                events.push(event("plan_approved", "plan", "plan approved by user", 1));
            } else if response.contains("rejected")
                || response.contains("decline")
                || response.contains("denied")
            {
                events.push(event(
                    "plan_rejected",
                    "plan",
                    format!(
                        "plan rejected: {}",
                        input.tool_response.clone().unwrap_or_default()
                    ),
                    2,
                ));
            }
            events
        }
        "Write" | "Edit" => {
            let path = tool_input_string(input, "file_path");
            if is_plan_file_path(&path) {
                vec![event(
                    "plan_file_write",
                    "plan",
                    format!("plan file: {}", basename(&path)),
                    2,
                )]
            } else {
                Vec::new()
            }
        }
        "apply_patch" if !is_tool_error(input) => {
            let command = input
                .tool_input
                .get("command")
                .or_else(|| input.tool_input.get("patch"))
                .map(json_string_or_string)
                .unwrap_or_default();
            extract_apply_patch_targets(&command)
                .into_iter()
                .filter(|(_, path)| is_plan_file_path(path))
                .map(|(_, path)| {
                    event(
                        "plan_file_write",
                        "plan",
                        format!("plan file: {}", basename(&path)),
                        2,
                    )
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

fn extract_env(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "Bash" {
        return Vec::new();
    }
    let command = tool_input_string(input, "command");
    let patterns = [
        "activate",
        "export ",
        "nvm use",
        "pyenv ",
        "conda activate",
        "rbenv ",
        "npm install",
        "npm ci",
        "pip install",
        "bun install",
        "yarn add",
        "yarn install",
        "pnpm add",
        "pnpm install",
        "cargo install",
        "cargo add",
        "go install",
        "go get",
        "rustup",
        "asdf",
        "volta",
        "deno install",
    ];
    if !patterns.iter().any(|pattern| command.contains(pattern)) {
        return Vec::new();
    }
    let sanitized = command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('\n', " ");
    let mut parts = Vec::new();
    for segment in sanitized.split("export ") {
        if parts.is_empty() {
            parts.push(segment.to_string());
            continue;
        }
        let mut key = segment.to_string();
        if let Some(eq) = key.find('=') {
            key.truncate(eq);
        }
        parts.push(format!("export {key}=***"));
    }
    vec![event("env", "env", parts.join(""), 2)]
}

fn extract_skill(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "Skill" {
        return Vec::new();
    }
    vec![event(
        "skill",
        "skill",
        tool_input_string(input, "skill"),
        2,
    )]
}

fn extract_constraint(input: &HookInput) -> Vec<SessionEvent> {
    if !input
        .tool_response
        .as_deref()
        .unwrap_or_default()
        .contains("Error")
        && input
            .tool_output
            .as_ref()
            .map(|value| value.is_error == Some(true))
            .unwrap_or(false)
    {
        return Vec::new();
    }
    let response = input.tool_response.as_deref().unwrap_or_default();
    for needle in [
        "not supported",
        "cannot",
        "does not support",
        "FAIL",
        "refused",
        "permission denied",
        "incompatible",
    ] {
        if let Some(index) = response
            .to_ascii_lowercase()
            .find(&needle.to_ascii_lowercase())
        {
            let start = index.saturating_sub(50);
            let end = (index + 200).min(response.len());
            return vec![event(
                "constraint_discovered",
                "constraint",
                response[start..end].trim().to_string(),
                2,
            )];
        }
    }
    Vec::new()
}

fn extract_subagent(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "Agent" {
        return Vec::new();
    }
    let prompt = input
        .tool_input
        .get("prompt")
        .or_else(|| input.tool_input.get("description"))
        .map(json_string_or_string)
        .unwrap_or_default();
    let response = input.tool_response.clone().unwrap_or_default();
    let completed = !response.is_empty();
    vec![event(
        if completed {
            "subagent_completed"
        } else {
            "subagent_launched"
        },
        "subagent",
        if completed {
            format!("[completed] {prompt} → {response}")
        } else {
            format!("[launched] {prompt}")
        },
        if completed { 2 } else { 3 },
    )]
}

fn extract_tool_invocation(input: &HookInput) -> Vec<SessionEvent> {
    if !input.tool_name.starts_with("mcp__") {
        return Vec::new();
    }
    let tool_short = input
        .tool_name
        .split("__")
        .last()
        .unwrap_or(&input.tool_name)
        .to_string();
    let first_arg = input
        .tool_input
        .values()
        .find_map(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    let response = input.tool_response.clone().unwrap_or_default();
    let mut data = tool_short;
    if !first_arg.is_empty() {
        data.push_str(": ");
        data.push_str(&first_arg);
    }
    if !response.is_empty() {
        data.push_str("\nresponse: ");
        data.push_str(&response);
    }
    vec![event("tool_invocation", "tool", data, 3)]
}

fn redact_secrets(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted = Map::new();
            for (key, value) in map {
                if SECRET_KEY_RE.is_match(key) {
                    redacted.insert(key.clone(), Value::String(REDACTED.to_string()));
                } else {
                    redacted.insert(key.clone(), redact_secrets(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => Value::Array(values.iter().map(redact_secrets).collect()),
        other => other.clone(),
    }
}

fn truncate_to_bytes(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let bytes = value.as_bytes();
    let mut cut = max_bytes.min(bytes.len() - 1);
    while cut > 0 && (bytes[cut] & 0b1100_0000) == 0b1000_0000 {
        cut -= 1;
    }
    (String::from_utf8_lossy(&bytes[..cut]).to_string(), true)
}

fn extract_tool_call(input: &HookInput) -> Vec<SessionEvent> {
    if !input.tool_name.starts_with("mcp__") {
        return Vec::new();
    }
    let redacted_input = redact_secrets(&Value::Object(input.tool_input.clone()));
    let params_str = serde_json::to_string(&redacted_input).unwrap_or_else(|_| "{}".to_string());
    let (capped, truncated) = truncate_to_bytes(&params_str, TOOL_CALL_PARAMS_BUDGET_BYTES);
    let payload = if truncated {
        json!({
            "tool_name": input.tool_name,
            "params_raw": capped,
            "truncated": true,
        })
    } else {
        match serde_json::from_str::<Value>(&capped) {
            Ok(params) => json!({
                "tool_name": input.tool_name,
                "params": params,
            }),
            Err(_) => json!({
                "tool_name": input.tool_name,
                "params_raw": capped,
            }),
        }
    };
    vec![event("tool_call", "tool_call", payload.to_string(), 4)]
}

fn extract_decision(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "AskUserQuestion" {
        return Vec::new();
    }
    let question_text = input
        .tool_input
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|questions| questions.first())
        .and_then(|value| value.get("question"))
        .map(json_string_or_string)
        .unwrap_or_default();
    let mut answer = String::new();
    if let Some(response) = input.tool_response.as_ref()
        && let Ok(parsed) = serde_json::from_str::<Value>(response)
        && let Some(answers) = parsed.get("answers").and_then(Value::as_object)
    {
        if !question_text.is_empty()
            && let Some(value) = answers.get(&question_text)
        {
            answer = answer_text(value);
        }
        if answer.is_empty() {
            answer = answers
                .values()
                .map(answer_text)
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" | ");
        }
    }
    let summary = if question_text.is_empty() {
        format!("answer: {answer}")
    } else {
        format!("Q: {question_text} → A: {answer}")
    };
    vec![event("decision_question", "decision", summary, 2)]
}

fn answer_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" | "),
        _ => String::new(),
    }
}

fn extract_agent_finding(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "Agent" {
        return Vec::new();
    }
    let Some(response) = input
        .tool_response
        .as_ref()
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    let summary = response.chars().take(500).collect::<String>();
    vec![event("agent_finding", "agent-finding", summary, 2)]
}

fn extract_external_ref(input: &HookInput) -> Vec<SessionEvent> {
    let mut haystack = json_string(&Value::Object(input.tool_input.clone()));
    if let Some(response) = input.tool_response.as_ref() {
        if !haystack.is_empty() {
            haystack.push(' ');
        }
        haystack.push_str(response);
    }
    if haystack.is_empty() {
        return Vec::new();
    }
    let mut refs = HashSet::new();
    for value in URL_RE.find_iter(&haystack) {
        let url = value
            .as_str()
            .trim_end_matches(|ch: char| {
                matches!(ch, '"' | '\'' | '}' | ')' | ']' | ',' | ';' | '.')
            })
            .to_string();
        if !url.contains("localhost") && !url.contains("127.0.0.1") {
            refs.insert(url);
        }
    }
    for captures in ISSUE_RE.captures_iter(&haystack) {
        if let Some(number) = captures.get(2) {
            refs.insert(format!("#{}", number.as_str()));
        }
    }
    if refs.is_empty() {
        return Vec::new();
    }
    let mut output = event(
        "external_ref",
        "external-ref",
        refs.into_iter().collect::<Vec<_>>().join(", "),
        3,
    );
    if let Some(response) = input.tool_response.as_deref()
        && let Some(captures) = FETCH_PREAMBLE_RE.captures(response)
        && let Some(kb_match) = captures.get(1)
        && let Ok(kb) = kb_match.as_str().parse::<f64>()
        && kb.is_finite()
        && kb > 0.0
    {
        output.bytes_avoided = Some((kb * 1024.0).round() as i64);
    }
    vec![output]
}

fn extract_worktree(input: &HookInput) -> Vec<SessionEvent> {
    if input.tool_name != "EnterWorktree" {
        return Vec::new();
    }
    let name = tool_input_string(input, "name");
    vec![event(
        "worktree",
        "env",
        format!("entered worktree: {name}"),
        2,
    )]
}

fn question_mark_present(value: &str) -> bool {
    value.contains('?') || value.contains('？') || value.contains('؟') || value.contains('¿')
}

fn codepoint_len(value: &str) -> usize {
    value.chars().count()
}

fn looks_like_decision(trimmed: &str) -> bool {
    !question_mark_present(trimmed)
        && ALPHABETIC_RE.is_match(trimmed)
        && CLAUSE_SEPARATOR_RE.is_match(trimmed)
        && {
            let len = codepoint_len(trimmed);
            (DECISION_MIN_CHARS..=DECISION_MAX_CHARS).contains(&len)
        }
}

fn extract_user_decision(message: &str) -> Vec<SessionEvent> {
    if looks_like_decision(message.trim()) {
        vec![event("decision", "decision", message, 2)]
    } else {
        Vec::new()
    }
}

fn looks_like_role(trimmed: &str) -> bool {
    let first_clause = trimmed
        .split(|ch| ['.', '!', '\n', '。', '！'].contains(&ch))
        .next()
        .unwrap_or("")
        .trim();
    if question_mark_present(first_clause)
        || CLAUSE_SEPARATOR_RE.is_match(first_clause)
        || !ALPHABETIC_RE.is_match(first_clause)
    {
        return false;
    }
    let len = codepoint_len(first_clause);
    if !(ROLE_MIN_CHARS..=ROLE_MAX_CHARS).contains(&len) {
        return false;
    }
    TWO_LEXICAL_TOKENS_RE.is_match(first_clause) || CONTINUOUS_LETTER_RUN_RE.is_match(first_clause)
}

fn extract_role(message: &str) -> Vec<SessionEvent> {
    if looks_like_role(message.trim()) {
        vec![event("role", "role", message, 3)]
    } else {
        Vec::new()
    }
}

fn is_imperative_tone(trimmed: &str) -> bool {
    !question_mark_present(trimmed) && ALPHABETIC_RE.is_match(trimmed) && {
        let len = codepoint_len(trimmed);
        len > 0 && len < IMPERATIVE_MAX_CHARS
    }
}

fn extract_intent(message: &str) -> Vec<SessionEvent> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mode = if question_mark_present(trimmed) {
        Some("investigate")
    } else if is_imperative_tone(trimmed) {
        Some("implement")
    } else {
        None
    };
    mode.map(|value| vec![event("intent", "intent", value, 4)])
        .unwrap_or_default()
}

fn extract_blocker(message: &str) -> Vec<SessionEvent> {
    if ['✓', '✔', '✅', '☑', '🎉']
        .iter()
        .any(|marker| message.contains(*marker))
        || BLOCKER_RESOLVED_MARKER_RE.is_match(message)
    {
        return vec![event("blocker_resolved", "blocked-on", message, 2)];
    }
    if BLOCKER_MARKERS_RE.is_match(message) {
        return vec![event("blocker", "blocked-on", message, 2)];
    }
    Vec::new()
}

fn extract_data(message: &str) -> Vec<SessionEvent> {
    if message.len() > 1024 {
        vec![event("data", "data", message, 4)]
    } else {
        Vec::new()
    }
}

fn extract_error_resolution(input: &HookInput, state: &mut ExtractorState) -> Vec<SessionEvent> {
    let response = input.tool_response.clone().unwrap_or_default();
    if is_tool_error(input) {
        state.last_error = Some(LastErrorState {
            tool: input.tool_name.clone(),
            error: response.chars().take(200).collect(),
            calls_since: 0,
        });
        return Vec::new();
    }
    let Some(last_error) = state.last_error.as_mut() else {
        return Vec::new();
    };
    last_error.calls_since += 1;
    if last_error.calls_since > 10 {
        state.last_error = None;
        return Vec::new();
    }
    let same_tool = input.tool_name == last_error.tool;
    let edit_after_read = last_error.tool == "Read"
        && matches!(input.tool_name.as_str(), "Edit" | "Write" | "apply_patch");
    if same_tool || edit_after_read {
        let result = vec![event(
            "error_resolved",
            "error-resolution",
            format!("Error in {}: {} → Fixed", last_error.tool, last_error.error),
            2,
        )];
        state.last_error = None;
        return result;
    }
    Vec::new()
}

fn simple_hash(value: &str) -> String {
    format!(
        "{}:{}",
        value.chars().count(),
        value.chars().take(20).collect::<String>()
    )
}

fn extract_iteration_loop(input: &HookInput, state: &mut ExtractorState) -> Vec<SessionEvent> {
    let json_input =
        serde_json::to_string(&Value::Object(input.tool_input.clone())).unwrap_or_default();
    let truncated = json_input.chars().take(200).collect::<String>();
    let input_hash = simple_hash(&truncated);
    state.call_history.push(CallHistoryEntry {
        tool: input.tool_name.clone(),
        input_hash: input_hash.clone(),
    });
    if state.call_history.len() > 50 {
        let drain = state.call_history.len() - 50;
        state.call_history.drain(0..drain);
    }
    if state.call_history.len() < 3 {
        return Vec::new();
    }
    let mut count = 0usize;
    for entry in state.call_history.iter().rev() {
        if entry.tool == input.tool_name && entry.input_hash == input_hash {
            count += 1;
        } else {
            break;
        }
    }
    if count >= 3 {
        let new_len = state.call_history.len().saturating_sub(count);
        state.call_history.truncate(new_len);
        return vec![event(
            "retry_detected",
            "iteration-loop",
            format!(
                "{} called {} times with similar input",
                input.tool_name, count
            ),
            2,
        )];
    }
    Vec::new()
}

fn build_queries(items: &[String], max_queries: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    for item in items {
        if item.is_empty() || !seen.insert(item.clone()) {
            continue;
        }
        selected.push(truncate_chars(item, 80));
        if selected.len() >= max_queries {
            break;
        }
    }
    selected
}

fn tool_call(tool_name: &str, queries: &[String]) -> String {
    if queries.is_empty() {
        return String::new();
    }
    let escaped = queries
        .iter()
        .map(|query| format!("\"{}\"", escape_xml(query)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "\n    For full details:\n    {}(\n      queries: [{}],\n      source: \"session-events\"\n    )",
        escape_xml(tool_name),
        escaped
    )
}

fn build_files_section(events: &[StoredEvent], search_tool: &str) -> String {
    if events.is_empty() {
        return String::new();
    }
    let mut file_map: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for event in events {
        let op = match event.event_type.as_str() {
            "file_write" => "write",
            "file_read" => "read",
            "file_edit" => "edit",
            other => other,
        };
        *file_map
            .entry(event.data.clone())
            .or_default()
            .entry(op.to_string())
            .or_default() += 1;
    }
    let entries = file_map.into_iter().collect::<Vec<_>>();
    let total_files = entries.len();
    let limited = entries
        .into_iter()
        .rev()
        .take(MAX_ACTIVE_FILES)
        .collect::<Vec<_>>();
    let mut summary = Vec::new();
    let mut query_terms = Vec::new();
    for (path, ops) in limited.into_iter().rev() {
        let ops_str = ops
            .iter()
            .map(|(name, count)| format!("{name}×{count}"))
            .collect::<Vec<_>>()
            .join(", ");
        let file_name = basename(&path);
        summary.push(format!(
            "    {} ({})",
            escape_xml(&file_name),
            escape_xml(&ops_str)
        ));
        query_terms.push(format!(
            "{} {}",
            file_name,
            ops.keys().cloned().collect::<Vec<_>>().join(" ")
        ));
    }
    let queries = build_queries(&query_terms, 4);
    [
        format!("  <files count=\"{}\">", total_files),
        summary.join("\n"),
        tool_call(search_tool, &queries),
        "  </files>".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_errors_section(events: &[StoredEvent], search_tool: &str) -> String {
    build_simple_section("errors", events, search_tool)
}

fn build_rules_section(events: &[StoredEvent], search_tool: &str) -> String {
    build_dedup_section("rules", events, search_tool)
}

fn build_git_section(events: &[StoredEvent], search_tool: &str) -> String {
    build_simple_section("git", events, search_tool)
}

fn build_decisions_section(events: &[StoredEvent], search_tool: &str) -> String {
    build_dedup_section("decisions", events, search_tool)
}

fn build_simple_section(section: &str, events: &[StoredEvent], search_tool: &str) -> String {
    if events.is_empty() {
        return String::new();
    }
    let lines = events
        .iter()
        .map(|event| format!("    {}", escape_xml(&event.data)))
        .collect::<Vec<_>>();
    let queries = build_queries(
        &events
            .iter()
            .map(|event| event.data.clone())
            .collect::<Vec<_>>(),
        4,
    );
    [
        format!("  <{section} count=\"{}\">", events.len()),
        lines.join("\n"),
        tool_call(search_tool, &queries),
        format!("  </{section}>"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_dedup_section(section: &str, events: &[StoredEvent], search_tool: &str) -> String {
    if events.is_empty() {
        return String::new();
    }
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut queries = Vec::new();
    for event in events {
        if seen.insert(event.data.clone()) {
            items.push(format!("    {}", escape_xml(&event.data)));
            queries.push(event.data.clone());
        }
    }
    if items.is_empty() {
        return String::new();
    }
    let queries = build_queries(&queries, 4);
    [
        format!("  <{section} count=\"{}\">", items.len()),
        items.join("\n"),
        tool_call(search_tool, &queries),
        format!("  </{section}>"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn render_task_state(task_events: &[StoredEvent]) -> String {
    if task_events.is_empty() {
        return String::new();
    }
    let mut creates = Vec::new();
    let mut updates = HashMap::new();
    for event in task_events {
        let Ok(parsed) = serde_json::from_str::<Value>(&event.data) else {
            continue;
        };
        if let Some(subject) = parsed.get("subject").and_then(Value::as_str) {
            creates.push(subject.to_string());
        } else if let (Some(task_id), Some(status)) = (
            parsed.get("taskId").and_then(Value::as_str),
            parsed.get("status").and_then(Value::as_str),
        ) {
            updates.insert(task_id.to_string(), status.to_string());
        }
    }
    if creates.is_empty() {
        return String::new();
    }
    let mut sorted_ids = updates.keys().cloned().collect::<Vec<_>>();
    sorted_ids.sort();
    let done = HashSet::from([
        "completed".to_string(),
        "deleted".to_string(),
        "failed".to_string(),
    ]);
    let mut pending = Vec::new();
    for (index, created) in creates.iter().enumerate() {
        let status = sorted_ids
            .get(index)
            .and_then(|task_id| updates.get(task_id))
            .cloned()
            .unwrap_or_else(|| "pending".to_string());
        if !done.contains(&status) {
            pending.push(format!("    [pending] {}", escape_xml(created)));
        }
    }
    pending.join("\n")
}

fn build_task_section(events: &[StoredEvent], search_tool: &str) -> String {
    let task_content = render_task_state(events);
    if task_content.is_empty() {
        return String::new();
    }
    let mut query_terms = Vec::new();
    for event in events {
        let Ok(parsed) = serde_json::from_str::<Value>(&event.data) else {
            continue;
        };
        if let Some(subject) = parsed.get("subject").and_then(Value::as_str) {
            query_terms.push(subject.to_string());
        }
    }
    let queries = build_queries(&query_terms, 4);
    let count = task_content.lines().count();
    [
        format!("  <task_state count=\"{count}\">"),
        task_content,
        tool_call(search_tool, &queries),
        "  </task_state>".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_environment_section(
    cwd_events: &[StoredEvent],
    env_events: &[StoredEvent],
    search_tool: &str,
) -> String {
    if cwd_events.is_empty() && env_events.is_empty() {
        return String::new();
    }
    let mut summary = Vec::new();
    let mut query_terms = Vec::new();
    if let Some(last_cwd) = cwd_events.last() {
        summary.push(format!("    cwd: {}", escape_xml(&last_cwd.data)));
        query_terms.push("working directory".to_string());
    }
    for event in env_events {
        summary.push(format!("    {}", escape_xml(&event.data)));
        query_terms.push(event.data.clone());
    }
    let queries = build_queries(&query_terms, 4);
    [
        "  <environment>".to_string(),
        summary.join("\n"),
        tool_call(search_tool, &queries),
        "  </environment>".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_subagents_section(events: &[StoredEvent], search_tool: &str) -> String {
    if events.is_empty() {
        return String::new();
    }
    let summary = events
        .iter()
        .map(|event| {
            let status = match event.event_type.as_str() {
                "subagent_completed" => "completed",
                "subagent_launched" => "launched",
                _ => "unknown",
            };
            format!("    [{status}] {}", escape_xml(&event.data))
        })
        .collect::<Vec<_>>();
    let queries = build_queries(
        &events
            .iter()
            .map(|event| format!("subagent {}", event.data))
            .collect::<Vec<_>>(),
        4,
    );
    [
        format!("  <subagents count=\"{}\">", events.len()),
        summary.join("\n"),
        tool_call(search_tool, &queries),
        "  </subagents>".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_skills_section(events: &[StoredEvent], search_tool: &str) -> String {
    if events.is_empty() {
        return String::new();
    }
    let mut counts = HashMap::new();
    for event in events {
        let name = event
            .data
            .split(':')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        *counts.entry(name).or_insert(0usize) += 1;
    }
    let mut summary = Vec::new();
    let mut queries = Vec::new();
    for (name, count) in counts {
        summary.push(format!("    {} ({}×)", escape_xml(&name), count));
        queries.push(format!("skill {name} invocation"));
    }
    let queries = build_queries(&queries, 4);
    [
        format!("  <skills count=\"{}\">", events.len()),
        summary.join("\n"),
        tool_call(search_tool, &queries),
        "  </skills>".to_string(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_roles_section(events: &[StoredEvent], search_tool: &str) -> String {
    build_dedup_section("roles", events, search_tool)
}

fn build_intent_section(events: &[StoredEvent]) -> String {
    events
        .last()
        .map(|event| format!("  <intent mode=\"{}\"/>", escape_xml(&event.data)))
        .unwrap_or_default()
}

fn truncate_for_snapshot(value: &str, max: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max {
        value.to_string()
    } else {
        chars.into_iter().take(max).collect()
    }
}

fn build_recent_messages_section(events: &[StoredEvent]) -> String {
    if events.is_empty() {
        return String::new();
    }
    let recent = events
        .iter()
        .rev()
        .take(RECENT_MESSAGES_LIMIT)
        .cloned()
        .collect::<Vec<_>>();
    let items = recent
        .into_iter()
        .rev()
        .filter_map(|event| {
            let body = truncate_for_snapshot(&event.data, RECENT_MESSAGE_MAX_CHARS);
            if body.is_empty() {
                None
            } else {
                Some(format!("    <message>{}</message>", escape_xml(&body)))
            }
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        return String::new();
    }
    [
        format!("  <recent_user_messages count=\"{}\">", items.len()),
        items.join("\n"),
        "  </recent_user_messages>".to_string(),
    ]
    .join("\n")
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn truncate_chars(value: &str, max: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max {
        value.to_string()
    } else {
        chars.into_iter().take(max).collect()
    }
}

fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn json_string_or_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| json_string(value))
}
