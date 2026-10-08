import { describe, expect, it } from "vitest";
import { posix } from "path";
import { createCodexStateOwnershipMigration } from "../../application/credentials/codex-state-ownership.js";
import type { CodexStateOwnershipPorts } from "../../ports/credentials/codex-state-ownership.js";
import type { CodexStateDirectory, CodexStatePrincipal, PreviousCodexStateContainer } from "../../domain/credentials/codex-state-ownership.js";

const root = "/host/ccc/codex";
const principal: CodexStatePrincipal = { uid: 1000, gid: 1000, mapping: "host", contractVersion: "1" };
const previous = (): PreviousCodexStateContainer => ({ Image: "old", Mounts: [{ Type: "bind", Source: root, Destination: "/home/ccc/.codex" }] });
function fixture() {
    const trace: unknown[][] = [];
    const facts: CodexStateDirectory = { mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 8n, ino: 9n,
        isDirectory() { expect(this).toBe(facts); return true; }, isSymbolicLink() { expect(this).toBe(facts); return false; } };
    const ports: CodexStateOwnershipPorts = {
        managedRoot: profile => { trace.push(["root", profile]); return root; },
        nestedContainerMarker: () => { trace.push(["nested"]); return ""; },
        runtime: () => { trace.push(["runtime"]); return { rootless: false, flavor: "docker-native" }; },
        platform: () => { trace.push(["platform"]); return "linux"; },
        effectiveUid: () => { trace.push(["euid"]); return 1000; },
        effectiveGid: () => { trace.push(["egid"]); return 1000; },
        normalizeImage: image => { trace.push(["normalize", image]); return image; },
        previousAccount: image => { trace.push(["account", image]); return "1001:1002"; },
        directory: path => { trace.push(["stat", path]); return facts; },
        parent: path => { trace.push(["parent", path]); return posix.dirname(path); },
        activeIds: () => { trace.push(["ps"]); return ""; },
        inspectActive: ids => { trace.push(["inspect", ids]); return "[]"; },
        isAbsolute: path => { trace.push(["absolute", path]); return posix.isAbsolute(path); },
        realpath: path => { trace.push(["realpath", path]); return path; },
        separator: "/",
        migrate: (...args) => { trace.push(["migrate", ...args]); return undefined; },
    };
    return { ports, trace, facts, run: (...args: Parameters<ReturnType<typeof createCodexStateOwnershipMigration>["run"]>) => createCodexStateOwnershipMigration(ports).run(...args) };
}
const names = (trace: unknown[][]) => trace.map(call => call[0]);
const noMigration = (trace: unknown[][]) => expect(names(trace)).not.toContain("migrate");

describe("Codex retained state ownership inward policy", () => {
    it("validates two complete ancestor traversals around active observations and dispatches last", () => {
        const f = fixture();
        expect(f.run(previous(), "new", principal, "profile")).toBeUndefined();
        expect(f.trace.slice(0, 8)).toEqual([["root", "profile"], ["nested"], ["runtime"], ["platform"], ["euid"], ["egid"], ["normalize", "old"], ["account", "old"]]);
        const stats = f.trace.filter(call => call[0] === "stat");
        expect(stats).toEqual([...Array(2)].flatMap(() => [root, "/host/ccc", "/host", "/"].map(path => ["stat", path])));
        expect(names(f.trace).filter(name => ["stat", "ps", "normalize", "migrate"].includes(String(name))))
            .toEqual(["normalize", "stat", "stat", "stat", "stat", "ps", "stat", "stat", "stat", "stat", "normalize", "migrate"]);
        expect(f.trace.at(-1)).toEqual(["migrate", root, "new", "1001", "1002", "1000", "1000", { dev: "8", ino: "9" }]);
    });
    it("resolves profile root before mapping skip and never eagerly observes later gates", () => {
        const f = fixture();
        f.run(previous(), "new", { ...principal, mapping: "desktop" }, "p");
        expect(f.trace).toEqual([["root", "p"]]);
        f.trace.length = 0;
        f.ports.nestedContainerMarker = () => "docker";
        f.run(previous(), "new", principal);
        expect(f.trace).toEqual([["root", undefined]]);
    });
    it.each(["rootless", "machine", "platform", "uid", "gid", "missing uid", "missing gid"])("refuses unsupported %s before previous mounts", gate => {
        const f = fixture();
        if (gate === "rootless") f.ports.runtime = () => ({ rootless: true, flavor: "docker-native" });
        if (gate === "machine") f.ports.runtime = () => ({ rootless: false, flavor: "podman-machine" });
        if (gate === "platform") f.ports.platform = () => "darwin";
        if (gate === "uid" || gate === "missing uid") f.ports.effectiveUid = () => gate === "uid" ? 77 : undefined;
        if (gate === "gid" || gate === "missing gid") f.ports.effectiveGid = () => gate === "gid" ? 77 : undefined;
        const value = { get Mounts(): never { throw new Error("mounts observed too early"); } };
        expect(() => f.run(value, "new", principal)).toThrow("Unsupported host mapping for Codex state migration.");
        noMigration(f.trace);
        if (gate === "rootless" || gate === "machine") expect(names(f.trace)).not.toContain("platform");
        if (gate === "uid" || gate === "missing uid") expect(names(f.trace)).not.toContain("egid");
    });
    it.each([undefined, [], [{ Destination: "elsewhere" }]])("skips absent managed mount %j before old-image validation", Mounts => {
        const f = fixture(); f.run({ Image: "invalid", Mounts }, "new", principal);
        expect(names(f.trace)).not.toContain("normalize"); noMigration(f.trace);
    });
    it.each([
        [{ Type: "volume", Source: root, Destination: "/home/ccc/.codex" }],
        [{ Type: "bind", Destination: "/home/ccc/.codex" }],
        [...previous().Mounts!, ...previous().Mounts!],
    ].map(Mounts => ({ Mounts })))("refuses ambiguous or unproven mount $Mounts", ({ Mounts }) => {
        const f = fixture(); expect(() => f.run({ Image: "old", Mounts }, "new", principal)).toThrow("Cannot prove the previous container used the exact CCC-managed Codex state directory.");
        expect(names(f.trace)).not.toContain("normalize"); noMigration(f.trace);
    });
    it("preserves repeated Source getter reads, bare proof invocation, truthiness and callback errors", () => {
        const f = fixture(); const reads: string[] = []; const marker = { marker: true }; let proofThis: unknown = "unset";
        const mount = { Type: "bind", Destination: "/home/ccc/.codex", get Source() { reads.push("source"); return "/alias"; } };
        f.run({ Image: "old", Mounts: [mount] }, "new", principal, undefined, function (this: unknown, source) { proofThis = this; expect(source).toBe("/alias"); return marker as unknown as boolean; });
        expect(reads).toEqual(["source", "source", "source"]); expect(proofThis).toBeUndefined();
        try { f.run({ Image: "old", Mounts: [mount] }, "new", principal, undefined, () => { throw marker; }); throw new Error("missing exception"); } catch (error) { expect(error).toBe(marker); }
    });
    it.each(["0:1002", "1001:0", "4294967295:1002", "1001:4294967295", "ccc:ccc", " 1001:1002"])("rejects malformed old principals %s before filesystem observations", account => {
        const f = fixture(); f.ports.previousAccount = () => account;
        expect(() => f.run(previous(), "new", principal)).toThrow("Cannot establish previous ccc UID/GID for Codex state migration.");
        expect(names(f.trace)).not.toContain("stat"); noMigration(f.trace);
    });
    it("matching previous principals return before root observation and current image normalization", () => {
        const f = fixture(); f.ports.previousAccount = () => "1000:1000";
        f.run(previous(), "invalid current", principal);
        expect(f.trace.filter(call => call[0] === "normalize")).toEqual([["normalize", "old"]]);
        expect(names(f.trace)).not.toContain("stat");
    });
    it.each(["mode", "directory", "link", "foreign", "root owner", "parent group"])("refuses unsafe ancestor facts %s without active or migration dispatch", flaw => {
        const f = fixture();
        f.ports.directory = path => ({ ...f.facts, mode: flaw === "mode" ? 0o40777n : f.facts.mode,
            uid: flaw === "foreign" ? 55n : flaw === "root owner" && path === root ? 0n : 1000n,
            gid: flaw === "parent group" && path === "/host/ccc" ? 55n : 1000n,
            isDirectory: () => flaw !== "directory", isSymbolicLink: () => flaw === "link" });
        expect(() => f.run(previous(), "new", principal)).toThrow(/Unsafe Codex|must belong/);
        expect(names(f.trace)).not.toContain("ps"); noMigration(f.trace);
    });
    it.each(["null", "{}", "[]", "not JSON", '[{"Id":"a"}]', '[{"Mounts":null}]'])("rejects malformed active inspection %s", payload => {
        const f = fixture(); f.ports.activeIds = () => "a"; f.ports.inspectActive = () => payload;
        expect(() => f.run(previous(), "new", principal)).toThrow(); noMigration(f.trace);
    });
    it.each([root, "/host/ccc", root + "/child", "/"])("refuses equal or overlapping active bind %s", Source => {
        const f = fixture(); f.ports.activeIds = () => " a \n b ";
        f.ports.inspectActive = ids => { expect(ids).toEqual(["a", "b"]); return JSON.stringify([{ Id: "a", Mounts: [{ Type: "bind", Source }] }, { Mounts: [] }]); };
        expect(() => f.run(previous(), "new", principal)).toThrow("Codex state is in use by container a."); noMigration(f.trace);
    });
    it.each([root + "-other", "/unrelated"])("permits sibling prefix and unrelated active bind %s", Source => {
        const f = fixture(); f.ports.activeIds = () => "a";
        f.ports.inspectActive = () => JSON.stringify([{ Mounts: [{ Type: "bind", Source }, { Type: "volume" }] }]);
        f.run(previous(), "new", principal); expect(names(f.trace)).toContain("migrate");
    });
    it.each([undefined, "", "relative"])("refuses missing or nonabsolute active Source %s before realpath", Source => {
        const f = fixture(); f.ports.activeIds = () => "a";
        f.ports.inspectActive = () => JSON.stringify([{ Mounts: [{ Type: "bind", Source }] }]);
        expect(() => f.run(previous(), "new", principal)).toThrow("Cannot resolve active container bind source.");
        expect(names(f.trace)).not.toContain("realpath"); noMigration(f.trace);
    });
    it("translates only realpath failure and retains its exact source context", () => {
        const f = fixture(); f.ports.activeIds = () => "a"; f.ports.inspectActive = () => JSON.stringify([{ Mounts: [{ Type: "bind", Source: root }] }]);
        f.ports.realpath = () => { throw { opaque: true }; };
        expect(() => f.run(previous(), "new", principal)).toThrow("Cannot resolve active container bind source: " + root); noMigration(f.trace);
    });
    it.each(["dev", "ino"] as const)("rejects replacement of root %s after a complete second traversal", field => {
        const f = fixture(); let roots = 0;
        f.ports.directory = path => ({ ...f.facts, [field]: path === root && ++roots === 2 ? 88n : f.facts[field], isDirectory: () => true, isSymbolicLink: () => false });
        expect(() => f.run(previous(), "new", principal)).toThrow("Codex state root changed before helper startup."); noMigration(f.trace);
    });
    it.each(["managedRoot", "nestedContainerMarker", "runtime", "platform", "effectiveUid", "effectiveGid", "normalizeImage", "previousAccount", "directory", "parent", "activeIds", "migrate"] as const)("propagates opaque %s failure without later effects", key => {
        const f = fixture(); const error = { key }; Reflect.set(f.ports, key, () => { throw error; });
        try { f.run(previous(), "new", principal); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(error); }
        if (key !== "migrate") noMigration(f.trace);
    });
    it.each(["mapping", "uid", "gid"] as const)("preserves throwing identity %s getter and raw error", field => {
        const f = fixture(); const error = { field }; const identity = { ...principal };
        Object.defineProperty(identity, field, { get() { throw error; } });
        try { f.run(previous(), "new", identity); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(error); }
        noMigration(f.trace);
    });
    it.each(["Mounts", "Image"] as const)("preserves throwing previous %s getter and raw error", field => {
        const f = fixture(); const error = { field }; const value = previous();
        Object.defineProperty(value, field, { get() { throw error; } });
        try { f.run(value, "new", principal); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(error); }
        noMigration(f.trace);
    });
    it.each(["Type", "Source", "Destination"] as const)("preserves throwing mount %s getter and raw error", field => {
        const f = fixture(); const error = { field }; const value = previous();
        Object.defineProperty(value.Mounts![0], field, { get() { throw error; } });
        try { f.run(value, "new", principal); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(error); }
        noMigration(f.trace);
    });
    it("checks mode before method access and retains native directory method receiver", () => {
        const f = fixture(); const reads: string[] = []; let record: CodexStateDirectory;
        record = {
            get mode() { reads.push("mode"); return 0o40777n; }, get uid() { reads.push("uid"); return 1000n; }, gid: 1000n, dev: 8n, ino: 9n,
            isDirectory() { expect(this).toBe(record); reads.push("directory"); return true; },
            isSymbolicLink() { expect(this).toBe(record); reads.push("link"); return false; },
        };
        f.ports.directory = () => record;
        expect(() => f.run(previous(), "new", principal)).toThrow("Remove group/other write permissions");
        expect(reads).toEqual(["mode"]); noMigration(f.trace);
    });
    it("current image normalization precedes final identity reads and preserves mutation", () => {
        const f = fixture(); const identity = { ...principal };
        f.ports.normalizeImage = image => { if (image === "new") identity.uid = 2000; return image; };
        f.run(previous(), "new", identity);
        expect(f.trace.at(-1)).toEqual(["migrate", root, "new", "1001", "1002", "2000", "1000", { dev: "8", ino: "9" }]);
    });
    it("second root dev mismatch does not read or coerce its ino receipt", () => {
        const f = fixture(); let roots = 0; let inoReads = 0;
        f.ports.directory = path => path === root && ++roots === 2 ? {
            ...f.facts, dev: 99n, get ino() { inoReads++; return 9n; }, isDirectory: () => true, isSymbolicLink: () => false,
        } : f.facts;
        expect(() => f.run(previous(), "new", principal)).toThrow("root changed");
        expect(inoReads).toBe(1); noMigration(f.trace);
    });

});
