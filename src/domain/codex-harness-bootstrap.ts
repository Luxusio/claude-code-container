/** Executed Python policy. These functions inspect data, never native resources. */
export const CODEX_HARNESS_DOMAIN_SOURCE = String.raw`
REVISION = "90a7afe02a9377d9e20cedd62e2c0d88e426d814"
SOURCE = "https://github.com/Luxusio/harness.git"

def registration_parts(data):
    plugins = data.get("plugins", {})
    plugin = plugins.get("harness@harness")
    mcp = data.get("mcp_servers", {}).get("harness")
    market = data.get("marketplaces", {}).get("harness")
    features = data.get("features", {})
    return plugins, plugin, mcp, market, features

def registration_disabled(plugin, mcp, features):
    return (features.get("plugin_hooks") is False
        or isinstance(plugin, dict) and plugin.get("enabled") is False
        or isinstance(mcp, dict) and mcp.get("enabled") is False)

def registration_absent(plugins, plugin, mcp, market):
    return plugin is None and mcp is None and market is None and not any(
        name.startswith("harness@") for name in plugins
    )

def require_enabled_registration(plugin, mcp, market, features):
    if not all(isinstance(value, dict) for value in (plugin, mcp, market)):
        raise RuntimeError("existing Harness registration is incomplete or custom; preserved")
    if plugin.get("enabled") is not True or features.get("plugin_hooks") is not True:
        raise RuntimeError("existing Harness plugin/hooks are not enabled; preserved")

def plugin_version(manifest):
    version = str(manifest.get("version", "local"))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}", version):
        raise RuntimeError("invalid Harness plugin version; preserved")
    return version

def hook_events():
    return {"SessionStart": "session_start", "PreToolUse": "pre_tool_use",
            "UserPromptSubmit": "user_prompt_submit", "PostToolUse": "post_tool_use"}

def hook_tokens(hook):
    command = shlex.split(hook.get("command", ""))
    if command and command[0] == "PYTHONDONTWRITEBYTECODE=1":
        command = command[1:]
    return command

def hook_identity(event, group, hook, events):
    if event not in events:
        raise RuntimeError("existing Harness hook event is custom; preserved")
    identity = {"event_name": events[event], "hooks": [{
        "async": False, "command": hook["command"],
        "timeout": max(1, int(hook.get("timeout") or 600)), "type": "command"}]}
    if group.get("matcher"):
        identity["matcher"] = group["matcher"]
    if hook.get("statusMessage"):
        identity["hooks"][0]["statusMessage"] = hook["statusMessage"]
    return identity

def hook_digest(identity):
    return "sha256:" + hashlib.sha256(json.dumps(
        identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def require_hook_trust(state, digest):
    if state.get("trusted_hash") != digest or state.get("enabled") is False:
        raise RuntimeError("existing Harness hook trust is missing, stale, or disabled; preserved")

def managed_python_version(command, home):
    prefix = str(home) + "/.local/share/mise/installs/python/"
    if not command.startswith(prefix):
        return None
    match = re.fullmatch(r"(3\.([0-9]{1,3})\.[0-9]{1,4})/bin/python(3\.[0-9]{1,3})", command[len(prefix):])
    if not match or int(match[2]) < 11 or match[3] != "3." + match[2]:
        return None
    return match[1]
`;
