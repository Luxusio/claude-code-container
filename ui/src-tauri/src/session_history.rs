use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

// ============================================================
// Registry structs (read-only; written by the ccc CLI)
// ============================================================

#[derive(Debug, Clone, Deserialize)]
struct RegistryProject {
    #[serde(default)]
    id: String,
    #[serde(default)]
    host_path: String,
    #[serde(default)]
    kind: String, // "source" | "worktree"
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    worktrees: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistrySnapshot {
    #[serde(default)]
    projects: std::collections::HashMap<String, RegistryProject>,
}

fn get_registry_path() -> PathBuf {
    if let Ok(p) = std::env::var("CCC_REGISTRY_PATH") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".ccc").join("registry.json")
}

fn load_registry() -> Option<RegistrySnapshot> {
    let path = get_registry_path();
    let bytes = std::fs::read(&path).ok()?;
    match serde_json::from_slice::<RegistrySnapshot>(&bytes) {
        Ok(snap) => Some(snap),
        Err(err) => {
            eprintln!("[ccc-ui] registry parse failed: {err}");
            None
        }
    }
}

/// Pure helper: return all worktree entries in the snapshot whose
/// `source` field matches `source_id` and whose `host_path` is non-empty.
fn select_worktree_children<'a>(
    snap: &'a RegistrySnapshot,
    source_id: &str,
) -> Vec<&'a RegistryProject> {
    snap.projects
        .values()
        .filter(|p| {
            p.kind == "worktree"
                && p.source.as_deref() == Some(source_id)
                && !p.host_path.is_empty()
        })
        .collect()
}

const WORKTREE_SEPARATOR: &str = "--";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub project_path: String,
    pub timestamp: String,
    pub summary: String,
    pub archived: bool,
    pub jsonl_path: String,
    pub worktree_branch: Option<String>,
}

/// Recover the likely source basename if `basename` itself contains the
/// worktree separator. Splits on the FIRST `--` and returns the prefix.
/// If there is no separator, returns `basename` unchanged.
fn strip_worktree_suffix(basename: &str) -> &str {
    match basename.find(WORKTREE_SEPARATOR) {
        Some(idx) => &basename[..idx],
        None => basename,
    }
}

/// Given a worktree host-path basename (e.g. `claude-code-container--feature-ui`)
/// and the source basename (e.g. `claude-code-container`), return the branch
/// suffix after `--`. Returns None if the format doesn't match.
/// The returned branch is the VERBATIM suffix — `/` has already been replaced
/// with `-` by `getWorkspacePath`, so this string is the "safe-branch" form.
fn worktree_branch_from_basename(worktree_base: &str, source_base: &str) -> Option<String> {
    let prefix = format!("{}{}", source_base, WORKTREE_SEPARATOR);
    worktree_base.strip_prefix(&prefix).map(|s| s.to_string())
}

/// Discover worktree sibling directories for the given source host path.
/// Returns a vec of absolute paths (PathBuf) for every directory in
/// `parent(resolved_source)` whose basename matches `<sourceBase>--*`
/// and is an actual directory on disk. If the input itself looks like a
/// worktree, the source basename is recovered by splitting on the first `--`.
/// Returns an empty vec if the parent can't be read.
fn discover_worktree_siblings(source_host_path: &str) -> Vec<PathBuf> {
    let resolved = std::path::absolute(Path::new(source_host_path))
        .unwrap_or_else(|_| Path::new(source_host_path).to_path_buf());
    let resolved_str = resolved.to_string_lossy().into_owned();
    let trimmed = resolved_str.trim_end_matches(|c: char| c == '/' || c == '\\');
    let parent = match Path::new(trimmed).parent() {
        Some(p) => p.to_path_buf(),
        None => return Vec::new(),
    };
    let source_base_raw = match Path::new(trimmed).file_name().and_then(|f| f.to_str()) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let source_base = strip_worktree_suffix(source_base_raw);
    let prefix = format!("{}{}", source_base, WORKTREE_SEPARATOR);

    let entries = match std::fs::read_dir(&parent) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut siblings = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with(&prefix) {
            let path = entry.path();
            if path.is_dir() {
                siblings.push(path);
            }
        }
    }
    siblings
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ArchivedSessions {
    archived_ids: Vec<String>,
}

/// Return the home directory, preferring HOME on POSIX, falling back to USERPROFILE on Windows.
fn dirs_path() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from).or_else(|| {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    })
}

/// Return the ccc-managed Claude projects directory:
///   POSIX:   $HOME/.ccc/claude/projects
///   Windows: %USERPROFILE%\.ccc\claude\projects
///
/// Returns None if the directory does not exist on disk.
///
/// Fallback: when the environment variable CCC_UI_USE_LEGACY_CLAUDE_DIR=1 is set
/// AND the new path is absent, fall back to $HOME/.claude/projects.
/// This is a dev-only escape hatch and must not be used in production.
fn get_claude_projects_dir() -> Option<PathBuf> {
    let home = dirs_path()?;
    let ccc_projects = home.join(".ccc").join("claude").join("projects");
    if ccc_projects.exists() {
        return Some(ccc_projects);
    }
    // Dev-only fallback: only when env var is explicitly set and new path is absent
    if std::env::var("CCC_UI_USE_LEGACY_CLAUDE_DIR").as_deref() == Ok("1") {
        let legacy = home.join(".claude").join("projects");
        if legacy.exists() {
            return Some(legacy);
        }
    }
    None
}

fn get_archive_path() -> Option<PathBuf> {
    let home = dirs_path()?;
    let dir = home.join(".ccc").join("ui");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("archived_sessions.json"))
}

fn load_archived_sessions() -> ArchivedSessions {
    get_archive_path()
        .and_then(|path| fs::read_to_string(&path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_archived_sessions(archived: &ArchivedSessions) -> Result<(), String> {
    let path = get_archive_path().ok_or("Cannot determine archive path")?;
    let content = serde_json::to_string_pretty(archived)
        .map_err(|e| format!("Serialization error: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

/// Port of Node.js getProjectId() from src/utils.ts:
///
///   getProjectId(path) =
///     basename(resolve(path)).toLowerCase().replace(/[^a-z0-9-]/g, "-")
///     + "-" + sha256(resolve(path)).hex[:12]
///
/// Canonicalization rules (mirrors Node.js path.resolve for absolute inputs):
/// 1. Use std::path::absolute to normalize . / .. and trailing separators.
/// 2. Convert to a UTF-8 string using to_string_lossy (native separators preserved).
/// 3. Trim any trailing '/' or '\' from the resulting string.
/// 4. Take file_name() of the resolved string as the base name.
/// 5. Lowercase the base name and replace every char not in [a-z0-9-] with '-'.
/// 6. SHA256 the exact resolved string bytes (not the lowercased name).
/// 7. Take the first 12 hex characters (lowercase) of the hash.
/// 8. Return format!("{name}-{hash}") — the suffix is ALWAYS appended.
pub fn compute_project_id(host_path: &str) -> String {
    // Step 1: resolve to absolute canonical path
    let path = Path::new(host_path);
    let resolved_path = std::path::absolute(path)
        .unwrap_or_else(|_| PathBuf::from(host_path));

    // Step 2-3: convert to string, trim trailing separators
    let resolved_str = resolved_path.to_string_lossy().into_owned();
    let resolved = resolved_str.trim_end_matches(['/', '\\']).to_string();

    // Step 4-5: compute sanitized base name
    let name_raw = Path::new(&resolved)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("")
        .to_string();
    let name: String = name_raw
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();

    // Step 6-7: SHA256 over the exact resolved path string
    let mut hasher = Sha256::new();
    hasher.update(resolved.as_bytes());
    let hash_bytes = hasher.finalize();
    let hash_hex = format!("{:x}", hash_bytes);
    let hash = &hash_hex[..12];

    // Step 8: always append hash suffix
    format!("{name}-{hash}")
}

/// Return the session directory for the given host project path:
///   <ccc_projects_dir>/-project-<compute_project_id(host_path)>
///
/// Returns None if the ccc projects directory cannot be determined.
pub fn compute_session_dir(host_path: &str) -> Option<PathBuf> {
    let projects_dir = get_claude_projects_dir()?;
    let project_id = compute_project_id(host_path);
    Some(projects_dir.join(format!("-project-{project_id}")))
}

/// Metadata extracted from scanning the first N lines of a JSONL file.
struct JsonlMetadata {
    timestamp: String,
    summary: String,
}

/// Scan up to the first MAX_SCAN_LINES lines of a .jsonl file and extract:
///   - timestamp (first line that has one)
///   - summary   (first line that has one; prefers "summary" over "message")
///
/// Stops scanning once both fields are found. Uses BufReader so the
/// potentially large file is never fully loaded into memory.
fn parse_jsonl_metadata(path: &Path) -> JsonlMetadata {
    use std::io::{BufRead, BufReader};

    const MAX_SCAN_LINES: usize = 20;

    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return JsonlMetadata { timestamp: String::new(), summary: String::new() },
    };

    let reader = BufReader::new(file);

    let mut timestamp = String::new();
    let mut summary = String::new();

    for line in reader.lines().take(MAX_SCAN_LINES) {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim_end().to_string();
        if line.is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if timestamp.is_empty() {
            if let Some(ts) = value.get("timestamp").or_else(|| value.get("ts")).and_then(|v| v.as_str()) {
                timestamp = ts.to_string();
            }
        }

        if summary.is_empty() {
            if let Some(s) = value.get("summary").or_else(|| value.get("message")).and_then(|v| v.as_str()) {
                summary = s.to_string();
            }
        }

        // Stop early once both are found
        if !timestamp.is_empty() && !summary.is_empty() {
            break;
        }
    }

    JsonlMetadata { timestamp, summary }
}

/// Read all session records from a single session directory.
/// Each record gets `project_path` and `worktree_branch` set by the caller.
fn read_sessions_in_dir(
    session_dir: &Path,
    project_path: &str,
    worktree_branch: Option<String>,
    archived_ids: &[String],
) -> Vec<SessionRecord> {
    let mut records = Vec::new();

    if !session_dir.exists() {
        return records;
    }

    let entries = match fs::read_dir(session_dir) {
        Ok(e) => e,
        Err(_) => return records,
    };

    for entry in entries.flatten() {
        let jsonl_path = entry.path();
        if jsonl_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = jsonl_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            continue;
        }

        let meta = parse_jsonl_metadata(&jsonl_path);
        let is_archived = archived_ids.contains(&session_id);

        records.push(SessionRecord {
            id: session_id,
            project_path: project_path.to_string(),
            timestamp: meta.timestamp,
            summary: meta.summary,
            archived: is_archived,
            jsonl_path: jsonl_path.to_string_lossy().to_string(),
            worktree_branch: worktree_branch.clone(),
        });
    }

    records
}

/// List all Claude sessions for the given host project path, including sessions
/// from every worktree registered in the registry (or sibling directories via
/// legacy fallback).
///
/// Primary path (default): reads `~/.ccc/registry.json` and enumerates all
/// worktree entries whose `source` matches the source project id.
///
/// Legacy fallback: only activated when `CCC_UI_USE_LEGACY_WORKTREE_SCAN=1`
/// AND the registry is absent/unreadable. Uses `discover_worktree_siblings`.
///
/// Each session record carries:
///   - `project_path`: the actual host path where the session lives (source or worktree)
///   - `worktree_branch`: None for source sessions, Some("safe-branch") for worktree sessions
///
/// Results are sorted by timestamp descending.
pub fn list_sessions_for_project(host_path: &str) -> Vec<SessionRecord> {
    let archived = load_archived_sessions();
    let archived_ids = &archived.archived_ids;
    let mut records = Vec::new();

    // Read source sessions (always included)
    if let Some(session_dir) = compute_session_dir(host_path) {
        let source_records = read_sessions_in_dir(&session_dir, host_path, None, archived_ids);
        records.extend(source_records);
    }

    // Primary path: use registry to find worktrees
    let registry_opt = load_registry();
    if let Some(ref snap) = registry_opt {
        let source_id = compute_project_id(host_path);
        let children = select_worktree_children(snap, &source_id);
        for child in children {
            if child.host_path.is_empty() {
                continue; // skip stubs
            }
            let branch = child.branch.clone();
            if let Some(session_dir) = compute_session_dir(&child.host_path) {
                let wt_records =
                    read_sessions_in_dir(&session_dir, &child.host_path, branch, archived_ids);
                records.extend(wt_records);
            }
        }
    } else if std::env::var("CCC_UI_USE_LEGACY_WORKTREE_SCAN").as_deref() == Ok("1") {
        // Legacy fallback: only when registry missing AND env flag set
        let resolved = std::path::absolute(Path::new(host_path))
            .unwrap_or_else(|_| Path::new(host_path).to_path_buf());
        let resolved_str = resolved.to_string_lossy().into_owned();
        let trimmed = resolved_str.trim_end_matches(|c: char| c == '/' || c == '\\');
        let source_base_raw = Path::new(trimmed)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("");
        let source_base = strip_worktree_suffix(source_base_raw).to_string();

        let siblings = discover_worktree_siblings(host_path);
        for sibling in siblings {
            let sibling_str = sibling.to_string_lossy().into_owned();
            let sibling_base = sibling
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or("");
            let branch = worktree_branch_from_basename(sibling_base, &source_base);

            if let Some(session_dir) = compute_session_dir(&sibling_str) {
                let sibling_records =
                    read_sessions_in_dir(&session_dir, &sibling_str, branch, archived_ids);
                records.extend(sibling_records);
            }
        }
    }
    // else: registry missing + env flag not set → return only source sessions

    // Sort by timestamp descending
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    records
}

pub fn archive_session(session_id: &str) -> Result<(), String> {
    let mut archived = load_archived_sessions();
    if !archived.archived_ids.contains(&session_id.to_string()) {
        archived.archived_ids.push(session_id.to_string());
    }
    save_archived_sessions(&archived)
}

pub fn unarchive_session(session_id: &str) -> Result<(), String> {
    let mut archived = load_archived_sessions();
    archived.archived_ids.retain(|id| id != session_id);
    save_archived_sessions(&archived)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_project_id_matches_nodejs_reference() {
        assert_eq!(
            compute_project_id("/project/claude-code-container-a18cde03af93"),
            "claude-code-container-a18cde03af93-9343673bd6a1"
        );
    }

    #[test]
    fn compute_project_id_always_appends_hash() {
        // The hash suffix must always be present, even when basename looks complete
        let id = compute_project_id("/some/path/myproject");
        let parts: Vec<&str> = id.rsplitn(2, '-').collect();
        assert_eq!(parts[0].len(), 12, "hash suffix must be 12 chars");
        assert!(parts[0].chars().all(|c| c.is_ascii_hexdigit()), "hash must be hex");
    }

    #[test]
    fn compute_project_id_sanitizes_name() {
        // Underscores and dots should be replaced with dashes
        let id = compute_project_id("/some/my_project.v2");
        assert!(id.starts_with("my-project-v2-"), "sanitized name should start the id");
    }

    #[test]
    fn strip_worktree_suffix_basic() {
        assert_eq!(strip_worktree_suffix("foo"), "foo");
        assert_eq!(strip_worktree_suffix("foo--bar"), "foo");
        assert_eq!(strip_worktree_suffix("foo--bar--baz"), "foo");
    }

    #[test]
    fn worktree_branch_from_basename_basic() {
        assert_eq!(
            worktree_branch_from_basename("foo--bar", "foo"),
            Some("bar".to_string())
        );
        assert_eq!(worktree_branch_from_basename("foo", "foo"), None);
        assert_eq!(
            worktree_branch_from_basename("foo--bar--baz", "foo"),
            Some("bar--baz".to_string())
        );
    }

    // ----------------------------------------------------------------
    // New tests: registry path
    // ----------------------------------------------------------------

    #[test]
    fn load_registry_missing_returns_none_without_panic() {
        // Point CCC_REGISTRY_PATH at a path that does not exist
        let rand = format!("ccc-reg-missing-{}", std::process::id());
        let path = std::env::temp_dir().join(rand).join("registry.json");
        std::env::set_var("CCC_REGISTRY_PATH", path.to_str().unwrap());
        let result = load_registry();
        std::env::remove_var("CCC_REGISTRY_PATH");
        assert!(result.is_none(), "expected None for missing registry file");
    }

    #[test]
    fn load_registry_malformed_returns_none_logs() {
        let rand = format!("ccc-reg-malformed-{}", std::process::id());
        let dir = std::env::temp_dir().join(&rand);
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("registry.json");
        std::fs::write(&path, b"{ not valid json !!!").expect("write malformed");
        std::env::set_var("CCC_REGISTRY_PATH", path.to_str().unwrap());
        let result = load_registry();
        std::env::remove_var("CCC_REGISTRY_PATH");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_none(), "expected None for malformed registry JSON");
    }

    #[test]
    fn registry_snapshot_groups_worktrees_by_source() {
        // Fabricate a snapshot in memory and test select_worktree_children pure helper
        let mut projects = std::collections::HashMap::new();

        let source_id = "source-proj-aabbcc001122".to_string();
        let wt1_id = "worktree-1-ddeeff334455".to_string();
        let wt2_id = "worktree-2-ffeedd665544".to_string();
        let other_id = "other-source-112233445566".to_string();

        projects.insert(source_id.clone(), RegistryProject {
            id: source_id.clone(),
            host_path: "/tmp/source".to_string(),
            kind: "source".to_string(),
            source: None,
            branch: None,
            worktrees: vec![wt1_id.clone(), wt2_id.clone()],
        });
        projects.insert(wt1_id.clone(), RegistryProject {
            id: wt1_id.clone(),
            host_path: "/tmp/source--feat-a".to_string(),
            kind: "worktree".to_string(),
            source: Some(source_id.clone()),
            branch: Some("feat-a".to_string()),
            worktrees: vec![],
        });
        projects.insert(wt2_id.clone(), RegistryProject {
            id: wt2_id.clone(),
            host_path: "/tmp/source--feat-b".to_string(),
            kind: "worktree".to_string(),
            source: Some(source_id.clone()),
            branch: Some("feat-b".to_string()),
            worktrees: vec![],
        });
        // A worktree belonging to a DIFFERENT source — must NOT appear
        projects.insert(other_id.clone(), RegistryProject {
            id: other_id.clone(),
            host_path: "/tmp/other--feat-c".to_string(),
            kind: "worktree".to_string(),
            source: Some("some-other-source".to_string()),
            branch: Some("feat-c".to_string()),
            worktrees: vec![],
        });
        // A stub (empty host_path) belonging to source — must be filtered by callers
        let stub_id = "stub-wt-aabbcc999888".to_string();
        projects.insert(stub_id.clone(), RegistryProject {
            id: stub_id.clone(),
            host_path: "".to_string(),
            kind: "worktree".to_string(),
            source: Some(source_id.clone()),
            branch: Some("stub-branch".to_string()),
            worktrees: vec![],
        });

        let snap = RegistrySnapshot { projects };
        let children = select_worktree_children(&snap, &source_id);

        // Should find exactly wt1 and wt2 (both have non-empty host_path and correct source)
        let child_ids: std::collections::HashSet<&str> =
            children.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(child_ids.len(), 2, "expected 2 children, got {:?}", child_ids);
        assert!(child_ids.contains(wt1_id.as_str()), "wt1 missing");
        assert!(child_ids.contains(wt2_id.as_str()), "wt2 missing");
        assert!(!child_ids.contains(other_id.as_str()), "other-source wt must not appear");
        assert!(!child_ids.contains(stub_id.as_str()), "stub must not appear");
    }

    #[test]
    fn discover_worktree_siblings_finds_matches() {
        use std::path::PathBuf;

        // Create a unique temp directory for this test
        let test_id = format!("ccc-test-siblings-{}", std::process::id());
        let parent = std::env::temp_dir().join(&test_id);
        std::fs::create_dir_all(&parent).expect("create parent");

        // Create sibling dirs: foo, foo--feature-ui, foo--fix, bar
        let foo = parent.join("foo");
        let foo_feature = parent.join("foo--feature-ui");
        let foo_fix = parent.join("foo--fix");
        let bar = parent.join("bar");
        for d in [&foo, &foo_feature, &foo_fix, &bar] {
            std::fs::create_dir_all(d).expect("create dir");
        }

        let source_path = foo.to_string_lossy().into_owned();
        let siblings = discover_worktree_siblings(&source_path);

        // Should find exactly foo--feature-ui and foo--fix
        let sibling_set: std::collections::HashSet<PathBuf> = siblings.into_iter().collect();
        assert_eq!(sibling_set.len(), 2, "expected 2 siblings, got {:?}", sibling_set);
        assert!(sibling_set.contains(&foo_feature), "missing foo--feature-ui");
        assert!(sibling_set.contains(&foo_fix), "missing foo--fix");
        assert!(!sibling_set.contains(&foo), "foo itself should not be a sibling");
        assert!(!sibling_set.contains(&bar), "bar should not be a sibling");

        // Cleanup
        let _ = std::fs::remove_dir_all(&parent);
    }
}
