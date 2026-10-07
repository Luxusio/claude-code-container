import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { join } from "path";
import { spawnSync } from "child_process";
import { CODEX_HARNESS_BOOTSTRAP, ensureCodexHarness } from "../codex-harness.js";
import { prepareCodexConfigForContainer, restoreCodexConfigHostOwnership } from "../docker.js";
import { withCodexConfigLock } from "../codex-config-lock.js";

vi.mock("child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../container-runtime.js", () => ({ runtimeCli: () => "podman" }));
vi.mock("../docker.js", () => ({ prepareCodexConfigForContainer: vi.fn(), restoreCodexConfigHostOwnership: vi.fn() }));
vi.mock("../codex-config-lock.js", () => ({ withCodexConfigLock: vi.fn((operation) => operation()) }));
const { spawnSync: realSpawn } = await vi.importActual<typeof import("child_process")>("child_process");
const temporary: string[] = [];
const pin = "90a7afe02a9377d9e20cedd62e2c0d88e426d814";

function fixture(hookPrefix = "") {
    const home = mkdtempSync(join(tmpdir(), "ccc-harness-test-"));
    temporary.push(home);
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, "bin"));
    const config = join(home, ".codex/config.toml");
    // Fake only the download transport; the actual orchestration executes a real
    // installer subprocess and probes the files/config it writes.
    writeFileSync(join(home, "bin/git"), `#!/usr/bin/python3\nimport os, pathlib, shutil, sys\nhome = pathlib.Path.home()\nwith (home / 'git-calls').open('a') as f: f.write(' '.join(sys.argv[1:]) + '\\n')\nif os.environ.get('FAIL_FETCH'): sys.exit(2)\nif sys.argv[1] == 'rev-parse': print(os.environ.get('REVISION', '${pin}'))\nif sys.argv[1] == 'checkout': shutil.copy(home / 'installer.py', pathlib.Path.cwd() / 'install.py')\n`, { mode: 0o755 });
    const source = join(home, ".codex/harness");
    const root = join(source, "plugins/harness");
    const cache = join(home, ".codex/plugins/cache/harness/harness/2.3.0");
    const hookCommand = `${hookPrefix}/usr/bin/python3 ${join(cache, "scripts/session-start.py")}`;
    // Keys ordered as the official installer's canonical JSON representation.
    const trustHash = "sha256:" + createHash("sha256").update(JSON.stringify({
        event_name: "session_start",
        hooks: [{ async: false, command: hookCommand, timeout: 600, type: "command" }],
    })).digest("hex");
    const contents = `model = "preserve-me"\n[plugins."harness@harness"]\nenabled = true\n[marketplaces.harness]\nsource_type = "local"\nsource = ${JSON.stringify(source)}\n[mcp_servers.harness]\ncommand = "/usr/bin/python3"\nargs = [${JSON.stringify(join(root, "mcp/harness_server.py"))}]\n[features]\nplugin_hooks = true\n[hooks.state."harness@harness:hooks.json:session_start:0:0"]\ntrusted_hash = "${trustHash}"\n`;
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
    writeFileSync(join(home, "installer.py"), `import json, pathlib, sys\nassert sys.argv[1:] == ['--codex-only']\nassert pathlib.Path.cwd() == pathlib.Path.home()\nfiles = json.loads(${JSON.stringify(JSON.stringify(files))})\nfor name, contents in files.items():\n p = pathlib.Path(name)\n p.parent.mkdir(parents=True, exist_ok=True)\n p.write_text(contents)\n`);
    const run = (env: Record<string, string> = {}, script = CODEX_HARNESS_BOOTSTRAP) => realSpawn("python3", ["-"], {
        input: script, encoding: "utf-8", timeout: 10000,
        env: { ...process.env, HOME: home, PATH: `${join(home, "bin")}:${process.env.PATH}`, ...env },
    });
    return { home, config, cache, run };
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
    it.each([{ FAIL_FETCH: "1" }, { REVISION: "wrong" }])("rejects download failures and pin mismatches", (env) => {
        const f = fixture();
        expect(f.run(env).status).toBe(1);
        expect(existsSync(f.config)).toBe(false);
    });
    it("bounds an installer process group", () => {
        const f = fixture();
        writeFileSync(join(f.home, "installer.py"), 'import subprocess, time\nsubprocess.Popen(["sleep", "30"])\ntime.sleep(30)\n');
        const result = f.run({}, CODEX_HARNESS_BOOTSTRAP.replace(
            '            run([sys.executable,',
            '            deadline = time.monotonic() + 0.3\n            run([sys.executable,',
        ));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("stopped installer and children");
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
    it.skipIf(process.platform !== "linux" || !process.env.CCC_TEST_HARNESS_IMAGE)("reads private config when the default UID differs from named ccc (Docker)", async (context) => {
        const image = process.env.CCC_TEST_HARNESS_IMAGE!;
        if (realSpawn("docker", ["image", "inspect", image], { timeout: 5000, stdio: "ignore" }).status !== 0) {
            context.skip();
        }
        const home = mkdtempSync(join(tmpdir(), "ccc-harness-uid-"));
        temporary.push(home);
        const contents = '[plugins."harness@harness"]\nenabled = false\n';
        writeFileSync(join(home, "config.toml"), contents, { mode: 0o600 });
        const container = `ccc-harness-uid-${process.pid}`;
        const run = (args: string[]) => {
            const result = realSpawn("docker", args, { encoding: "utf8", timeout: 15000 });
            expect(result.status, result.stderr || result.error?.message).toBe(0);
            return result.stdout.trim();
        };
        try {
            run(["run", "-d", "--name", container, "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`,
                "--mount", `type=bind,src=${home},dst=/home/ccc/.codex`, "--entrypoint", "sleep", image, "infinity"]);
            if (run(["exec", container, "id", "-u"]) === run(["exec", container, "id", "-u", "ccc"])) context.skip();
            const actual = await vi.importActual<typeof import("../docker.js")>("../docker.js");
            vi.mocked(prepareCodexConfigForContainer).mockImplementation(actual.prepareCodexConfigForContainer);
            // Transport uses Docker; preparation and bootstrap both execute
            // their real commands against the same isolated identity split.
            vi.mocked(spawnSync).mockImplementation((_runtime, args, options) => realSpawn("docker", args as string[], options!));
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            ensureCodexHarness(container);
            expect(prepareCodexConfigForContainer).toHaveBeenCalledWith(container, undefined);
            expect(warn).not.toHaveBeenCalled();
            expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(contents);
        } finally {
            realSpawn("docker", ["rm", "-f", container], { timeout: 15000, stdio: "ignore" });
        }
    }, 30000);
    it.each(["prepare", "installer", "lock"])("warns and continues after %s failure", (failure) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        if (failure === "prepare") vi.mocked(prepareCodexConfigForContainer).mockImplementation(() => { throw new Error("permission denied"); });
        if (failure === "installer") vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "network failed" } as ReturnType<typeof spawnSync>);
        if (failure === "lock") vi.mocked(withCodexConfigLock).mockImplementation(() => { throw new Error("lock timed out"); });
        expect(() => ensureCodexHarness("test-container")).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Codex will continue"));
        if (failure !== "lock") expect(restoreCodexConfigHostOwnership).toHaveBeenCalledOnce();
    });
});
