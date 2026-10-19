import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createSessionCleanup } from "../../application/session-cleanup.js";
import type { SessionCleanupPorts } from "../../ports/session-cleanup.js";

const portNames = ["projectId", "withLifecycleLock", "peerVetoes", "removeClaim", "cleanupDevices",
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
    const settlements: Array<Parameters<SessionCleanupPorts["removeClaim"]>[1]> = [];
    const peerQueries: Array<[string, string, string | null]> = [];
    let held = false;
    let vetoes = { sharedDeviceCleanupBlocked: false, exactContainerStopBlocked: false, responsibilityTransferred: false };
    const ports: SessionCleanupPorts = {
        projectId(path) { trace.push(["project", path]); return "project-id"; },
        withLifecycleLock<T>(prefix: string, operation: () => T): T {
            trace.push(["lock", prefix]);
            held = true;
            try { return operation(); } finally { held = false; trace.push(["unlock", prefix]); }
        },
        peerVetoes(prefix, ownPath, pinnedId) {
            expect(held).toBe(true);
            trace.push(["raw", prefix, ownPath]);
            peerQueries.push([prefix, ownPath, pinnedId]);
            return { ...vetoes };
        },
        removeClaim(path, settlement) {
            expect(held).toBe(true);
            trace.push(["remove", path]);
            settlements.push({ ...settlement });
            return undefined;
        },
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
        app, ports, trace, settlements, peerQueries, setActive,
        setPeerVetoes: (value: typeof vetoes) => { vetoes = { ...value }; },
        setForeign: (value: boolean) => {
            vetoes = { sharedDeviceCleanupBlocked: value, exactContainerStopBlocked: value, responsibilityTransferred: false };
        },
        isHeld: () => held,
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
    it.each([false, true])("matches synchronous cleanup effects and completion state with foreign ownership %s", foreign => {
        const ordinary = fixture();
        const held = fixture();
        for (const f of [ordinary, held]) { f.setActive(); f.setForeign(foreign); }
        if (foreign) {
            expect(() => ordinary.app.cleanupSession()).toThrow("session-cleanup-responsibility-incomplete");
            expect(() => held.runHeld()).toThrow("session-cleanup-responsibility-incomplete");
        } else {
            ordinary.app.cleanupSession();
            expect(held.runHeld()).toBeUndefined();
        }
        expect(held.trace).toEqual(ordinary.trace.filter(row => row[0] !== "lock" && row[0] !== "unlock"));
        expect(held.app.getCurrentSession()).toEqual(ordinary.app.getCurrentSession());
        expect(held.app.getCurrentSession()).toEqual(foreign ? active : { ...initial, toolName: "custom" });
        held.trace.length = 0;
        if (foreign) {
            expect(() => held.runHeld()).toThrow("session-cleanup-responsibility-incomplete");
            expect(held.trace.map(row => row[0])).toEqual(["project", "raw"]);
        } else {
            held.runHeld();
            expect(held.trace).toEqual([]);
        }
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
    it.each(["peerVetoes", "stopContainer", "removeClaim"] as const)("retains claim and incomplete context after held %s failure, then retries", member => {
        const f = fixture();
        f.setActive();
        let claimPresent = true;
        const remove = f.ports.removeClaim;
        f.ports.removeClaim = (path, settlement) => { remove(path, settlement); claimPresent = false; return undefined; };
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
        if (member === "peerVetoes") {
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
    it("rechecks qualified responsibility transfer on retry before releasing only its own receipt", () => {
        const f = fixture();
        f.setActive();
        f.app.setSessionContainerId("a".repeat(64));
        f.ports.stopContainer = () => { throw new Error("stop failed"); };
        expect(() => f.runHeld()).toThrow("stop failed");
        expect(f.trace.some(row => row[0] === "remove")).toBe(false);
        f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: true });
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
    it("a foreign claim without a responsibility recipient retains own claim and permits a later exact-stop retry", () => {
        const f = fixture();
        f.setActive();
        f.setForeign(true);
        expect(() => f.app.cleanupSession()).toThrow("session-cleanup-responsibility-incomplete");
        expect(f.trace).toEqual([
            ["project", active.projectPath], ["lock", "project-id--p--work"],
            ["raw", "project-id--p--work", active.lockFile],
            ["unlock", "project-id--p--work"],
        ]);
        expect(f.settlements).toEqual([]);
        expect(f.app.getCurrentSession()).toEqual(active);
        f.setForeign(false);
        f.app.cleanupSession();
        expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "captured-container-id"]]);
        expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
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

describe("independent shared-device and exact-container cleanup decisions", () => {
    const containerId = "a".repeat(64);
    const incomplete = "session-cleanup-responsibility-incomplete";

    for (const entry of ["ordinary", "held"] as const) {
        const run = (f: ReturnType<typeof fixture>) => entry === "held" ? f.runHeld() : f.app.cleanupSession();

        it(`${entry} stops its pinned container while a qualified different full-ID peer protects shared devices`, () => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(containerId);
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: false, responsibilityTransferred: false });

            run(f);

            expect(f.peerQueries).toEqual([["project-id--p--work", active.lockFile, containerId]]);
            expect(f.trace.some(row => row[0] === "devices")).toBe(false);
            expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", containerId]]);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
            expect(f.settlements).toEqual([{
                containerId, cleanupEnabled: true, containerStopped: true, responsibilityTransferred: false,
            }]);
            expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: active.toolName });
        });

        it(`${entry} keeps its true obligation when an equal or uncertain peer cannot receive responsibility`, () => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(containerId);
            // Qualification is the peer port's responsibility. Equal, short,
            // pending, null, legacy, unreadable and replaced peers all produce
            // this veto without an authorized transfer.
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });

            expect(() => run(f)).toThrow(incomplete);

            expect(f.peerQueries).toEqual([["project-id--p--work", active.lockFile, containerId]]);
            expect(f.trace.some(row => ["devices", "stop", "remove"].includes(String(row[0])))).toBe(false);
            expect(f.settlements).toEqual([]);
            expect(f.app.getCurrentSession()).toEqual(active);

            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: false, responsibilityTransferred: false });
            run(f);
            expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", containerId]]);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
        });

        it(`${entry} retires only its own receipt after qualified responsibility transfer without shared effects`, () => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(containerId);
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: true });

            run(f);

            expect(f.trace.some(row => row[0] === "devices" || row[0] === "stop")).toBe(false);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
            expect(f.settlements).toEqual([{
                containerId, cleanupEnabled: true, containerStopped: false, responsibilityTransferred: true,
            }]);
            expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: active.toolName });
            f.trace.length = 0;
            run(f);
            expect(f.trace).toEqual([]);
            expect(f.settlements).toHaveLength(1);
        });

        it(`${entry} releases a cleanup-false join without claiming a stop or inherited obligation`, () => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(containerId);
            f.app.setSessionCleanupEnabled(false);
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });

            run(f);

            expect(f.trace.some(row => row[0] === "devices" || row[0] === "stop")).toBe(false);
            expect(f.settlements).toEqual([{
                containerId, cleanupEnabled: false, containerStopped: false, responsibilityTransferred: false,
            }]);
            expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: active.toolName });
        });

        it.each([null, ""])(`${entry} passes an absent stop target %j to qualified retirement without inventing authority`, id => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(id);
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });

            run(f);

            expect(f.trace.some(row => row[0] === "devices" || row[0] === "stop")).toBe(false);
            expect(f.settlements).toEqual([{
                containerId: id, cleanupEnabled: true, containerStopped: false, responsibilityTransferred: false,
            }]);
        });

        it(`${entry} rechecks a transfer after failed retirement instead of discarding the retained obligation`, () => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(containerId);
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: true });
            const remove = f.ports.removeClaim;
            const failure = new Error("qualified retirement failed");
            f.ports.removeClaim = () => { throw failure; };
            expect(() => run(f)).toThrow(failure);
            expect(f.app.getCurrentSession()).toEqual(active);

            f.ports.removeClaim = remove;
            f.setPeerVetoes({ sharedDeviceCleanupBlocked: true, exactContainerStopBlocked: true, responsibilityTransferred: false });
            expect(() => run(f)).toThrow(incomplete);
            expect(f.trace.some(row => row[0] === "stop" || row[0] === "remove")).toBe(false);
            expect(f.settlements).toEqual([]);
            expect(f.app.getCurrentSession()).toEqual(active);
        });
    }
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
    it.each(["projectId", "withLifecycleLock", "peerVetoes", "removeClaim", "stopContainer"] as const)("propagates %s failure identity without finalization and permits retry", member => {
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
        const faultStage = { projectId: "project", withLifecycleLock: "lock", peerVetoes: "raw", removeClaim: "remove", stopContainer: "stop" }[member];
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
    it("propagates lock return failure after retirement without repeating cleanup on retry", () => {
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
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
        expect(f.trace.filter(row => row[0] === "stop")).toHaveLength(1);
        f.ports.withLifecycleLock = original;
        f.app.cleanupSession();
        for (const effect of ["remove", "devices", "stop"]) expect(f.trace.filter(row => row[0] === effect)).toHaveLength(1);
        expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: "custom" });
    });
});

describe("cleanup pins its target and authorization across callbacks", () => {
    const authorizationChanged = /cleanup.*authorization.*changed/i;
    const replacement = {
        lockFile: "/claims/replacement.lock", projectPath: "/replacement",
        profile: "replacement-profile", toolName: "replacement-tool",
    };
    const phases = [
        "project lookup", "guard admission", "peer lookup", "foreign peer lookup", "device cleanup",
        "diagnostic reporting", "native binding", "claim removal", "guard return",
    ] as const;

    for (const entry of ["ordinary", "held"] as const) {
        const callbacks = phases.filter(phase => entry === "ordinary" || (phase !== "guard admission" && phase !== "guard return"));
        it.each(callbacks)(`${entry} cleanup preserves a replacement session created during %s`, phase => {
            const f = fixture();
            f.setActive();
            const claims = new Set([active.lockFile, replacement.lockFile]);
            const replaceSession = () => {
                f.app.setSession(replacement.lockFile, replacement.projectPath, replacement.profile, replacement.toolName);
                f.app.setSessionContainerId("replacement-container-id");
            };
            const project = f.ports.projectId;
            const lock = f.ports.withLifecycleLock;
            const peers = f.ports.peerVetoes;
            const devices = f.ports.cleanupDevices;
            const report = f.ports.reportDeviceCleanupFailure;
            const remove = f.ports.removeClaim;
            f.ports.removeClaim = (path, settlement) => {
                remove(path, settlement);
                claims.delete(path);
                if (phase === "claim removal") replaceSession();
                return undefined;
            };
            if (phase === "project lookup") f.ports.projectId = path => {
                const id = project(path);
                replaceSession();
                return id;
            };
            if (phase === "guard admission" || phase === "guard return") {
                f.ports.withLifecycleLock = <T>(prefix: string, operation: () => T): T => {
                    const result = lock(prefix, () => {
                        if (phase === "guard admission") replaceSession();
                        return operation();
                    });
                    if (phase === "guard return") {
                        f.app.clearSession();
                        replaceSession();
                    }
                    return result;
                };
            }
            if (phase === "peer lookup" || phase === "foreign peer lookup") {
                f.setForeign(phase === "foreign peer lookup");
                f.ports.peerVetoes = (prefix, path, pinnedId) => {
                    const result = peers(prefix, path, pinnedId);
                    replaceSession();
                    return result;
                };
            }
            if (phase === "device cleanup" || phase === "diagnostic reporting") {
                f.ports.cleanupDevices = (path, timeout, profile) => {
                    devices(path, timeout, profile);
                    if (phase === "diagnostic reporting") throw "device failure";
                    replaceSession();
                    return undefined;
                };
            }
            if (phase === "diagnostic reporting") f.ports.reportDeviceCleanupFailure = error => {
                report(error);
                replaceSession();
                return undefined;
            };
            if (phase === "native binding") f.ports.stopContainer = readId => {
                expect(f.isHeld()).toBe(true);
                replaceSession();
                f.trace.push(["stop", readId()]);
                return undefined;
            };

            const effectsCompletedBeforeMutation = phase === "claim removal" || phase === "guard return";
            const run = () => entry === "held" ? f.runHeld() : f.app.cleanupSession();
            if (effectsCompletedBeforeMutation) expect(run).not.toThrow();
            else expect(run).toThrow(authorizationChanged);
            expect(f.app.getCurrentSession()).toEqual(replacement);
            expect(claims.has(replacement.lockFile)).toBe(true);
            expect(f.trace.filter(row => row[0] === "stop")).toEqual(effectsCompletedBeforeMutation ? [["stop", "captured-container-id"]] : []);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual(effectsCompletedBeforeMutation ? [["remove", active.lockFile]] : []);
            expect(claims.has(active.lockFile)).toBe(!effectsCompletedBeforeMutation);
            for (const row of f.trace.filter(row => row[0] === "devices")) {
                expect(row).toEqual(["devices", active.projectPath, 5000, active.profile]);
            }
            expect(f.isHeld()).toBe(false);
        });

        it.each([
            [null, "late-container-id"], ["captured-container-id", null],
            ["captured-container-id", "replacement-container-id"],
        ] as const)(`${entry} cleanup rejects an ID change from %j to %j and permits an explicit retry`, (before, after) => {
            const f = fixture();
            f.setActive();
            f.app.setSessionContainerId(before);
            const devices = f.ports.cleanupDevices;
            f.ports.cleanupDevices = (path, timeout, profile) => {
                devices(path, timeout, profile);
                f.app.setSessionContainerId(after);
                return undefined;
            };
            const run = () => entry === "held" ? f.runHeld() : f.app.cleanupSession();
            expect(run).toThrow(authorizationChanged);
            expect(f.trace.some(row => row[0] === "stop" || row[0] === "remove")).toBe(false);
            expect(f.app.getCurrentSession()).toEqual(active);

            f.ports.cleanupDevices = devices;
            f.app.setSessionContainerId("authorized-retry-id");
            f.trace.length = 0;
            run();
            expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "authorized-retry-id"]]);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
            expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: active.toolName });
        });

        it.each(["target away and back", "authorization revoked and regranted"] as const)(`${entry} cleanup detects %s even when final values match`, mutation => {
            const f = fixture();
            f.setActive();
            const devices = f.ports.cleanupDevices;
            f.ports.cleanupDevices = (path, timeout, profile) => {
                devices(path, timeout, profile);
                if (mutation === "target away and back") {
                    f.app.setSessionContainerId("temporary-id");
                    f.app.setSessionContainerId("captured-container-id");
                } else {
                    f.app.setSessionCleanupEnabled(false);
                    f.app.setSessionCleanupEnabled(true);
                }
                return undefined;
            };
            const run = () => entry === "held" ? f.runHeld() : f.app.cleanupSession();
            expect(run).toThrow(authorizationChanged);
            expect(f.trace.some(row => row[0] === "stop" || row[0] === "remove")).toBe(false);
            expect(f.app.getCurrentSession()).toEqual(active);

            f.ports.cleanupDevices = devices;
            run();
            expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "captured-container-id"]]);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
        });

        it(`${entry} cleanup rejects a native lazy read after an earlier read was authorized`, () => {
            const f = fixture();
            f.setActive();
            const stop = f.ports.stopContainer;
            f.ports.stopContainer = readId => {
                expect(readId()).toBe("captured-container-id");
                f.app.setSessionContainerId("replacement-container-id");
                f.trace.push(["stop", readId()]);
                return undefined;
            };
            const run = () => entry === "held" ? f.runHeld() : f.app.cleanupSession();
            expect(run).toThrow(authorizationChanged);
            expect(f.trace.some(row => row[0] === "stop" || row[0] === "remove")).toBe(false);
            expect(f.app.getCurrentSession()).toEqual(active);
            f.ports.stopContainer = stop;
            run();
            expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "replacement-container-id"]]);
        });

        it(`${entry} cleanup respects clearSession during peer lookup and permits a later session`, () => {
            const f = fixture();
            f.setActive();
            const peers = f.ports.peerVetoes;
            f.ports.peerVetoes = (prefix, path, pinnedId) => {
                const result = peers(prefix, path, pinnedId);
                f.app.clearSession();
                return result;
            };
            const run = () => entry === "held" ? f.runHeld() : f.app.cleanupSession();
            expect(run).toThrow(authorizationChanged);
            expect(f.trace.some(row => row[0] === "devices" || row[0] === "stop" || row[0] === "remove")).toBe(false);
            expect(f.app.getCurrentSession()).toEqual(initial);

            f.ports.peerVetoes = peers;
            f.setActive();
            run();
            expect(f.trace.filter(row => row[0] === "stop")).toEqual([["stop", "captured-container-id"]]);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", active.lockFile]]);
        });

        it(`${entry} cleanup preserves a replacement session's disabled shutdown authorization`, () => {
            const f = fixture();
            f.setActive();
            const devices = f.ports.cleanupDevices;
            f.ports.cleanupDevices = (path, timeout, profile) => {
                devices(path, timeout, profile);
                f.app.setSession(replacement.lockFile, replacement.projectPath, replacement.profile, replacement.toolName);
                f.app.setSessionContainerId("replacement-container-id");
                f.app.setSessionCleanupEnabled(false);
                return undefined;
            };
            const run = () => entry === "held" ? f.runHeld() : f.app.cleanupSession();
            expect(run).toThrow(authorizationChanged);
            expect(f.app.getCurrentSession()).toEqual(replacement);
            expect(f.trace.some(row => row[0] === "stop" || row[0] === "remove")).toBe(false);

            f.ports.cleanupDevices = devices;
            f.trace.length = 0;
            run();
            expect(f.trace.some(row => row[0] === "devices" || row[0] === "stop")).toBe(false);
            expect(f.trace.filter(row => row[0] === "remove")).toEqual([["remove", replacement.lockFile]]);
            expect(f.app.getCurrentSession()).toEqual({ ...initial, toolName: replacement.toolName });
        });
    }
});
