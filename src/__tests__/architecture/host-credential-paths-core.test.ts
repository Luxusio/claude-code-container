import { describe, expect, it } from "vitest";
import { createHostCredentialPaths } from "../../application/credentials/host-paths.js";
import type { HostCredentialPathPorts, CredentialDirectoryOptions } from "../../ports/credentials/host-paths.js";
import type { CredentialMount } from "../../domain/tool-registry.js";

const packages = "/home/ccc/.codex/packages";
function fixture() {
    const trace: unknown[][] = [];
    const state = { context: "host" as "host" | "container", fault: "", error: {} };
    const call = <T>(name: string, result: T, ...args: unknown[]): T => {
        trace.push([name, ...args]);
        if (state.fault === name) throw state.error;
        return result;
    };
    const ports: HostCredentialPathPorts = {
        executionContext: () => call("context", state.context),
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
    it("constructs without observing any port or mount", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
    });
    it.each([undefined, ""])("returns a literal custom mount in container context for raw profile %s", profile => {
        const f = fixture(); f.state.context = "container";
        expect(f.api.resolveCredentialHostPath(f.mount(["/custom/mounted"]), profile)).toBe("/custom/mounted");
        expect(f.trace).toEqual([["context"], ["mount", "/custom/mounted"]]);
    });
    it.each([undefined, ""])("delegates raw default profiles in host context: %s", profile => {
        const f = fixture();
        expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.codex"]), profile)).toBe("codex-result");
        expect(f.trace).toContainEqual(["context"]);
        expect(f.trace).toContainEqual(["codex", profile]);
        f.trace.length = 0;
        expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.claude"]), profile)).toBe("claude-result");
        expect(f.trace).toContainEqual(["claude", profile]);
    });
    it.each(["default", " work ", "work", " "])("delegates truthy raw profiles unchanged without observing context: %s", profile => {
        for (const context of ["host", "container"] as const) {
            const f = fixture(); f.state.context = context; f.state.fault = "context";
            expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.codex"]), profile)).toBe("codex-result");
            expect(f.trace).toContainEqual(["codex", profile]);
            f.trace.length = 0;
            expect(f.api.resolveCredentialHostPath(f.mount(["/home/ccc/.claude"]), profile)).toBe("claude-result");
            expect(f.trace).toContainEqual(["claude", profile]);
            expect(f.trace).not.toContainEqual(["context"]);
        }
    });
    it("uses the host fallback for custom mounts on host and truthy profiles in container context", () => {
        const f = fixture();
        expect(f.api.resolveCredentialHostPath(f.mount(["other"]))).toBe("/host/.other");
        f.state.context = "container"; f.trace.length = 0;
        expect(f.api.resolveCredentialHostPath(f.mount(["other"]), "default")).toBe("/host/.other");
        expect(f.trace).not.toContainEqual(["context"]);
        expect(f.trace).toContainEqual(["join", "/host", ".other"]);
    });
    it("reads live semantic context on subsequent calls", () => {
        const f = fixture(); const mount = f.mount(["mounted"]);
        expect(f.api.resolveCredentialHostPath(mount)).toBe("/host/.other");
        f.state.context = "container";
        expect(f.api.resolveCredentialHostPath(mount)).toBe("mounted");
        f.state.context = "host";
        expect(f.api.resolveCredentialHostPath(mount)).toBe("/host/.other");
        expect(f.trace.filter(row => row[0] === "context")).toHaveLength(3);
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
    it.each(["context", "mount", "claude", "codex", "home", "hostDir", "join", "mkdir", "parent", "basename"])("propagates %s identity and stops immediately", fault => {
        const f = fixture(); f.state.fault = fault;
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
            expect(() => createHostCredentialPaths(ports, packages)).toThrow(new TypeError(`Host credential paths requires a callable ${name} port.`));
        }
        expect(f.trace).toEqual([]);
    });
});
