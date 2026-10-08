import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ home: "", faults: new Map<string, unknown>(), writes: [] as string[] }));
vi.mock("os", async original => ({ ...await original<typeof import("os")>(), homedir: () => f.home }));
vi.mock("fs", async original => {
    const actual = await original<typeof import("fs")>();
    function fail(name: string, path: unknown) { const key = `${name}:${String(path)}`; if (f.faults.has(key)) throw f.faults.get(key); }
    return { ...actual,
        existsSync: (path: import("fs").PathLike) => { fail("exists", path); return actual.existsSync(path); },
        mkdirSync: ((path: import("fs").PathLike, options: import("fs").MakeDirectoryOptions) => { fail("mkdir", path); return actual.mkdirSync(path, options); }) as typeof actual.mkdirSync,
        readFileSync: ((path: import("fs").PathOrFileDescriptor, options: unknown) => { fail("read", path); return actual.readFileSync(path, options as BufferEncoding); }) as typeof actual.readFileSync,
        writeFileSync: ((path: import("fs").PathOrFileDescriptor, data: string, options: unknown) => { fail("write", path); f.writes.push(String(path)); return actual.writeFileSync(path, data, options as import("fs").WriteFileOptions); }) as typeof actual.writeFileSync,
    };
});

let api: typeof import("../../mcp-forward.js");
let utils: typeof import("../../utils.js");
let layout: typeof import("../../home-layout.js");
beforeEach(async () => {
    f.home = mkdtempSync(join(tmpdir(), "ccc-mcp-native-")); f.faults.clear(); f.writes = [];
    vi.stubEnv("container", ""); vi.resetModules();
    api = await import("../../mcp-forward.js"); utils = await import("../../utils.js"); layout = await import("../../home-layout.js");
});
afterEach(() => { rmSync(f.home, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function prepare(profile?: string) {
    const claude = utils.getClaudeJsonFile(profile); const codex = utils.getCodexConfigFile(profile);
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(join(f.home, ".claude.json"), '{"mcpServers":{"host":{"url":"http://localhost:9"}}}');
    return { claude, codex };
}
function lockPath(profile?: string) {
    return profile ? join(layout.locksDir(), `codex-config-${createHash("sha256").update(utils.getCodexConfigFile(profile)).digest("hex")}.lock`) : join(layout.cccHome(), "codex-config.lock");
}

describe("private native facade, real lock and direct filesystem publication", () => {
    it.each([undefined, "work"])("publishes both consumers under profile %s and invokes restore within the actual fence", profile => {
        const { claude, codex } = prepare(profile);
        let receiver: unknown = "not called";
        expect(api.buildMcpConfig(profile, function (this: unknown) { receiver = this; expect(existsSync(lockPath(profile))).toBe(true); expect(existsSync(codex)).toBe(false); })).toEqual(["host"]);
        expect(receiver).toBeUndefined(); expect(existsSync(lockPath(profile))).toBe(false);
        expect(statSync(claude).mode & 0o777).toBe(0o600); expect(statSync(codex).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(claude, "utf8")).mcpServers.host.url).toBe("http://host.docker.internal:9");
        expect(readFileSync(codex, "utf8")).toContain('url = "http://host.docker.internal:9"');
        expect(f.writes.filter(path => path === claude || path === codex)).toEqual([codex, claude]);
        const inode = statSync(codex).ino; f.writes = []; api.buildMcpConfig(profile);
        expect(statSync(codex).ino).toBe(inode); expect(f.writes).not.toContain(codex); expect(f.writes).toContain(claude);
    });
    it("direct writes retain existing inode and mode and follow symlinks", () => {
        const { claude, codex } = prepare("linked"); mkdirSync(dirname(codex), { recursive: true });
        const codexTarget = join(f.home, "codex-target"); const claudeTarget = join(f.home, "claude-target");
        writeFileSync(codexTarget, 'model = "keep"\n'); writeFileSync(claudeTarget, '{"theme":"keep"}');
        chmodSync(codexTarget, 0o640); chmodSync(claudeTarget, 0o644);
        symlinkSync(codexTarget, codex); symlinkSync(claudeTarget, claude);
        const codexInode = statSync(codexTarget).ino; const claudeInode = statSync(claudeTarget).ino;
        api.buildMcpConfig("linked");
        expect(lstatSync(codex).isSymbolicLink()).toBe(true); expect(lstatSync(claude).isSymbolicLink()).toBe(true);
        expect(statSync(codexTarget).ino).toBe(codexInode); expect(statSync(claudeTarget).ino).toBe(claudeInode);
        expect(statSync(codexTarget).mode & 0o777).toBe(0o640); expect(statSync(claudeTarget).mode & 0o777).toBe(0o644);
        expect(readFileSync(codexTarget, "utf8")).toContain('model = "keep"'); expect(JSON.parse(readFileSync(claudeTarget, "utf8")).theme).toBe("keep");
    });
    it("refuses exact container marker with no Codex publication or restoration", () => {
        const { claude, codex } = prepare(); vi.stubEnv("container", "docker"); const restore = vi.fn();
        expect(() => api.buildMcpConfig(undefined, restore)).toThrow("host configuration lock is unavailable");
        expect(restore).not.toHaveBeenCalled(); expect(existsSync(codex)).toBe(false); expect(existsSync(claude)).toBe(false);
    });
    it.each(["null", "1", "true", '"text"'])("keeps Codex bytes after valid Claude scalar %s fails", value => {
        const { claude, codex } = prepare(); writeFileSync(claude, value);
        expect(() => api.buildMcpConfig()).toThrow(TypeError);
        expect(readFileSync(codex, "utf8")).toContain("# ccc-managed-mcp end"); expect(readFileSync(claude, "utf8")).toBe(value);
        expect(existsSync(lockPath())).toBe(false);
    });
    it("preserves successful Codex bytes and raw Claude write failure", () => {
        const { claude, codex } = prepare(); const cause = { code: "EACCES", detail: "Claude" }; f.faults.set(`write:${claude}`, cause);
        let thrown: unknown; try { api.buildMcpConfig(); } catch (error) { thrown = error; }
        expect(thrown).toBe(cause); expect(readFileSync(codex, "utf8")).toContain("# ccc-managed-mcp end"); expect(existsSync(claude)).toBe(false);
    });
    it.each(["EACCES", "EPERM", "EIO"])("retains contextual Codex write error and permission-only hint for %s", code => {
        const { claude, codex } = prepare(); f.faults.set(`write:${codex}`, Object.assign(new Error("fixture denied"), { code }));
        let message = ""; try { api.buildMcpConfig(); } catch (error) { message = (error as Error).message; }
        expect(message).toContain(`Unable to write Codex config at ${codex}: fixture denied.`);
        expect(message.includes("sudo chown")).toBe(code !== "EIO"); expect(existsSync(claude)).toBe(false); expect(existsSync(lockPath())).toBe(false);
    });
    it("keeps host existence outside ignored read catch", () => {
        prepare(); const host = join(f.home, ".claude.json"); const cause = Symbol("exists"); f.faults.set(`exists:${host}`, cause);
        let thrown: unknown; try { api.readHostMcpServers(); } catch (error) { thrown = error; } expect(thrown).toBe(cause);
        f.faults.clear(); f.faults.set(`read:${host}`, cause); expect(api.readHostMcpServers()).toEqual({});
    });
});
