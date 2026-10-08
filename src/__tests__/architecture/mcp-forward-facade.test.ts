import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
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
    it.each(["normal", "mutating", "serialization-throw", "selected-writer-throw"])("pairs actual builtin writer selection before serialization: %s", mode => {
        const root = fileURLToPath(new URL("../../../", import.meta.url));
        const baseline = execFileSync("git", ["show", "39947369b0d9dee83d085d93853e2c2306f2107e:src/mcp-forward.ts"], {cwd: root, encoding: "utf8"});
        const original = ts.transpileModule(baseline, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText
            .replace('"./utils.js"', JSON.stringify(pathToFileURL(join(root, "dist/utils.js")).href))
            .replace('"./codex-config-lock.js"', JSON.stringify(pathToFileURL(join(root, "dist/codex-config-lock.js")).href));
        const baselineFile = join(f.home, "frozen-facade.mjs"); writeFileSync(baselineFile, original);
        const script = join(f.home, "serialized-writer.mjs");
        writeFileSync(script, `
import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
import cp from 'node:child_process'; import {syncBuiltinESMExports as synchronize} from 'node:module';
const mode=process.argv[3],events=[],nativeWrite=fs.writeFileSync,nativeStringify=JSON.stringify;
const raw={fault:mode};const profile=path.join(process.env.HOME,'.ccc/profiles/default');fs.mkdirSync(profile,{recursive:true});
nativeWrite(path.join(profile,'claude.json'),'{}');fs.mkdirSync(path.join(profile,'codex'),{recursive:true});nativeWrite(path.join(profile,'codex/config.toml'),'model = "keep"\\n');
cp.spawnSync=()=>{throw Error('External process denied')};cp.spawn=()=>{throw Error('External process denied')};
fs.writeFileSync=function(file,text,options){if(String(file).endsWith('/claude.json')||String(file).endsWith('/config.toml'))events.push(['selected',path.relative(process.env.HOME,String(file)),options]);if(mode==='selected-writer-throw'&&String(file).endsWith('/claude.json'))throw raw;return nativeWrite(file,text,options)};
syncBuiltinESMExports();const api=await import(process.argv[2]);
JSON.stringify=function(value,...args){if(value&&typeof value==='object'&&Object.hasOwn(value,'mcpServers')){events.push('serialize');if(mode!=='normal'){fs.writeFileSync=function(){events.push('alternate');throw Error('Alternate writer must not be called')};synchronize()}if(mode==='serialization-throw')throw raw}return nativeStringify(value,...args)};
let result,error;try{result=api.buildMcpConfig()}catch(caught){error=caught===raw?'raw-error':String(caught)}finally{JSON.stringify=nativeStringify;fs.writeFileSync=nativeWrite;syncBuiltinESMExports()}
const documents={claude:fs.readFileSync(path.join(profile,'claude.json'),'utf8'),codex:fs.readFileSync(path.join(profile,'codex/config.toml'),'utf8')};console.log(nativeStringify({result,error,events,documents}));
`);
        function execute(entry: string, variant: string) {
            const home = join(f.home, `${mode}-${variant}`); mkdirSync(home);
            const result = spawnSync(process.execPath, [script, pathToFileURL(entry).href, mode], {env: {...process.env, HOME: home, USERPROFILE: home, container: ""}, cwd: home, encoding: "utf8", timeout: 20000});
            expect(result.status, result.stderr).toBe(0);
            return JSON.parse(result.stdout.trim());
        }
        const expected = execute(baselineFile, "baseline");
        expect(execute(join(root, "dist/mcp-forward.js"), "candidate")).toEqual(expected);
        expect(expected.events).not.toContain("alternate"); expect(expected.documents.codex).toContain("# ccc-managed-mcp end");
        if (mode === "serialization-throw" || mode === "selected-writer-throw") { expect(expected.error).toBe("raw-error"); expect(expected.documents.claude).toBe("{}"); }
    }, 30000);
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
