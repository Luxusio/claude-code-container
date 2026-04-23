use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Per-session status — string-serialized for Tauri event payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    InProgress,
    PermissionRequest,
    Completed,
}

impl SessionStatus {
    fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::InProgress => "in_progress",
            SessionStatus::PermissionRequest => "permission_request",
            SessionStatus::Completed => "completed",
        }
    }
}

#[derive(Debug, Deserialize)]
struct JsonlEvent {
    #[serde(rename = "type")]
    event_type: Option<String>,
    stop_reason: Option<String>,
    // We only look at type and stop_reason for status derivation.
    // Other fields are passed through to the React side as raw JSON.
}

/// spawn_watcher — background thread that discovers the jsonl file for a
/// new PTY session, tails it for structured events, derives per-session
/// status, and emits Tauri events.
///
/// Arguments:
/// - app: Tauri AppHandle for emit calls
/// - client_id: our UUID key (also the PTY id in pty.rs PtyMap)
/// - project_path: absolute project dir (used to derive claude projects dir)
/// - known_session_id: if set (continue mode), skip discovery and use this directly
/// - cancel: shared flag; when set to true the watcher exits gracefully
pub fn spawn_watcher(
    app: AppHandle,
    client_id: String,
    project_path: String,
    known_session_id: Option<String>,
    cancel: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let session_dir = match crate::session_history::compute_session_dir(&project_path) {
            Some(d) => d,
            None => {
                eprintln!("[session_events] cannot determine session dir; skipping watcher for {}", client_id);
                return;
            }
        };

        // Ensure the session dir exists (Claude will create it when it starts;
        // we may need to create it ourselves to avoid FS watcher issues).
        let _ = fs::create_dir_all(&session_dir);

        // Discover the jsonl file: either known (continue mode) or first new file
        let jsonl_path = if let Some(sid) = known_session_id {
            session_dir.join(format!("{}.jsonl", sid))
        } else {
            match discover_new_jsonl(&session_dir, &cancel) {
                Some(p) => p,
                None => {
                    eprintln!("[session_events] discovery cancelled or timed out for {}", client_id);
                    return;
                }
            }
        };

        eprintln!("[session_events] tailing {} for client {}", jsonl_path.display(), client_id);

        // Emit initial idle status once we have the file path
        let _ = app.emit(
            &format!("session_status_{}", client_id),
            SessionStatus::Idle.as_str(),
        );

        // Tail loop: poll-based (simple, cross-platform, good enough for jsonl)
        tail_jsonl_loop(&app, &client_id, &jsonl_path, cancel);
    });
}

/// discover_new_jsonl — watch session_dir for a new *.jsonl file that didn't
/// exist when we started. Returns the path of the first such file, or None
/// if cancelled or timed out (30s).
fn discover_new_jsonl(session_dir: &Path, cancel: &Arc<AtomicBool>) -> Option<PathBuf> {
    // Snapshot existing files
    let existing: HashSet<String> = fs::read_dir(session_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.ends_with(".jsonl") { Some(name) } else { None }
                })
                .collect()
        })
        .unwrap_or_default();

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        if let Ok(entries) = fs::read_dir(session_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".jsonl") && !existing.contains(&name) {
                    return Some(entry.path());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}

/// tail_jsonl_loop — open the jsonl file, read all existing lines, then
/// follow appends via poll (seek to end, sleep, check size, read new bytes).
fn tail_jsonl_loop(app: &AppHandle, client_id: &str, path: &Path, cancel: Arc<AtomicBool>) {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[session_events] open {} failed: {}", path.display(), e);
            return;
        }
    };
    let mut position: u64 = 0;
    let mut state = StatusMachine::new();
    let mut buffer = String::new();

    let status_event_name = format!("session_status_{}", client_id);
    let data_event_name = format!("session_event_{}", client_id);

    loop {
        if cancel.load(Ordering::Relaxed) {
            eprintln!("[session_events] tail cancelled for {}", client_id);
            return;
        }

        // Check file size; if grown, read new bytes
        let current_size = match file.metadata().map(|m| m.len()) {
            Ok(s) => s,
            Err(_) => break,
        };

        if current_size > position {
            if file.seek(SeekFrom::Start(position)).is_err() { break; }
            let mut reader = BufReader::new(&file);
            loop {
                buffer.clear();
                match reader.read_line(&mut buffer) {
                    Ok(0) => break, // EOF (for now)
                    Ok(n) => {
                        position += n as u64;
                        let trimmed = buffer.trim_end();
                        if trimmed.is_empty() { continue; }

                        // Emit raw event to React side (for possible future UI use)
                        let _ = app.emit(&data_event_name, trimmed);

                        // Parse event type and feed state machine
                        if let Ok(parsed) = serde_json::from_str::<JsonlEvent>(trimmed) {
                            if let Some(new_status) = state.on_event(&parsed) {
                                let _ = app.emit(&status_event_name, new_status.as_str());
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        } else {
            // Idle timeout: if we've been sitting on the same position for > 5s
            // AND the current status is InProgress or PermissionRequest, flip to Completed
            if let Some(new_status) = state.check_idle() {
                let _ = app.emit(&status_event_name, new_status.as_str());
            }
        }

        std::thread::sleep(Duration::from_millis(500));
    }
}

/// StatusMachine — derives SessionStatus from a stream of JsonlEvent.
struct StatusMachine {
    current: SessionStatus,
    last_event_at: Instant,
    pending_tool_use: bool,
}

impl StatusMachine {
    fn new() -> Self {
        Self {
            current: SessionStatus::Idle,
            last_event_at: Instant::now(),
            pending_tool_use: false,
        }
    }

    /// Consume an event; return Some(new_status) if status transitioned.
    fn on_event(&mut self, evt: &JsonlEvent) -> Option<SessionStatus> {
        self.last_event_at = Instant::now();
        let prev = self.current;
        let new = match evt.event_type.as_deref() {
            Some("user") => {
                self.pending_tool_use = false;
                SessionStatus::InProgress
            }
            Some("assistant") => {
                if evt.stop_reason.as_deref() == Some("end_turn") {
                    SessionStatus::Completed
                } else if evt.stop_reason.as_deref() == Some("tool_use") {
                    self.pending_tool_use = true;
                    SessionStatus::PermissionRequest
                } else {
                    SessionStatus::InProgress
                }
            }
            Some("tool_use") => {
                self.pending_tool_use = true;
                SessionStatus::PermissionRequest
            }
            Some("tool_result") => {
                self.pending_tool_use = false;
                SessionStatus::InProgress
            }
            _ => self.current, // unknown event type — no change
        };
        self.current = new;
        if prev != new { Some(new) } else { None }
    }

    /// Called when the tail has been idle. Returns Some(Completed) if we've
    /// been in a non-completed state for > 5s with no new events.
    fn check_idle(&mut self) -> Option<SessionStatus> {
        if self.current == SessionStatus::Completed || self.current == SessionStatus::Idle {
            return None;
        }
        if self.last_event_at.elapsed() > Duration::from_secs(5) {
            let prev = self.current;
            self.current = SessionStatus::Completed;
            if prev != SessionStatus::Completed { Some(SessionStatus::Completed) } else { None }
        } else {
            None
        }
    }
}

