# Handoff: src-tauri
written_at: 2026-04-07T02:59:02Z

## Verification
```bash
cd /project/claude-code-container-2990bbf949b6/ui/src-tauri && mise exec -- cargo check 2>&1 | tail -5 && cd /project/claude-code-container-2990bbf949b6/ui/src-sidecar && mise exec -- cargo build 2>&1 | tail -5
```
Expected output: see transcript

## What changed
Fixed three Rust compile errors in the Tauri 2.x app and updated the sidecar protocol:

1. `src/lib.rs` line 7: Removed unused `Manager` import — changed to `use tauri::{AppHandle, State};`

2. `src/lib.rs` `cmd_pick_folder`: Switched from async `.pick_folder().await` (which does not exist in tauri_plugin_dialog) to the blocking API `blocking_pick_folder()`. Function is now sync (no `async`).

3. `src/lib.rs` `SidecarRequest` + `cmd_sidecar_cmd`: Removed `#[serde(default)]` attribute (no longer needed). Changed `cmd_sidecar_cmd` from sync with `.stdin()` pipe (unsupported by tauri_plugin_shell) to async with `.args(&args).output().await`. Protocol changed from stdin JSON to CLI args (`ccc-daemon list_containers` / `ccc-daemon stop_container <name>`).

4. `src-sidecar/src/main.rs`: Rewrote `main()` from stdin line-reader loop to CLI args dispatch (`std::env::args()`). Removed unused `serde::Deserialize`, `io`, and `Request` struct. Docker wrapper functions (`list_containers`, `start_container`, `stop_container`, `remove_container`) refactored to return `Result<serde_json::Value, String>` instead of `Response`. Response JSON serialized directly with `serde_json::json!`.

5. Created `icons/icon.png` (32x32 RGBA PNG) — required by `tauri::generate_context!()` macro at compile time; the directory was missing entirely.

## Do not regress
Both `cargo check` (src-tauri) and `cargo build` (src-sidecar) must exit 0 with no errors or warnings about the changed symbols. The sidecar binary must accept CLI args protocol (not stdin JSON).
