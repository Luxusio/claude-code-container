/** Entire executed probe/install decision workflow over named native capabilities. */
export const CODEX_HARNESS_APPLICATION_SOURCE = String.raw`
def probe(ports):
    data = ports.read_configuration()
    plugins, plugin, mcp, market, features = registration_parts(data)
    if registration_disabled(plugin, mcp, features):
        return "disabled"
    if registration_absent(plugins, plugin, mcp, market):
        if ports.unregistered_payload_present():
            raise RuntimeError("existing Harness payload has no registration; preserved")
        return "absent"
    require_enabled_registration(plugin, mcp, market, features)
    source, root = ports.marketplace_paths(market.get("source", ""))
    manifest = ports.read_plugin_manifest(root)
    version = plugin_version(manifest)
    cache, required = ports.cache_payloads(source, root, version)
    args = mcp.get("args", [])
    command = mcp.get("command", "")
    if not command or not ports.command_available(command) or not args or not ports.declared_payload_available(args[0]):
        raise RuntimeError("existing Harness MCP command or payload is unavailable; preserved")
    if any(not ports.required_payload_available(path) for path in required):
        raise RuntimeError("existing Harness plugin payload is incomplete; preserved")
    hooks = ports.read_installed_hooks(cache).get("hooks", {})
    trust = data.get("hooks", {}).get("state", {})
    if not hooks or not any(key.startswith("harness@harness:") for key in trust):
        raise RuntimeError("existing Harness hooks or trust registration is incomplete; preserved")
    events = hook_events()
    checked = 0
    for event, groups in hooks.items():
        for group_index, group in enumerate(groups):
            for hook_index, hook in enumerate(group.get("hooks", [])):
                if hook.get("type") == "command":
                    command = hook_tokens(hook)
                    if len(command) < 2 or not ports.command_available(command[0]) or not ports.declared_payload_available(command[1]):
                        raise RuntimeError("existing Harness hook command or payload is unavailable; preserved")
                    identity = hook_identity(event, group, hook, events)
                    digest = hook_digest(identity)
                    key = f"harness@harness:hooks.json:{events[event]}:{group_index}:{hook_index}"
                    state = trust.get(key, {})
                    require_hook_trust(state, digest)
                    checked += 1
    if not checked:
        raise RuntimeError("existing Harness command hooks are missing; preserved")
    return "ready"

def run_bootstrap(ports):
    try:
        state = probe(ports)
        if state == "absent":
            ports.report_installing()
            with ports.installation_workspace() as temp:
                ports.run_command(["git", "init", "--quiet", temp], temp)
                ports.run_command(["git", "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", SOURCE, REVISION], temp)
                actual = ports.run_command(["git", "rev-parse", "FETCH_HEAD"], temp)
                if actual != REVISION:
                    raise RuntimeError("downloaded Harness revision does not match pinned revision")
                ports.run_command(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], temp)
                ports.run_command([ports.installer_interpreter(), ports.installer_path(temp), "--codex-only"], ports.installer_home())
            if probe(ports) != "ready":
                raise RuntimeError("installer did not produce an enabled Harness registration")
    except Exception as error:
        ports.report_failure(error)
        ports.exit_failure()
`;
