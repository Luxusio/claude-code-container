import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CODEX_HARNESS_BOOTSTRAP } from "../../codex-harness.js";

const PIN = "90a7afe02a9377d9e20cedd62e2c0d88e426d814";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Options = {
    registration?: "ready" | "absent" | "disabled" | "incomplete" | "malformed";
    trust?: "valid" | "missing" | "stale" | "disabled";
    missingPayload?: boolean;
    unregisteredPayload?: boolean;
    version?: string;
    revision?: string;
    failure?: "fetch" | "installer";
    installerReady?: boolean;
};

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function fixture(options: Options = {}) {
    const root = mkdtempSync(join(tmpdir(), "ccc-bootstrap-test-")); roots.push(root);
    const home = join(root, "home"), bin = join(root, "bin"), temporary = join(root, "tmp");
    for (const directory of [home, bin, temporary]) mkdirSync(directory);
    const source = join(home, ".codex", "harness"), plugin = join(source, "plugins", "harness");
    const version = options.version ?? "2.3.0";
    const cache = join(home, ".codex", "plugins", "cache", "harness", "harness", "2.3.0");
    const hookPath = join(cache, "scripts", "session-start.py");
    const command = `/usr/bin/python3 ${hookPath}`;
    const identity = { event_name: "session_start", hooks: [{ async: false, command, timeout: 600, type: "command" }] };
    const digest = "sha256:" + createHash("sha256").update(canonical(identity)).digest("hex");
    const trust = options.trust === "missing" ? "" :
        `[hooks.state."harness@harness:hooks.json:session_start:0:0"]\ntrusted_hash = ${JSON.stringify(options.trust === "stale" ? "sha256:stale" : digest)}\n${options.trust === "disabled" ? "enabled = false\n" : ""}`;
    const readyConfig = `[plugins."harness@harness"]\nenabled = true\n[features]\nplugin_hooks = true\n[marketplaces.harness]\nsource = ${JSON.stringify(source)}\n[mcp_servers.harness]\ncommand = "/usr/bin/python3"\nargs = [${JSON.stringify(join(plugin, "mcp", "harness_server.py"))}]\n${trust}`;
    const configPath = join(home, ".codex", "config.toml");
    const files: Record<string, string> = {
        [configPath]: readyConfig,
        [join(source, ".agents", "plugins", "marketplace.json")]: "{}",
        [join(plugin, ".codex-plugin", "plugin.json")]: JSON.stringify({ version }),
        [join(plugin, "mcp", "harness_server.py")]: "# synthetic MCP entry\n",
        [join(cache, ".codex-plugin", "plugin.json")]: "{}",
        [join(cache, "skills", "run", "SKILL.md")]: "synthetic skill\n",
        [join(cache, "mcp", "harness_server.py")]: "# synthetic MCP entry\n",
        [join(cache, "hooks.json")]: JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }),
        [hookPath]: "# synthetic hook\n",
    };
    const write = (file: string, content: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
    const registration = options.registration ?? "ready";
    if (registration === "ready") {
        for (const [file, contents] of Object.entries(files)) write(file, contents);
        if (options.missingPayload) rmSync(join(cache, "skills", "run", "SKILL.md"));
    } else if (registration === "disabled") write(configPath, "[features]\nplugin_hooks = false\n");
    else if (registration === "incomplete") write(configPath, '[plugins."harness@harness"]\nenabled = true\n');
    else if (registration === "malformed") write(configPath, "bad = [");
    if (options.unregisteredPayload) mkdirSync(source, { recursive: true });

    const installer = `import json,pathlib,sys\nassert sys.argv[1:] == ["--codex-only"]\nassert pathlib.Path.cwd() == pathlib.Path.home()\n${options.failure === "installer" ? 'raise RuntimeError("fixture installer failed")\n' : ""}files=json.loads(${JSON.stringify(JSON.stringify(options.installerReady === false ? {} : files))})\nfor name,contents in files.items():\n p=pathlib.Path(name)\n p.parent.mkdir(parents=True,exist_ok=True)\n p.write_text(contents)\n`;
    const installerPath = join(root, "fixture-installer.py"); writeFileSync(installerPath, installer);
    const callsPath = join(root, "git-calls.jsonl");
    const git = `#!/usr/bin/python3\nimport json,pathlib,sys\nargs=sys.argv[1:]\nwith pathlib.Path(${JSON.stringify(callsPath)}).open("a") as log:log.write(json.dumps(args)+"\\n")\nkind="fetch" if "fetch" in args else args[0]\nif kind == ${JSON.stringify(options.failure ?? "none")}:\n print("fixture fetch failed",file=sys.stderr)\n sys.exit(2)\nif kind == "rev-parse":print(${JSON.stringify(options.revision ?? PIN)})\nif kind == "checkout":pathlib.Path("install.py").write_text(pathlib.Path(${JSON.stringify(installerPath)}).read_text())\n`;
    writeFileSync(join(bin, "git"), git, { mode: 0o700 });
    return { root, home, temporary, bin, configPath, readyConfig, callsPath };
}

function execute(options: Options = {}) {
    const f = fixture(options);
    const result = spawnSync("/usr/bin/python3", ["-"], {
        input: CODEX_HARNESS_BOOTSTRAP, encoding: "utf8", cwd: f.home,
        env: { HOME: f.home, TMPDIR: f.temporary, PATH: f.bin, PYTHONDONTWRITEBYTECODE: "1" },
        timeout: 5000, maxBuffer: 1024 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    const calls = existsSync(f.callsPath) ? readFileSync(f.callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
    expect(readdirSync(f.temporary)).toEqual([]);
    return { ...f, result, calls };
}

describe("current Codex Harness Python bootstrap", () => {
    it("accepts an enabled registration with the exact hook trust digest without installing", () => {
        const f = execute();
        expect(f.result.status).toBe(0); expect(f.result.stdout).toBe(""); expect(f.result.stderr).toBe("");
        expect(f.calls).toEqual([]); expect(readFileSync(f.configPath, "utf8")).toBe(f.readyConfig);
    });
    it("leaves an explicitly disabled registration alone", () => {
        const f = execute({ registration: "disabled" });
        expect(f.result.status).toBe(0); expect(f.calls).toEqual([]);
        expect(readFileSync(f.configPath, "utf8")).toBe("[features]\nplugin_hooks = false\n");
    });
    it.each(["missing", "stale", "disabled"] as const)("refuses %s hook trust without downloading or changing config", trust => {
        const f = execute({ trust });
        expect(f.result.status).toBe(1); expect(f.result.stderr).toContain("trust"); expect(f.calls).toEqual([]);
        expect(readFileSync(f.configPath, "utf8")).toBe(f.readyConfig);
    });
    it.each(["incomplete", "malformed"] as const)("refuses %s configuration without installing", registration => {
        const f = execute({ registration });
        expect(f.result.status).toBe(1); expect(f.result.stderr).not.toBe(""); expect(f.calls).toEqual([]);
    });
    it("refuses an unregistered existing payload", () => {
        const f = execute({ registration: "absent", unregisteredPayload: true });
        expect(f.result.status).toBe(1); expect(f.result.stderr).toContain("no registration"); expect(f.calls).toEqual([]);
    });
    it.each([{ missingPayload: true }, { version: "../invalid" }])("refuses unavailable or invalid plugin payload %j", options => {
        const f = execute(options);
        expect(f.result.status).toBe(1); expect(f.calls).toEqual([]);
    });
    it("installs the pinned revision and verifies the resulting registration", () => {
        const f = execute({ registration: "absent" });
        expect(f.result.status).toBe(0); expect(f.result.stdout).toContain("Installing Harness");
        expect(f.calls).toEqual([
            ["init", "--quiet", expect.any(String)],
            ["-c", "credential.helper=", "fetch", "--quiet", "--depth=1", "https://github.com/Luxusio/harness.git", PIN],
            ["rev-parse", "FETCH_HEAD"], ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
        ]);
        expect(readFileSync(f.configPath, "utf8")).toBe(f.readyConfig);
        expect(existsSync(f.temporary)).toBe(true);
    });
    it("refuses a fetched revision that differs from the pin before checkout or installation", () => {
        const f = execute({ registration: "absent", revision: "wrong" });
        expect(f.result.status).toBe(1); expect(f.result.stderr).toContain("does not match pinned revision");
        expect(f.calls).toHaveLength(3); expect(existsSync(f.configPath)).toBe(false);
    });
    it.each(["fetch", "installer"] as const)("reports %s failure without inventing a successful registration", failure => {
        const f = execute({ registration: "absent", failure });
        expect(f.result.status).toBe(1); expect(f.result.stderr).toContain(`fixture ${failure} failed`);
        expect(existsSync(f.configPath)).toBe(false);
    });
    it("refuses an installer that leaves registration absent", () => {
        const f = execute({ registration: "absent", installerReady: false });
        expect(f.result.status).toBe(1); expect(f.result.stderr).toContain("installer did not produce an enabled Harness registration");
        expect(existsSync(f.configPath)).toBe(false);
    });
});
