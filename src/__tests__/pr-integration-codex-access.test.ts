import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixture = vi.hoisted(() => ({ home: "", configDir: "", executions: [] as string[][], failRepair: false }));
vi.mock("os", async (original) => ({
    ...await original<typeof import("os")>(),
    homedir: () => {
        if (!fixture.home) throw new Error("private HOME fixture is not initialized");
        return fixture.home;
    },
}));
vi.mock("../container-runtime.js", async (original) => ({
    ...await original<typeof import("../container-runtime.js")>(),
    runtimeCli: () => "docker",
}));
vi.mock("child_process", async (original) => {
    const native = await original<typeof import("child_process")>();
    return {
        ...native,
        spawnSync: ((command: string, args: string[], options: object) => {
            if (command !== "docker") return native.spawnSync(command, args, options);
            fixture.executions.push([...args]);
            if (args.join(" ") === "exec pinned-test-container sh -c id -u") {
                return { status: 0, stdout: "2001\n", stderr: "" };
            }
            if (args.slice(0, 6).join(" ") !== "exec --user root pinned-test-container sh -c") {
                throw new Error("unexpected fixture runtime operation");
            }
            if (fixture.failRepair) return { status: 1, stdout: "", stderr: "fixture repair refused" };
            const script = args[6];
            // Only the runtime mount is simulated. The generated ACL script,
            // descriptor walk, host EACCES, config lock and MCP writer are real.
            if (!script.includes("/home/ccc/.codex") || !fixture.configDir.startsWith(fixture.home + "/")) {
                throw new Error("ACL script/private mount boundary missing");
            }
            const privateScript = script.replaceAll("/home/ccc/.codex", fixture.configDir);
            if (privateScript.includes("/home/ccc/.codex")) throw new Error("unredirected credential path");
            return native.spawnSync("/bin/sh", ["-c", privateScript], options);
        }) as typeof native.spawnSync,
    };
});

let configFile: string;
let buildMcpConfig: typeof import("../mcp-forward.js").buildMcpConfig;
let restore: typeof import("../docker.js").restoreCodexConfigHostOwnership;
let getClaudeJsonFile: typeof import("../utils.js").getClaudeJsonFile;
const retained = 'model = "fixture-model"\n# retained user preferences\n[mcp_servers.user_owned]\ncommand = "fixture-user-server"\n';

beforeEach(async () => {
    vi.resetModules();
    fixture.home = fs.mkdtempSync(join(tmpdir(), "ccc-pr-codex-access-"));
    fixture.executions = [];
    fixture.failRepair = false;
    vi.stubEnv("container", "");
    vi.stubEnv("VITEST", "true");
    const utilities = await import("../utils.js");
    configFile = utilities.getCodexConfigFile();
    fixture.configDir = utilities.getCodexDir();
    getClaudeJsonFile = utilities.getClaudeJsonFile;
    fs.mkdirSync(fixture.configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(configFile, retained, { mode: 0o100 });
    ({ buildMcpConfig } = await import("../mcp-forward.js"));
    ({ restoreCodexConfigHostOwnership: restore } = await import("../docker.js"));
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(fixture.home, { recursive: true, force: true });
    fixture.home = "";
});

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("real host access repair through MCP generation", () => {
    it("repairs real EACCES before MCP writing and preserves shared access after the command", () => {
        expect(() => fs.accessSync(configFile, fs.constants.R_OK | fs.constants.W_OK)).toThrowError(expect.objectContaining({ code: "EACCES" }));
        const original = fs.statSync(configFile);
        expect(() => buildMcpConfig()).toThrow(/Unable to read Codex config/);
        expect(buildMcpConfig(undefined, () => restore("pinned-test-container"))).toEqual([]);
        const generated = fs.readFileSync(configFile, "utf8");
        expect(generated).toContain(retained.trim());
        expect(generated).toContain("[mcp_servers.chrome-devtools]");
        expect(generated).toContain("[mcp_servers.device-lab]");
        expect(fs.statSync(configFile)).toMatchObject({ uid: original.uid, gid: original.gid, ino: original.ino });
        expect(JSON.parse(fs.readFileSync(getClaudeJsonFile(), "utf8")).mcpServers).toHaveProperty("device-lab");
        expect(fixture.executions).toHaveLength(2);
        // Healthy post-command restoration does not perform needless effects.
        restore("pinned-test-container");
        expect(fixture.executions).toHaveLength(2);
        expect(fs.readFileSync(configFile, "utf8")).toBe(generated);
        // A command can replace permission bits; the same public restoration
        // path recovers actual denial without discarding generated/user bytes.
        fs.chmodSync(configFile, 0o100);
        expect(() => fs.accessSync(configFile, fs.constants.R_OK)).toThrowError(expect.objectContaining({ code: "EACCES" }));
        restore("pinned-test-container");
        expect(fixture.executions).toHaveLength(4);
        expect(fs.readFileSync(configFile, "utf8")).toBe(generated);
        expect(fs.statSync(configFile)).toMatchObject({ uid: original.uid, gid: original.gid, ino: original.ino });
        fs.accessSync(configFile, fs.constants.R_OK | fs.constants.W_OK);
        const native = readAclResult(configFile);
        expect(native).toContainEqual([2, 6, 2001]);
    });

    it("keeps denied user config and its metadata intact when native repair fails", () => {
        fixture.failRepair = true;
        const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const original = fs.statSync(configFile);
        expect(() => buildMcpConfig(undefined, () => restore("pinned-test-container"))).toThrow(/Unable to read Codex config/);
        expect(warning).toHaveBeenCalledOnce();
        expect(fs.statSync(configFile)).toMatchObject({ uid: original.uid, gid: original.gid, ino: original.ino, mode: original.mode });
        expect(fs.existsSync(getClaudeJsonFile())).toBe(false);
        expect(() => fs.accessSync(configFile, fs.constants.R_OK)).toThrowError(expect.objectContaining({ code: "EACCES" }));
        fs.chmodSync(configFile, 0o600);
        expect(fs.readFileSync(configFile, "utf8")).toBe(retained);
    });
});

import { spawnSync } from "child_process";
function readAclResult(file: string): number[][] {
    const result = spawnSync("python3", ["-c", 'import os,struct,json,sys; d=os.getxattr(sys.argv[1],"system.posix_acl_access"); print(json.dumps(list(struct.iter_unpack("<HHI",d[4:]))))', file], { encoding: "utf8", timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
}
