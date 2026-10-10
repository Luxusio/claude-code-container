import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpSmoke, validatePackageLayout } from "../../scripts/test-workspace-packages.mjs";

const roots: string[] = [];
function packageFixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc-package-smoke-test-"));
    roots.push(root);
    const file = (relative: string, contents = "fixture\n") => {
        const target = join(root, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
    };
    const manifest = { name: "claude-code-container", type: "module", version: "1.0.0", bin: { ccc: "dist/index.js" } };
    file("package.json", JSON.stringify(manifest));
    for (const name of ["dist/index.js", "dist/device-lab-mcp/server.mjs", "scripts/install.js",
        "scripts/build-distribution-image.mjs", "Dockerfile", "Containerfile"]) file(name);
    file("Dockerfile.distribution", "FROM scratch\n");
    for (const name of ["device-lab", "hyper-v"]) {
        file(`dist/packages/${name}/package.json`, JSON.stringify({
            name: `@ccc/${name}`, version: manifest.version, type: "module", exports: { ".": "./dist/index.js" },
        }));
        file(`dist/packages/${name}/dist/index.js`, "export {};\n");
        file(`dist/packages/${name}/powershell/fixture.ps1`);
    }
    file("dist/packages/device-lab/providers/fixture.mjs", "export {};\n");
    for (const name of ["package.json", "package-lock.json", "server.mjs"]) {
        file(`dist/packages/device-lab/appium-runtime/${name}`, name.endsWith(".json") ? "{}" : "export {};\n");
    }
    return { root, file, manifest };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("current package layout", () => {
    it("accepts a complete package with embedded exports and native assets", () => {
        const fixture = packageFixture();
        expect(validatePackageLayout(fixture.root)).toEqual(fixture.manifest);
    });
    it.each(["package.json", "dist/packages/device-lab/package.json", "dist/packages/hyper-v/package.json"])(
        "rejects missing manifest %s", relative => {
            const fixture = packageFixture();
            rmSync(join(fixture.root, relative));
            expect(() => validatePackageLayout(fixture.root)).toThrow();
        },
    );
    it.each(["dist/index.js", "dist/packages/device-lab/dist/index.js", "dist/packages/hyper-v/dist/index.js"])(
        "rejects missing public entry %s", relative => {
            const fixture = packageFixture();
            rmSync(join(fixture.root, relative));
            expect(() => validatePackageLayout(fixture.root)).toThrow();
        },
    );
    it.each(["dist/packages/hyper-v/powershell", "dist/packages/device-lab/appium-runtime/server.mjs"])(
        "rejects missing native asset %s", relative => {
            const fixture = packageFixture();
            rmSync(join(fixture.root, relative), { recursive: true });
            expect(() => validatePackageLayout(fixture.root)).toThrow();
        },
    );
    it("rejects a recipe referring to an absent distribution source", () => {
        const fixture = packageFixture();
        fixture.file("Dockerfile.distribution", "FROM scratch\nCOPY missing-asset /app/\n");
        expect(() => validatePackageLayout(fixture.root)).toThrow();
    });
    it("rejects a root executable targeting a missing file", () => {
        const fixture = packageFixture();
        fixture.file("package.json", JSON.stringify({ ...fixture.manifest, bin: { ccc: "dist/missing-cli.js" } }));
        expect(() => validatePackageLayout(fixture.root)).toThrow();
    });
    it("rejects an embedded package without public exports", () => {
        const fixture = packageFixture();
        fixture.file("dist/packages/device-lab/package.json", JSON.stringify({ name: "@ccc/device-lab", version: "1.0.0", type: "module" }));
        expect(() => validatePackageLayout(fixture.root)).toThrow();
    });
});

function mcpFixture(mode: "success" | "invalid-json" | "null-response" | "rpc-error" | "exit" | "timeout" | "eof-exit" | "ignore-eof" | "partial-json") {
    const fixture = packageFixture();
    const pidFile = join(fixture.root, "child.pid"), homeFile = join(fixture.root, "child.home");
    const requestsFile = join(fixture.root, "requests.jsonl");
    fixture.file("dist/device-lab-mcp/server.mjs", `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(homeFile)}, process.env.HOME);
const finish = () => process.exit(0);
const deadline = setTimeout(finish, 8000);
process.on('SIGTERM', finish);
const mode = ${JSON.stringify(mode)};
if (mode === 'ignore-eof') setInterval(() => {}, 1000);
const input = createInterface({ input: process.stdin });
input.on('close', () => {
    if (mode === 'ignore-eof') return;
    clearTimeout(deadline);
    if (mode === 'eof-exit') process.exit(7);
    if (mode === 'partial-json') { process.stdout.write('{"jsonrpc":', finish); return; }
    finish();
});
input.on('line', line => {
    const request = JSON.parse(line);
    appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(request) + '\\n');
    if (request.id === undefined) return;
    if (mode === 'timeout') return;
    if (mode === 'exit') { process.exit(7); }
    if (mode === 'invalid-json') { process.stdout.write('invalid JSON\\n'); return; }
    if (mode === 'null-response') { process.stdout.write('null\\n'); return; }
    if (mode === 'rpc-error') { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'fixture failure'}})+'\\n'); return; }
    const result = request.method === 'initialize'
        ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'device-lab-mcp',version:'1.0.0'}}
        : request.method === 'tools/list'
        ? {tools:[{name:'screenshot',inputSchema:{type:'object'}},{name:'create_windows_vm',inputSchema:{type:'object'}}]}
        : {};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`);
    return { ...fixture, pidFile, homeFile, requestsFile };
}

function expectChildJoined(pidFile: string) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
}

describe("real MCP stdio smoke", () => {
    it("initializes, lists tools and pings, then closes the child", async () => {
        const fixture = mcpFixture("success");
        const result = await mcpSmoke(fixture.root, { timeoutMs: 3000 });
        expect(result.initialized.serverInfo.name).toBe("device-lab-mcp");
        expect(result.listed.tools.map((tool: { name: string }) => tool.name)).toEqual(["screenshot", "create_windows_vm"]);
        const requests = readFileSync(fixture.requestsFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(requests.map(request => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "ping"]);
        expect(existsSync(readFileSync(fixture.homeFile, "utf8"))).toBe(false);
        expectChildJoined(fixture.pidFile);
    });
    it.each([
        ["invalid-json", /invalid JSON/i], ["null-response", /invalid.*response|protocol|object/i],
        ["rpc-error", /RPC|fixture failure|32603/i],
        ["exit", /exited|closed|exit/i], ["timeout", /timeout|timed out/i],
    ] as const)("rejects %s and joins the child", async (mode, error) => {
        const fixture = mcpFixture(mode);
        await expect(mcpSmoke(fixture.root, { timeoutMs: mode === "timeout" ? 1000 : 3000 })).rejects.toThrow(error);
        expectChildJoined(fixture.pidFile);
    });
    it.each([
        ["eof-exit", /7|non.?zero|exit|closed/i],
        ["ignore-eof", /timeout|timed out|close/i],
        ["partial-json", /unterminated JSON/i],
    ] as const)("rejects %s after a complete handshake and joins the child", async (mode, error) => {
        const fixture = mcpFixture(mode);
        await expect(mcpSmoke(fixture.root, { timeoutMs: 1000 })).rejects.toThrow(error);
        const requests = readFileSync(fixture.requestsFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(requests.map(request => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "ping"]);
        expectChildJoined(fixture.pidFile);
    });
});
