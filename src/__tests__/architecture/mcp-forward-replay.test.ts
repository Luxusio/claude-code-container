import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ documents: new Map<string, string>(), events: [] as unknown[], failures: new Map<string, unknown>(), locked: false }));
function effect(name: string, ...args: unknown[]) { f.events.push([name, ...args]); if (f.failures.has(name)) throw f.failures.get(name); }
const native = {
    existsSync(path: string) { effect(`exists:${path}`); return f.documents.has(path); },
    mkdirSync(path: string, options: unknown) { effect(`mkdir:${path}`, options); },
    readFileSync(path: string, encoding: string) { effect(`read:${path}`, encoding); return f.documents.get(path); },
    writeFileSync(path: string, text: string, options: unknown) { effect(`write:${path}`, text, options); f.documents.set(path, text); },
};
vi.mock("fs", () => ({ existsSync: (p: string) => native.existsSync(p), mkdirSync: (p: string, o: unknown) => native.mkdirSync(p, o), readFileSync: (p: string, e: string) => native.readFileSync(p, e), writeFileSync: (p: string, t: string, o: unknown) => native.writeFileSync(p, t, o) }));
vi.mock("os", () => ({ homedir: () => "/fixture" }));
const paths = { getClaudeJsonFile: (profile?: string) => { effect("resolve-claude", profile); return "/fixture/profile/claude.json"; }, getCodexConfigFile: (profile?: string) => { effect("resolve-codex", profile); return "/fixture/profile/codex/config.toml"; } };
const lock = { withCodexConfigLock<T>(operation: () => T, profile?: string): T { effect("lock", profile); f.locked = true; try { return operation(); } finally { f.locked = false; effect("unlock"); } } };
vi.mock("../../utils.js", () => ({ getClaudeJsonFile: (p?: string) => paths.getClaudeJsonFile(p), getCodexConfigFile: (p?: string) => paths.getCodexConfigFile(p) }));
vi.mock("../../codex-config-lock.js", () => ({ withCodexConfigLock: <T>(op: () => T, p?: string) => lock.withCodexConfigLock(op, p) }));

type Public = typeof import("../../mcp-forward.js");
const frozenSource = execFileSync("git", ["show", "39947369b0d9dee83d085d93853e2c2306f2107e:src/mcp-forward.ts"], { encoding: "utf8" });
function baseline(): Public {
    const javascript = ts.transpileModule(frozenSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    new Function("require", "exports", javascript)((name: string) => {
        if (name === "fs") return native;
        if (name === "os") return { homedir: () => "/fixture" };
        if (name === "path") return { dirname, join };
        if (name === "./utils.js") return paths;
        if (name === "./codex-config-lock.js") return lock;
        throw new Error(`Unexpected frozen import ${name}`);
    }, exports);
    return exports as Public;
}
const claudePath = "/fixture/profile/claude.json";
const codexPath = "/fixture/profile/codex/config.toml";
function observe(api: Public, claude: string | undefined, host: string | undefined, codex = "", failure?: [string, unknown]) {
    f.documents = new Map([[codexPath, codex]]); if (claude !== undefined) f.documents.set(claudePath, claude); if (host !== undefined) f.documents.set("/fixture/.claude.json", host);
    f.events = []; f.failures = new Map(failure ? [failure] : []); f.locked = false;
    let result: unknown; let error: unknown; let receiver: unknown = "not-called";
    try { result = api.buildMcpConfig("work", function (this: unknown) { receiver = this; effect("restore", f.locked); }); } catch (cause) { error = cause; }
    return { result, error: error instanceof Error ? [error.constructor.name, error.message] : error, receiver, events: [...f.events], documents: [...f.documents] };
}

describe("actual immutable facade replay", () => {
    let old: Public; let candidate: Public;
    beforeEach(async () => { vi.resetModules(); old = baseline(); candidate = await import("../../mcp-forward.js"); });
    it.each(["claude-replacement", "host-replacement", "claude-getter-throw", "host-getter-throw"])("pairs parser selection before native read: %s", mode => {
        function witness(api: Public) {
            const originalDescriptor = Object.getOwnPropertyDescriptor(JSON, "parse")!;
            const originalParse = JSON.parse; const originalRead = native.readFileSync;
            const raw = {mode}; const calls: unknown[] = []; let selection = 0;
            const selected = function (this: unknown, text: string) { calls.push(["parse", this === JSON]); return originalParse(text); };
            let parser: typeof JSON.parse = selected;
            Object.defineProperty(JSON, "parse", {configurable: true, get() {
                const phase = selection++ === 0 ? "claude" : "host"; calls.push(["select", phase]);
                if (mode === `${phase}-getter-throw`) throw raw;
                return parser;
            }});
            native.readFileSync = (path, encoding) => {
                calls.push(["read", path]);
                if ((mode === "claude-replacement" && path === claudePath) || (mode === "host-replacement" && path === "/fixture/.claude.json")) {
                    parser = function (this: unknown) { calls.push(["replacement", this === JSON]); return {mcpServers: {replacement: {command: "replacement"}}}; };
                }
                return originalRead(path, encoding);
            };
            try { return {observation: observe(api, '{"theme":"dark"}', '{"mcpServers":{"original":{"command":"node"}}}'), calls}; }
            finally { Object.defineProperty(JSON, "parse", originalDescriptor); native.readFileSync = originalRead; }
        }
        expect(witness(candidate)).toEqual(witness(old));
    });
    it.each([undefined, "{broken", "[]", "null", "1", "true", '"string"', '{"theme":"dark"}'])("pairs complete byte/order/error behavior for Claude %s", claude => {
        const host = JSON.stringify({ mcpServers: { remote: { url: "http://localhost:8?q=1", env: { Z: "last", A: "first" }, unknown: 3, unsupported: null }, "with.dot": { command: "node", args: ["x"], beta: false, alpha: "a" }, lab: {}, retired: { command: "/opt/ccc/dist/x11-mcp/server.mjs" } } });
        expect(observe(candidate, claude, host)).toEqual(observe(old, claude, host));
    });
    it.each([undefined, "{bad", "null", "1", '{"mcpServers":[]}', '{"mcpServers":{"unknown":42}}', '{"mcpServers":{"unknown":null}}'])("pairs permissive host entries and raw failures: %s", host => {
        expect(observe(candidate, undefined, host)).toEqual(observe(old, undefined, host));
    });
    it.each([
        'model = "user"\n[mcp_servers.keep]\ncommand = "custom"\n',
        '[mcp_servers.alias.env]\nK = "keep?"\n[mcp_servers.alias]\nargs = ["/opt/ccc/dist/x11-mcp/server.mjs"]\n[other]\nx = 1\n',
        'description = """\n[mcp_servers.chrome-devtools]\n# ccc-managed-mcp begin\n"""\n[mcp_servers."keep.dot"]\ncommand = "safe"\n',
        '[mcp_servers.retired]\ncommand = "\\u002fopt/ccc/x11-mcp/server.mjs"\n[mcp_servers.safe.env]\ncommand = "/opt/ccc/x11-mcp/server.mjs"\n',
        '# ccc-managed-mcp begin\nstale = true\n# ccc-managed-mcp end\nmodel = "remaining"\n',
        '# ccc-managed-mcp begin\nmodel = "unpaired"\n',
    ])("pairs TOML scanner preservation and actual second-regeneration bytes", text => {
        const first = observe(old, undefined, undefined, text);
        expect(observe(candidate, undefined, undefined, text)).toEqual(first);
        const next = new Map(first.documents).get(codexPath)!;
        const expectedSecond = observe(old, undefined, undefined, next);
        const second = observe(candidate, undefined, undefined, next);
        expect(second).toEqual(expectedSecond);
        const unpaired = text === '# ccc-managed-mcp begin\nmodel = "unpaired"\n';
        expect(second.events.some(e => (e as string[])[0] === `write:${codexPath}`)).toBe(unpaired);
        if (unpaired) {
            expect(new Map(expectedSecond.documents).get(codexPath)).not.toBe(next);
            expect(new Map(second.documents).get(codexPath)).not.toContain('model = "unpaired"');
        } else {
            expect(new Map(second.documents).get(codexPath)).toBe(next);
        }
        expect(second.events.some(e => (e as string[])[0] === `write:${claudePath}`)).toBe(true);
    });
    it.each(["resolve-claude", `exists:${claudePath}`, `read:${claudePath}`, "exists:/fixture/.claude.json", "read:/fixture/.claude.json", "lock", "restore", "resolve-codex", "mkdir:/fixture/profile/codex", `exists:${codexPath}`, `read:${codexPath}`, `write:${codexPath}`, `write:${claudePath}`])("pairs native failure precedence and survivors at %s", point => {
        for (const cause of [Object.assign(new Error("denied"), { code: "EACCES" }), Object.assign(new Error("denied"), { code: "EPERM" }), "raw-fault"]) {
            const args = ['{"theme":"dark"}', '{"mcpServers":{"ok":{"command":"node"}}}', "model = \"old\"\n", [point, cause] as [string, unknown]] as const;
            expect(observe(candidate, ...args)).toEqual(observe(old, ...args));
        }
    });
    it("pairs URL getter reads, clone receiver and shared shallow references", () => {
        function witness(api: Public) {
            const reads: unknown[] = []; const args = ["shared"]; const server = { args, get url() { reads.push(this); return "http://127.0.0.1:9"; } };
            const result = api.processServerForContainer("x", server);
            return { count: reads.length, receivers: reads.every(value => value === server), shared: result.args === args, clone: result !== server, result };
        }
        expect(witness(candidate)).toEqual(witness(old));
    });
    it.each(["http://localhost", "http://localhost.evil", "//127.0.0.1#x", "http://LOCALHOST:8", "localhost:8", "http://localhost?x=http://127.0.0.1/"])("pairs exact URL rewrite %s", url => {
        expect(candidate.rewriteLocalhostUrl(url)).toBe(old.rewriteLocalhostUrl(url));
    });
});
