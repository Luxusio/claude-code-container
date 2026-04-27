use tauri::AppHandle;

/// Ask detection patterns for Claude interactive prompts.
/// Triggers OS notification when these patterns appear in PTY output.
const ASK_PATTERNS: &[&str] = &[
    "Do you want",
    "Would you like",
    "Shall I",
    "? ",
];

const BASH_PROMPT_PATTERNS: &[&str] = &[
    "$ ",
    "# ",
];

/// Check PTY output for ask patterns and send OS notification.
pub fn check_and_notify(app: &AppHandle, data: &str, session_id: &str) {
    let should_notify = ASK_PATTERNS.iter().any(|pattern| data.contains(pattern))
        || is_bash_prompt(data);

    if should_notify {
        send_notification(app, session_id, data);
    }
}

fn is_bash_prompt(data: &str) -> bool {
    for line in data.lines() {
        let trimmed = line.trim_end();
        for pattern in BASH_PROMPT_PATTERNS {
            if trimmed.ends_with(pattern) {
                return true;
            }
        }
    }
    false
}

fn send_notification(app: &AppHandle, session_id: &str, data: &str) {
    use tauri_plugin_notification::NotificationExt;

    // Extract a short excerpt for the notification body
    let body = extract_ask_excerpt(data);
    let title = format!("ccc — Session {}", &session_id[..8.min(session_id.len())]);

    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

fn extract_ask_excerpt(data: &str) -> String {
    // Find the line containing an ask pattern and return it trimmed
    for line in data.lines() {
        let trimmed = line.trim();
        if ASK_PATTERNS.iter().any(|p| trimmed.contains(p)) {
            // Slice on a char boundary — `trimmed[..120]` panics when 120
            // lands inside a multi-byte UTF-8 char (e.g. Korean), which
            // would crash the PTY reader thread and zombify the session.
            let excerpt: String = trimmed.chars().take(120).collect();
            return excerpt;
        }
    }
    "Claude is waiting for your input".to_string()
}
