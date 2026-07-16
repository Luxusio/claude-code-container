import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";
import { withOwnerDeviceOperation } from "../../device-lab-mcp/src/state/device-store.mjs";
import { updateMacosDevice } from "../../device-lab-mcp/src/state/macos-state.mjs";
import { cleanupFakeMacosMcpContext, createFakeMacosMcpContext, type FakeMacosMcpContext } from "./helpers/fake-macos-mcp-fixture.js";

describe("macOS VM backend with fake Tart provider", () => {
    let context: FakeMacosMcpContext;
    let logPath: string;
    let homeDir: string;

    beforeAll(() => {
        context = createFakeMacosMcpContext();
        logPath = context.logPath;
        homeDir = context.homeDir;
    });

    afterAll(() => {
        cleanupFakeMacosMcpContext(context);
    });

    function macosStatePath() {
        const ownersRoot = join(homeDir, ".ccc", "devices", "owners");
        return join(ownersRoot, readdirSync(ownersRoot)[0], "macos", "devices.json");
    }

    function armMacosReplacement(command: string, deviceId: string) {
        const statePath = macosStatePath();
        const state = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: Array<Record<string, unknown>> };
        const original = state.devices.find((device) => device.id === deviceId);
        if (!original) throw new Error(`Missing macOS test device: ${deviceId}`);
        const successor = {
            ...original,
            status: "running",
            provider: "tart",
            providerInstance: `${String(original.providerInstance)}-successor`,
            runtime: { runtimeId: "successor-runtime", providerPid: 999999 },
            lifecycle: { runtimeId: "successor-lifecycle", operation: "start", claimedAt: new Date().toISOString() },
            successorMarker: command,
        };
        const replacementPath = join(homeDir, `macos-${command}-replacement.json`);
        writeFileSync(replacementPath, JSON.stringify({
            devices: state.devices.map((device) => device.id === deviceId ? successor : device),
        }));
        process.env.FAKE_TART_REPLACE_ON = command;
        process.env.FAKE_TART_REPLACEMENT_STATE = replacementPath;
        process.env.FAKE_TART_TARGET_STATE = statePath;
        return { statePath, successor };
    }

    function disarmMacosReplacement() {
        delete process.env.FAKE_TART_REPLACE_ON;
        delete process.env.FAKE_TART_REPLACEMENT_STATE;
        delete process.env.FAKE_TART_TARGET_STATE;
    }

    it("reports missing macOS snapshot targets as device errors instead of unknown tools", async () => {
        for (const tool of ["device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete"]) {
            const result = await handleMacosTool(tool, {
                deviceId: "missing-macos-device",
                snapshotName: "missing-snapshot",
            });
            expect(result?.isError).toBe(true);
            expect((result?.content as Array<{ text?: string }>)[0].text).toContain("Unknown macOS device: missing-macos-device");
        }
    });

    it("recovers stale lifecycle claims before accepting a new mutation", async () => {
        const deviceId = "macos-stale-lifecycle";
        const created = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Stale Lifecycle",
            deviceId,
            provider: "tart",
        });
        expect(created?.isError).not.toBe(true);
        updateMacosDevice(deviceId, (device) => ({
            ...device,
            status: "starting",
            lifecycle: {
                runtimeId: "interrupted-start",
                operation: "start",
                claimedAt: "2020-01-01T00:00:00.000Z",
                previousStatus: "stopped",
            },
        }));

        const logBefore = readFileSync(logPath, { encoding: "utf-8", flag: "a+" });
        const started = await handleMacosTool("device_start", { deviceId });
        expect(started?.isError, (started?.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
        const persisted = JSON.parse(readFileSync(macosStatePath(), "utf-8")) as {
            devices: Array<{ id: string; lifecycle?: unknown; status: string; lastLifecycleRecovery?: { runtimeId: string } }>;
        };
        expect(persisted.devices.find((device) => device.id === deviceId)).toEqual(expect.objectContaining({
            status: "running",
            lastLifecycleRecovery: expect.objectContaining({ runtimeId: "interrupted-start" }),
        }));
        expect(persisted.devices.find((device) => device.id === deviceId)?.lifecycle).toBeUndefined();
        const newLog = readFileSync(logPath, "utf-8").slice(logBefore.length);
        expect(newLog).toContain(`tart stop ccc-`);
        expect(newLog).toMatch(/tart run (?:--with-softnet )?ccc-/);

        expect((await handleMacosTool("device_stop", { deviceId }))?.isError).not.toBe(true);
        expect((await handleMacosTool("device_delete", { deviceId }))?.isError).not.toBe(true);
        writeFileSync(logPath, "");
    });

    it("deletes a Tart clone target after the clone command times out", async () => {
        const tartPath = join(context.binDir, "tart");
        const originalTart = readFileSync(tartPath, "utf-8");
        const resources = join(homeDir, "timeout-clone-resources");
        mkdirSync(resources);
        writeFileSync(tartPath, `#!${process.execPath}\n`
            + `const fs = require("fs");\n`
            + `const path = require("path");\n`
            + `const args = process.argv.slice(2);\n`
            + `fs.appendFileSync(process.env.FAKE_TART_LOG, "tart " + args.join(" ") + "\\n");\n`
            + `const resource = (name) => path.join(process.env.FAKE_TART_TIMEOUT_RESOURCE_DIR, encodeURIComponent(name));\n`
            + `if (args[0] === "run" && args[1] === "--help") process.exit(0);\n`
            + `if (args[0] === "clone") { fs.writeFileSync(resource(args[2]), "partial"); const deadline = Date.now() + 10000; while (Date.now() < deadline) {} }\n`
            + `if (args[0] === "delete") { fs.rmSync(resource(args[1]), {force:true}); process.exit(0); }\n`
            + `process.exit(0);\n`);
        chmodSync(tartPath, 0o755);
        process.env.FAKE_TART_TIMEOUT_RESOURCE_DIR = resources;
        process.env.CCC_MACOS_VM_CLONE_TIMEOUT_MS = "50";
        process.env.CCC_MACOS_VM_DELETE_TIMEOUT_MS = "1000";
        try {
            const result = await handleMacosTool("device_base_image_create", {
                backend: "macos-vm",
                name: "Timeout Clone",
                sourceImage: "ghcr.io/example/macos:latest",
                provider: "tart",
            });
            expect(result?.isError).toBe(true);
            expect((result?.content as Array<{ text?: string }>)[0].text).toContain("macos-tart-clone-failed");
            expect(readdirSync(resources)).toEqual([]);
            expect(readFileSync(logPath, "utf-8")).toContain("tart delete ccc-");
        } finally {
            writeFileSync(tartPath, originalTart);
            chmodSync(tartPath, 0o755);
            delete process.env.FAKE_TART_TIMEOUT_RESOURCE_DIR;
            delete process.env.CCC_MACOS_VM_CLONE_TIMEOUT_MS;
            delete process.env.CCC_MACOS_VM_DELETE_TIMEOUT_MS;
            writeFileSync(logPath, "");
        }
    });

    it("does not persist a Tart process that exits successfully during startup as running", async () => {
        const deviceId = "macos-immediate-exit";
        const created = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Immediate Exit",
            deviceId,
            provider: "tart",
        });
        expect(created?.isError).not.toBe(true);
        process.env.FAKE_TART_RUN_EXIT_IMMEDIATELY = "1";
        try {
            const started = await handleMacosTool("device_start", { deviceId });
            expect(started?.isError).toBe(true);
            expect((started?.content as Array<{ text?: string }>)[0].text).toContain("exited before it was ready: exit 0");
            const state = JSON.parse(readFileSync(macosStatePath(), "utf-8")) as {
                devices: Array<{ id: string; status: string; lifecycle?: unknown; runtime?: unknown }>;
            };
            const persisted = state.devices.find((device) => device.id === deviceId);
            expect(persisted).toEqual(expect.objectContaining({ status: "stopped" }));
            expect(persisted?.lifecycle).toBeUndefined();
            expect(persisted?.runtime).toBeUndefined();
        } finally {
            delete process.env.FAKE_TART_RUN_EXIT_IMMEDIATELY;
        }
        expect((await handleMacosTool("device_delete", { deviceId }))?.isError).not.toBe(true);
        writeFileSync(logPath, "");
    });

    it("serializes snapshot mutations with other device runtime operations", async () => {
        const created = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Snapshot Lock",
            provider: "tart",
            image: "ghcr.io/example/macos:latest",
        });
        expect(created?.isError).not.toBe(true);
        const deviceId = "macos-snapshot-lock";
        let release!: () => void;
        let entered!: () => void;
        const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const holder = withOwnerDeviceOperation("macos", deviceId, async () => {
            entered();
            await gate;
        });
        await enteredLock;

        let settled = false;
        const snapshot = handleMacosTool("device_snapshot_create", {
            deviceId,
            snapshotName: "serialized-snapshot",
        }).then((result) => {
            settled = true;
            return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);

        release();
        await holder;
        const result = await snapshot;
        expect(result?.isError).not.toBe(true);
        const deleted = await handleMacosTool("device_delete", { deviceId });
        expect(deleted?.isError).not.toBe(true);
    });

    it("fences direct lifecycle generations and preserves exact same-id successors", async () => {
        const create = async (deviceId: string, managed = false) => {
            const result = await handleMacosTool(managed ? "device_base_image_create" : "device_create", managed ? {
                backend: "macos-vm",
                name: deviceId,
                deviceId,
                sourceImage: "ghcr.io/example/macos:latest",
                provider: "tart",
            } : {
                backend: "macos-vm",
                name: deviceId,
                deviceId,
                provider: "tart",
            });
            expect(result?.isError).not.toBe(true);
        };
        const persisted = (deviceId: string) => {
            const state = JSON.parse(readFileSync(macosStatePath(), "utf-8")) as { devices: Array<Record<string, unknown>> };
            return state.devices.find((device) => device.id === deviceId);
        };
        const cleanupSuccessor = async (deviceId: string) => {
            updateMacosDevice(deviceId, (device) => {
                const cleaned = {
                    ...device,
                    status: "stopped",
                    runtime: null,
                    providerResourceManaged: false,
                    imageSource: null,
                    provisioning: null,
                    clonedFrom: null,
                    imageCreatedAt: null,
                    clonedAt: null,
                    restoreRecovery: null,
                    snapshots: [],
                };
                delete cleaned.lifecycle;
                return cleaned;
            });
            const deleted = await handleMacosTool("device_delete", { deviceId });
            expect(deleted?.isError).not.toBe(true);
        };

        await create("macos-generation-duplicate-start");
        const firstStart = await handleMacosTool("device_start", { deviceId: "macos-generation-duplicate-start" });
        expect(firstStart?.isError).not.toBe(true);
        const beforeDuplicate = readFileSync(logPath, "utf-8");
        const duplicate = await handleMacosTool("device_start", { deviceId: "macos-generation-duplicate-start" });
        expect(duplicate?.isError).toBe(true);
        expect((duplicate?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start");
        expect(readFileSync(logPath, "utf-8")).toBe(beforeDuplicate);
        await handleMacosTool("device_stop", { deviceId: "macos-generation-duplicate-start" });
        await handleMacosTool("device_delete", { deviceId: "macos-generation-duplicate-start" });

        await create("macos-fail-delete-force", true);
        const forceDeleteStart = await handleMacosTool("device_start", { deviceId: "macos-fail-delete-force" });
        expect(forceDeleteStart?.isError).not.toBe(true);
        const forceDeleteFailure = await handleMacosTool("device_delete", { deviceId: "macos-fail-delete-force", force: true });
        expect(forceDeleteFailure?.isError).toBe(true);
        expect(persisted("macos-fail-delete-force")).toEqual(expect.objectContaining({
            status: "stopped",
            runtime: null,
            recording: null,
            bootReady: false,
            lastBootCheck: null,
        }));
        await cleanupSuccessor("macos-fail-delete-force");

        for (const scenario of [
            { command: "run", operation: "device_start", deviceId: "macos-generation-start", managed: false },
            { command: "stop", operation: "device_stop", deviceId: "macos-generation-stop", managed: false },
            { command: "delete", operation: "device_delete", deviceId: "macos-generation-delete", managed: true },
        ]) {
            await create(scenario.deviceId, scenario.managed);
            if (scenario.operation === "device_stop") {
                const started = await handleMacosTool("device_start", { deviceId: scenario.deviceId });
                expect(started?.isError).not.toBe(true);
            }
            const armed = armMacosReplacement(scenario.command, scenario.deviceId);
            let result;
            try {
                result = await handleMacosTool(scenario.operation, { deviceId: scenario.deviceId });
            } finally {
                disarmMacosReplacement();
            }
            expect(result?.isError, `${scenario.operation}: ${(result?.content as Array<{ text?: string }>)[0]?.text}`).toBe(true);
            expect((result?.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
            expect(persisted(scenario.deviceId)).toEqual(armed.successor);
            await cleanupSuccessor(scenario.deviceId);
        }

        for (const scenario of [
            { operation: "device_snapshot_create", command: "clone", deviceId: "macos-generation-snapshot-create", snapshotName: "Race Create", seed: false },
            { operation: "device_snapshot_delete", command: "delete", deviceId: "macos-generation-snapshot-delete", snapshotName: "Race Delete", seed: true },
            { operation: "device_snapshot_restore", command: "clone", deviceId: "macos-generation-snapshot-restore", snapshotName: "Race Restore", seed: true },
        ]) {
            await create(scenario.deviceId, true);
            if (scenario.seed) {
                const seeded = await handleMacosTool("device_snapshot_create", { deviceId: scenario.deviceId, snapshotName: scenario.snapshotName });
                expect(seeded?.isError).not.toBe(true);
            }
            const original = persisted(scenario.deviceId) as { providerInstance: string };
            const armed = armMacosReplacement(scenario.command, scenario.deviceId);
            const logBefore = readFileSync(logPath, "utf-8");
            let result;
            try {
                result = await handleMacosTool(scenario.operation, { deviceId: scenario.deviceId, snapshotName: scenario.snapshotName });
            } finally {
                disarmMacosReplacement();
            }
            expect(result?.isError, `${scenario.operation}: ${(result?.content as Array<{ text?: string }>)[0]?.text}`).toBe(true);
            expect((result?.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
            expect(persisted(scenario.deviceId)).toEqual(armed.successor);
            if (scenario.operation === "device_snapshot_restore") {
                expect(readFileSync(logPath, "utf-8").slice(logBefore.length)).not.toContain(`tart delete ${original.providerInstance}\n`);
            }
            await cleanupSuccessor(scenario.deviceId);
        }

        await create("macos-generation-clone-source", true);
        const cloneSource = armMacosReplacement("clone", "macos-generation-clone-source");
        let cloned;
        try {
            cloned = await handleMacosTool("device_base_image_clone", {
                backend: "macos-vm",
                name: "Generation Clone Target",
                deviceId: "macos-generation-clone-target",
                sourceDeviceId: "macos-generation-clone-source",
            });
        } finally {
            disarmMacosReplacement();
        }
        expect(cloned?.isError).toBe(true);
        expect((cloned?.content as Array<{ text?: string }>)[0].text).toContain("owner-device-state-conflict");
        expect(persisted("macos-generation-clone-source")).toEqual(cloneSource.successor);
        expect(persisted("macos-generation-clone-target")).toBeUndefined();
        await cleanupSuccessor("macos-generation-clone-source");
        writeFileSync(logPath, "");
    });

    it("registers a restore candidate before primary deletion and resumes after interruption", async () => {
        const tartPath = join(context.binDir, "tart");
        const originalTart = readFileSync(tartPath, "utf-8");
        const resourceDir = join(homeDir, "stateful-tart-resources");
        const interruptionPath = join(homeDir, "stateful-tart-interrupted");
        const cleanupInterruptionPath = join(homeDir, "stateful-tart-cleanup-interrupted");
        mkdirSync(resourceDir);
        writeFileSync(tartPath, `#!${process.execPath}\n`
            + `const fs = require("fs");\n`
            + `const path = require("path");\n`
            + `const args = process.argv.slice(2);\n`
            + `fs.appendFileSync(process.env.FAKE_TART_LOG, "tart " + args.join(" ") + "\\n");\n`
            + `const resource = (name) => path.join(process.env.FAKE_TART_RESOURCE_DIR, encodeURIComponent(name));\n`
            + `if (args[0] === "run" && args[1] === "--help") { console.log("Usage: tart run [--with-softnet]"); process.exit(0); }\n`
            + `if (args[0] === "clone") {\n`
            + `  if (!fs.existsSync(resource(args[1])) || fs.existsSync(resource(args[2]))) process.exit(7);\n`
            + `  fs.writeFileSync(resource(args[2]), args[1]);\n`
            + `  process.exit(0);\n`
            + `}\n`
            + `if (args[0] === "delete") {\n`
            + `  if (!fs.existsSync(resource(args[1]))) process.exit(6);\n`
            + `  if (args[1] === process.env.FAKE_TART_PRIMARY) {\n`
            + `    const state = JSON.parse(fs.readFileSync(process.env.FAKE_TART_STATE, "utf8"));\n`
            + `    const device = state.devices.find((item) => item.id === process.env.FAKE_TART_DEVICE_ID);\n`
            + `    if (!device.restoreRecovery?.candidateProviderInstance) process.exit(20);\n`
            + `  }\n`
            + `  if (args[1] !== process.env.FAKE_TART_PRIMARY && fs.existsSync(resource(process.env.FAKE_TART_PRIMARY)) && !fs.existsSync(process.env.FAKE_TART_CLEANUP_INTERRUPTED)) {\n`
            + `    const state = JSON.parse(fs.readFileSync(process.env.FAKE_TART_STATE, "utf8"));\n`
            + `    const device = state.devices.find((item) => item.id === process.env.FAKE_TART_DEVICE_ID);\n`
            + `    if (device.restoreRecovery?.phase === "activated") {\n`
            + `      delete device.lifecycle;\n`
            + `      fs.writeFileSync(process.env.FAKE_TART_STATE, JSON.stringify(state));\n`
            + `      fs.writeFileSync(process.env.FAKE_TART_CLEANUP_INTERRUPTED, "1");\n`
            + `      process.exit(0);\n`
            + `    }\n`
            + `  }\n`
            + `  fs.rmSync(resource(args[1]));\n`
            + `  if (args[1] === process.env.FAKE_TART_PRIMARY && !fs.existsSync(process.env.FAKE_TART_INTERRUPTED)) {\n`
            + `    const state = JSON.parse(fs.readFileSync(process.env.FAKE_TART_STATE, "utf8"));\n`
            + `    const device = state.devices.find((item) => item.id === process.env.FAKE_TART_DEVICE_ID);\n`
            + `    delete device.lifecycle;\n`
            + `    fs.writeFileSync(process.env.FAKE_TART_STATE, JSON.stringify(state));\n`
            + `    fs.writeFileSync(process.env.FAKE_TART_INTERRUPTED, "1");\n`
            + `  }\n`
            + `  process.exit(0);\n`
            + `}\n`
            + `process.exit(0);\n`);
        chmodSync(tartPath, 0o755);

        const deviceId = "macos-stateful-restore";
        process.env.FAKE_TART_RESOURCE_DIR = resourceDir;
        process.env.FAKE_TART_INTERRUPTED = interruptionPath;
        process.env.FAKE_TART_CLEANUP_INTERRUPTED = cleanupInterruptionPath;
        process.env.FAKE_TART_DEVICE_ID = deviceId;
        try {
            const created = await handleMacosTool("device_create", {
                backend: "macos-vm",
                name: "Stateful Restore",
                deviceId,
                provider: "tart",
            });
            expect(created?.isError).not.toBe(true);
            const createdPayload = JSON.parse(((created?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                device: { providerInstance: string };
            };
            const primary = createdPayload.device.providerInstance;
            process.env.FAKE_TART_PRIMARY = primary;
            process.env.FAKE_TART_STATE = macosStatePath();
            writeFileSync(join(resourceDir, encodeURIComponent(primary)), "primary");

            const snapshot = await handleMacosTool("device_snapshot_create", {
                deviceId,
                snapshotName: "Crash Point",
            });
            expect(snapshot?.isError).not.toBe(true);

            const interrupted = await handleMacosTool("device_snapshot_restore", {
                deviceId,
                snapshotName: "Crash Point",
            });
            expect(interrupted?.isError).toBe(true);
            const interruptedState = JSON.parse(readFileSync(macosStatePath(), "utf-8")) as {
                devices: Array<{ id: string; lifecycle?: unknown; restoreRecovery?: { candidateProviderInstance: string } }>;
            };
            const interruptedDevice = interruptedState.devices.find((item) => item.id === deviceId);
            const candidate = interruptedDevice?.restoreRecovery?.candidateProviderInstance;
            expect(candidate).toContain("-restore-");
            expect(interruptedDevice?.lifecycle).toBeUndefined();
            expect(existsSync(join(resourceDir, encodeURIComponent(primary)))).toBe(false);
            expect(existsSync(join(resourceDir, encodeURIComponent(candidate!)))).toBe(true);

            const interruptedCleanup = await handleMacosTool("device_snapshot_restore", {
                deviceId,
                snapshotName: "Crash Point",
            });
            expect(interruptedCleanup?.isError).toBe(true);
            expect(existsSync(join(resourceDir, encodeURIComponent(primary)))).toBe(true);
            expect(existsSync(join(resourceDir, encodeURIComponent(candidate!)))).toBe(true);
            const activatedState = JSON.parse(readFileSync(macosStatePath(), "utf-8")) as {
                devices: Array<{ id: string; restoreRecovery?: { phase: string } }>;
            };
            expect(activatedState.devices.find((item) => item.id === deviceId)?.restoreRecovery?.phase).toBe("activated");

            const resumed = await handleMacosTool("device_snapshot_restore", {
                deviceId,
                snapshotName: "Crash Point",
            });
            expect(resumed?.isError).not.toBe(true);
            expect(existsSync(join(resourceDir, encodeURIComponent(primary)))).toBe(true);
            expect(existsSync(join(resourceDir, encodeURIComponent(candidate!)))).toBe(false);
            const resumedPayload = JSON.parse(((resumed?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
                device: { restoreRecovery: unknown; restoredFrom: { name: string } };
            };
            expect(resumedPayload.device.restoreRecovery).toBeNull();
            expect(resumedPayload.device.restoredFrom.name).toBe("Crash Point");
        } finally {
            writeFileSync(tartPath, originalTart);
            chmodSync(tartPath, 0o755);
            delete process.env.FAKE_TART_RESOURCE_DIR;
            delete process.env.FAKE_TART_INTERRUPTED;
            delete process.env.FAKE_TART_CLEANUP_INTERRUPTED;
            delete process.env.FAKE_TART_DEVICE_ID;
            delete process.env.FAKE_TART_PRIMARY;
            delete process.env.FAKE_TART_STATE;
        }
    });

    it("plans, starts, stops, and diagnoses helper-required operations without provider calls on create", async () => {
        const create = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fake Tart",
            provider: "auto",
            image: "ghcr.io/example/macos:latest",
            memoryMb: 4096,
            cpus: 2,
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(create?.isError).not.toBe(true);
        const created = JSON.parse(((create?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerPlan: { selectedProvider: string; providerInstance: string; startCommand: { args: string[] }; helper: { workspaceDir: string; hostHelperScript: string; remoteScriptPath: string }; implemented: string[]; deferred: string[] } };
        };
        expect(created.device.id).toBe("macos-fake-tart");
        expect(created.device.providerPlan.selectedProvider).toBe("tart");
        expect(created.device.providerPlan.providerInstance).toContain("macos-fake-tart");
        expect(created.device.providerPlan.startCommand.args).toEqual(["run", created.device.providerPlan.providerInstance]);
        expect(created.device.providerPlan.helper.workspaceDir).toContain("macos-fake-tart");
        expect(created.device.providerPlan.helper.remoteScriptPath).toBe("/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(created.device.providerPlan.implemented).toEqual(expect.arrayContaining(["base-image-clone", "snapshot-clone", "provider-delete"]));
        expect(created.device.providerPlan.deferred).toEqual([]);
        expect(existsSync(created.device.providerPlan.helper.hostHelperScript)).toBe(false);
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const sshKey = join(homeDir, "id_ed25519");
        const sshKeyLink = join(homeDir, "linked-key");
        writeFileSync(sshKey, "private-key");
        symlinkSync(sshKey, sshKeyLink);
        const symlinkKeyCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Symlink Key",
            provider: "auto",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
            sshKeyPath: sshKeyLink,
        });
        expect(symlinkKeyCreate?.isError).toBe(true);
        expect((symlinkKeyCreate?.content as Array<{ text?: string }>)[0].text).toContain("ssh-key-path-symlink-rejected");

        const mutableSshKey = join(homeDir, "mutable-id-ed25519");
        const mutableSshKeyTarget = join(homeDir, "mutable-id-ed25519-target");
        writeFileSync(mutableSshKey, "private-key");
        writeFileSync(mutableSshKeyTarget, "private-key-target");
        const mutableKeyCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Mutable Key",
            provider: "auto",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
            sshKeyPath: mutableSshKey,
        });
        expect(mutableKeyCreate?.isError).not.toBe(true);
        rmSync(mutableSshKey, { force: true });
        symlinkSync(mutableSshKeyTarget, mutableSshKey);
        const mutableKeyExec = await handleMacosTool("device_exec", {
            deviceId: "macos-mutable-key",
            command: "whoami",
        });
        expect(mutableKeyExec?.isError).toBe(true);
        expect((mutableKeyExec?.content as Array<{ text?: string }>)[0].text).toContain("ssh-key-path-symlink-rejected");
        const logBeforeMutableKeyStart = readFileSync(logPath, "utf-8");
        const mutableKeyStart = await handleMacosTool("device_start", { deviceId: "macos-mutable-key" });
        expect(mutableKeyStart?.isError).toBe(true);
        expect((mutableKeyStart?.content as Array<{ text?: string }>)[0].text).toContain("ssh-key-path-symlink-rejected");
        expect(readFileSync(logPath, "utf-8").slice(logBeforeMutableKeyStart.length)).not.toContain("tart run");

        const inventory = await handleMacosTool("device_inventory", { backend: "macos-vm" });
        expect(inventory?.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; providerPlan: { selectedProvider: string; startCommand: { args: string[] } } }>;
            discovery: { available: boolean; providers: Array<{ name: string }> };
            hostVms: { lazy: boolean; providers: Array<{ name: string }> };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.discovery.providers.map((provider) => provider.name)).toEqual(expect.arrayContaining(["tart", "vz"]));
        expect(inventoryPayload.hostVms).toEqual(expect.objectContaining({ lazy: true }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "macos-fake-tart",
                providerPlan: expect.objectContaining({
                    selectedProvider: "tart",
                    startCommand: expect.objectContaining({ args: ["run", created.device.providerPlan.providerInstance] }),
                }),
            }),
        ]));
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const passwordCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Password Tart",
            provider: "auto",
            image: "ccc-macos-base",
        });
        expect(passwordCreate?.isError).not.toBe(true);
        const passwordCreated = JSON.parse(((passwordCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { ssh: { user?: string; password?: string; passwordConfigured?: boolean }; providerPlan: { helper: { ssh: { user?: string; password?: string; passwordConfigured?: boolean } } } };
        };
        expect(passwordCreated.device.ssh.user).toBe("admin");
        expect(passwordCreated.device.ssh.password).toBeUndefined();
        expect(passwordCreated.device.ssh.passwordConfigured).toBe(true);
        expect(passwordCreated.device.providerPlan.helper.ssh.user).toBe("admin");
        expect(passwordCreated.device.providerPlan.helper.ssh.password).toBeUndefined();
        expect(passwordCreated.device.providerPlan.helper.ssh.passwordConfigured).toBe(true);
        updateMacosDevice("macos-password-tart", (device) => ({
            ...device,
            ssh: {
                ...device.ssh,
                host: "127.0.0.1",
                port: 2222,
            },
        }));

        const passwordStart = await handleMacosTool("device_start", { deviceId: "macos-password-tart" });
        expect(passwordStart?.isError).not.toBe(true);
        const passwordExec = await handleMacosTool("device_exec", {
            deviceId: "macos-password-tart",
            command: "whoami",
        });
        expect(passwordExec?.isError).not.toBe(true);
        const passwordLog = readFileSync(logPath, "utf-8");
        expect(passwordLog).toContain("scp -P 2222 -o BatchMode=no -o PubkeyAuthentication=no -o StrictHostKeyChecking=no");
        expect(passwordLog).toContain("ssh -p 2222 -o BatchMode=no -o PubkeyAuthentication=no -o StrictHostKeyChecking=no admin@127.0.0.1 whoami");

        const imageCreate = await handleMacosTool("device_base_image_create", {
            backend: "macos-vm",
            name: "Base Image",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
            memoryMb: 4096,
            cpus: 2,
        });
        expect(imageCreate?.isError).not.toBe(true);
        const imageCreated = JSON.parse(((imageCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            operation: string;
            device: { id: string; provider: string; providerInstance: string; imageSource: string; provisioning: string };
        };
        expect(imageCreated.operation).toBe("base-image-create");
        expect(imageCreated.device).toEqual(expect.objectContaining({
            id: "macos-base-image",
            provider: "tart",
            imageSource: "ghcr.io/example/macos-base:latest",
            provisioning: "image-created",
        }));
        expect(imageCreated.device.providerInstance).toContain("macos-base-image");

        const imageClone = await handleMacosTool("device_base_image_clone", {
            backend: "macos-vm",
            name: "Base Clone",
            sourceDeviceId: "macos-base-image",
        });
        expect(imageClone?.isError).not.toBe(true);
        const imageCloned = JSON.parse(((imageClone?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            operation: string;
            device: { id: string; provider: string; providerInstance: string; clonedFrom: { deviceId: string; providerInstance: string }; provisioning: string };
        };
        expect(imageCloned.operation).toBe("base-image-clone");
        expect(imageCloned.device).toEqual(expect.objectContaining({
            id: "macos-base-clone",
            provider: "tart",
            provisioning: "image-cloned",
        }));
        expect(imageCloned.device.clonedFrom.deviceId).toBe("macos-base-image");
        expect(imageCloned.device.clonedFrom.providerInstance).toBe(imageCreated.device.providerInstance);

        const imageSnapshotForCascadeDelete = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-base-image",
            snapshotName: "Delete Cascade",
        });
        expect(imageSnapshotForCascadeDelete?.isError).not.toBe(true);
        const imageSnapshotPayload = JSON.parse(((imageSnapshotForCascadeDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };

        const startBaseImage = await handleMacosTool("device_start", { deviceId: "macos-base-image" });
        expect(startBaseImage?.isError).not.toBe(true);
        const startedBaseImage = JSON.parse(((startBaseImage?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            helper: { status: string };
            device: { helper: { provisioning: { status: string } } };
        };
        expect(startedBaseImage.helper.status).toBe("skipped-missing-ssh");
        expect(startedBaseImage.device.helper.provisioning.status).toBe("skipped-missing-ssh");
        const baseStatusAfterSkippedHelper = await handleMacosTool("device_status", { deviceId: "macos-base-image" });
        const baseStatusAfterSkippedHelperPayload = JSON.parse(((baseStatusAfterSkippedHelper?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { status: string; provisioning: { status: string } } };
        };
        expect(baseStatusAfterSkippedHelperPayload.device.helper.status).toBe("skipped-missing-ssh");
        expect(baseStatusAfterSkippedHelperPayload.device.helper.provisioning.status).toBe("skipped-missing-ssh");
        const forceClone = await handleMacosTool("device_base_image_clone", {
            backend: "macos-vm",
            name: "Forced Clone",
            sourceDeviceId: "macos-base-image",
            force: true,
        });
        expect(forceClone?.isError).not.toBe(true);
        const baseStatusAfterForceClone = await handleMacosTool("device_status", { deviceId: "macos-base-image" });
        const baseAfterForceClone = JSON.parse(((baseStatusAfterForceClone?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string };
        };
        expect(baseAfterForceClone.device.status).toBe("stopped");

        const unsupportedProvider = await handleMacosTool("device_base_image_create", {
            backend: "macos-vm",
            name: "Unsupported VZ Image",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "vz",
        });
        expect(unsupportedProvider?.isError).toBe(true);
        expect((unsupportedProvider?.content as Array<{ text?: string }>)[0].text).toContain("Tart is currently required");

        const headlessCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Headless Tart",
            provider: "auto",
        });
        expect(headlessCreate?.isError).not.toBe(true);
        const headlessStart = await handleMacosTool("device_start", { deviceId: "macos-headless-tart", headless: true, waitForBoot: true, bootTimeoutMs: 1000 });
        expect(headlessStart?.isError).not.toBe(true);
        const headlessStarted = JSON.parse(((headlessStart?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { headless: boolean; bootReady: boolean; lastBootCheck: { ready: boolean; ip: string }; runtime: { detached: boolean; providerPid: number; startCommand: { args: string[] } } };
            providerStart: { detached: boolean; providerPid: number; startCommand: { args: string[] } };
            boot: { ready: boolean; ip: string; provider: string };
        };
        expect(headlessStarted.device.headless).toBe(true);
        expect(headlessStarted.boot).toEqual(expect.objectContaining({ ready: true, ip: "192.0.2.44", provider: "tart" }));
        expect(headlessStarted.device.bootReady).toBe(true);
        expect(headlessStarted.device.lastBootCheck).toEqual(expect.objectContaining({ ready: true, ip: "192.0.2.44" }));
        expect(headlessStarted.providerStart).toEqual(expect.objectContaining({
            detached: true,
            providerPid: expect.any(Number),
        }));
        expect(headlessStarted.providerStart.startCommand.args).toEqual(["run", "--with-softnet", "--no-graphics", headlessStarted.providerStart.startCommand.args.at(-1)]);
        expect(headlessStarted.device.runtime.startCommand.args).toEqual(headlessStarted.providerStart.startCommand.args);
        const headlessStop = await handleMacosTool("device_stop", { deviceId: "macos-headless-tart" });
        const headlessStopped = JSON.parse(((headlessStop?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean; lastBootCheck: null; runtime: null };
        };
        expect(headlessStopped.device).toEqual(expect.objectContaining({
            status: "stopped",
            bootReady: false,
            lastBootCheck: null,
            runtime: null,
        }));
        await handleMacosTool("device_delete", { deviceId: "macos-headless-tart" });

        const arpFallbackCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "ARP Fallback",
            deviceId: "macos-arp-fallback",
            provider: "tart",
        });
        expect(arpFallbackCreate?.isError).not.toBe(true);
        const arpFallbackStart = await handleMacosTool("device_start", { deviceId: "macos-arp-fallback", waitForBoot: true, bootTimeoutMs: 1000 });
        expect(arpFallbackStart?.isError).not.toBe(true);
        const arpFallbackStarted = JSON.parse(((arpFallbackStart?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            boot: { ready: boolean; ip: string; resolver: string; attempts: Array<{ resolver: string; status: number }> };
            device: { lastBootCheck: { resolver: string } };
        };
        expect(arpFallbackStarted.boot).toEqual(expect.objectContaining({
            ready: true,
            ip: "192.0.2.45",
            resolver: "arp",
        }));
        expect(arpFallbackStarted.boot.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ resolver: "dhcp-leases", status: 1 }),
            expect.objectContaining({ resolver: "arp", status: 0 }),
        ]));
        expect(arpFallbackStarted.device.lastBootCheck).toEqual(expect.objectContaining({ resolver: "arp" }));
        await handleMacosTool("device_stop", { deviceId: "macos-arp-fallback" });
        await handleMacosTool("device_delete", { deviceId: "macos-arp-fallback" });

        const inferredSshCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Inferred SSH Host",
            provider: "tart",
            sshUser: "ccc",
        });
        expect(inferredSshCreate?.isError).not.toBe(true);
        const inferredSshStart = await handleMacosTool("device_start", {
            deviceId: "macos-inferred-ssh-host",
            waitForBoot: true,
            bootTimeoutMs: 1000,
        });
        expect(inferredSshStart?.isError).not.toBe(true);
        const inferredSshStarted = JSON.parse(((inferredSshStart?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { ssh: { host: string; user: string }; provisioning: { status: string; provider: string } } };
            helper: { status: string; provider: string };
            boot: { ip: string };
        };
        expect(inferredSshStarted.boot.ip).toBe("192.0.2.44");
        expect(inferredSshStarted.helper).toEqual(expect.objectContaining({ status: "provisioned", provider: "ssh-scp" }));
        expect(inferredSshStarted.device.helper.ssh).toEqual(expect.objectContaining({
            host: "192.0.2.44",
            user: "ccc",
        }));
        expect(inferredSshStarted.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "provisioned",
            provider: "ssh-scp",
        }));
        await handleMacosTool("device_stop", { deviceId: "macos-inferred-ssh-host" });
        await handleMacosTool("device_delete", { deviceId: "macos-inferred-ssh-host" });

        const helperFailureCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fail Helper",
            provider: "auto",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(helperFailureCreate?.isError).not.toBe(true);
        const helperFailureStart = await handleMacosTool("device_start", { deviceId: "macos-fail-helper" });
        expect(helperFailureStart?.isError).toBe(true);
        const helperFailurePayload = JSON.parse((helperFailureStart?.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            command: { provider: string; status: number; stderr: string };
            device: { status: string; helper: { provisioning: { status: string; remoteScriptPath: string } } };
        };
        expect(helperFailurePayload).toEqual(expect.objectContaining({
            ok: false,
            error: "macos-helper-scp-failed",
        }));
        expect(helperFailurePayload.command).toEqual(expect.objectContaining({ status: 5, stderr: expect.stringContaining("scp helper failure") }));
        expect(helperFailurePayload.device.status).toBe("running");
        expect(helperFailurePayload.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "failed",
            remoteScriptPath: "/tmp/ccc-macos-fail-helper-guest-helper.sh",
        }));

        const localHelperFailureCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Local Helper Failure",
            provider: "auto",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(localHelperFailureCreate?.isError).not.toBe(true);
        const localHelperFailureCreated = JSON.parse(((localHelperFailureCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { providerPlan: { helper: { hostHelperScript: string } } };
        };
        mkdirSync(localHelperFailureCreated.device.providerPlan.helper.hostHelperScript, { recursive: true });
        const localHelperFailureStart = await handleMacosTool("device_start", { deviceId: "macos-local-helper-failure" });
        expect(localHelperFailureStart?.isError).toBe(true);
        const localHelperFailurePayload = JSON.parse((localHelperFailureStart?.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            device: { status: string; helper: { provisioning: { status: string; provider: string } } };
        };
        expect(localHelperFailurePayload).toEqual(expect.objectContaining({
            ok: false,
            error: "macos-helper-write-failed",
        }));
        expect(localHelperFailurePayload.device.status).toBe("running");
        expect(localHelperFailurePayload.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "failed",
            provider: "local",
        }));

        const deleteFailureCreate = await handleMacosTool("device_base_image_create", {
            backend: "macos-vm",
            name: "Fail Delete",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
        });
        expect(deleteFailureCreate?.isError).not.toBe(true);
        const deleteFailureCreated = JSON.parse(((deleteFailureCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerInstance: string };
        };
        expect(deleteFailureCreated.device.providerInstance).toContain("fail-delete");
        const deleteFailure = await handleMacosTool("device_delete", { deviceId: "macos-fail-delete" });
        expect(deleteFailure?.isError).toBe(true);
        expect((deleteFailure?.content as Array<{ text?: string }>)[0].text).toContain("delete failed");
        const deleteFailureStillPresent = await handleMacosTool("device_status", { deviceId: "macos-fail-delete" });
        expect(deleteFailureStillPresent?.isError).not.toBe(true);

        const partialDeleteCreate = await handleMacosTool("device_base_image_create", {
            backend: "macos-vm",
            name: "Partial Delete",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
        });
        expect(partialDeleteCreate?.isError).not.toBe(true);
        const partialDeleteCreated = JSON.parse(((partialDeleteCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerInstance: string };
        };
        const partialDeleteSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-partial-delete",
            snapshotName: "Retry Safe",
        });
        expect(partialDeleteSnapshot?.isError).not.toBe(true);
        const partialDeleteSnapshotPayload = JSON.parse(((partialDeleteSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const partialDelete = await handleMacosTool("device_delete", { deviceId: "macos-partial-delete" });
        expect(partialDelete?.isError).toBe(true);
        expect((partialDelete?.content as Array<{ text?: string }>)[0].text).toContain("primary delete failed");
        const partialDeleteStatus = await handleMacosTool("device_status", { deviceId: "macos-partial-delete" });
        const partialDeleteStillPresent = JSON.parse(((partialDeleteStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { snapshots: unknown[] };
        };
        expect(partialDeleteStillPresent.device.snapshots).toEqual([]);
        const logBeforePartialRetry = readFileSync(logPath, "utf-8");
        const partialDeleteRetry = await handleMacosTool("device_delete", { deviceId: "macos-partial-delete" });
        expect(partialDeleteRetry?.isError).toBe(true);
        const partialRetryDelta = readFileSync(logPath, "utf-8").slice(logBeforePartialRetry.length);
        expect(partialRetryDelta).toContain(`tart delete ${partialDeleteCreated.device.providerInstance}`);
        expect(partialRetryDelta).not.toContain(partialDeleteSnapshotPayload.snapshot.providerInstance);

        const start = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(start?.isError).not.toBe(true);
        const started = JSON.parse(((start?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; provider: string; providerInstance: string; runtime: { detached: boolean; providerPid: number }; helper: { hostHelperScript: string; remoteScriptPath: string; provisioning: { status: string; provider: string; localScriptPath: string; remoteScriptPath: string } } };
            helper: { status: string; provider: string };
            providerStart: { detached: boolean; providerPid: number };
        };
        expect(started.device.status).toBe("running");
        expect(started.device.provider).toBe("tart");
        expect(started.providerStart).toEqual(expect.objectContaining({
            detached: true,
            providerPid: expect.any(Number),
        }));
        expect(started.device.runtime).toEqual(expect.objectContaining({
            detached: true,
            providerPid: started.providerStart.providerPid,
        }));
        expect(started.helper).toEqual(expect.objectContaining({ status: "provisioned", provider: "ssh-scp" }));
        expect(started.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "provisioned",
            provider: "ssh-scp",
            localScriptPath: started.device.helper.hostHelperScript,
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
        }));
        const hostHelperScript = readFileSync(started.device.helper.hostHelperScript, "utf-8");
        expect(hostHelperScript).toContain("ccc macOS guest helper for macos-fake-tart");
        expect(hostHelperScript).toContain("window_list)");
        expect(hostHelperScript).toContain("accessibility_snapshot)");
        expect(hostHelperScript).toContain("macos-system-events");
        const startedStatus = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const startedStatusPayload = JSON.parse(((startedStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backend: { capabilities: string[] };
        };
        expect(startedStatusPayload.backend.capabilities).toEqual(expect.arrayContaining([
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_window_list",
            "device_accessibility_snapshot",
        ]));

        const snapshotWhileRunning = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(snapshotWhileRunning?.isError).toBe(true);
        expect((snapshotWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to snapshot");

        const failingSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Snapshot",
            force: true,
        });
        expect(failingSnapshot?.isError).toBe(true);
        const statusAfterFailingSnapshot = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const failingSnapshotStatus = JSON.parse(((statusAfterFailingSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: unknown[] };
        };
        expect(failingSnapshotStatus.device.status).toBe("stopped");
        expect(failingSnapshotStatus.device.snapshots || []).toEqual([]);

        const restartAfterFailedSnapshot = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterFailedSnapshot?.isError).not.toBe(true);

        const snapshotCreate = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
            force: true,
        });
        expect(snapshotCreate?.isError).not.toBe(true);
        const snapshotCreated = JSON.parse(((snapshotCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: Array<{ id: string; name: string; providerInstance: string }> };
            snapshot: { id: string; name: string; providerInstance: string };
        };
        expect(snapshotCreated.device.status).toBe("stopped");
        expect(snapshotCreated.snapshot).toEqual(expect.objectContaining({
            id: "snapshot-before-install",
            name: "Before Install",
        }));
        expect(snapshotCreated.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-before-install", name: "Before Install" }),
        ]));

        const restartAfterSnapshot = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterSnapshot?.isError).not.toBe(true);

        const restoreWhileRunning = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(restoreWhileRunning?.isError).toBe(true);
        expect((restoreWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to restore");

        const failingRestore = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
            force: true,
        });
        expect(failingRestore?.isError).not.toBe(true);
        const restartBeforeFailRestore = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeFailRestore?.isError).not.toBe(true);
        const logBeforeFailedRestore = readFileSync(logPath, "utf-8");
        const restoreCloneFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
            force: true,
        });
        expect(restoreCloneFailure?.isError).toBe(true);
        const failedRestoreLogDelta = readFileSync(logPath, "utf-8").slice(logBeforeFailedRestore.length);
        expect(failedRestoreLogDelta).toContain("fail-restore");
        expect(failedRestoreLogDelta).not.toContain(`tart delete ${started.device.providerInstance}`);
        const statusAfterFailedRestore = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const failedRestoreStatus = JSON.parse(((statusAfterFailedRestore?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: Array<{ name: string }> };
        };
        expect(failedRestoreStatus.device.status).toBe("stopped");
        expect(failedRestoreStatus.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "Fail Restore" }),
        ]));

        const activationFailureSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
            force: true,
        });
        expect(activationFailureSnapshot?.isError).not.toBe(true);
        const activationSnapshotPayload = JSON.parse(((activationFailureSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const restartBeforeActivationFailure = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeActivationFailure?.isError).not.toBe(true);
        const logBeforeActivationFailure = readFileSync(logPath, "utf-8");
        const activationFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
            force: true,
        });
        expect(activationFailure?.isError).toBe(true);
        expect((activationFailure?.content as Array<{ text?: string }>)[0].text).toContain("Restore candidate preserved");
        const activationFailureDelta = readFileSync(logPath, "utf-8").slice(logBeforeActivationFailure.length);
        expect(activationFailureDelta).toContain(activationSnapshotPayload.snapshot.providerInstance);
        expect(activationFailureDelta).toContain("fail-activate");
        const preservedCandidate = activationFailureDelta
            .split("\n")
            .find((line) => line.includes("fail-activate"))?.split(" ").pop() || "";
        expect(preservedCandidate).toContain("restore-");
        expect(activationFailureDelta).not.toContain(`tart delete ${preservedCandidate}`);
        const statusAfterActivationFailure = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const activationFailureStatus = JSON.parse(((statusAfterActivationFailure?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { restoreRecovery: { candidateProviderInstance: string; snapshotName: string } };
        };
        expect(activationFailureStatus.device.restoreRecovery).toEqual(expect.objectContaining({
            candidateProviderInstance: preservedCandidate,
            snapshotName: "Fail Activate",
        }));

        const snapshotRestore = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
            force: true,
        });
        expect(snapshotRestore?.isError).not.toBe(true);
        const restored = JSON.parse(((snapshotRestore?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; restoredFrom: { id: string; name: string } };
        };
        expect(restored.device.status).toBe("stopped");
        expect(restored.device.restoredFrom).toEqual(expect.objectContaining({
            id: "snapshot-before-install",
            name: "Before Install",
        }));

        const snapshotDelete = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(snapshotDelete?.isError).not.toBe(true);
        const snapshotDeleted = JSON.parse(((snapshotDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(snapshotDeleted.deleted).toBe("snapshot-before-install");
        expect(snapshotDeleted.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-fail-restore" }),
        ]));
        expect(snapshotDeleted.device.snapshots).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-before-install" }),
        ]));

        const failRestoreSnapshotDeleted = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
        });
        expect(failRestoreSnapshotDeleted?.isError).not.toBe(true);
        const failRestoreDeleted = JSON.parse(((failRestoreSnapshotDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(failRestoreDeleted.deleted).toBe("snapshot-fail-restore");
        expect(failRestoreDeleted.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-fail-activate" }),
        ]));

        const failActivateSnapshotDeleted = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
        });
        expect(failActivateSnapshotDeleted?.isError).not.toBe(true);
        const failActivateDeleted = JSON.parse(((failActivateSnapshotDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(failActivateDeleted.deleted).toBe("snapshot-fail-activate");
        expect(failActivateDeleted.device.snapshots).toEqual([]);

        const restartAfterRestore = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterRestore?.isError).not.toBe(true);

        const cloneWhileRunning = await handleMacosTool("device_base_image_clone", {
            backend: "macos-vm",
            name: "Running Clone",
            sourceDeviceId: "macos-fake-tart",
        });
        expect(cloneWhileRunning?.isError).toBe(true);
        expect((cloneWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to clone");

        const stop = await handleMacosTool("device_stop", { deviceId: "macos-fake-tart" });
        expect(stop?.isError).not.toBe(true);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`tart run --with-softnet ${started.device.providerInstance}`);
        expect(log).toContain(`tart stop ${started.device.providerInstance}`);
        expect(log).toContain(`tart clone ghcr.io/example/macos-base:latest ${imageCreated.device.providerInstance}`);
        expect(log).toContain(`tart clone ${imageCreated.device.providerInstance} ${imageCloned.device.providerInstance}`);
        expect(log).toContain(`tart clone ${imageCreated.device.providerInstance} `);
        expect(log).toContain(`tart clone ${started.device.providerInstance} ${snapshotCreated.snapshot.providerInstance}`);
        expect(log).toContain("tart clone ");
        expect(log).toContain("fail-snapshot");
        expect(log).toContain("fail-restore");
        expect(log).toContain(`tart delete ${started.device.providerInstance}`);
        expect(log).toContain(`tart clone ${snapshotCreated.snapshot.providerInstance} `);
        expect(log).toContain(`tart clone ${started.device.providerInstance}-restore-`);
        expect(log).toContain(`tart delete ${snapshotCreated.snapshot.providerInstance}`);
        expect(log).not.toContain("vz clone");
        expect(log).toContain("scp -P 2222 -o BatchMode=yes -o StrictHostKeyChecking=no");
        expect(log).toContain("ccc-guest-helper.sh ccc@127.0.0.1:/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(log).toContain("chmod 700 '/tmp/ccc-macos-fake-tart-guest-helper.sh'");

        const startCloneBeforeDelete = await handleMacosTool("device_start", { deviceId: "macos-base-clone" });
        expect(startCloneBeforeDelete?.isError).not.toBe(true);
        const runningCloneDelete = await handleMacosTool("device_delete", { deviceId: "macos-base-clone" });
        expect(runningCloneDelete?.isError).toBe(true);
        expect((runningCloneDelete?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete macos-base-clone while status is running");
        const clonedDeleted = await handleMacosTool("device_delete", { deviceId: "macos-base-clone", force: true });
        expect(clonedDeleted?.isError).not.toBe(true);
        const clonedDeletedPayload = JSON.parse(((clonedDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(clonedDeletedPayload.providerDeleted).toContain(imageCloned.device.providerInstance);
        const forcedClonedDeleted = await handleMacosTool("device_delete", { deviceId: "macos-forced-clone" });
        expect(forcedClonedDeleted?.isError).not.toBe(true);
        const imageDeleted = await handleMacosTool("device_delete", { deviceId: "macos-base-image" });
        expect(imageDeleted?.isError).not.toBe(true);
        const imageDeletedPayload = JSON.parse(((imageDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(imageDeletedPayload.providerDeleted).toContain(imageSnapshotPayload.snapshot.providerInstance);
        expect(imageDeletedPayload.providerDeleted).toContain(imageCreated.device.providerInstance);

        const recoverySnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate Delete",
        });
        expect(recoverySnapshot?.isError).not.toBe(true);
        const recoverySnapshotPayload = JSON.parse(((recoverySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const restartBeforeRecoveryDelete = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeRecoveryDelete?.isError).not.toBe(true);
        const recoveryRestoreFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate Delete",
            force: true,
        });
        expect(recoveryRestoreFailure?.isError).toBe(true);
        const statusBeforeRecoveryDelete = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const recoveryDeleteStatus = JSON.parse(((statusBeforeRecoveryDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { restoreRecovery: { candidateProviderInstance: string } };
        };
        expect(recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance).toContain("restore-");
        const deleted = await handleMacosTool("device_delete", { deviceId: "macos-fake-tart" });
        expect(deleted?.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(deletedPayload.providerDeleted).toEqual(expect.arrayContaining([
            recoverySnapshotPayload.snapshot.providerInstance,
            recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance,
        ]));

        const deleteLog = readFileSync(logPath, "utf-8");
        expect(deleteLog).toContain(`tart stop ${imageCloned.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageCloned.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageSnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageCreated.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${deleteFailureCreated.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${partialDeleteSnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${recoverySnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance}`);
    });
});
