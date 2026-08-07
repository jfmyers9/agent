use std::collections::HashMap;
use std::fs;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{configure_sqlite_connection, table_exists, write_text_response};

const MAX_METRICS_PER_SESSION: i64 = 10_000;
const SESSION_SCHEMA_VERSION: i64 = 3;

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
    #[serde(rename = "maxAgeDays")]
    max_age_days: Option<i64>,
    #[serde(rename = "includeStats")]
    include_stats: Option<bool>,
    #[serde(rename = "includeToolCallStats")]
    include_tool_call_stats: Option<bool>,
    #[serde(rename = "latestSessionId")]
    latest_session_id: Option<bool>,
    #[serde(rename = "toolName")]
    tool_name: Option<String>,
    #[serde(rename = "bytesReturned")]
    bytes_returned: Option<i64>,
    #[serde(rename = "rawBytes")]
    raw_bytes: Option<i64>,
    #[serde(rename = "indexedBytes")]
    indexed_bytes: Option<i64>,
    #[serde(rename = "omittedBytes")]
    omitted_bytes: Option<i64>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: Option<i64>,
    success: Option<bool>,
}

#[derive(Default, Serialize)]
struct SessionQueryResponse {
    #[serde(rename = "latestSessionId", skip_serializing_if = "Option::is_none")]
    latest_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<SessionMetaRow>,
    #[serde(rename = "toolCallStats", skip_serializing_if = "Option::is_none")]
    tool_call_stats: Option<SessionToolCallStats>,
}

#[derive(Serialize)]
struct SessionMetaRow {
    session_id: String,
    project_dir: String,
    started_at: String,
    last_event_at: Option<String>,
}

#[derive(Serialize)]
struct SessionToolCallStats {
    #[serde(rename = "totalCalls")]
    total_calls: i64,
    #[serde(rename = "totalBytesReturned")]
    total_bytes_returned: i64,
    #[serde(rename = "totalRawBytes")]
    total_raw_bytes: i64,
    #[serde(rename = "totalIndexedBytes")]
    total_indexed_bytes: i64,
    #[serde(rename = "totalOmittedBytes")]
    total_omitted_bytes: i64,
    #[serde(rename = "totalElapsedMs")]
    total_elapsed_ms: i64,
    failures: i64,
    #[serde(rename = "byTool")]
    by_tool: HashMap<String, SessionToolCallByTool>,
}

#[derive(Serialize)]
struct SessionToolCallByTool {
    calls: i64,
    #[serde(rename = "bytesReturned")]
    bytes_returned: i64,
    #[serde(rename = "rawBytes")]
    raw_bytes: i64,
    #[serde(rename = "indexedBytes")]
    indexed_bytes: i64,
    #[serde(rename = "omittedBytes")]
    omitted_bytes: i64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: i64,
    failures: i64,
}

#[derive(Default)]
pub(crate) struct CurrentSessionStatus {
    pub(crate) tool_calls: i64,
    pub(crate) raw_bytes: i64,
    pub(crate) indexed_bytes: i64,
    pub(crate) returned_bytes: i64,
    pub(crate) omitted_bytes: i64,
    pub(crate) failures: i64,
    pub(crate) p50_elapsed_ms: i64,
    pub(crate) p95_elapsed_ms: i64,
    pub(crate) sessions: i64,
    pub(crate) latest_event_at: Option<String>,
}

pub(crate) struct LifetimeStatus {
    pub(crate) total_sessions: i64,
    pub(crate) distinct_projects: i64,
    pub(crate) tool_calls: i64,
    pub(crate) omitted_bytes: i64,
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
    tx.execute_batch(
        "DROP TABLE IF EXISTS session_events;
         DROP TABLE IF EXISTS session_resume;
         DROP TABLE IF EXISTS session_extractor_state;
         CREATE TABLE IF NOT EXISTS session_meta (
            session_id TEXT PRIMARY KEY,
            project_dir TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_event_at TEXT
         );
         CREATE TABLE IF NOT EXISTS tool_calls (
            session_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            calls INTEGER NOT NULL DEFAULT 0,
            raw_bytes INTEGER NOT NULL DEFAULT 0,
            indexed_bytes INTEGER NOT NULL DEFAULT 0,
            bytes_returned INTEGER NOT NULL DEFAULT 0,
            omitted_bytes INTEGER NOT NULL DEFAULT 0,
            elapsed_ms INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, tool)
         );
         CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
         CREATE TABLE IF NOT EXISTS tool_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            raw_bytes INTEGER NOT NULL DEFAULT 0,
            indexed_bytes INTEGER NOT NULL DEFAULT 0,
            returned_bytes INTEGER NOT NULL DEFAULT 0,
            omitted_bytes INTEGER NOT NULL DEFAULT 0,
            elapsed_ms INTEGER NOT NULL DEFAULT 0,
            success INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE INDEX IF NOT EXISTS idx_tool_metrics_session ON tool_metrics(session_id, id);",
    )
    .map_err(|err| format!("failed to initialize session schema: {err}"))?;
    for statement in [
        "ALTER TABLE tool_calls ADD COLUMN raw_bytes INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tool_calls ADD COLUMN indexed_bytes INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tool_calls ADD COLUMN omitted_bytes INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tool_calls ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tool_calls ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
    ] {
        match tx.execute_batch(statement) {
            Ok(()) => {}
            Err(err) if err.to_string().contains("duplicate column name") => {}
            Err(err) => return Err(format!("failed to update session schema: {err}")),
        }
    }
    tx.pragma_update(None, "user_version", SESSION_SCHEMA_VERSION)
        .map_err(|err| format!("failed to record session schema version: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit session schema migration: {err}"))
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

fn session_stats(conn: &Connection, session_id: &str) -> Result<Option<SessionMetaRow>, String> {
    conn.query_row(
        "SELECT session_id, project_dir, started_at, last_event_at FROM session_meta WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(SessionMetaRow {
                session_id: row.get(0)?,
                project_dir: row.get(1)?,
                started_at: row.get(2)?,
                last_event_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to read session stats for {session_id}: {err}"))
}

fn session_tool_call_stats(
    conn: &Connection,
    session_id: &str,
) -> Result<SessionToolCallStats, String> {
    let (
        total_calls,
        total_raw_bytes,
        total_indexed_bytes,
        total_bytes_returned,
        total_omitted_bytes,
        total_elapsed_ms,
        failures,
    ): (i64, i64, i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(raw_bytes), 0), \
                    COALESCE(SUM(indexed_bytes), 0), COALESCE(SUM(bytes_returned), 0), \
                    COALESCE(SUM(omitted_bytes), 0), COALESCE(SUM(elapsed_ms), 0), \
                    COALESCE(SUM(failures), 0) \
             FROM tool_calls WHERE session_id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .map_err(|err| format!("failed to read tool-call totals for {session_id}: {err}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT tool, calls, raw_bytes, indexed_bytes, bytes_returned, omitted_bytes, elapsed_ms, failures \
             FROM tool_calls WHERE session_id = ?1 ORDER BY calls DESC",
        )
        .map_err(|err| format!("failed to prepare tool-call stats query: {err}"))?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SessionToolCallByTool {
                    calls: row.get(1)?,
                    raw_bytes: row.get(2)?,
                    indexed_bytes: row.get(3)?,
                    bytes_returned: row.get(4)?,
                    omitted_bytes: row.get(5)?,
                    elapsed_ms: row.get(6)?,
                    failures: row.get(7)?,
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
        total_raw_bytes,
        total_indexed_bytes,
        total_bytes_returned,
        total_omitted_bytes,
        total_elapsed_ms,
        failures,
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
        "tool_metrics",
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

pub(crate) fn command(params: serde_json::Value) -> Result<(), String> {
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
        "query" => {
            let Some(conn) = open_existing_session_db(&params.session_db_path)? else {
                return write_text_response(
                    &serde_json::to_string(&SessionQueryResponse::default())
                        .map_err(|err| format!("failed to encode empty session query: {err}"))?,
                    false,
                );
            };
            let target = resolve_session_target(&conn, params.session_id.as_deref())?;
            let mut response = SessionQueryResponse::default();
            if params.latest_session_id.unwrap_or(false) {
                response.latest_session_id = target.clone();
            }
            if let Some(session_id) = target.as_deref() {
                if params.include_stats.unwrap_or(false) {
                    response.stats = session_stats(&conn, session_id)?;
                }
                if params.include_tool_call_stats.unwrap_or(false) {
                    response.tool_call_stats = Some(session_tool_call_stats(&conn, session_id)?);
                }
            }
            write_text_response(
                &serde_json::to_string(&response)
                    .map_err(|err| format!("failed to encode session query: {err}"))?,
                false,
            )
        }
        "record_tool_telemetry" => record_tool_telemetry(&params),
        "build_pi_check" => {
            let db_path = params.db_path.as_deref().unwrap_or("");
            let mut lines = vec![
                "## cg-check (Pi)".to_string(),
                String::new(),
                format!("- DB path: `{db_path}`"),
                format!(
                    "- DB exists: {}",
                    !db_path.is_empty() && Path::new(db_path).exists()
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
                let stats = session_tool_call_stats(&conn, session_id)?;
                lines.push(format!("- Tool calls: {}", stats.total_calls));
                lines.push(format!("- Omitted bytes: {}", stats.total_omitted_bytes));
                lines.push(format!("- Failures: {}", stats.failures));
            }
            write_text_response(&lines.join("\n"), false)
        }
        action => write_text_response(&format!("unsupported session action: {action}"), true),
    }
}

fn record_tool_telemetry(params: &SessionParams) -> Result<(), String> {
    let mut conn = open_session_db(&params.session_db_path)?;
    let session_id = match resolve_session_target(&conn, params.session_id.as_deref())? {
        Some(session_id) => session_id,
        None => {
            return write_text_response(&json!({ "updated": false }).to_string(), false);
        }
    };
    let tool_name = params.tool_name.as_deref().unwrap_or("unknown");
    let returned_bytes = clamp_nonnegative_i64(params.bytes_returned);
    let omitted_bytes = clamp_nonnegative_i64(params.omitted_bytes);
    let raw_bytes = clamp_nonnegative_i64(
        params
            .raw_bytes
            .or_else(|| Some(returned_bytes.saturating_add(omitted_bytes))),
    );
    let indexed_bytes = clamp_nonnegative_i64(params.indexed_bytes);
    let elapsed_ms = clamp_nonnegative_i64(params.elapsed_ms);
    let success = params.success.unwrap_or(true);
    let failures = i64::from(!success);
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|err| format!("failed to start telemetry transaction: {err}"))?;
    tx.execute(
        "INSERT INTO tool_calls (session_id, tool, calls, raw_bytes, indexed_bytes, bytes_returned, omitted_bytes, elapsed_ms, failures) \
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(session_id, tool) DO UPDATE SET \
         calls = calls + 1, raw_bytes = raw_bytes + excluded.raw_bytes, \
         indexed_bytes = indexed_bytes + excluded.indexed_bytes, \
         bytes_returned = bytes_returned + excluded.bytes_returned, \
         omitted_bytes = omitted_bytes + excluded.omitted_bytes, \
         elapsed_ms = elapsed_ms + excluded.elapsed_ms, \
         failures = failures + excluded.failures, updated_at = datetime('now')",
        params![session_id, tool_name, raw_bytes, indexed_bytes, returned_bytes, omitted_bytes, elapsed_ms, failures],
    )
    .map_err(|err| format!("failed to aggregate tool telemetry: {err}"))?;
    tx.execute(
        "INSERT INTO tool_metrics(session_id, tool, raw_bytes, indexed_bytes, returned_bytes, omitted_bytes, elapsed_ms, success) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![session_id, tool_name, raw_bytes, indexed_bytes, returned_bytes, omitted_bytes, elapsed_ms, success],
    )
    .map_err(|err| format!("failed to append tool telemetry: {err}"))?;
    tx.execute(
        "UPDATE session_meta SET last_event_at = datetime('now') WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|err| format!("failed to touch session telemetry: {err}"))?;
    tx.execute(
        "DELETE FROM tool_metrics WHERE session_id = ?1 AND id NOT IN (\
            SELECT id FROM tool_metrics WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2\
         )",
        params![session_id, MAX_METRICS_PER_SESSION],
    )
    .map_err(|err| format!("failed to retain tool telemetry: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit tool telemetry: {err}"))?;
    write_text_response(&json!({ "updated": true }).to_string(), false)
}

pub(crate) fn purge_rows(session_db_path: &str, session_id: &str) -> Result<usize, String> {
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
        "tool_metrics",
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

pub(crate) fn read_current_status(session_db_path: &str) -> Result<CurrentSessionStatus, String> {
    if !Path::new(session_db_path).exists() {
        return Ok(CurrentSessionStatus::default());
    }

    let conn = open_session_db(session_db_path)?;
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
    let (tool_calls, raw_bytes, indexed_bytes, returned_bytes, omitted_bytes, failures) =
        latest_session_id
            .as_deref()
            .and_then(|session_id| {
                conn.query_row(
                    "SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(raw_bytes), 0), \
                        COALESCE(SUM(indexed_bytes), 0), COALESCE(SUM(bytes_returned), 0), \
                        COALESCE(SUM(omitted_bytes), 0), COALESCE(SUM(failures), 0) \
                 FROM tool_calls WHERE session_id = ?1",
                    params![session_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .ok()
            })
            .unwrap_or((0, 0, 0, 0, 0, 0));
    let mut elapsed = Vec::new();
    if let Some(session_id) = latest_session_id.as_deref()
        && table_exists(&conn, "tool_metrics")?
    {
        let mut stmt = conn
            .prepare(
                "SELECT elapsed_ms FROM tool_metrics WHERE session_id = ?1 ORDER BY elapsed_ms",
            )
            .map_err(|err| format!("failed to prepare latency query: {err}"))?;
        let rows = stmt
            .query_map(params![session_id], |row| row.get::<_, i64>(0))
            .map_err(|err| format!("failed to query latency metrics: {err}"))?;
        for row in rows {
            elapsed.push(row.map_err(|err| format!("failed to read latency metric: {err}"))?);
        }
    }
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_meta", [], |row| row.get(0))
        .unwrap_or(0);
    let latest_event_at: Option<String> = conn
        .query_row("SELECT MAX(last_event_at) FROM session_meta", [], |row| {
            row.get(0)
        })
        .ok()
        .flatten();

    Ok(CurrentSessionStatus {
        tool_calls,
        raw_bytes,
        indexed_bytes,
        returned_bytes,
        omitted_bytes,
        failures,
        p50_elapsed_ms: percentile(&elapsed, 50),
        p95_elapsed_ms: percentile(&elapsed, 95),
        sessions,
        latest_event_at,
    })
}

fn percentile(sorted: &[i64], percentile: usize) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() - 1) * percentile).div_ceil(100);
    sorted[index.min(sorted.len() - 1)]
}

pub(crate) fn read_lifetime_status(sessions_dir: &str) -> Result<LifetimeStatus, String> {
    let mut total_sessions = 0i64;
    let mut distinct_projects = 0i64;
    let mut tool_calls = 0i64;
    let mut omitted_bytes = 0i64;

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
            total_sessions += db
                .query_row("SELECT COUNT(*) FROM session_meta", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0);
            let totals: (i64, i64) = db
                .query_row(
                    "SELECT COALESCE(SUM(calls), 0), COALESCE(SUM(omitted_bytes), 0) FROM tool_calls",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or((0, 0));
            tool_calls += totals.0;
            omitted_bytes += totals.1;
        }
    }

    Ok(LifetimeStatus {
        total_sessions,
        distinct_projects,
        tool_calls,
        omitted_bytes,
    })
}
