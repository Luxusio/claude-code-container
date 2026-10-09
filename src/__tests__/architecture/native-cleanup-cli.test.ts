import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { createNativeCleanupRealm, project } from "../helpers/native-cleanup-fixture.js";

function callerPair(caseName: "enabled" | "disabled" | "retry" | "device-throw" | "captured" | "successor") {
    const snapshots: unknown[] = [];
    for (const original of [true, false]) {
        const realm = createNativeCleanupRealm(original);
        try {
            realm.writeJson(realm.ownerFile("android"), { devices: [{ id: "native-a", status: "running", serial: "emulator-5554" }] });
            const session = realm.load("src/session.ts"); realm.assertZero();
            const runtime = realm.load("src/container-runtime.ts"); realm.assertZero();
            runtime._setRuntimeInfoForTest({ runtime: "docker" });
            const utils = realm.load("src/utils.ts"); realm.assertZero();
            const claim = session.createSessionLock(utils.getProjectId(project)); realm.assertZero();
            let thrown: unknown, receiptExists: boolean | undefined, failureOrder: number[] | undefined;
            if (caseName === "captured" || caseName === "successor") {
                const ownership = realm.load("src/adapters/session-ownership.ts"); realm.assertZero();
                const receipt = ownership.captureNativeSessionOwnership(claim); realm.assertZero();
                if (caseName === "successor") {
                    realm.fencedFs.unlinkSync(claim);
                    realm.fencedFs.writeFileSync(claim, "999003", { mode: 0o600 });
                }
                const composition = realm.load("src/composition/session-ownership.ts"); realm.assertZero();
                try { composition.cleanupCapturedNativeSessionOwnership({ lockFile: claim, projectPath: project, toolName: "claude" }, receipt, "fixture-container", "docker"); }
                catch (error) { thrown = error; }
                realm.assertZero();
                receiptExists = realm.fencedFs.existsSync(claim);
                if (caseName === "successor") {
                    expect(receiptExists).toBe(true);
                    expect(realm.trace.some(row => row[0] === "spawnSync" && row[1] === "/controlled/adb")).toBe(false);
                } else {
                    expect(receiptExists).toBe(false);
                    const removed = realm.trace.findIndex(row => row[0] === "fs.unlinkSync" && row[1] === realm.normalize(claim));
                    const command = realm.trace.findIndex(row => row[0] === "spawnSync" && row[1] === "/controlled/adb");
                    expect(removed).toBeGreaterThan(0); expect(command).toBeGreaterThan(removed);
                }
            } else {
                session.setSession(claim, project);
                session.setSessionContainerId("fixture-container");
                session.setSessionCleanupEnabled(caseName !== "disabled");
                if (caseName === "retry") realm.state.stopStatus = 73;
                if (caseName === "device-throw") {
                    realm.writeJson(realm.ownerFile("android"), { devices: "invalid original native state" });
                }
                try { session.cleanupSession(); } catch (error) { thrown = error; }
                realm.assertZero();
                if (caseName === "retry") {
                    expect((thrown as Error).message).toContain("shutdown failed");
                    expect(session.getCurrentSession().lockFile).toBe(claim);
                    expect(realm.fencedFs.existsSync(claim)).toBe(true);
                    realm.state.stopStatus = 0;
                    session.cleanupSession(); realm.assertZero();
                    expect(session.getCurrentSession().lockFile).toBeNull();
                } else if (caseName === "device-throw") {
                    const report = realm.trace.findIndex(row => row[0] === "error" && String(row[1]).includes("device cleanup failed"));
                    const stop = realm.trace.findIndex(row => row[0] === "spawnSync" && row[1] === "docker" && (row[2] as string[])[0] === "stop");
                    expect(report).toBeGreaterThan(0); expect(stop).toBeGreaterThan(report);
                    failureOrder = [report, stop];
                } else if (caseName === "disabled") {
                    expect(realm.trace.some(row => row[0] === "spawnSync" && ["/controlled/adb", "docker"].includes(String(row[1])))).toBe(false);
                }
                receiptExists = realm.fencedFs.existsSync(claim);
                expect(receiptExists).toBe(false);
            }
            realm.assertZero();
            if (!original) expect(realm.loaded).not.toContain("src/device-lab-admin.ts");
            snapshots.push(realm.normalize({ trace: realm.trace, thrown, receiptExists, failureOrder }));
        } finally { realm.cleanup(); }
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
}

describe("actual public session and captured cleanup callers", () => {
    it.each(["enabled", "disabled", "retry", "device-throw", "captured", "successor"] as const)("preserves real %s caller path with no whole-cleanup mocks", callerPair);
    it("executes legacy admin stop CLI through the same real extracted native authority", () => {
        const snapshots: unknown[] = [];
        for (const original of [true, false]) {
            const realm = createNativeCleanupRealm(original);
            try {
                const admin = realm.load("src/device-lab-admin.ts"); realm.assertZero();
                realm.writeJson(realm.ownerFile("android"), { devices: [{ id: "native-a", status: "running", serial: "emulator-5554" }] });
                const code = admin.devicesCli(["stop", "native-a"], project);
                realm.assertZero(); expect(code).toBe(0);
                expect(realm.trace.some(row => row[0] === "spawnSync" && row[1] === "/controlled/adb")).toBe(true);
                snapshots.push(realm.normalize({ code, trace: realm.trace, state: realm.readJson(realm.ownerFile("android")) }));
                realm.assertZero();
            } finally { realm.cleanup(); }
        }
        expect(snapshots[1]).toEqual(snapshots[0]);
    });
    it("denies unallocated child spawning as a negative authority control", () => {
        // This is only an authority negative control. It does not load index or
        // prove CLI breadth/startup; existing boxed entrypoint captures retain
        // their separately recorded 8/10/30s budgets and limitations.
        const realm = createNativeCleanupRealm(false);
        try {
            realm.assertZero();
            expect(() => realm.childProcess.spawn("docker", ["run"])).toThrow("DENIED");
            expect(realm.denied).toBe(1);
            expect(path.basename(realm.home)).toMatch(/^ccc-native-cleanup-pair-/);
        } finally { realm.cleanup(); }
    });
});
