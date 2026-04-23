mod notify;
mod pty;
mod session_events;
mod session_history;

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};

use pty::{create_pty_map, pty_close, pty_create, pty_resize, pty_write, PtyCreateOptions, PtyMap};
use session_history::{archive_session, list_sessions_for_project, unarchive_session, SessionRecord};

// --- PTY Commands ---

#[tauri::command]
fn cmd_pty_create(
    app: AppHandle,
    state: State<'_, PtyMap>,
    opts: PtyCreateOptions,
) -> Result<String, String> {
    pty_create(app, state.inner().clone(), opts)
}

#[tauri::command]
fn cmd_pty_write(
    state: State<'_, PtyMap>,
    id: String,
    data: String,
) -> Result<(), String> {
    pty_write(state.inner().clone(), &id, &data)
}

#[tauri::command]
fn cmd_pty_resize(
    state: State<'_, PtyMap>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    pty_resize(state.inner().clone(), &id, cols, rows)
}

#[tauri::command]
fn cmd_pty_close(
    state: State<'_, PtyMap>,
    id: String,
) -> Result<(), String> {
    pty_close(state.inner().clone(), &id)
}

// --- Session History Commands ---

#[tauri::command]
fn cmd_list_sessions(project_path: Option<String>) -> Vec<SessionRecord> {
    match project_path {
        Some(p) => list_sessions_for_project(&p),
        None => Vec::new(),
    }
}

#[tauri::command]
fn cmd_archive_session(session_id: String) -> Result<(), String> {
    archive_session(&session_id)
}

#[tauri::command]
fn cmd_unarchive_session(session_id: String) -> Result<(), String> {
    unarchive_session(&session_id)
}

// --- File System Commands ---

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn cmd_list_files(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    let entries = fs::read_dir(&dir).map_err(|e| format!("Cannot read dir: {}", e))?;

    let mut files: Vec<FileEntry> = entries
        .flatten()
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let full_path = e.path().to_string_lossy().to_string();
            let is_dir = e.path().is_dir();
            FileEntry {
                name,
                path: full_path,
                is_dir,
            }
        })
        .collect();

    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(files)
}

#[tauri::command]
fn cmd_read_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    let metadata = fs::metadata(&p).map_err(|e| format!("Cannot stat file: {}", e))?;
    const MAX_BYTES: u64 = 1 * 1024 * 1024; // 1 MB
    if metadata.len() > MAX_BYTES {
        return Err(format!(
            "File too large ({} bytes, max 1MB)",
            metadata.len()
        ));
    }
    fs::read_to_string(&p).map_err(|e| format!("Cannot read file: {}", e))
}

#[derive(serde::Serialize)]
struct ChangedFileEntry {
    name: String,
    path: String,
    is_dir: bool,
    status: String,
    additions: u32,
    deletions: u32,
}

#[derive(serde::Serialize)]
struct DiffStat {
    additions: u32,
    deletions: u32,
}

#[tauri::command]
fn cmd_list_changed_files(path: String) -> Result<Vec<ChangedFileEntry>, String> {
    use std::process::Command;
    let output = Command::new("git")
        .args(["-C", &path, "status", "--porcelain"])
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git status error: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Run git diff --numstat for tracked changed files
    let numstat_output = Command::new("git")
        .args(["-C", &path, "diff", "--numstat"])
        .output()
        .ok();

    // Also run git diff --cached --numstat for staged files
    let cached_numstat_output = Command::new("git")
        .args(["-C", &path, "diff", "--cached", "--numstat"])
        .output()
        .ok();

    // Build a map from relative filepath -> (additions, deletions)
    let mut stat_map: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();

    let parse_numstat = |output: &std::process::Output, map: &mut std::collections::HashMap<String, (u32, u32)>| {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                let add: u32 = parts[0].parse().unwrap_or(0);
                let del: u32 = parts[1].parse().unwrap_or(0);
                let filepath = parts[2].to_string();
                let entry = map.entry(filepath).or_insert((0, 0));
                entry.0 = entry.0.saturating_add(add);
                entry.1 = entry.1.saturating_add(del);
            }
        }
    };

    if let Some(ref o) = numstat_output {
        parse_numstat(o, &mut stat_map);
    }
    if let Some(ref o) = cached_numstat_output {
        parse_numstat(o, &mut stat_map);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<ChangedFileEntry> = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let file_path = line[3..].trim();
        // Handle renames: "R  old -> new"
        let actual_path = if let Some(pos) = file_path.find(" -> ") {
            &file_path[pos + 4..]
        } else {
            file_path
        };
        let full_path = PathBuf::from(&path).join(actual_path);
        let name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Look up diff stats by relative path
        let (additions, deletions) = stat_map.get(actual_path).copied().unwrap_or((0, 0));

        // For untracked files (?), count lines as additions
        let (additions, deletions) = if (status == "?" || status == "??") && additions == 0 {
            // Count lines in the file
            let line_count = fs::read_to_string(&full_path)
                .map(|content| content.lines().count() as u32)
                .unwrap_or(0);
            (line_count, 0)
        } else {
            (additions, deletions)
        };

        entries.push(ChangedFileEntry {
            name,
            path: full_path.to_string_lossy().to_string(),
            is_dir: false,
            status,
            additions,
            deletions,
        });
    }

    Ok(entries)
}

#[tauri::command]
fn cmd_worktree_diff_stat(path: String) -> Result<DiffStat, String> {
    use std::process::Command;

    let mut total_add: u32 = 0;
    let mut total_del: u32 = 0;

    // Run git diff --numstat (unstaged changes)
    if let Ok(output) = Command::new("git")
        .args(["-C", &path, "diff", "--numstat"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                total_add = total_add.saturating_add(parts[0].parse().unwrap_or(0));
                total_del = total_del.saturating_add(parts[1].parse().unwrap_or(0));
            }
        }
    }

    // Run git diff --cached --numstat (staged changes)
    if let Ok(output) = Command::new("git")
        .args(["-C", &path, "diff", "--cached", "--numstat"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                total_add = total_add.saturating_add(parts[0].parse().unwrap_or(0));
                total_del = total_del.saturating_add(parts[1].parse().unwrap_or(0));
            }
        }
    }

    // Include untracked files — count their lines as additions
    if let Ok(status_output) = Command::new("git")
        .args(["-C", &path, "status", "--porcelain"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&status_output.stdout);
        for line in stdout.lines() {
            if line.len() < 4 {
                continue;
            }
            let status = line[..2].trim();
            if status == "?" || status == "??" {
                let file_path = line[3..].trim();
                let full_path = PathBuf::from(&path).join(file_path);
                if let Ok(content) = fs::read_to_string(&full_path) {
                    total_add = total_add.saturating_add(content.lines().count() as u32);
                }
            }
        }
    }

    Ok(DiffStat {
        additions: total_add,
        deletions: total_del,
    })
}

#[tauri::command]
fn cmd_list_files_recursive(path: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    const MAX_ENTRIES: usize = 5000;
    let mut result: Vec<FileEntry> = Vec::new();

    fn walk(dir: &PathBuf, result: &mut Vec<FileEntry>, max: usize) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if result.len() >= max {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden files/dirs (.git, .DS_Store, etc.)
            if name.starts_with('.') {
                continue;
            }
            let full_path = entry.path().to_string_lossy().to_string();
            let is_dir = entry.path().is_dir();
            if is_dir {
                walk(&entry.path(), result, max);
            } else {
                result.push(FileEntry {
                    name,
                    path: full_path,
                    is_dir: false,
                });
            }
        }
    }

    walk(&root, &mut result, MAX_ENTRIES);
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[tauri::command]
async fn cmd_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let folder = rx.await.map_err(|e| e.to_string())?;
    Ok(folder.map(|p| p.to_string()))
}

// --- Git File Diff ---

#[derive(serde::Serialize)]
struct GitFileDiff {
    old_content: String,
    new_content: String,
    status: String,
}

#[tauri::command]
fn cmd_git_file_diff(project_path: String, file_path: String) -> Result<GitFileDiff, String> {
    use std::process::Command;

    let project = PathBuf::from(&project_path);
    let abs_file = PathBuf::from(&file_path);
    // Compute relative path
    let rel = abs_file
        .strip_prefix(&project)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| file_path.clone());

    // Get status for this file
    let status_out = Command::new("git")
        .args(["-C", &project_path, "status", "--porcelain", "--", &rel])
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;
    let status_line = String::from_utf8_lossy(&status_out.stdout);
    let status: String = status_line
        .lines()
        .next()
        .map(|l| l.get(..2).unwrap_or("").trim().to_string())
        .unwrap_or_default();

    // Old content from HEAD (empty if untracked/added)
    let old_content = if status == "??" || status == "?" || status == "A" {
        String::new()
    } else {
        let show = Command::new("git")
            .args(["-C", &project_path, "show", &format!("HEAD:{}", rel)])
            .output()
            .map_err(|e| format!("git show failed: {}", e))?;
        if show.status.success() {
            String::from_utf8_lossy(&show.stdout).to_string()
        } else {
            String::new()
        }
    };

    // New content from working tree (empty if deleted)
    let new_content = if status == "D" {
        String::new()
    } else if abs_file.is_file() {
        fs::read_to_string(&abs_file).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(GitFileDiff {
        old_content,
        new_content,
        status,
    })
}

// --- UI State Persistence ---

fn ui_state_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = PathBuf::from(home).join(".ccc");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create ~/.ccc: {}", e))?;
    Ok(dir.join("ui-state.json"))
}

#[tauri::command]
fn cmd_load_ui_state() -> Result<String, String> {
    let path = ui_state_path()?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Cannot read ui-state: {}", e))
}

#[tauri::command]
fn cmd_save_ui_state(json: String) -> Result<(), String> {
    let path = ui_state_path()?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Cannot write ui-state: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Cannot rename ui-state: {}", e))?;
    Ok(())
}

// --- Sidecar Commands ---

#[derive(serde::Deserialize)]
struct SidecarRequest {
    cmd: String,
    name: Option<String>,
}

#[tauri::command]
async fn cmd_sidecar_cmd(
    app: AppHandle,
    request: SidecarRequest,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_shell::ShellExt;

    let mut args = vec![request.cmd.clone()];
    if let Some(name) = &request.name {
        args.push(name.clone());
    }

    let output = app
        .shell()
        .sidecar("ccc-daemon")
        .map_err(|e| format!("Sidecar error: {}", e))?
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Sidecar execution error: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .map_err(|e| format!("Failed to parse sidecar response: {}", e))
}

// --- Window Commands ---

#[tauri::command]
async fn cmd_open_new_window(app: AppHandle) -> Result<(), String> {
    let label = format!(
        "ccc-{}",
        uuid::Uuid::new_v4()
    );
    tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("ccc")
    .inner_size(1280.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .center()
    .build()
    .map_err(|e| format!("Failed to open new window: {}", e))?;
    Ok(())
}

// --- App Entry Point ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(create_pty_map())
        .invoke_handler(tauri::generate_handler![
            cmd_pty_create,
            cmd_pty_write,
            cmd_pty_resize,
            cmd_pty_close,
            cmd_list_sessions,
            cmd_archive_session,
            cmd_unarchive_session,
            cmd_list_files,
            cmd_read_file,
            cmd_list_files_recursive,
            cmd_list_changed_files,
            cmd_worktree_diff_stat,
            cmd_pick_folder,
            cmd_load_ui_state,
            cmd_save_ui_state,
            cmd_git_file_diff,
            cmd_sidecar_cmd,
            cmd_open_new_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
