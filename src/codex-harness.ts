import { spawnSync } from "child_process";
import { runtimeCli } from "./container-runtime.js";
import { withCodexConfigLock } from "./codex-config-lock.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "./docker.js";

// Run in the container: host-installed Harness embeds paths that are not portable.
// Exported so tests can execute the same probe and installer orchestration in isolation.
export const CODEX_HARNESS_BOOTSTRAP = String.raw`
import hashlib, json, os, re, shlex, shutil, signal, subprocess, sys, tempfile, time, tomllib
from pathlib import Path

REVISION = "90a7afe02a9377d9e20cedd62e2c0d88e426d814"
SOURCE = "https://github.com/Luxusio/harness.git"
home = Path.home() / ".codex"
config = home / "config.toml"
deadline = time.monotonic() + 120

def run(args, cwd):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("installation exceeded 120 seconds")
    child = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    try:
        out, err = child.communicate(timeout=remaining)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        raise RuntimeError("installation exceeded 120 seconds; stopped installer and children")
    if child.returncode:
        detail = (out + "\n" + err)[-2000:].strip()
        raise RuntimeError(f"{args[0]} failed: {detail}")
    return out.strip()

def probe():
    data = tomllib.loads(config.read_text()) if config.exists() else {}
    plugins = data.get("plugins", {})
    plugin = plugins.get("harness@harness")
    mcp = data.get("mcp_servers", {}).get("harness")
    market = data.get("marketplaces", {}).get("harness")
    features = data.get("features", {})
    if (features.get("plugin_hooks") is False
        or isinstance(plugin, dict) and plugin.get("enabled") is False
        or isinstance(mcp, dict) and mcp.get("enabled") is False):
        return "disabled"
    if plugin is None and mcp is None and market is None and not any(
        name.startswith("harness@") for name in plugins
    ):
        if (home / "harness").exists() or (home / "plugins/cache/harness").exists():
            raise RuntimeError("existing Harness payload has no registration; preserved")
        return "absent"
    # Any existing declaration belongs to the user. Diagnose, never force a merge.
    if not all(isinstance(value, dict) for value in (plugin, mcp, market)):
        raise RuntimeError("existing Harness registration is incomplete or custom; preserved")
    if plugin.get("enabled") is not True or features.get("plugin_hooks") is not True:
        raise RuntimeError("existing Harness plugin/hooks are not enabled; preserved")
    source = Path(market.get("source", ""))
    root = source / "plugins" / "harness"
    manifest = json.loads((root / ".codex-plugin" / "plugin.json").read_text())
    version = str(manifest.get("version", "local"))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}", version):
        raise RuntimeError("invalid Harness plugin version; preserved")
    cache = home / "plugins" / "cache" / "harness" / "harness" / version
    required = [source / ".agents/plugins/marketplace.json", root / "mcp/harness_server.py",
                cache / ".codex-plugin/plugin.json", cache / "skills/run/SKILL.md",
                cache / "mcp/harness_server.py", cache / "hooks.json"]
    args = mcp.get("args", [])
    command = mcp.get("command", "")
    if not command or not shutil.which(command) or not args or not Path(args[0]).is_file():
        raise RuntimeError("existing Harness MCP command or payload is unavailable; preserved")
    if any(not path.is_file() for path in required):
        raise RuntimeError("existing Harness plugin payload is incomplete; preserved")
    hooks = json.loads((cache / "hooks.json").read_text()).get("hooks", {})
    trust = data.get("hooks", {}).get("state", {})
    if not hooks or not any(key.startswith("harness@harness:") for key in trust):
        raise RuntimeError("existing Harness hooks or trust registration is incomplete; preserved")
    # Match the pinned official installer's normalized command-hook identity.
    events = {"SessionStart": "session_start", "PreToolUse": "pre_tool_use",
              "UserPromptSubmit": "user_prompt_submit", "PostToolUse": "post_tool_use"}
    checked = 0
    for event, groups in hooks.items():
        for group_index, group in enumerate(groups):
            for hook_index, hook in enumerate(group.get("hooks", [])):
                if hook.get("type") == "command":
                    command = shlex.split(hook.get("command", ""))
                    if command and command[0] == "PYTHONDONTWRITEBYTECODE=1":
                        command = command[1:]
                    if len(command) < 2 or not shutil.which(command[0]) or not Path(command[1]).is_file():
                        raise RuntimeError("existing Harness hook command or payload is unavailable; preserved")
                    if event not in events:
                        raise RuntimeError("existing Harness hook event is custom; preserved")
                    identity = {"event_name": events[event], "hooks": [{
                        "async": False, "command": hook["command"],
                        "timeout": max(1, int(hook.get("timeout") or 600)), "type": "command"}]}
                    if group.get("matcher"):
                        identity["matcher"] = group["matcher"]
                    if hook.get("statusMessage"):
                        identity["hooks"][0]["statusMessage"] = hook["statusMessage"]
                    digest = "sha256:" + hashlib.sha256(json.dumps(
                        identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                    key = f"harness@harness:hooks.json:{events[event]}:{group_index}:{hook_index}"
                    state = trust.get(key, {})
                    if state.get("trusted_hash") != digest or state.get("enabled") is False:
                        raise RuntimeError("existing Harness hook trust is missing, stale, or disabled; preserved")
                    checked += 1
    if not checked:
        raise RuntimeError("existing Harness command hooks are missing; preserved")
    return "ready"

try:
    state = probe()
    if state == "absent":
        print("[ccc] Installing Harness for Codex...", flush=True)
        with tempfile.TemporaryDirectory(prefix="ccc-codex-harness-") as temp:
            run(["git", "init", "--quiet", temp], temp)
            run(["git", "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", SOURCE, REVISION], temp)
            actual = run(["git", "rev-parse", "FETCH_HEAD"], temp)
            if actual != REVISION:
                raise RuntimeError("downloaded Harness revision does not match pinned revision")
            run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], temp)
            run([sys.executable, str(Path(temp) / "install.py"), "--codex-only"], Path.home())
        if probe() != "ready":
            raise RuntimeError("installer did not produce an enabled Harness registration")
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;

export function ensureCodexHarness(containerName: string, profile?: string): void {
    try {
        withCodexConfigLock(() => {
            try {
                prepareCodexConfigForContainer(containerName, profile);
                const result = spawnSync(runtimeCli(), [
                    "exec", "-i", "--workdir", "/home/ccc",
                    "--env", "HOME=/home/ccc", "--env", "GIT_TERMINAL_PROMPT=0",
                    containerName, "python3", "-",
                ], { input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf-8", timeout: 135000 });
                if (result.stdout?.trim()) console.error(result.stdout.trim());
                if (result.error || result.status !== 0) {
                    throw new Error(result.error?.message ?? (result.stderr?.trim() || `bootstrap exited ${result.status}`));
                }
            } finally {
                restoreCodexConfigHostOwnership(containerName, profile);
            }
        }, profile);
    } catch (error) {
        console.warn(`[ccc] Harness is unavailable: ${error instanceof Error ? error.message : String(error)}. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.`);
    }
}
