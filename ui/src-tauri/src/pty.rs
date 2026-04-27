use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send>,
    pub size: PtySize,
    pub cancel: Arc<AtomicBool>, // session_events watcher cancel flag
    /// Owns the PTY master so ConPTY handles aren't dropped on Windows, and
    /// also forwards SIGWINCH to the child via `resize()` on `pty_resize`.
    master: Box<dyn portable_pty::MasterPty + Send>,
}

pub type PtyMap = Arc<Mutex<HashMap<String, PtySession>>>;

pub fn create_pty_map() -> PtyMap {
    Arc::new(Mutex::new(HashMap::new()))
}

#[derive(Debug, serde::Deserialize)]
pub struct PtyCreateOptions {
    pub id: String,
    pub project_path: String,
    pub session_id: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// On Windows, resolve an npm global `.cmd` shim to the actual JS entry point.
///
/// npm shims have a predictable format:
/// ```bat
/// @IF EXIST "%~dp0\node.exe" (
///   "%~dp0\node.exe" "%~dp0\node_modules\pkg\dist\index.js" %*
/// ) ELSE (
///   ...node "%~dp0\node_modules\pkg\dist\index.js" %*
/// )
/// ```
///
/// Returns `Some((node_exe_path, js_entry_path))` on success.
#[cfg(target_os = "windows")]
fn resolve_cmd_shim(cmd_name: &str) -> Option<(String, String)> {
    // Step 1: find the .cmd shim via where.exe (called directly, NOT via cmd.exe)
    let where_output = std::process::Command::new("where.exe")
        .arg(cmd_name)
        .output()
        .ok()?;

    if !where_output.status.success() {
        return None;
    }

    let shim_path = String::from_utf8_lossy(&where_output.stdout)
        .lines()
        .find(|l| l.trim().ends_with(".cmd") || l.trim().ends_with(".CMD"))
        .map(|l| l.trim().to_string())?;

    eprintln!("[pty] found shim: {}", shim_path);

    // Step 2: read the .cmd file content
    let content = std::fs::read_to_string(&shim_path).ok()?;

    // Step 3: extract the JS entry point with regex
    // Match both old npm format (%~dp0\path.js) and new npm 9+ format (%dp0%\path.js)
    // Old: "%~dp0\node_modules\pkg\dist\index.js"
    // New: "%dp0%\node_modules\pkg\dist\index.js"
    let re = regex::Regex::new(r#"(?i)["']?(?:%~dp0\\|%dp0%\\)([^"'\s]*\.js)["']?"#).ok()?;

    let shim_dir = std::path::Path::new(&shim_path).parent()?;

    let js_absolute = if let Some(caps) = re.captures(&content) {
        let js_relative = caps.get(1)?.as_str().to_string();
        shim_dir.join(&js_relative)
    } else {
        // Regex failed — log first 200 chars of .cmd for debugging
        eprintln!(
            "[pty] regex did not match .cmd content (first 200 chars): {:?}",
            &content.chars().take(200).collect::<String>()
        );
        // Direct-path fallback: npm global installs always put node_modules/ alongside the .cmd
        let fallback = shim_dir.join("node_modules")
            .join("claude-code-container")
            .join("dist")
            .join("index.js");
        eprintln!("[pty] trying direct-path fallback: {:?}", fallback);
        fallback
    };

    if !js_absolute.exists() {
        eprintln!("[pty] resolved JS path does not exist: {:?}", js_absolute);
        return None;
    }

    // Also resolve node.exe — check shim_dir first, then fall back to PATH
    let node_in_shim_dir = shim_dir.join("node.exe");
    let node_path = if node_in_shim_dir.exists() {
        node_in_shim_dir.to_string_lossy().to_string()
    } else {
        "node.exe".to_string() // rely on PATH
    };

    let js_path = js_absolute.to_string_lossy().to_string();
    eprintln!("[pty] resolved: node={} js={}", node_path, js_path);
    Some((node_path, js_path))
}

pub fn pty_create(
    app: AppHandle,
    pty_map: PtyMap,
    opts: PtyCreateOptions,
) -> Result<String, String> {
    eprintln!("[pty] create request id={} path={:?} session_id={:?}", opts.id, opts.project_path, opts.session_id);

    // Guard: don't overwrite an existing live PTY (React StrictMode calls effects twice)
    {
        let map = pty_map.lock().map_err(|e| format!("Mutex error: {}", e))?;
        if map.contains_key(&opts.id) {
            eprintln!("[pty] PTY {} already exists — skipping duplicate creation", opts.id);
            return Ok(opts.id);
        }
    }

    let pty_system = native_pty_system();

    let cols = opts.cols.unwrap_or(220);
    let rows = opts.rows.unwrap_or(50);

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build command: login shell so PATH includes npm global bins (ccc)
    // Fall back gracefully: if ccc not found, user still gets a working shell
    let mut cmd = if cfg!(target_os = "windows") {
        // Windows: resolve the .cmd shim to node.exe + JS entry point to bypass
        // ConPTY + batch interpreter silent-fail. npm .cmd shims exit immediately
        // when run through portable_pty's ConPTY.
        #[cfg(target_os = "windows")]
        {
            match resolve_cmd_shim("ccc") {
                Some((node_path, js_path)) => {
                    eprintln!("[pty] using resolved shim: {} {}", node_path, js_path);
                    let mut c = CommandBuilder::new(&node_path);
                    if let Some(ref session_id) = opts.session_id {
                        c.args([&js_path, "--resume", session_id]);
                    } else {
                        c.arg(&js_path);
                    }
                    c
                }
                None => {
                    // Fallback: try powershell.exe which handles .cmd shims better
                    eprintln!("[pty] .cmd shim resolution failed, falling back to powershell.exe");

                    // Check if ccc is available at all
                    let ccc_available = std::process::Command::new("where.exe")
                        .arg("ccc")
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false);

                    if ccc_available {
                        let mut c = CommandBuilder::new("powershell.exe");
                        if let Some(ref session_id) = opts.session_id {
                            let ps_cmd = format!("ccc --resume {}", session_id);
                            c.args(["-NoProfile", "-Command", &ps_cmd]);
                        } else {
                            c.args(["-NoProfile", "-Command", "ccc"]);
                        }
                        c
                    } else {
                        // ccc not installed — open interactive powershell
                        eprintln!("[pty] ccc not found, falling back to interactive powershell.exe");
                        CommandBuilder::new("powershell.exe")
                    }
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            // This branch is unreachable but satisfies the compiler
            unreachable!()
        }
    } else {
        // Unix: login shell so PATH includes npm global bins (ccc)
        if let Some(ref session_id) = opts.session_id {
            // Continue an existing Claude session
            let ccc_cmd = format!("ccc --resume {}", session_id);
            let mut c = CommandBuilder::new("bash");
            c.args(["-l", "-c", &ccc_cmd]);
            c
        } else {
            // Check if ccc is available; if so launch it, otherwise just open bash
            let ccc_available = std::process::Command::new("bash")
                .args(["-l", "-c", "command -v ccc"])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

            eprintln!("[pty] ccc_available={}", ccc_available);

            if ccc_available {
                let mut c = CommandBuilder::new("bash");
                c.args(["-l", "-c", "ccc"]);
                c
            } else {
                // ccc not installed — open interactive bash so PTY pipeline still works
                eprintln!("[pty] ccc not found, falling back to interactive bash");
                CommandBuilder::new("bash")
            }
        }
    };

    cmd.cwd(&opts.project_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    eprintln!("[pty] spawning…");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;
    eprintln!("[pty] child spawned");

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    let session_id = opts.id.clone();
    let app_clone = app.clone();

    // Spawn background thread to read PTY output and emit events
    std::thread::spawn(move || {
        eprintln!("[pty] reader thread started for {}", session_id);
        let mut buf = [0u8; 4096];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    eprintln!("[pty] EOF for {}", session_id);
                    // Flush any trailing leftover (best-effort, likely invalid UTF-8 at EOF)
                    if !leftover.is_empty() {
                        let flush = String::from_utf8_lossy(&leftover).to_string();
                        let event_name = format!("pty_data_{}", session_id);
                        let _ = app_clone.emit(&event_name, &flush);
                    }
                    break;
                }
                Ok(n) => {
                    // Combine leftover bytes from last iteration with new read
                    let mut chunk: Vec<u8> = Vec::with_capacity(leftover.len() + n);
                    chunk.extend_from_slice(&leftover);
                    chunk.extend_from_slice(&buf[..n]);
                    leftover.clear();

                    // Find the last valid UTF-8 boundary in `chunk`
                    let valid_up_to = match std::str::from_utf8(&chunk) {
                        Ok(_) => chunk.len(),
                        Err(e) => e.valid_up_to(),
                    };

                    if valid_up_to > 0 {
                        // Safe: &chunk[..valid_up_to] is valid UTF-8
                        let valid_str = unsafe { std::str::from_utf8_unchecked(&chunk[..valid_up_to]) }.to_string();
                        let event_name = format!("pty_data_{}", session_id);
                        if let Err(e) = app_clone.emit(&event_name, &valid_str) {
                            eprintln!("[pty] emit error: {}", e);
                        }
                        crate::notify::check_and_notify(&app_clone, &valid_str, &session_id);
                    }

                    // Stash the incomplete trailing bytes
                    leftover.extend_from_slice(&chunk[valid_up_to..]);

                    // Safety valve: valid UTF-8 is at most 4 bytes; if leftover grows
                    // beyond that we have genuinely invalid bytes — flush them with
                    // lossy replacement and move on rather than starving forever.
                    if leftover.len() > 8 {
                        let flush = String::from_utf8_lossy(&leftover).to_string();
                        let event_name = format!("pty_data_{}", session_id);
                        let _ = app_clone.emit(&event_name, &flush);
                        leftover.clear();
                    }
                }
                Err(e) => {
                    eprintln!("[pty] read error for {}: {}", session_id, e);
                    break;
                }
            }
        }
        eprintln!("[pty] emitting pty_closed for {}", session_id);
        let _ = app_clone.emit(&format!("pty_closed_{}", session_id), ());
    });

    let cancel = Arc::new(AtomicBool::new(false));
    crate::session_events::spawn_watcher(
        app.clone(),
        opts.id.clone(),
        opts.project_path.clone(),
        opts.session_id.clone(),
        cancel.clone(),
    );

    let session = PtySession {
        writer,
        child,
        size,
        cancel,
        master: pair.master,
    };

    pty_map
        .lock()
        .map_err(|e| format!("Mutex error: {}", e))?
        .insert(opts.id.clone(), session);

    eprintln!("[pty] PTY {} inserted into map", opts.id);
    Ok(opts.id)
}

pub fn pty_write(pty_map: PtyMap, id: &str, data: &str) -> Result<(), String> {
    let mut map = pty_map
        .lock()
        .map_err(|e| format!("Mutex error: {}", e))?;

    let session = map.get_mut(id).ok_or_else(|| format!("Session {} not found", id))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;

    session
        .writer
        .flush()
        .map_err(|e| format!("Flush error: {}", e))?;

    Ok(())
}

pub fn pty_resize(pty_map: PtyMap, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let mut map = pty_map
        .lock()
        .map_err(|e| format!("Mutex error: {}", e))?;

    let session = map.get_mut(id).ok_or_else(|| format!("Session {} not found", id))?;

    let new_size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    // Forward SIGWINCH to the child so TUI apps (Claude Code) reflow.
    session
        .master
        .resize(new_size)
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    session.size = new_size;

    Ok(())
}

pub fn pty_close(pty_map: PtyMap, id: &str) -> Result<(), String> {
    let mut map = pty_map
        .lock()
        .map_err(|e| format!("Mutex error: {}", e))?;

    if let Some(mut session) = map.remove(id) {
        session.cancel.store(true, Ordering::Relaxed);
        let _ = session.child.kill();
        eprintln!("[pty] closed PTY {}", id);
    }

    Ok(())
}
