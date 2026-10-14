import { describe, expect, it } from "vitest";
import { posix } from "path";
import { createCodexStateOwnershipMigration } from "../../application/credentials/codex-state-ownership.js";
import type { CodexStateOwnershipPorts } from "../../ports/credentials/codex-state-ownership.js";
import type { CodexStateDirectory, CodexStatePrincipal, PreviousCodexStateContainer } from "../../domain/credentials/codex-state-ownership.js";

const root = "/host/ccc/codex";
const principal: CodexStatePrincipal = { uid: 1000, gid: 1000, mapping: "host", contractVersion: "1" };
const previous = (): PreviousCodexStateContainer => ({ image: "old", mounts: [{ kind: "bind", source: root, destination: "/home/ccc/.codex" }] });
function fixture() {
    const trace: unknown[][] = [];
    const facts: CodexStateDirectory = { mode: 0o40755n, uid: 1000n, gid: 1000n, dev: 8n, ino: 9n,
        isDirectory() { return true; }, isSymbolicLink() { return false; } };
    const ports: CodexStateOwnershipPorts = {
        managedRoot: profile => { trace.push(["root", profile]); return root; },
        nestedContainerMarker: () => { trace.push(["nested"]); return ""; },
        runtime: () => { trace.push(["runtime"]); return { rootless: false, flavor: "docker-native" }; },
        platform: () => { trace.push(["platform"]); return "linux"; },
        effectiveUid: () => { trace.push(["euid"]); return 1000; },
        effectiveGid: () => { trace.push(["egid"]); return 1000; },
        normalizeImage: image => { trace.push(["normalize", image]); return image; },
        previousAccount: image => { trace.push(["account", image]); return { uid: 1001, gid: 1002 }; },
        directory: path => { trace.push(["stat", path]); return facts; },
        parent: path => { trace.push(["parent", path]); return posix.dirname(path); },
        activeContainers: () => { trace.push(["active"]); return []; },
        isAbsolute: path => { trace.push(["absolute", path]); return posix.isAbsolute(path); },
        realpath: path => { trace.push(["realpath", path]); return path; },
        separator: "/",
        migrate: (...args) => { trace.push(["migrate", ...args]); return undefined; },
    };
    return { ports, trace, facts, run: (observePrevious: () => PreviousCodexStateContainer, ...args: [string, CodexStatePrincipal, string?, ((source: string) => boolean)?]) =>
        createCodexStateOwnershipMigration(ports).run(() => { trace.push(["previous"]); return observePrevious(); }, ...args) };
}
const names = (trace: unknown[][]) => trace.map(call => call[0]);
const noMigration = (trace: unknown[][]) => expect(names(trace)).not.toContain("migrate");

describe("Codex retained state ownership inward policy", () => {
    it("validates two complete ancestor traversals around active observations and dispatches last", () => {
        const f = fixture();
        expect(f.run(previous, "new", principal, "profile")).toBeUndefined();
        expect(f.trace.slice(0, 9)).toEqual([["root", "profile"], ["nested"], ["runtime"], ["platform"], ["euid"], ["egid"], ["previous"], ["normalize", "old"], ["account", "old"]]);
        expect(f.trace.filter(call => call[0] === "stat"))
            .toEqual([...Array(2)].flatMap(() => [root, "/host/ccc", "/host", "/"].map(path => ["stat", path])));
        expect(names(f.trace).filter(name => ["stat", "active", "normalize", "migrate"].includes(String(name))))
            .toEqual(["normalize", "stat", "stat", "stat", "stat", "active", "stat", "stat", "stat", "stat", "normalize", "migrate"]);
        expect(names(f.trace).filter(name => name === "euid" || name === "egid")).toEqual(["euid", "egid", "euid", "egid"]);
        expect(f.trace.at(-1)).toEqual(["migrate", root, "new", "1001", "1002", "1000", "1000", { dev: "8", ino: "9" }]);
    });
    it("resolves profile root before mapping skip and never eagerly observes previous data", () => {
        const f = fixture();
        f.run(() => { throw new Error("previous observed too early"); }, "new", { ...principal, mapping: "desktop" }, "p");
        expect(f.trace).toEqual([["root", "p"]]);
        f.trace.length = 0;
        f.ports.nestedContainerMarker = () => "docker";
        f.run(() => { throw new Error("previous observed too early"); }, "new", principal);
        expect(f.trace).toEqual([["root", undefined]]);
    });
    it.each(["rootless", "machine", "platform", "uid", "gid", "missing uid", "missing gid"])("refuses unsupported %s before previous observations", gate => {
        const f = fixture();
        if (gate === "rootless") f.ports.runtime = () => ({ rootless: true, flavor: "docker-native" });
        if (gate === "machine") f.ports.runtime = () => ({ rootless: false, flavor: "podman-machine" });
        if (gate === "platform") f.ports.platform = () => "darwin";
        if (gate === "uid" || gate === "missing uid") f.ports.effectiveUid = () => gate === "uid" ? 77 : undefined;
        if (gate === "gid" || gate === "missing gid") f.ports.effectiveGid = () => gate === "gid" ? 77 : undefined;
        expect(() => f.run(() => { throw new Error("previous observed too early"); }, "new", principal)).toThrow("Unsupported host mapping for Codex state migration.");
        expect(names(f.trace)).not.toContain("previous");
        noMigration(f.trace);
        if (gate === "rootless" || gate === "machine") expect(names(f.trace)).not.toContain("platform");
        if (gate === "uid" || gate === "missing uid") expect(names(f.trace)).not.toContain("egid");
    });
    it("does not read the principal gid getter after an initial uid mismatch", () => {
        const f = fixture();
        const identity = { ...principal, uid: 77, get gid(): never { throw new Error("gid observed too early"); } };
        expect(() => f.run(previous, "new", identity)).toThrow("Unsupported host mapping for Codex state migration.");
        expect(names(f.trace)).not.toContain("previous");
        expect(names(f.trace)).not.toContain("egid");
    });
    it.each([{ mounts: [] }, { mounts: [{ kind: "other" as const, destination: "elsewhere" }] }])("skips absent managed mount $mounts without reading the image", ({ mounts }) => {
        const f = fixture();
        f.run(() => ({ get image(): never { throw new Error("old image observed too early"); }, mounts }), "new", principal);
        expect(names(f.trace)).not.toContain("normalize");
        noMigration(f.trace);
    });
    it.each([
        [{ kind: "other" as const, destination: "/home/ccc/.codex" }],
        [{ kind: "bind" as const, source: "", destination: "/home/ccc/.codex" }],
        [...previous().mounts, ...previous().mounts],
    ].map(mounts => ({ mounts })))("refuses ambiguous or unproven mount $mounts without reading the image", ({ mounts }) => {
        const f = fixture();
        expect(() => f.run(() => ({ get image(): never { throw new Error("old image observed too early"); }, mounts }), "new", principal))
            .toThrow("Cannot prove the previous container used the exact CCC-managed Codex state directory.");
        expect(names(f.trace)).not.toContain("normalize");
        noMigration(f.trace);
    });
    it("uses the caller's source proof for a nonempty alias before reading the old image", () => {
        const f = fixture(); const proof: string[] = [];
        f.run(() => ({ image: "old", mounts: [{ kind: "bind", source: "runtime-alias", destination: "/home/ccc/.codex" }] }), "new", principal, undefined,
            source => { proof.push(source); return true; });
        expect(proof).toEqual(["runtime-alias"]);
        expect(f.trace.at(-1)?.slice(0, 3)).toEqual(["migrate", root, "new"]);
    });
    it.each([
        { uid: 0, gid: 1002 }, { uid: 1001, gid: 0 }, { uid: 4294967295, gid: 1002 }, { uid: 1001, gid: 4294967295 },
        { uid: 1.5, gid: 1002 }, { uid: 1001, gid: NaN }, { uid: Infinity, gid: 1002 },
    ])("rejects unqualified old account facts %j before filesystem observations", account => {
        const f = fixture(); f.ports.previousAccount = () => account;
        expect(() => f.run(previous, "new", principal)).toThrow("Cannot establish previous ccc UID/GID for Codex state migration.");
        expect(names(f.trace)).not.toContain("stat");
        noMigration(f.trace);
    });
    it("matching previous principals return before root observation and current image normalization", () => {
        const f = fixture(); f.ports.previousAccount = () => ({ uid: 1000, gid: 1000 });
        f.run(previous, "invalid current", principal);
        expect(f.trace.filter(call => call[0] === "normalize")).toEqual([["normalize", "old"]]);
        expect(names(f.trace)).not.toContain("stat");
    });
    it.each(["mode", "directory", "link", "foreign", "root owner", "parent group"])("refuses unsafe ancestor facts %s without active or migration dispatch", flaw => {
        const f = fixture();
        f.ports.directory = path => ({ ...f.facts, mode: flaw === "mode" ? 0o40777n : f.facts.mode,
            uid: flaw === "foreign" ? 55n : flaw === "root owner" && path === root ? 0n : 1000n,
            gid: flaw === "parent group" && path === "/host/ccc" ? 55n : 1000n,
            isDirectory: () => flaw !== "directory", isSymbolicLink: () => flaw === "link" });
        expect(() => f.run(previous, "new", principal)).toThrow(/Unsafe Codex|must belong/);
        expect(names(f.trace)).not.toContain("active");
        noMigration(f.trace);
    });
    it.each([root, "/host/ccc", root + "/child", "/"])("refuses equal or overlapping active bind %s", source => {
        const f = fixture();
        f.ports.activeContainers = () => [{ id: "a", mounts: [{ kind: "bind", source, destination: "/private" }] }, { id: "b", mounts: [] }];
        expect(() => f.run(previous, "new", principal)).toThrow("Codex state is in use by container a.");
        noMigration(f.trace);
    });
    it.each([root + "-other", "/unrelated"])("permits sibling prefix and unrelated active bind %s", source => {
        const f = fixture();
        f.ports.activeContainers = () => [{ id: "a", mounts: [{ kind: "bind", source, destination: "/private" }, { kind: "other", destination: "" }] }];
        f.run(previous, "new", principal);
        expect(names(f.trace)).toContain("migrate");
    });
    it.each(["", "relative"])("refuses empty or nonabsolute active source %s before realpath", source => {
        const f = fixture();
        f.ports.activeContainers = () => [{ id: "a", mounts: [{ kind: "bind", source, destination: "" }] }];
        expect(() => f.run(previous, "new", principal)).toThrow("Cannot resolve active container bind source.");
        expect(names(f.trace)).not.toContain("realpath");
        noMigration(f.trace);
    });
    it("translates only realpath failure and retains its exact source context", () => {
        const f = fixture();
        f.ports.activeContainers = () => [{ id: "a", mounts: [{ kind: "bind", source: root, destination: "" }] }];
        f.ports.realpath = () => { throw { opaque: true }; };
        expect(() => f.run(previous, "new", principal)).toThrow("Cannot resolve active container bind source: " + root);
        noMigration(f.trace);
    });
    it.each(["dev", "ino"] as const)("rejects replacement of root %s after a complete second traversal", field => {
        const f = fixture(); let roots = 0;
        f.ports.directory = path => {
            f.trace.push(["stat", path]);
            return { ...f.facts, [field]: path === root && ++roots === 2 ? 88n : f.facts[field], isDirectory: () => true, isSymbolicLink: () => false };
        };
        expect(() => f.run(previous, "new", principal)).toThrow("Codex state root changed before helper startup.");
        expect(f.trace.filter(call => call[0] === "stat")).toHaveLength(8);
        noMigration(f.trace);
    });
    it("revalidates a parent changed during active observations before helper dispatch", () => {
        const f = fixture(); let observedActive = false;
        f.ports.activeContainers = () => { observedActive = true; return []; };
        f.ports.directory = path => ({ ...f.facts, mode: observedActive && path === "/host/ccc" ? 0o40775n : f.facts.mode });
        expect(() => f.run(previous, "new", principal)).toThrow("Remove group/other write permissions");
        noMigration(f.trace);
    });
    it.each(["uid", "gid", "mapping", "effective uid", "effective gid"])("refuses changed final %s after both complete traversals", field => {
        const f = fixture(); const identity: CodexStatePrincipal = { ...principal };
        if (field.startsWith("effective")) {
            let reads = 0;
            if (field === "effective uid") f.ports.effectiveUid = () => ++reads === 1 ? 1000 : 77;
            else f.ports.effectiveGid = () => ++reads === 1 ? 1000 : 77;
        } else f.ports.activeContainers = () => {
            if (field === "uid") identity.uid = 77;
            if (field === "gid") identity.gid = 77;
            if (field === "mapping") identity.mapping = "desktop";
            return [];
        };
        expect(() => f.run(previous, "new", identity)).toThrow("Host principal changed before Codex state migration.");
        expect(f.trace.filter(call => call[0] === "stat")).toHaveLength(8);
        expect(f.trace.filter(call => call[0] === "normalize")).toEqual([["normalize", "old"]]);
        noMigration(f.trace);
    });
    it("publishes unrounded BigInt root identity strings to the helper", () => {
        const f = fixture(); const dev = 9007199254740993n; const ino = 12345678901234567890n;
        f.ports.directory = () => ({ ...f.facts, dev, ino });
        f.run(previous, "new", principal);
        expect(f.trace.at(-1)?.at(-1)).toEqual({ dev: "9007199254740993", ino: "12345678901234567890" });
    });
    it.each(["managedRoot", "nestedContainerMarker", "runtime", "platform", "effectiveUid", "effectiveGid", "normalizeImage", "previousAccount", "directory", "parent", "activeContainers", "migrate"] as const)("propagates opaque %s failure without later effects", key => {
        const f = fixture(); const error = { key }; Reflect.set(f.ports, key, () => { throw error; });
        try { f.run(previous, "new", principal); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(error); }
        if (key !== "migrate") noMigration(f.trace);
    });
    it("preserves the lazy previous observer's original fault without account or filesystem effects", () => {
        const f = fixture(); const fault = { previous: true };
        try { f.run(() => { throw fault; }, "new", principal); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(fault); }
        expect(names(f.trace)).not.toContain("account");
        expect(names(f.trace)).not.toContain("stat");
        noMigration(f.trace);
    });
    it("propagates a source proof fault without reading image, account or filesystem", () => {
        const f = fixture(); const fault = { proof: true };
        const observe = () => ({ get image(): never { throw new Error("image observed too early"); }, mounts: [{ kind: "bind" as const, source: "alias", destination: "/home/ccc/.codex" }] });
        try { f.run(observe, "new", principal, undefined, () => { throw fault; }); throw new Error("missing exception"); } catch (actual) { expect(actual).toBe(fault); }
        expect(names(f.trace)).not.toContain("account");
        expect(names(f.trace)).not.toContain("stat");
        noMigration(f.trace);
    });
});
