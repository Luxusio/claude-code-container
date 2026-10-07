import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const state = vi.hoisted(() => ({ home: "", homes: [] as string[], trace: [] as unknown[][], forbid: false, fail: "", partialWrite: false, error: {} as unknown }));
vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => {
    if (state.forbid) throw new Error("eager home resolution"); state.trace.push(["home"]); return state.homes.shift() ?? state.home;
} }));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const wrapped: Record<string, unknown> = { ...actual };
    for (const name of ["closeSync", "existsSync", "lstatSync", "mkdirSync", "openSync", "readdirSync", "readFileSync", "renameSync", "rmdirSync", "statSync", "unlinkSync", "writeFileSync"] as const) {
        wrapped[name] = (...args: unknown[]) => {
            if (state.forbid) throw new Error(`eager fs ${name}`);
            for (const value of args.slice(0, name === "renameSync" ? 2 : 1)) if (typeof value === "string") {
                const path = resolve(value), root = resolve(state.home); if (path !== root && !path.startsWith(root + sep)) throw new Error(`fixture fence ${name}`);
            }
            state.trace.push([name, ...args]);
            if (name === "writeFileSync" && state.partialWrite) {
                actual.writeFileSync(args[0] as string, String(args[1]).slice(0, 7), args[2] as import("node:fs").WriteFileOptions);
                throw state.error;
            }
            if (state.fail === name) throw state.error;
            return (actual[name] as (...values: unknown[]) => unknown)(...args);
        };
    }
    return wrapped;
});
const native = await vi.importActual<typeof import("node:fs")>("node:fs");
const facade = await import("../../home-layout.js");
let root: string;
beforeEach(() => { root = native.mkdtempSync(join(tmpdir(), "ccc-resolution-config-")); native.chmodSync(root, 0o700); state.home = root; state.homes = []; state.trace = []; state.fail = ""; state.partialWrite = false; state.error = { nativeFailure: true }; state.forbid = false; });
afterEach(() => { state.forbid = false; native.rmSync(root, { recursive: true, force: true }); });
const home = () => join(root, ".ccc");
const put = (path: string, text = "synthetic") => { native.mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 }); native.writeFileSync(path, text, { mode: 0o600 }); };
describe("actual home facade private native filesystem", () => {
    it("module construction observes neither home nor filesystem", async () => {
        vi.resetModules(); state.forbid = true; try { await expect(import("../../home-layout.js")).resolves.toBeDefined(); } finally { state.forbid = false; }
        expect(state.trace).toEqual([]);
    });
    it("retains exact native public arities and constants", () => {
        for (const name of ["cccHome", "profilesDir", "defaultProfileDir", "ensureDefaultProfileDir", "runDir", "locksDir", "clipboardFilesDir", "helperBinDir", "clipboardStateDir", "clipboardPortFile", "clipboardStartingLock", "configFile", "legacyRemoteConfigDir", "readCccConfig"] as const) expect(facade[name].length).toBe(0);
        for (const name of ["profileClaudeDir", "profileClaudeJsonFile", "profileCodexDir", "updateCccConfig", "normalizeProfile"] as const) expect(facade[name].length).toBe(1);
        expect(facade.DEFAULT_PROFILE_NAME).toBe("default"); expect(facade.DEFAULT_PROFILE_MARKER).toBe(".ccc-default-profile");
    });
    it("creates marker bytes and modes and never rewrites existing marker", () => {
        expect(facade.ensureDefaultProfileDir()).toBeUndefined(); const dir = join(home(), "profiles", "default"), marker = join(dir, facade.DEFAULT_PROFILE_MARKER);
        expect(native.readFileSync(marker, "utf8")).toBe(""); put(marker, "retain"); facade.ensureDefaultProfileDir(); expect(native.readFileSync(marker, "utf8")).toBe("retain");
        if (process.platform !== "win32") { expect(native.statSync(dir).mode & 0o777).toBe(0o700); expect(native.statSync(marker).mode & 0o777).toBe(0o600); }
    });
    it("preserves unmarked account provenance and switches marked entries independently", () => {
        put(join(home(), "codex", "synthetic.txt")); expect(facade.profileClaudeDir()).toBe(join(home(), "claude"));
        facade.ensureDefaultProfileDir(); expect(facade.profileCodexDir()).toBe(join(home(), "codex")); expect(facade.profileClaudeDir()).toBe(join(home(), "profiles", "default", "claude"));
        native.mkdirSync(join(home(), "profiles", "default", "codex")); expect(facade.profileCodexDir()).toBe(join(home(), "profiles", "default", "codex"));
    });
    it("lstat catches arbitrary failures while config exists faults escape", () => {
        state.fail = "lstatSync"; expect(facade.locksDir()).toBe(join(home(), "run", "locks")); state.fail = "existsSync";
        let caught: unknown; try { facade.readCccConfig(); } catch (value) { caught = value; } expect(caught).toBe(state.error);
    });
    it("uses dangling inode for path fallback but config existsSync sees an absent target", context => {
        native.mkdirSync(home()); const target = join(home(), "missing-target");
        try { native.symlinkSync(target, join(home(), "locks")); native.symlinkSync(target, join(home(), "config.json")); }
        catch (error) { if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip(); return; } throw error; }
        expect(facade.locksDir()).toBe(join(home(), "locks")); expect(facade.readCccConfig()).toEqual({});
    });
    it("writes pretty bytes with actual PID and native modes", () => {
        facade.updateCccConfig(config => { config.synthetic = "value"; }); const file = join(home(), "config.json"), temp = `${file}.${process.pid}.tmp`;
        expect(native.readFileSync(file, "utf8")).toBe('{\n  "synthetic": "value"\n}'); expect(native.existsSync(temp)).toBe(false); expect(facade.readCccConfig()).toEqual({ synthetic: "value" });
        expect(state.trace.find(([name]) => name === "writeFileSync")).toEqual(["writeFileSync", temp, '{\n  "synthetic": "value"\n}', { mode: 0o600 }]);
        if (process.platform !== "win32") { expect(native.statSync(home()).mode & 0o777).toBe(0o700); expect(native.statSync(file).mode & 0o777).toBe(0o600); }
    });
    it.each(["broken", "[]", "null"])("invalid native config %s is preserved", text => {
        const file = join(home(), "config.json"); put(file, text); expect(facade.readCccConfig()).toEqual({}); expect(() => facade.updateCccConfig(() => {})).toThrow(`${file} is not a valid JSON object; fix or remove it`); expect(native.readFileSync(file, "utf8")).toBe(text);
    });
    it("rename failure retains completed temp bytes and original file", () => {
        const file = join(home(), "config.json"); put(file, '{"old":true}'); state.fail = "renameSync";
        let caught: unknown; try { facade.updateCccConfig(config => { config.new = true; }); } catch (value) { caught = value; }
        expect(caught).toBe(state.error); expect(native.readFileSync(file, "utf8")).toBe('{"old":true}'); expect(native.readFileSync(`${file}.${process.pid}.tmp`, "utf8")).toBe('{\n  "old": true,\n  "new": true\n}');
    });
    it("partial native write failure leaves its bytes and does not rescue or rename", () => {
        const file = join(home(), "config.json"), temp = `${file}.${process.pid}.tmp`; put(file, '{"old":true}'); state.partialWrite = true;
        let caught: unknown; try { facade.updateCccConfig(config => { config.new = true; }); } catch (value) { caught = value; }
        expect(caught).toBe(state.error); expect(native.readFileSync(temp, "utf8")).toBe('{\n  "ol'); expect(native.readFileSync(file, "utf8")).toBe('{"old":true}'); expect(state.trace.some(([name]) => name === "renameSync" || name === "unlinkSync")).toBe(false);
    });
    it("undefined serialization reaches native write rejection and preserves original", () => {
        const file = join(home(), "config.json"); put(file, "{}"); expect(() => facade.updateCccConfig(config => { config.toJSON = () => undefined; })).toThrow(TypeError); expect(native.readFileSync(file, "utf8")).toBe("{}"); expect(state.trace.some(([name]) => name === "renameSync")).toBe(false);
    });
    it("retains old migration no-home behavior without creating storage", () => { expect(facade.migrateHomeLayout({ hasLiveSessions: () => false })).toEqual({ status: "not-needed" }); expect(native.existsSync(home())).toBe(false); });
});
