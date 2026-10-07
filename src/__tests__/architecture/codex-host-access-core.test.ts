import { describe, expect, it } from "vitest";
import { createCodexHostAccessRestoration } from "../../application/credentials/codex-host-access.js";
import type { CodexHostAccessPorts } from "../../ports/credentials/codex-host-access.js";

function thrown(fn: () => unknown): unknown { try { fn(); } catch (error) { return error; } throw new Error("Expected throw"); }
function fixture(...values: [] | [unknown]) {
    const initial = values.length ? values[0] : { code: "EACCES" };
    const trace: string[] = [];
    const warnings: unknown[] = [];
    let accesses = 0;
    const parent = { get uid() { trace.push("uid"); return 1001; }, isDirectory() { expect(this).toBe(parent); trace.push("directory"); return true; } };
    const config = { isFile() { expect(this).toBe(config); trace.push("file"); return true; }, get nlink(): never { throw new Error("Forbidden nlink"); } };
    const ports: CodexHostAccessPorts = {
        resolveConfig(profile) { trace.push(`resolve:${profile}`); return "/host/config"; },
        accessConfig(path) { expect(path).toBe("/host/config"); trace.push("access"); if (++accesses === 1) throw initial; return undefined; },
        hasHostIdentity() { trace.push("identity"); return true; },
        inspectParent(path) { expect(path).toBe("/host/config"); trace.push("parent"); return parent; },
        inspectConfig(path) { expect(path).toBe("/host/config"); trace.push("config"); return config; },
        currentHostUid() { trace.push("current"); return 1001; },
        repairConfig(target, path) { trace.push(`repair:${target}:${path}`); return undefined; },
        warn(path, reason) { expect(path).toBe("/host/config"); trace.push("warn"); warnings.push(reason); return undefined; },
    };
    return { ports, parent, config, trace, warnings, restore: () => createCodexHostAccessRestoration(ports).restore("target", "named") };
}
const repaired = ["resolve:named", "access", "identity", "parent", "config", "directory", "uid", "current", "file", "repair:target:/host/config", "access"];
describe("Codex host access restoration policy", () => {
    it("constructs without invoking capabilities and returns synchronous undefined", () => {
        const f = fixture(); const app = createCodexHostAccessRestoration(f.ports);
        expect(f.trace).toEqual([]); expect(app.restore("target", "named")).toBeUndefined(); expect(f.trace).toEqual(repaired);
    });
    it("returns immediately on successful access", () => {
        const f = fixture(); f.ports = { ...f.ports, accessConfig: () => { f.trace.push("access"); return undefined; } };
        createCodexHostAccessRestoration(f.ports).restore("target", "named"); expect(f.trace).toEqual(["resolve:named", "access"]);
    });
    it.each(["EACCES", "EPERM"])("repairs %s with metadata obtained before predicates", code => {
        const f = fixture({ code }); expect(f.restore()).toBeUndefined(); expect(f.trace).toEqual(repaired); expect(f.warnings).toEqual([]);
    });
    it.each(["ENOENT", "EIO", "ENOTDIR", "EINVAL", undefined, 7])("preserves errno decision for %s", code => {
        const error = { code }; const f = fixture(error); f.restore();
        expect(f.trace).toEqual(["resolve:named", "access", ...(code === "ENOENT" ? [] : ["warn"])]);
        expect(f.warnings).toEqual(code === "ENOENT" ? [] : [error]);
    });
    it.each([false, 3, "denied", Symbol("denied")])("warns raw primitive %s", error => { const f = fixture(error); f.restore(); expect(f.warnings).toEqual([error]); });
    it.each([null, undefined])("lets direct code access throw on %s", error => { const f = fixture(error); expect(thrown(f.restore)).toBeInstanceOf(TypeError); expect(f.trace).toEqual(["resolve:named", "access"]); });
    it("reads code directly once and preserves getter throw identity", () => {
        const sentinel = {}; const f = fixture({ get code() { throw sentinel; } }); expect(thrown(f.restore)).toBe(sentinel); expect(f.warnings).toEqual([]);
        let reads = 0; const g = fixture({ get code() { reads++; return "EPERM"; } }); g.restore(); expect(reads).toBe(1);
    });
    it("lets resolution and initial warning failures escape unchanged", () => {
        for (const stage of ["resolveConfig", "warn"] as const) {
            const f = fixture({ code: "EIO" }); const sentinel = { stage }; const ports = { ...f.ports, [stage]: () => { throw sentinel; } };
            expect(thrown(() => createCodexHostAccessRestoration(ports).restore("target"))).toBe(sentinel); expect(f.trace).toEqual(stage === "resolveConfig" ? [] : ["resolve:undefined", "access"]);
        }
    });
    it.each(["hasHostIdentity", "inspectParent", "inspectConfig", "currentHostUid", "repairConfig"] as const)("warns exact %s callback failure and suppresses later effects", stage => {
        const f = fixture(); const sentinel = { stage }; const ports = { ...f.ports, [stage]: () => { f.trace.push(stage); throw sentinel; } };
        expect(createCodexHostAccessRestoration(ports).restore("target", "named")).toBeUndefined(); expect(f.warnings).toEqual([sentinel]);
        const before = { hasHostIdentity: 2, inspectParent: 3, inspectConfig: 4, currentHostUid: 7, repairConfig: 9 }[stage];
        expect(f.trace).toEqual([...repaired.slice(0, before), stage, "warn"]);
    });
    it.each(["directory", "uid", "file"])("warns exact metadata %s getter/method failure", stage => {
        const f = fixture(); const sentinel = { stage };
        if (stage === "uid") Object.defineProperty(f.parent, "uid", { get() { throw sentinel; } });
        else if (stage === "directory") f.parent.isDirectory = () => { throw sentinel; };
        else f.config.isFile = () => { throw sentinel; };
        f.restore(); expect(f.warnings).toEqual([sentinel]); expect(f.trace).not.toContain("repair:target:/host/config");
    });
    it.each(["identity", "directory", "owner", "file"])("rejects unsafe %s with original short circuit", invalid => {
        const f = fixture(); let ports = f.ports;
        if (invalid === "identity") ports = { ...ports, hasHostIdentity: () => false };
        if (invalid === "directory") f.parent.isDirectory = () => false;
        if (invalid === "owner") ports = { ...ports, currentHostUid: () => 2 };
        if (invalid === "file") f.config.isFile = () => false;
        createCodexHostAccessRestoration(ports).restore("target", "named");
        expect((f.warnings[0] as Error).message).toBe(invalid === "identity" ? "host user identity is unavailable; automatic access repair skipped" : "automatic repair requires a regular config file in a non-symlink directory owned by the host user");
        expect(f.trace).not.toContain("repair:target:/host/config");
        if (invalid === "identity") expect(f.trace).toEqual(["resolve:named", "access", "warn"]);
        if (invalid === "directory") expect(f.trace).toEqual(["resolve:named", "access", "identity", "parent", "config", "warn"]);
        if (invalid === "owner") expect(f.trace).not.toContain("file");
    });
    it("warns recheck failure identity and allows final warning failure to escape", () => {
        const f = fixture(); const denied = {}; let count = 0;
        const ports = { ...f.ports, accessConfig: () => { if (++count === 1) throw { code: "EPERM" }; throw denied; } };
        createCodexHostAccessRestoration(ports).restore("target"); expect(f.warnings).toEqual([denied]);
        count = 0;
        const warning = {}; expect(thrown(() => createCodexHostAccessRestoration({ ...ports, warn: () => { throw warning; } }).restore("target"))).toBe(warning);
    });
    it("keeps repeated calls independent after failed repair", () => {
        const f = fixture(); let repairs = 0; let accesses = 0;
        const app = createCodexHostAccessRestoration({ ...f.ports, accessConfig: () => { if (++accesses <= 2) throw { code: "EACCES" }; return undefined; }, repairConfig: () => { if (++repairs === 1) throw "first"; return undefined; } });
        app.restore("one"); app.restore("two"); expect(repairs).toBe(2); expect(accesses).toBe(3); expect(f.warnings).toEqual(["first"]);
    });
});
