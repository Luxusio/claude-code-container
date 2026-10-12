import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createSessionCleanup } from "../../application/session-cleanup.js";
import type { SessionCleanupPorts } from "../../ports/session-cleanup.js";

const portNames = ["projectId", "withLifecycleLock", "hasOtherClaims", "removeClaim", "cleanupDevices",
    "reportDeviceCleanupFailure", "stopContainer"] as const;
const initial = { lockFile: null, projectPath: null, profile: undefined, toolName: null };
const active = { lockFile: "/claims/own.lock", projectPath: "/project", profile: "work", toolName: "custom" };

it("keeps session cleanup policy inward and its native adapter out of Admin and broker entrypoints", () => {
    const imports = (url: URL) => ts.createSourceFile(url.pathname, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true)
        .statements.flatMap(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
            ? [statement.moduleSpecifier.text] : []);
    const adapter = imports(new URL("../../adapters/session-cleanup.ts", import.meta.url));
    expect(adapter).toContain("../device-lab-cleanup.js");
    expect(adapter.some(specifier => /device-lab-(?:admin|broker)/.test(specifier))).toBe(false);
    const application = imports(new URL("../../application/session-cleanup.ts", import.meta.url));
    expect(application.every(specifier => specifier.startsWith("../domain/") || specifier.startsWith("../ports/"))).toBe(true);
});

function fixture() {
    const trace: unknown[][] = [];
    let held = false;
    let foreign = false;
    const ports: SessionCleanupPorts = {
        projectId(path) { trace.push(["project", path]); return "project-id"; },
        withLifecycleLock<T>(prefix: string, operation: () => T): T {
            trace.push(["lock", prefix]);
            held = true;
            try { return operation(); } finally { held = false; trace.push(["unlock", prefix]); }
        },
        hasOtherClaims(prefix, ownPath) { expect(held).toBe(true); trace.push(["raw", prefix, ownPath]); return foreign; },
        removeClaim(path) { expect(held).toBe(true); trace.push(["remove", path]); return undefined; },
        cleanupDevices(path, timeoutMs, profile) { expect(held).toBe(true); trace.push(["devices", path, timeoutMs, profile]); return undefined; },
        reportDeviceCleanupFailure(error) { expect(held).toBe(true); trace.push(["report", error]); return undefined; },
        stopContainer(readContainerId) {
            expect(held).toBe(true);
            expect(typeof readContainerId).toBe("function");
            trace.push(["stop", readContainerId()]);
            return undefined;
        },
    };
    const app = createSessionCleanup(ports);
    const setActive = () => {
        app.setSession(active.lockFile, active.projectPath, active.profile, active.toolName);
        app.setSessionContainerId("captured-container-id");
    };
    return {
        app, ports, trace, setActive,
        setForeign: (value: boolean) => { foreign = value; }, isHeld: () => held,
        runHeld: () => {
            held = true;
            try { return app.cleanupSessionInHeldLifecycleLock(); } finally { held = false; }
        },
    };
}

describe("explicit session cleanup construction", () => {
    it.each([undefined, null])("rejects absent ports %s", value => {
        expect(() => createSessionCleanup(value as unknown as SessionCleanupPorts)).toThrow(TypeError);
    });
    for (const name of portNames) {
        it(`requires callable ${name} without invoking effects`, () => {
            for (const invalid of [undefined, null, false, 0, "callback", {}]) {
                const f = fixture();
                expect(() => createSessionCleanup({ ...f.ports, [name]: invalid } as unknown as SessionCleanupPorts)).toThrow(TypeError);
                expect(f.trace).toEqual([]);
            }
            const f = fixture();
            const incomplete: Record<string, unknown> = { ...f.ports };
            delete incomplete[name];
            expect(() => createSessionCleanup(incomplete as unknown as SessionCleanupPorts)).toThrow(TypeError);
            expect(f.trace).toEqual([]);
        });
    }
    it("constructs without effects and keeps instances independent", () => {
        const first = fixture();
        const second = createSessionCleanup(first.ports);
        expect(first.trace).toEqual([]);
        first.setActive();
        expect(second.getCurrentSession()).toEqual(initial);
        second.setSession("second.lock", "/second");
        first.app.clearSession();
        expect(second.getCurrentSession()).toEqual({ lockFile: "second.lock", projectPath: "/second", profile: undefined, toolName: "claude" });
        second.cleanupSession();
        first.setActive();
        first.app.cleanupSession();
        expect(first.trace.filter(row => row[0] === "remove")).toEqual([["remove", "second.lock"], ["remove", active.lockFile]]);
    });


});

describe("cleanup in an already-held lifecycle guard", () => {
    it.each([false, true])("matches synchronous cleanup effects and finalization with foreign ownership %s", foreign => {
        const ordinary = fixture();
        const held = fixture();
        for (const f of [ordinary, held]) { f.setActive(); f.setForeign(foreign); }
        ordinary.app.cleanupSession();
        expect(held.runHeld()).toBeUndefined();
        expect(held.trace).toEqual(ordinary.trace.filter(row => row[0] !== "lock" && row[0] !== "unlock"));
        expect(held.app.getCurrentSession()).toEqual(ordinary.app.getCurrentSession());
        expect(held.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
        held.trace.length = 0;
        held.runHeld();
        expect(held.trace).toEqual([]);
    });
    it("never reacquires a lifecycle guard while stopping the captured container", () => {
        const f = fixture();
        f.setActive();
        f.ports.withLifecycleLock = () => { throw new Error("nested guard acquisition"); };
        f.runHeld();
        expect(f.trace).toEqual([
            ["project", active.projectPath], ["raw", "project-id--p--work", active.lockFile],
            ["devices", active.projectPath, 5000, active.profile], ["stop", "captured-container-id"],
            ["remove", active.lockFile],
        ]);
    });
    it.each(["hasOtherClaims", "stopContainer", "removeClaim"] as const)("retains claim and incomplete context after held %s failure, then retries", member => {
        const f = fixture();
        f.setActive();
        let claimPresent = true;
        const remove = f.ports.removeClaim;
        f.ports.removeClaim = path => { remove(path); claimPresent = false; return undefined; };
        const original = f.ports[member];
        const failure = { member };
        Object.assign(f.ports, { [member]: () => {
            expect(f.isHeld()).toBe(true);
            expect(claimPresent).toBe(true);
            f.trace.push(["failure", member]);
            throw failure;
        } });
        let caught: unknown;
        try { f.runHeld(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(claimPresent).toBe(true);
        expect(f.app.getCurrentSession()).toEqual(active);
        expect(f.trace.some(row => row[0] === "remove")).toBe(false);
        if (member === "hasOtherClaims") {
            expect(f.trace.some(row => row[0] === "devices" || row[0] === "stop")).toBe(false);
        }
        Object.assign(f.ports, { [member]: original });
        f.trace.length = 0;
        f.runHeld();
        expect(f.trace).toEqual([
            ["project", active.projectPath], ["raw", "project-id--p--work", active.lockFile],
            ["devices", active.projectPath, 5000, active.profile], ["stop", "captured-container-id"],
            ["remove", active.lockFile],
        ]);
        expect(claimPresent).toBe(false);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
    it("rechecks foreign authority on retry before releasing only its own receipt", () => {
        const f = fixture();
        f.setActive();
        f.ports.stopContainer = () => { throw new Error("stop failed"); };
        expect(() => f.runHeld()).toThrow("stop failed");
        expect(f.trace.some(row => row[0] === "remove")).toBe(false);
        f.setForeign(true);
        f.trace.length = 0;
        f.runHeld();
        expect(f.trace).toEqual([
            ["project", active.projectPath], ["raw", "project-id--p--work", active.lockFile],
            ["remove", active.lockFile],
        ]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
    it.each(["ordinary", "held"] as const)("%s cleanup respects disabled shutdown authorization", entry => {
        const f = fixture();
        f.setActive();
        f.app.setSessionCleanupEnabled(false);
        if (entry === "held") f.runHeld(); else f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] !== "lock" && row[0] !== "unlock")).toEqual([
            ["project", active.projectPath], ["raw", "project-id--p--work", active.lockFile],
            ["remove", active.lockFile],
        ]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
});

describe("session context", () => {
    it("starts empty and returns fresh snapshots with no container ID", () => {
        const f = fixture();
        const first = f.app.getCurrentSession();
        expect(first).toEqual(initial);
        expect(f.app.getCurrentSession()).not.toBe(first);
        f.setActive();
        const snapshot = f.app.getCurrentSession();
        expect(snapshot).toEqual(active);
        expect(Object.keys(snapshot).sort()).toEqual(["lockFile", "profile", "projectPath", "toolName"]);
        snapshot.lockFile = "changed outside";
        snapshot.projectPath = "/outside";
        snapshot.profile = "outside";
        snapshot.toolName = "outside";
        expect(f.app.getCurrentSession()).toEqual(active);
        expect(first).toEqual(initial);
        expect(f.trace).toEqual([]);
    });
    it.each([
        [undefined, undefined, "claude"], ["", "", ""], ["work", "custom", "custom"],
        [undefined, null, "claude"],
    ] as const)("preserves profile %j and nullish tool %j", (profile, tool, expectedTool) => {
        const f = fixture();
        f.app.setSession("lock", "/path", profile, tool as unknown as string | undefined);
        expect(f.app.getCurrentSession()).toEqual({ lockFile: "lock", projectPath: "/path", profile, toolName: expectedTool });
        expect(f.trace).toEqual([]);
    });
    it("setSession resets the captured container ID, and clear resets every field", () => {
        const f = fixture();
        f.setActive();
        f.app.setSession("new.lock", "/new");
        f.app.cleanupSession();
        expect(f.trace.some(row => row[0] === "stop")).toBe(false);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "claude" });
        f.app.clearSession();
        expect(f.app.getCurrentSession()).toEqual(initial);
        f.app.setSession("third.lock", "/third");
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "remove")).toHaveLength(2);
        expect(f.trace.some(row => row[0] === "stop")).toBe(false);
    });
    it("successful cleanup retains the hidden captured ID until a setter or clear changes it", () => {
        const f = fixture();
        f.setActive();
        let reader: () => string | null = () => { throw new Error("stop did not receive its reader"); };
        f.ports.stopContainer = readId => { reader = readId; return undefined; };
        f.app.cleanupSession();
        expect(reader()).toBe("captured-container-id");
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
        f.app.setSessionContainerId("changed-id");
        expect(reader()).toBe("changed-id");
        f.app.setSession("next.lock", "/next");
        expect(reader()).toBe(null);
        f.app.setSessionContainerId("another-id");
        f.app.clearSession();
        expect(reader()).toBe(null);
    });
});

describe("cleanup gates and raw ownership veto", () => {
    it("empty initial state has no effects", () => {
        const f = fixture();
        f.app.cleanupSession();
        expect(f.trace).toEqual([]);
        expect(f.app.getCurrentSession()).toEqual(initial);
    });
    it.each([["", "/project"], ["own.lock", ""], ["", ""]])("does nothing for lock %j and project %j", (lock, path) => {
        const f = fixture();
        f.app.setSession(lock, path, "work", "custom");
        const before = f.app.getCurrentSession();
        f.app.cleanupSession();
        expect(f.trace).toEqual([]);
        expect(f.app.getCurrentSession()).toEqual(before);
        f.setActive();
        f.app.cleanupSession();
        expect(f.trace.some(row => row[0] === "remove")).toBe(true);
    });
    it.each([undefined, "", "work--extra"])("holds profile %j guard through raw query, own removal, devices and exact ID stop", profile => {
        const f = fixture();
        const prefix = profile ? `project-id--p--${profile}` : "project-id";
        f.app.setSession(active.lockFile, active.projectPath, profile, "custom");
        f.app.setSessionContainerId("opaque-captured-id");
        f.app.cleanupSession();
        expect(f.trace).toEqual([
            ["project", active.projectPath], ["lock", prefix], ["raw", prefix, active.lockFile],
            ["devices", active.projectPath, 5000, profile],
            ["stop", "opaque-captured-id"], ["remove", active.lockFile], ["unlock", prefix],
        ]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
        f.app.cleanupSession();
        expect(f.trace).toHaveLength(7);
    });
    it.each([null, ""])("cleans devices but skips stop for ID %j", id => {
        const f = fixture();
        f.setActive();
        f.app.setSessionContainerId(id);
        f.app.cleanupSession();
        expect(f.trace.map(row => row[0])).toEqual(["project", "lock", "raw", "devices", "remove", "unlock"]);
    });
    it("foreign raw claims veto devices and stop but remove own claim and finalize", () => {
        const f = fixture();
        f.setActive();
        f.setForeign(true);
        f.app.cleanupSession();
        expect(f.trace).toEqual([
            ["project", active.projectPath], ["lock", "project-id--p--work"],
            ["raw", "project-id--p--work", active.lockFile], ["remove", active.lockFile],
            ["unlock", "project-id--p--work"],
        ]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
        f.setActive();
        f.app.cleanupSession();
        expect(f.trace).toHaveLength(5);
        expect(f.app.getCurrentSession()).toEqual(active);
        f.app.clearSession();
        f.setActive();
        f.setForeign(false);
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "captured-container-id"]]);
    });
    it("setSession after successful cleanup does not rearm cleanup; clearSession does", () => {
        const f = fixture();
        f.setActive();
        f.app.cleanupSession();
        f.trace.length = 0;
        f.setActive();
        f.app.cleanupSession();
        expect(f.trace).toEqual([]);
        expect(f.app.getCurrentSession()).toEqual(active);
        f.app.clearSession();
        f.setActive();
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "stop")).toHaveLength(1);
    });
});

describe("cleanup failures and retries", () => {
    it("retains its ownership receipt until the exact-ID stop succeeds on retry", () => {
        const f = fixture();
        f.setActive();
        const stop = f.ports.stopContainer;
        f.ports.stopContainer = () => { throw new Error("stop failed"); };
        expect(() => f.app.cleanupSession()).toThrow("stop failed");
        expect(f.trace.some(row => row[0] === "remove")).toBe(false);
        expect(f.app.getCurrentSession()).toEqual(active);
        f.ports.stopContainer = stop;
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
    it.each([new Error("device failure"), "device failure", null, { failure: "devices" }])("reports device error %j unchanged and continues", failure => {
        const f = fixture();
        f.setActive();
        f.ports.cleanupDevices = () => { f.trace.push(["device-throw"]); throw failure; };
        f.app.cleanupSession();
        expect(f.trace.slice(-5)).toEqual([
            ["device-throw"], ["report", failure], ["stop", "captured-container-id"], ["remove", active.lockFile], ["unlock", "project-id--p--work"],
        ]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
    it.each(["projectId", "withLifecycleLock", "hasOtherClaims", "removeClaim", "stopContainer"] as const)("propagates %s failure identity without finalization and permits retry", member => {
        const f = fixture();
        f.setActive();
        const failure = { member };
        const original = f.ports[member];
        Object.assign(f.ports, { [member]: () => { f.trace.push(["failure", member]); throw failure; } });
        let caught: unknown;
        try { f.app.cleanupSession(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.app.getCurrentSession()).toEqual(active);
        expect(f.isHeld()).toBe(false);
        const stages = ["project", "lock", "raw", "devices", "stop", "remove"];
        const faultStage = { projectId: "project", withLifecycleLock: "lock", hasOtherClaims: "raw", removeClaim: "remove", stopContainer: "stop" }[member];
        const faultIndex = stages.indexOf(faultStage);
        expect(f.trace.filter(row => row[0] !== "unlock")).toEqual([
            ...[
                ["project", active.projectPath], ["lock", "project-id--p--work"],
                ["raw", "project-id--p--work", active.lockFile],
                ["devices", active.projectPath, 5000, active.profile], ["stop", "captured-container-id"],
            ].slice(0, faultIndex), ["failure", member],
        ]);
        Object.assign(f.ports, { [member]: original });
        f.trace.length = 0;
        f.app.cleanupSession();
        expect(f.trace.map(row => row[0])).toEqual(stages.concat("unlock"));
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
    it("reporter failure escapes, skips stop/finalization and retries the device cleanup", () => {
        const f = fixture();
        f.setActive();
        const deviceFailure = "device";
        const reportFailure = { failure: "reporter" };
        f.ports.cleanupDevices = () => { f.trace.push(["device-throw"]); throw deviceFailure; };
        const original = f.ports.reportDeviceCleanupFailure;
        f.ports.reportDeviceCleanupFailure = error => { expect(error).toBe(deviceFailure); throw reportFailure; };
        let caught: unknown;
        try { f.app.cleanupSession(); } catch (error) { caught = error; }
        expect(caught).toBe(reportFailure);
        expect(f.trace.some(row => row[0] === "stop")).toBe(false);
        expect(f.app.getCurrentSession()).toEqual(active);
        f.ports.reportDeviceCleanupFailure = original;
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "device-throw")).toHaveLength(2);
        expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "captured-container-id"]]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
    it("lock return failure follows effects but preserves context and repeats effects on retry", () => {
        const f = fixture();
        f.setActive();
        const original = f.ports.withLifecycleLock;
        const failure = { failure: "release" };
        f.ports.withLifecycleLock = <T>(prefix: string, operation: () => T): T => {
            original(prefix, operation);
            throw failure;
        };
        let caught: unknown;
        try { f.app.cleanupSession(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.app.getCurrentSession()).toEqual(active);
        expect(f.trace.filter(row => row[0] === "stop")).toHaveLength(1);
        f.ports.withLifecycleLock = original;
        f.app.cleanupSession();
        for (const effect of ["remove", "devices", "stop"]) expect(f.trace.filter(row => row[0] === effect)).toHaveLength(2);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
});

describe("cleanup reads mutable context at each callback boundary", () => {
    it("reads profile after project identity, while retaining the identity from the original path", () => {
        const f = fixture();
        f.setActive();
        f.ports.projectId = path => {
            expect(path).toBe(active.projectPath);
            f.app.setSession("identity.lock", "/identity", "identity-profile", "identity-tool");
            f.app.setSessionContainerId("identity-id");
            return "original-project-id";
        };
        f.app.cleanupSession();
        expect(f.trace).toEqual([
            ["lock", "original-project-id--p--identity-profile"],
            ["raw", "original-project-id--p--identity-profile", "identity.lock"],
            ["devices", "/identity", 5000, "identity-profile"], ["stop", "identity-id"],
            ["remove", "identity.lock"],
            ["unlock", "original-project-id--p--identity-profile"],
        ]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "identity-tool" });
    });
    it.each(["lock", "raw", "remove", "devices", "report", "runtime", "lock-return"] as const)("preserves dynamic reads during %s callback mutation", phase => {
        const f = fixture();
        f.setActive();
        const mutate = () => {
            f.app.setSession("mutated.lock", "/mutated", "mutated-profile", "mutated-tool");
            f.app.setSessionContainerId("mutated-id");
        };
        const lock = f.ports.withLifecycleLock;
        const raw = f.ports.hasOtherClaims;
        const remove = f.ports.removeClaim;
        const devices = f.ports.cleanupDevices;
        const report = f.ports.reportDeviceCleanupFailure;
        if (phase === "lock" || phase === "lock-return") {
            f.ports.withLifecycleLock = <T>(prefix: string, operation: () => T): T => {
                if (phase === "lock") mutate();
                const result = lock(prefix, operation);
                if (phase === "lock-return") mutate();
                return result;
            };
        }
        if (phase === "raw") f.ports.hasOtherClaims = (prefix, path) => { const result = raw(prefix, path); mutate(); return result; };
        if (phase === "remove") f.ports.removeClaim = path => { remove(path); mutate(); return undefined; };
        if (phase === "devices" || phase === "report") f.ports.cleanupDevices = (path, timeout, profile) => {
            devices(path, timeout, profile);
            if (phase === "devices") mutate();
            else throw "device failure";
            return undefined;
        };
        if (phase === "report") f.ports.reportDeviceCleanupFailure = error => { report(error); mutate(); return undefined; };
        if (phase === "runtime") f.ports.stopContainer = readId => {
            expect(f.isHeld()).toBe(true);
            mutate();
            f.trace.push(["stop", readId()]);
            return undefined;
        };
        f.app.cleanupSession();
        const earlyMutation = phase === "lock";
        const beforeDevicesMutation = earlyMutation || phase === "raw";
        const beforeRemovalMutation = beforeDevicesMutation || phase === "devices" || phase === "report" || phase === "runtime";
        expect(f.trace.find(row => row[0] === "raw")).toEqual(["raw", "project-id--p--work", earlyMutation ? "mutated.lock" : active.lockFile]);
        expect(f.trace.find(row => row[0] === "remove")).toEqual(["remove", beforeRemovalMutation ? "mutated.lock" : active.lockFile]);
        expect(f.trace.find(row => row[0] === "devices")).toEqual([
            "devices", beforeDevicesMutation ? "/mutated" : active.projectPath, 5000,
            beforeDevicesMutation ? "mutated-profile" : active.profile,
        ]);
        expect(f.trace.find(row => row[0] === "stop")).toEqual(["stop", phase === "lock-return" || phase === "remove" ? "captured-container-id" : "mutated-id"]);
        expect(f.trace.find(row => row[0] === "lock")).toEqual(["lock", "project-id--p--work"]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "mutated-tool" });
        f.trace.length = 0;
        f.setActive();
        f.app.cleanupSession();
        expect(f.trace).toEqual([]);
    });
    it.each(["devices", "report"] as const)("reads container truthiness after %s clears it", phase => {
        const f = fixture();
        f.setActive();
        f.ports.cleanupDevices = () => {
            if (phase === "report") throw "device";
            f.app.setSessionContainerId(null);
            return undefined;
        };
        f.ports.reportDeviceCleanupFailure = () => { f.app.setSessionContainerId(null); return undefined; };
        f.app.cleanupSession();
        expect(f.trace.some(row => row[0] === "stop")).toBe(false);
    });
    it("an ID assigned during devices permits stopping even when no ID existed initially", () => {
        const f = fixture();
        f.app.setSession(active.lockFile, active.projectPath);
        f.ports.cleanupDevices = () => { f.app.setSessionContainerId("late-id"); return undefined; };
        f.app.cleanupSession();
        expect(f.trace.find(row => row[0] === "stop")).toEqual(["stop", "late-id"]);
    });
    it.each([null, ""])("stop's lazy reader preserves runtime mutation to %j without a second truthiness gate", id => {
        const f = fixture();
        f.setActive();
        f.ports.stopContainer = readId => {
            f.app.setSessionContainerId(id);
            f.trace.push(["stop", readId()]);
            return undefined;
        };
        f.app.cleanupSession();
        expect(f.trace.find(row => row[0] === "stop")).toEqual(["stop", id]);
    });
    it("clearSession during raw query does not insert new lock/path gates inside cleanup", () => {
        const f = fixture();
        f.setActive();
        f.ports.hasOtherClaims = () => { f.app.clearSession(); return false; };
        f.app.cleanupSession();
        expect(f.trace.find(row => row[0] === "remove")).toEqual(["remove", null]);
        expect(f.trace.find(row => row[0] === "devices")).toEqual(["devices", null, 5000, undefined]);
        expect(f.trace.some(row => row[0] === "stop")).toBe(false);
        expect(f.app.getCurrentSession()).toEqual(initial);
        f.trace.length = 0;
        f.setActive();
        f.app.cleanupSession();
        expect(f.trace).toEqual([]);
    });
});
