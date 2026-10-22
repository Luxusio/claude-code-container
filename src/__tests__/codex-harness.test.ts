import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { spawnSync } from "child_process";
import { CODEX_HARNESS_BOOTSTRAP, ensureCodexHarness } from "../codex-harness.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../docker.js";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { modernPythonFixture, pythonFixtureProgram } from "./helpers/modern-python-fixture.js";

vi.mock("child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../container-runtime.js", async () => {
    const { validateNativeRuntimeInvocation } = await import("../adapters/container-runtime-invocation.js");
    const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import("../ports/container-runtime-invocation.js");
    const invocation = validateNativeRuntimeInvocation({
        version: 1, runtime: "podman", executable: "/fixture/runtime/podman",
        transport: { kind: "podman-local", graphRoot: "/fixture/storage", runRoot: "/fixture/run",
            storageDriver: "overlay", storageOptions: [], transientStore: false },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
    });
    // This unit owner supplies the process leaf explicitly; emitted integration owns native routing.
    const runner = () => { const capturedCli = "podman"; return { invocation,
        spawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => spawnSync(capturedCli, args, options),
    }; };
    return { ...({ runtimeCli: () => "podman" }), getRuntimeInfo: () => ({ dockerDesktop: false }), getRuntimeInvocation: () => invocation, bindNativeRuntimeInvocation: runner,
        runtimeSpawnSync: (args: readonly string[], options?: import("child_process").SpawnSyncOptions) => runner().spawnSync(args, options),
        runWithNativeRuntimeInvocation: <T>(_invocation: unknown, operation: () => T): T => operation() };
});
vi.mock("../docker.js", () => ({ prepareCodexConfigForContainer: vi.fn(), restoreCodexConfigHostOwnership: vi.fn() }));
vi.mock("../codex-config-lock.js", () => ({ withCodexConfigLock: vi.fn((operation) => operation()) }));
const { spawnSync: realSpawn } = await vi.importActual<typeof import("child_process")>("child_process");
const python = modernPythonFixture(realSpawn);
const hostPython = python.executable ?? "";
const temporary: string[] = [];
const pin = "90a7afe02a9377d9e20cedd62e2c0d88e426d814";

function fixture(hookPrefix = "", managedVersion?: string) {
    const home = mkdtempSync(join(tmpdir(), "ccc-harness-test-"));
    temporary.push(home);
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, "bin"));
    const workspace = join(home, "tmp");
    mkdirSync(workspace);
    const config = join(home, ".codex/config.toml");
    // Fake only the download transport; the actual orchestration executes a real
    // installer subprocess and probes the files/config it writes.
    writeFileSync(join(home, "bin/git"), pythonFixtureProgram(hostPython, `import os, pathlib, shutil, sys\nhome = pathlib.Path.home()\nwith (home / 'git-calls').open('a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')\nif os.environ.get('FAIL_FETCH'): sys.exit(2)\nif sys.argv[1] == 'rev-parse': print(os.environ.get('REVISION', '${pin}'))\nif sys.argv[1] == 'checkout': shutil.copy(home / 'installer.py', pathlib.Path.cwd() / 'install.py')\n`), { mode: 0o755 });
    const source = join(home, ".codex/harness");
    const root = join(source, "plugins/harness");
    const cache = join(home, ".codex/plugins/cache/harness/harness/2.3.0");
    const interpreter = managedVersion ? join(home, `.local/share/mise/installs/python/${managedVersion}/bin/python3.12`) : hostPython;
    if (managedVersion) {
        mkdirSync(join(interpreter, ".."), { recursive: true });
        copyFileSync(hostPython, interpreter);
    }
    const hookCommand = `${hookPrefix}${JSON.stringify(interpreter)} ${JSON.stringify(join(cache, "scripts/session-start.py"))}`;
    // Keys ordered as the official installer's canonical JSON representation.
    const trustHash = "sha256:" + createHash("sha256").update(JSON.stringify({
        event_name: "session_start",
        hooks: [{ async: false, command: hookCommand, timeout: 600, type: "command" }],
    })).digest("hex");
    const contents = `model = "preserve-me"\n[plugins."harness@harness"]\nenabled = true\n[marketplaces.harness]\nsource_type = "local"\nsource = ${JSON.stringify(source)}\n[mcp_servers.harness]\ncommand = ${JSON.stringify(interpreter)}\nargs = [${JSON.stringify(join(root, "mcp/harness_server.py"))}]\n[features]\nplugin_hooks = true\n[hooks.state."harness@harness:hooks.json:session_start:0:0"]\ntrusted_hash = "${trustHash}"\n`;
    const files: Record<string, string> = {
        [config]: contents,
        [join(root, ".codex-plugin/plugin.json")]: JSON.stringify({ version: "2.3.0" }),
        [join(source, ".agents/plugins/marketplace.json")]: "{}",
        [join(root, "mcp/harness_server.py")]: "# MCP",
        [join(cache, ".codex-plugin/plugin.json")]: "{}",
        [join(cache, "skills/run/SKILL.md")]: "# Harness",
        [join(cache, "mcp/harness_server.py")]: "# MCP",
        [join(cache, "scripts/session-start.py")]: "# hook",
        [join(cache, "hooks.json")]: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }] } }),
    };
    writeFileSync(join(home, "installer.py"), `import json, pathlib, sys\nassert sys.argv[1:] == ['--codex-only']\nassert pathlib.Path.cwd() == pathlib.Path.home()\nassert sys.executable == ${JSON.stringify(hostPython)}\nfiles = json.loads(${JSON.stringify(JSON.stringify(files))})\nfor name, contents in files.items():\n p = pathlib.Path(name)\n p.parent.mkdir(parents=True, exist_ok=True)\n p.write_text(contents)\n`);
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/mise"), pythonFixtureProgram(hostPython, `import os, pathlib, shutil, sys\nhome=pathlib.Path.home()\n(home/'mise-calls').write_text(' '.join(sys.argv[1:]))\nassert sys.argv[1:] == ['install','python@3.12.14']\nif os.environ.get('FAIL_MISE'): sys.exit(2)\n${managedVersion ? `shutil.copyfile(${JSON.stringify(hostPython)},${JSON.stringify(interpreter)}); os.chmod(${JSON.stringify(interpreter)},0o755)` : "raise RuntimeError('unexpected runtime installation')"}\n`), { mode: 0o755 });
    const run = (env: Record<string, string> = {}, script = CODEX_HARNESS_BOOTSTRAP) => realSpawn(hostPython, ["-"], {
        // Only the host fixture substitutes the image's fixed installer interpreter.
        input: script.replaceAll('"/usr/bin/python3"', JSON.stringify(hostPython)), encoding: "utf-8", timeout: 10000,
        env: { ...process.env, HOME: home, TMPDIR: workspace, PATH: `${join(home, "bin")}:${process.env.PATH}`, ...env },
    });
    return { home, config, cache, run, interpreter, workspace };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(withCodexConfigLock).mockImplementation((operation) => operation());
    vi.mocked(prepareCodexConfigForContainer).mockImplementation(() => {});
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>);
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const home of temporary.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Harness bootstrap script", () => {
    beforeEach(({ skip }) => { if (!python.executable) skip(python.reason); });
    it("restores a trusted missing managed Python without changing registration, then reuses it", () => {
        const f = fixture("", "3.12.14");
        expect(f.run().status).toBe(0);
        const config = readFileSync(f.config, "utf8");
        const hooks = readFileSync(join(f.cache, "hooks.json"), "utf8");
        const gitCalls = readFileSync(join(f.home, "git-calls"), "utf8");
        rmSync(f.interpreter);
        const restored = f.run({ FAIL_FETCH: "1" });
        expect(restored.status, restored.stderr).toBe(0);
        expect(restored.stdout).toContain("Restoring Harness Python 3.12.14");
        expect(readFileSync(join(f.home, "mise-calls"), "utf8")).toBe("install python@3.12.14");
        expect(readFileSync(f.config, "utf8")).toBe(config);
        expect(readFileSync(join(f.cache, "hooks.json"), "utf8")).toBe(hooks);
        expect(readFileSync(join(f.home, "git-calls"), "utf8")).toBe(gitCalls);
        const reuse = f.run({ FAIL_MISE: "1", FAIL_FETCH: "1" });
        expect(reuse.status, reuse.stderr).toBe(0);
        expect(reuse.stdout).toBe("");
    });
    it.each(["trust", "payload", "custom", "version"])("preserves missing interpreter registration without installing when %s is invalid", (kind) => {
        const f = fixture("", "3.12.14");
        expect(f.run().status).toBe(0);
        rmSync(f.interpreter);
        if (kind === "trust") writeFileSync(f.config, readFileSync(f.config, "utf8").replace(/sha256:[a-f0-9]+/, "sha256:stale"));
        if (kind === "payload") rmSync(join(f.cache, "scripts/session-start.py"));
        if (kind === "custom" || kind === "version") {
            const replacement = kind === "custom" ? join(f.home, "custom/python3.12") : f.interpreter.replace("bin/python3.12", "bin/python3.11");
            writeFileSync(f.config, readFileSync(f.config, "utf8").replace(f.interpreter, replacement));
        }
        const before = readFileSync(f.config, "utf8");
        const result = f.run({ FAIL_FETCH: "1" });
        expect(result.status).toBe(1);
        expect(existsSync(join(f.home, "mise-calls"))).toBe(false);
        expect(readFileSync(f.config, "utf8")).toBe(before);
    });
    it("preserves registered commands and reports a failed interpreter restoration", () => {
        const f = fixture("", "3.12.14");
        expect(f.run().status).toBe(0);
        const before = readFileSync(f.config, "utf8");
        const beforeHooks = readFileSync(join(f.cache, "hooks.json"), "utf8");
        const beforeGit = readFileSync(join(f.home, "git-calls"), "utf8");
        rmSync(f.interpreter);
        const result = f.run({ FAIL_MISE: "1", FAIL_FETCH: "1" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("failed");
        expect(existsSync(f.interpreter)).toBe(false);
        expect(readFileSync(f.config, "utf8")).toBe(before);
        expect(readFileSync(join(f.cache, "hooks.json"), "utf8")).toBe(beforeHooks);
        expect(readFileSync(join(f.home, "git-calls"), "utf8")).toBe(beforeGit);
        expect(readFileSync(join(f.home, "mise-calls"), "utf8")).toBe("install python@3.12.14");
    });
    it("preserves an installed payload when its registration is absent", () => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        const beforeCalls = readFileSync(join(f.home, "git-calls"), "utf8");
        const beforeManifest = readFileSync(join(f.cache, ".codex-plugin/plugin.json"), "utf8");
        writeFileSync(f.config, 'model = "user-only"\n');
        const result = f.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("existing Harness payload has no registration; preserved");
        expect(readFileSync(f.config, "utf8")).toBe('model = "user-only"\n');
        expect(readFileSync(join(f.home, "git-calls"), "utf8")).toBe(beforeCalls);
        expect(readFileSync(join(f.cache, ".codex-plugin/plugin.json"), "utf8")).toBe(beforeManifest);
    });
    it.each(["", "PYTHONDONTWRITEBYTECODE=1 "])("installs once and reuses registration with hook prefix %s", (prefix) => {
        const f = fixture(prefix);
        const first = f.run();
        expect(first.status, first.stderr).toBe(0);
        expect(first.stdout).toContain("Installing Harness");
        const gitCalls = readFileSync(join(f.home, "git-calls"), "utf8");
        expect(gitCalls).toContain(`https://github.com/Luxusio/harness.git ${pin}`);
        expect(readFileSync(f.config, "utf8")).toContain('model = "preserve-me"');
        const second = f.run({ FAIL_FETCH: "1" });
        expect(second.status, second.stderr).toBe(0);
        expect(second.stdout).toBe("");
        expect(readFileSync(join(f.home, "git-calls"), "utf8")).toBe(gitCalls);
    });
    it("rejects an unsupported hook environment prefix", () => {
        const f = fixture("UNKNOWN=1 ");
        const result = f.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("hook command or payload is unavailable");
    });
    it.each([
        '[plugins."harness@harness"]\nenabled = false',
        '[mcp_servers.harness]\nenabled = false',
        '[features]\nplugin_hooks = false',
    ])("preserves explicit disable without network: %s", (contents) => {
        const f = fixture();
        writeFileSync(f.config, contents);
        expect(f.run().status).toBe(0);
        expect(readFileSync(f.config, "utf8")).toBe(contents);
        expect(existsSync(join(f.home, "git-calls"))).toBe(false);
    });
    it.each(['[mcp_servers.harness]\ncommand = "custom"', '[plugins."harness@custom"]\nenabled = true', 'bad = ['])('preserves incomplete/custom/malformed config: %s', (contents) => {
        const f = fixture();
        writeFileSync(f.config, contents);
        expect(f.run().status).toBe(1);
        expect(readFileSync(f.config, "utf8")).toBe(contents);
        expect(existsSync(join(f.home, "git-calls"))).toBe(false);
    });
    it.each(["mcp/harness_server.py", "skills/run/SKILL.md", "scripts/session-start.py"])("diagnoses missing installed payload %s without downloading", (relative) => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        const original = readFileSync(f.config, "utf8");
        rmSync(join(f.cache, relative));
        const result = f.run({ FAIL_FETCH: "1" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("payload");
        expect(readFileSync(f.config, "utf8")).toBe(original);
    });
    it.each(["stale", "missing", "unrelated"])("preserves and diagnoses %s hook trust", (kind) => {
        const f = fixture();
        expect(f.run().status).toBe(0);
        let contents = readFileSync(f.config, "utf8");
        if (kind === "stale") contents = contents.replace(/sha256:[a-f0-9]+/, "sha256:stale");
        if (kind === "missing") contents = contents.replace(/trusted_hash = .*\n/, "");
        if (kind === "unrelated") contents = contents.replace("session_start:0:0", "pre_tool_use:0:0");
        writeFileSync(f.config, contents);
        const result = f.run({ FAIL_FETCH: "1" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("hook trust");
        expect(readFileSync(f.config, "utf8")).toBe(contents);
    });
    it.each<Record<string, string>>([{ FAIL_FETCH: "1" }, { REVISION: "wrong" }])("rejects download failures and pin mismatches", (env) => {
        const f = fixture();
        expect(f.run(env).status).toBe(1);
        expect(existsSync(f.config)).toBe(false);
    });
    it("bounds an installer process group and drains inherited pipes after stopping its children", async () => {
        const f = fixture();
        const pidsPath = join(f.home, "installer-pids");
        const descendant = 'import sys,time\nprint("inherited stdout",flush=True)\nprint("inherited stderr",file=sys.stderr,flush=True)\ntime.sleep(30)\n';
        writeFileSync(join(f.home, "installer.py"), `import os,pathlib,subprocess,sys,time\nchild=subprocess.Popen([sys.executable,"-c",${JSON.stringify(descendant)}])\npathlib.Path(${JSON.stringify(pidsPath)}).write_text(f"{os.getpid()}\\n{child.pid}\\n")\ntime.sleep(30)\n`);
        const installationBoundary = "                ports.install_codex(temp)";
        // Admission guard: a changed generated program must not silently omit
        // the bounded fixture and leave a thirty-second child running.
        expect(CODEX_HARNESS_BOOTSTRAP.split(installationBoundary)).toHaveLength(2);
        const bounded = CODEX_HARNESS_BOOTSTRAP.replace(installationBoundary,
            `                globals()["deadline"] = time.monotonic() + 0.3\n${installationBoundary}`);
        const isRunning = (pid: number) => {
            try { process.kill(pid, 0); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
                throw error;
            }
            if (process.platform !== "linux") return true;
            try {
                const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
                return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0]);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw error;
            }
        };
        let pids: number[] = [];
        try {
            const started = performance.now();
            const result = f.run({}, bounded);
            if (existsSync(pidsPath)) pids = readFileSync(pidsPath, "utf8").trim().split("\n").map(Number);
            expect(result.error).toBeUndefined();
            expect(result.signal).toBeNull();
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("stopped installer and children");
            expect(performance.now() - started).toBeLessThan(5000);
            expect(pids).toHaveLength(2);
            expect(pids.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
            const stoppedDeadline = performance.now() + 1000;
            while (pids.some(isRunning) && performance.now() < stoppedDeadline) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(pids.filter(isRunning)).toEqual([]);
            expect(existsSync(f.config)).toBe(false);
            expect(readdirSync(f.workspace)).toEqual([]);
        } finally {
            for (const pid of pids) if (isRunning(pid)) process.kill(pid, "SIGKILL");
        }
    });
});

describe("ensureCodexHarness", () => {
    it("uses the selected profile configuration lock", () => {
        ensureCodexHarness("test-container", "work");
        expect(withCodexConfigLock).toHaveBeenCalledWith(expect.any(Function), "work");
        expect(prepareCodexConfigForContainer).toHaveBeenCalledWith("test-container", "work");
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledWith("test-container", "work");
    });
    it("prepares and restores under lock, keeping the default container identity and outer timeout", () => {
        ensureCodexHarness("test-container");
        expect(withCodexConfigLock).toHaveBeenCalledOnce();
        expect(spawnSync).toHaveBeenCalledWith("podman", expect.arrayContaining(["test-container", "python3", "-"]), expect.objectContaining({ input: CODEX_HARNESS_BOOTSTRAP, timeout: 135000 }));
        expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain("--user");
        expect(prepareCodexConfigForContainer).toHaveBeenCalledWith("test-container", undefined);
        expect(restoreCodexConfigHostOwnership).toHaveBeenCalledWith("test-container", undefined);
        expect(vi.mocked(prepareCodexConfigForContainer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawnSync).mock.invocationCallOrder[0]);
        expect(vi.mocked(spawnSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(restoreCodexConfigHostOwnership).mock.invocationCallOrder[0]);
    });
    it("publishes trimmed installer output before restoration, lock release and the native failure warning", () => {
        const trace: string[] = [];
        vi.mocked(withCodexConfigLock).mockImplementationOnce(operation => {
            trace.push("lock");
            try { return operation(); } finally { trace.push("unlock"); }
        });
        vi.mocked(prepareCodexConfigForContainer).mockImplementationOnce(() => { trace.push("prepare"); });
        vi.mocked(spawnSync).mockImplementationOnce(() => {
            trace.push("execute");
            return {status: 1, stdout: "  installed partially\n", stderr: "  installer refused\n"} as ReturnType<typeof spawnSync>;
        });
        vi.mocked(restoreCodexConfigHostOwnership).mockImplementationOnce(() => { trace.push("restore"); });
        const output = vi.spyOn(console, "error").mockImplementation(() => { trace.push("output"); });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { trace.push("warning"); });
        expect(ensureCodexHarness("test-container", "work")).toBeUndefined();
        expect(trace).toEqual(["lock", "prepare", "execute", "output", "restore", "unlock", "warning"]);
        expect(output).toHaveBeenCalledExactlyOnceWith("installed partially");
        expect(warn).toHaveBeenCalledExactlyOnceWith("[ccc] Harness is unavailable: installer refused. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.");
    });
    it("reads private config when the default UID differs from named ccc (Docker; native-only)", async (context) => {
        const image = process.env.CCC_TEST_HARNESS_IMAGE?.trim();
        if (!image) return context.skip("Set CCC_TEST_HARNESS_IMAGE to an existing suitable image to opt into the native UID regression.");
        if (process.platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
            return context.skip("The native UID regression requires a POSIX host with UID/GID APIs.");
        }
        const inspected = realSpawn("docker", ["image", "inspect", image], {
            encoding: "utf8", timeout: 5000, windowsHide: true, shell: false,
        });
        if (inspected.error || inspected.status !== 0) {
            throw new Error(`Cannot inspect CCC_TEST_HARNESS_IMAGE=${JSON.stringify(image)}: ${inspected.error?.message ?? (inspected.stderr.trim() || `exit ${inspected.status}`)}. Make the image available locally and verify Docker access before retrying.`);
        }
        const home = mkdtempSync(join(tmpdir(), "ccc-harness-uid-"));
        temporary.push(home);
        const contents = '[plugins."harness@harness"]\nenabled = false\n';
        writeFileSync(join(home, "config.toml"), contents, { mode: 0o600 });
        const name = `ccc-harness-uid-${randomUUID()}`;
        const run = (args: string[]) => {
            const result = realSpawn("docker", args, { encoding: "utf8", timeout: 15000, windowsHide: true, shell: false });
            expect(result.status, result.stderr || result.error?.message).toBe(0);
            return result.stdout.trim();
        };
        const created = realSpawn("docker", ["run", "-d", "--name", name, "--network", "none", "--user", `${process.getuid()}:${process.getgid()}`,
            "--mount", `type=bind,src=${home},dst=/home/ccc/.codex`, "--entrypoint", "sleep", image, "infinity"], {
            encoding: "utf8", timeout: 15000, windowsHide: true, shell: false,
        });
        const container = created.stdout?.trim() ?? "";
        if (created.error || created.status !== 0 || !/^[a-f0-9]{64}$/.test(container)) {
            throw new Error(`Native UID fixture creation was not confirmed for ${name}: ${created.error?.message ?? (created.stderr.trim() || `exit ${created.status}; stdout ${JSON.stringify(created.stdout)}`)}. No cleanup was attempted without a validated owned container ID; inspect this unique fixture name before removing anything.`);
        }
        try {
            if (run(["exec", container, "id", "-u"]) === run(["exec", container, "id", "-u", "ccc"])) {
                return context.skip("The host default UID equals the image's named ccc UID, so this fixture cannot exercise the identity split.");
            }
            const actual = await vi.importActual<typeof import("../docker.js")>("../docker.js");
            vi.spyOn(await import("../utils.js"), "getCodexConfigFile").mockReturnValue(join(home, "config.toml"));
            vi.mocked(prepareCodexConfigForContainer).mockImplementation(actual.prepareCodexConfigForContainer);
            // Transport uses Docker; preparation and bootstrap both execute
            // their real commands against the same isolated identity split.
            vi.mocked(spawnSync).mockImplementation((_runtime, args, options) => realSpawn("docker", args as string[], {
                ...options, timeout: options?.timeout ?? 15000, windowsHide: true, shell: false,
            }));
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            ensureCodexHarness(container);
            expect(prepareCodexConfigForContainer).toHaveBeenCalledWith(container, undefined);
            expect(warn).not.toHaveBeenCalled();
            expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(contents);
        } finally {
            run(["rm", "-f", container]);
        }
    }, 300000);
    it.each(["prepare", "installer", "lock"])("warns and continues after %s failure", (failure) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        if (failure === "prepare") vi.mocked(prepareCodexConfigForContainer).mockImplementation(() => { throw new Error("permission denied"); });
        if (failure === "installer") vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "network failed" } as ReturnType<typeof spawnSync>);
        if (failure === "lock") vi.mocked(withCodexConfigLock).mockImplementation(() => { throw new Error("lock timed out"); });
        expect(() => ensureCodexHarness("test-container")).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Codex will continue"));
        if (failure === "lock") {
            expect(prepareCodexConfigForContainer).not.toHaveBeenCalled();
            expect(spawnSync).not.toHaveBeenCalled();
            expect(restoreCodexConfigHostOwnership).not.toHaveBeenCalled();
        } else {
            expect(restoreCodexConfigHostOwnership).toHaveBeenCalledOnce();
            if (failure === "prepare") {
                expect(spawnSync).not.toHaveBeenCalled();
                expect(warn).toHaveBeenCalledExactlyOnceWith("[ccc] Harness is unavailable: permission denied. Codex will continue. Check the container's ~/.codex/config.toml and Harness installation, then retry ccc codex.");
            }
        }
    });
});
