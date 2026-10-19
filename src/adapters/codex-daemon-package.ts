import { spawnSync } from "node:child_process";
import { bindNativeRuntimeInvocation, captureNativeRuntimeInvocation, currentNativeRuntimeInvocation, type BoundNativeSpawnSync } from "../container-runtime.js";

export const CODEX_DAEMON_PACKAGE_BOOTSTRAP = String.raw`
import fcntl, json, os, platform, shutil, subprocess, tempfile
root = '/home/ccc/.codex/packages/app-server-daemon'
current = root + '/current'
if os.path.isfile(current + '/bin/codex') and os.access(current + '/bin/codex', os.X_OK):
    raise SystemExit(0)
help = subprocess.run(['/home/ccc/.local/bin/mise', 'exec', 'node@22', '--', 'codex', 'app-server', 'daemon', 'start', '--help'], capture_output=True, text=True, timeout=10)
if help.returncode != 0 or 'app-server daemon start' not in help.stdout:
    raise SystemExit(0)
node = subprocess.check_output(['/home/ccc/.local/bin/mise', 'exec', 'node@22', '--', 'node', '-p', 'process.execPath'], text=True).strip()
launcher = os.path.dirname(node) + '/codex'
package = os.path.dirname(os.path.dirname(os.path.realpath(launcher)))
with open(package + '/package.json') as metadata:
    if json.load(metadata).get('name') != '@openai/codex':
        raise RuntimeError('Cannot identify the installed official Codex package')
arch = {'x86_64':'x64', 'aarch64':'arm64'}.get(platform.machine())
if not arch: raise RuntimeError('Unsupported Codex daemon package architecture')
vendor = package + '/node_modules/@openai/codex-linux-' + arch + '/vendor'
sources = []
for target in os.listdir(vendor):
    source = vendor + '/' + target
    manifest = source + '/codex-package.json'
    if not os.path.isfile(manifest): continue
    with open(manifest) as metadata: data = json.load(metadata)
    if data.get('entrypoint') == 'bin/codex' and data.get('target') == target and data.get('variant') == 'codex':
        sources.append((source, data))
if len(sources) != 1: raise RuntimeError('Installed Codex package layout is ambiguous')
source, data = sources[0]
version = data['version']
if not version or any(c not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-' for c in version):
    raise RuntimeError('Invalid Codex package version')
expected = subprocess.check_output([source + '/bin/codex', '--version'], text=True).strip()
if expected != 'codex-cli ' + version: raise RuntimeError('Codex package version does not match its executable')
os.makedirs(root, exist_ok=True)
with open(root + '/.ccc-package.lock', 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if os.path.lexists(current):
        if os.path.isfile(current + '/bin/codex') and os.access(current + '/bin/codex', os.X_OK): raise SystemExit(0)
        raise RuntimeError('Existing daemon package selection requires repair; it was preserved')
    destination = root + '/ccc-cli-' + version
    if not os.path.lexists(destination):
        staging = tempfile.mkdtemp(prefix='.ccc-package-', dir=root)
        try:
            shutil.copytree(source, staging, dirs_exist_ok=True)
            if subprocess.check_output([staging + '/bin/codex', '--version'], text=True).strip() != expected:
                raise RuntimeError('Copied Codex daemon package verification failed')
            os.rename(staging, destination)
        finally:
            if os.path.exists(staging): shutil.rmtree(staging)
    else:
        if os.path.islink(destination) or subprocess.check_output([destination + '/bin/codex', '--version'], text=True).strip() != expected:
            raise RuntimeError('Existing cached daemon package does not match the installed CLI')
    os.symlink(os.path.basename(destination), current)
print('Codex daemon package prepared from the installed CLI')
`;

export function prepareCodexDaemonPackage(cli: string, target: string, runner?: BoundNativeSpawnSync): void {
    if (!runner && (cli === "docker" || cli === "podman")) {
        const current = currentNativeRuntimeInvocation();
        runner = bindNativeRuntimeInvocation(current?.runtime === cli ? current : captureNativeRuntimeInvocation(cli)).spawnSync;
    }
    const args = ["exec", "-i", target, "timeout", "-k", "2s", "90s", "python3", "-I", "-"];
    const options = { input: CODEX_DAEMON_PACKAGE_BOOTSTRAP, encoding: "utf8" as const, timeout: 95000 };
    const result = runner ? runner(args, options) : spawnSync(cli, args, options);
    if (result.error || result.status !== 0) throw new Error(`Codex daemon package preparation failed: ${result.stderr?.trim()}`, { cause: result.error });
}
