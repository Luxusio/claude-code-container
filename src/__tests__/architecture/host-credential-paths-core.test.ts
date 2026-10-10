import { describe, expect, it } from "vitest";
import { createHostCredentialPaths } from "../../application/credentials/host-paths.js";
import type { HostCredentialPathPorts, CredentialDirectoryOptions } from "../../ports/credentials/host-paths.js";
import type { CredentialMount } from "../../domain/tool-registry.js";

const packages = "/home/ccc/.codex/packages";
function fixture() {
    const trace: unknown[][] = [];
    const state = { container: undefined as string | undefined, vitest: undefined as string | undefined, fault: "", error: {} };
    const call = <T>(name: string, result: T, ...args: unknown[]): T => {
        trace.push([name, ...args]);
        if (state.fault === name) throw state.error;
        return result;
    };
    const ports: HostCredentialPathPorts = {
        readContainerEnvironment: () => call("container", state.container),
        readVitestEnvironment: () => call("vitest", state.vitest),
        claudeProfilePath: profile => call("claude", "claude-result", profile),
        codexProfilePath: profile => call("codex", "codex-result", profile),
        homeDirectory: () => call("home", "/host"),
        joinHostPath: (base, relative) => call("join", `${base}/${relative}`, base, relative),
        createDirectory: (path, options) => call("mkdir", undefined, path, options),
        packageParentPath: path => call("parent", "/home/ccc/.codex", path),
        packageBasename: path => call("basename", "packages", path),
    };
    const api = createHostCredentialPaths(ports, packages);
    const mount = (values: string[], host = ".other"): CredentialMount => ({
        get containerDir() { const value = values.length > 1 ? values.shift() : values[0]; trace.push(["mount", value]); if (state.fault === "mount") throw state.error; if (!value) throw new Error("unexpected extra mount read"); return value; },
        get hostDir() { return call("hostDir", host); },
    });
    return { trace, state, ports, api, mount };
}
describe("complete host credential operations", () => {
    it("constructs without observing any port or mount and exposes exactly two operations", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        expect(Object.keys(f.api).sort()).toEqual(["ensureCredentialHostDir", "resolveCredentialHostPath"]);
    });
    it.each([undefined, "", "0", "false"])("uses single VITEST truthiness: %s", vitest => {
        const f = fixture(); f.state.container = "docker"; f.state.vitest = vitest;
        const values = vitest ? ["other", "other"] : ["mounted"];
        expect(f.api.resolveCredentialHostPath(f.mount(values))).toBe(vitest ? "/host/.other" : "mounted");
        expect(f.trace.slice(0, 2)).toEqual([["container"], ["vitest"]]);
    });
    it("resolves non-profile mounts outside Docker", () => {
        const f = fixture(); expect(f.api.resolveCredentialHostPath(f.mount(["one"]))).toBe("/host/.other");
    });
    it.each(["default", " work ", "work"])("resolves credential profiles %s", profile => {
        const f = fixture();
        expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.codex"]), profile)).toBe("codex-result");
        f.trace.length = 0;
        expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.claude"]), profile)).toBe("claude-result");
    });
    it("reads live environments on subsequent calls", () => {
        const f = fixture(); f.state.container = "docker";
        expect(f.api.resolveCredentialHostPath(f.mount(["mounted"]))).toBe("mounted");
        f.state.vitest = "1";
        expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.claude"]))).toBe("claude-result");
    });
    it("creates private credential directories", () => {
        const f = fixture();
        expect(f.api.ensureCredentialHostDir(f.mount(["/home/ccc/.codex"]), "work")).toBe("codex-result");
        expect(f.trace.filter(row => row[0] === "mkdir")).toEqual([["mkdir", "codex-result", { recursive: true, mode: 0o700 }], ["mkdir", "codex-result/packages", { recursive: true, mode: 0o700 }]]);
    });
    it("uses sparse default mkdir options and skips basename/join on parent mismatch", () => {
        const f = fixture(); f.api.ensureCredentialHostDir(f.mount(["x", "x", "x", "x", "x"]), "work");
        expect(f.trace.filter(row => row[0] === "mkdir")).toEqual([["mkdir", "/host/.other", { recursive: true }]]);
        expect(f.trace.some(row => row[0] === "basename")).toBe(false);
    });
    it.each(["container", "vitest", "mount", "claude", "codex", "home", "hostDir", "join", "mkdir", "parent", "basename"])("propagates %s identity and stops immediately", fault => {
        const f = fixture(); f.state.fault = fault; f.state.container = "docker"; f.state.vitest = "1";
        const path = fault === "claude" ? "/home/ccc/.claude" : ["codex", "basename", "parent", "mkdir"].includes(fault) ? "/home/ccc/.codex" : "other";
        let caught: unknown;
        try { f.api.ensureCredentialHostDir(f.mount(Array(10).fill(path))); } catch (error) { caught = error; }
        expect(caught).toBe(f.state.error);
        expect(f.trace.at(-1)?.[0]).toBe(fault);
    });
    it("nested mkdir failure preserves successful root and performs no subsequent effects", () => {
        const f = fixture(); const made: string[] = []; const sentinel = {};
        const ports = { ...f.ports, createDirectory: (path: string, options: CredentialDirectoryOptions): undefined => { f.trace.push(["mkdir", path, options]); if (made.length) throw sentinel; made.push(path); return undefined; } };
        const api = createHostCredentialPaths(ports, packages); let caught: unknown;
        try { api.ensureCredentialHostDir(f.mount(Array(5).fill("/home/ccc/.codex")), "work"); } catch (error) { caught = error; }
        expect(caught).toBe(sentinel); expect(made).toEqual(["codex-result"]);
        expect(f.trace.at(-1)).toEqual(["mkdir", "codex-result/packages", { recursive: true, mode: 0o700 }]);
    });

    it("rejects each missing callable without observing any remaining callback", () => {
        const f = fixture();
        for (const name of Object.keys(f.ports)) {
            const ports = { ...f.ports, [name]: undefined } as unknown as HostCredentialPathPorts;
            expect(() => createHostCredentialPaths(ports, packages)).toThrow();
        }
        expect(f.trace).toEqual([]);
    });
});
