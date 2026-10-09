import { CODEX_HARNESS_DOMAIN_SOURCE } from "../domain/codex-harness-bootstrap.js";
import { CODEX_HARNESS_PORTS_SOURCE } from "../ports/codex-harness-bootstrap.js";
import { CODEX_HARNESS_APPLICATION_SOURCE } from "../application/codex-harness-bootstrap.js";

export const CODEX_HARNESS_NATIVE_IMPORTS = String.raw`
import hashlib, json, os, re, shlex, shutil, signal, subprocess, sys, tempfile, time, tomllib
from pathlib import Path

`;
export const CODEX_HARNESS_NATIVE_SOURCE = String.raw`home = Path.home() / ".codex"
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

class NativeBootstrapPorts(CodexBootstrapPorts):
    def read_configuration(self):
        return tomllib.loads(config.read_text()) if config.exists() else {}

    def unregistered_payload_present(self):
        return (home / "harness").exists() or (home / "plugins/cache/harness").exists()

    @property
    def marketplace_paths(self):
        selected_path = Path
        def resolve_marketplace(value):
            source = selected_path(value)
            return source, source / "plugins" / "harness"
        return resolve_marketplace

    def read_plugin_manifest(self, root):
        return json.loads((root / ".codex-plugin" / "plugin.json").read_text())

    def cache_payloads(self, source, root, version):
        cache = home / "plugins" / "cache" / "harness" / "harness" / version
        required = [source / ".agents/plugins/marketplace.json", root / "mcp/harness_server.py",
                    cache / ".codex-plugin/plugin.json", cache / "skills/run/SKILL.md",
                    cache / "mcp/harness_server.py", cache / "hooks.json"]
        return cache, required

    @property
    def command_available(self):
        return shutil.which

    @property
    def declared_payload_available(self):
        selected_path = Path
        return lambda token: selected_path(token).is_file()

    def required_payload_available(self, path):
        return path.is_file()

    def read_installed_hooks(self, cache):
        return json.loads((cache / "hooks.json").read_text())

    def installation_workspace(self):
        return tempfile.TemporaryDirectory(prefix="ccc-codex-harness-")

    @property
    def run_command(self):
        return run

    def installer_interpreter(self):
        return sys.executable

    def installer_path(self, temp):
        return str(Path(temp) / "install.py")

    def installer_home(self):
        return Path.home()

    def report_installing(self):
        print("[ccc] Installing Harness for Codex...", flush=True)

    def report_failure(self, error):
        print(str(error), file=sys.stderr)

    def exit_failure(self):
        sys.exit(1)
`;

export const CODEX_HARNESS_BOOTSTRAP = [
    CODEX_HARNESS_NATIVE_IMPORTS, CODEX_HARNESS_DOMAIN_SOURCE,
    CODEX_HARNESS_PORTS_SOURCE, CODEX_HARNESS_NATIVE_SOURCE,
    CODEX_HARNESS_APPLICATION_SOURCE, "\nrun_bootstrap(NativeBootstrapPorts())\n",
].join("\n");
