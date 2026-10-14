import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compactToolValue } from "../../device-lab-mcp/src/public-output.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, TIMEOUT } from "./helpers/device-lab-mcp-fixture.js";

const provider = "container-qemu";
const observation = (index: number) => ({ id: `readiness-${index}`, labId: "lab", targetId: "lab:vm", provider,
    state: "process-running", checkedAt: `time-${index}`, checks: [
        { name: "runtime-process", status: "pass", pid: 123 },
        { name: "guest-readiness", status: "skipped", reason: "no-bounded-guest-probe-configured" },
    ], diagnostics: { kind: "process-only" } });
const latest = observation(49);
const lab = {
    id: "lab", name: "Lab", ownerId: "owner", provider, runtimeState: "running",
    createdAt: "created", updatedAt: "updated", resources: { cpus: 2, memoryMb: 2048 },
    image: { sourceImage: "/incoming/base.qcow2", diskImage: "/labs/lab/disks/root.qcow2", format: "qcow2" },
    paths: { labDir: "/labs/lab", snapshotsDir: "/labs/lab/snapshots", workspaceDir: "/labs/lab/workspace",
        artifactsDir: "/labs/lab/artifacts", exportsDir: "/exports/lab" },
    runtime: { pid: 123, command: "/usr/bin/qemu-system-x86_64", startedAt: "started" },
    readiness: { latest, history: Array.from({ length: 50 }, (_, index) => observation(index)) },
    snapshots: [], fileOperations: [], custom: { ownerId: "user-value", paths: { labDir: "user-data" } },
};
const device = { ...lab, deviceId: lab.id, backend: "linux-vm", capabilities: ["device_status"] };
const compactLab = {
    id: lab.id, name: lab.name, provider, runtimeState: lab.runtimeState, resources: lab.resources, image: lab.image,
    paths: { workspaceDir: lab.paths.workspaceDir, artifactsDir: lab.paths.artifactsDir, exportsDir: lab.paths.exportsDir },
    runtime: { startedAt: "started" }, readiness: { latest }, snapshots: [], custom: lab.custom,
};
const compactDevice = { ...compactLab, deviceId: lab.id, backend: "linux-vm", capabilities: ["device_status"] };
const target = { id: "lab:vm", labId: "lab", name: "Lab", targetKind: "lab-vm", provider,
    runtimeState: "running", readiness: "process-running", sessionState: "attachable", attachable: true,
    creatable: false, runtime: lab.runtime, readinessProbe: latest,
    paths: { workspaceDir: lab.paths.workspaceDir, artifactsDir: lab.paths.artifactsDir },
    sessionHints: { monitor: "bounded-monitor-proxy-required" } };
const compactTarget = { ...target, runtime: { startedAt: "started" } };
const envelope = { ok: true, backend: "linux-vm", ownerId: "owner" };

describe("known VM provider output", () => {
    it.each(["device_create", "device_start", "device_stop", "device_status", "device_readiness_probe", "device_guest_agent_status", "device_guest_agent_provision"])("projects %s device/lab aliases without changing input", (name) => {
        const input = { ...envelope, lab, device };
        const before = structuredClone(input);
        expect(compactToolValue(name, input)).toEqual({ ok: true, backend: "linux-vm", device: compactDevice });
        expect(input).toEqual(before);
    });

    it.each(["device_list", "device_inventory"])("projects %s and reduces 50 repeated readiness observations", (name) => {
        const input = { ...envelope, labs: [lab], devices: [device] };
        const result = compactToolValue(name, input);
        expect(result).toEqual({ ok: true, backend: "linux-vm", devices: [compactDevice] });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(Buffer.byteLength(JSON.stringify(input)) / 10);
    });

    it("keeps singular/plural target semantics and the current session identity", () => {
        const session = { id: "session-1", labId: lab.id, targetId: target.id, targetKind: "lab-vm", sessionType: "metadata",
            provider, state: "open", createdAt: "now", authority: "device-lab-metadata", attach: { available: true } };
        const withSession = { ...lab, sessions: [session] };
        expect(compactToolValue("device_session_open", { ...envelope, lab: withSession, device: { ...device, sessions: [session] }, target, session }))
            .toEqual({ ok: true, backend: "linux-vm", device: compactDevice, target: compactTarget, session });
        expect(compactToolValue("device_target_list", { ...envelope, targets: [target] }))
            .toEqual({ ok: true, backend: "linux-vm", targets: [compactTarget] });
        expect(compactToolValue("device_readiness_probe", { ...envelope, lab, device, target, readiness: latest }))
            .toEqual({ ok: true, backend: "linux-vm", device: compactDevice, target: compactTarget, readiness: latest });
    });

    it("compacts the explicitly nested reboot/materialized records and preserves partial failure", () => {
        const materialized = { ok: true, ownerId: "owner", lab, materialized: true, diskImage: lab.image.diskImage };
        const start = { ok: true, ownerId: "owner", lab, materialized };
        const stop = { ok: true, ownerId: "owner", lab, stopped: true };
        const result = compactToolValue("device_reboot", { ...envelope, lab, device, rebooted: true, stop, start });
        expect(result).toEqual({ ok: true, backend: "linux-vm", device: compactDevice, rebooted: true,
            stop: { ok: true, lab: compactLab, stopped: true }, start: { ok: true, lab: compactLab,
                materialized: { ok: true, lab: compactLab, materialized: true, diskImage: lab.image.diskImage } } });
        const failed = { ...start, ok: false, error: "cleanup-failed", recovery: { artifactPath: "/recover", ownerId: "keep" } };
        expect(compactToolValue("device_reboot", { ...envelope, lab, start: failed }).start).toEqual(failed);
        expect(compactToolValue("device_disk_materialize", { ...envelope, lab, device, dryRun: true,
            plan: { command: "qemu-img", args: ["create", lab.image.diskImage] } }).plan)
            .toEqual({ command: "qemu-img", args: ["create", lab.image.diskImage] });
    });

    it("removes successful launch command wiring while retaining warnings, artifacts and failures", () => {
        const command = { ok: true, pid: 123, processIdentity: { start: "token" }, command: "/bin/qemu",
            args: ["-pidfile", "/private/qemu.pid"], status: 0, stdout: "", stderr: "warning: software acceleration" };
        const input = { ...envelope, lab, device, started: command,
            materialized: { ok: true, lab, materialized: true, diskImage: lab.image.diskImage, result: command } };
        const result = compactToolValue("device_start", input);
        expect(result.started).toEqual({ ok: true, stderr: command.stderr });
        expect(result.materialized.result).toEqual({ ok: true, stderr: command.stderr });
        expect(result.materialized.diskImage).toBe(lab.image.diskImage);
        const failed = { ...command, ok: false, error: "partial-start", recovery: { command: "stop", pid: 123 } };
        expect(compactToolValue("device_start", { ...input, started: failed }).started).toEqual(failed);
    });

    it("retains failures, unique and unknown history, stale stopped observations and artifact operations", () => {
        const failure = { ...observation(10), state: "failed", recovery: { reason: "retry-ssh" } };
        const unknown = { ...observation(11), custom: { diagnostics: "keep" } };
        const warning = { ...observation(12), diagnostics: { kind: "guest-readiness", warning: "slow" } };
        const unique = { ...observation(13), checks: [{ name: "guest-readiness", status: "skipped", reason: "other" }] };
        const history = [observation(0), failure, unknown, warning, unique, latest];
        const fileOperations = [{ type: "export_artifacts", sourcePath: "/artifacts/report", destinationPath: "/exports/report", files: 1, bytes: 9, completedAt: "then" }];
        const source = { ...lab, readiness: { latest, history }, fileOperations };
        const result = compactToolValue("device_status", { ...envelope, device: source });
        expect(result.device.readiness).toEqual({ latest, history: [failure, unknown, warning, unique] });
        expect(result.device.fileOperations).toEqual(fileOperations);
        const stopped = { ...source, runtimeState: "stopped", runtime: null, readiness: { latest: null, history } };
        const stoppedResult = compactToolValue("device_status", { ...envelope, device: stopped }).device;
        expect(stoppedResult.runtimeState).toBe("stopped");
        expect(stoppedResult.readiness).toEqual({ latest: null, history: [observation(0), failure, unknown, warning, unique] });
        for (const record of [{ ...lab, ok: false }, { ...lab, error: "partial" }]) {
            expect(compactToolValue("device_status", { ...envelope, device: record }).device).toEqual(record);
        }
        const unknownRecord = { provider: "container-qemu", paths: lab.paths, readiness: lab.readiness };
        expect(compactToolValue("device_status", { device: unknownRecord }).device).toEqual(unknownRecord);
    });

    it.each([null, { ownerId: "owner", deviceId: "sandbox", claimId: "generation", sandboxId: "runtime" },
        { ownerId: "other-owner", deviceId: "other-sandbox", claimId: "other-generation", error: "busy" }])("keeps Sandbox singleton evidence (%j)", (lock) => {
        const input = { backend: "windows-sandbox", devices: [], discovery: { wsb: "/bin/wsb", available: true, missing: [] },
            hostSandboxes: { provider: "wsb", command: "/bin/wsb", available: true, missing: [], lazy: true,
                singleton: true, lock, note: "Owner definitions only; no stable all-sandbox inventory." } };
        const original = structuredClone(input);
        expect(compactToolValue("device_inventory", input)).toEqual({ backend: input.backend, devices: [],
            discovery: { available: true, missing: [] }, hostSandboxes: { provider: "wsb", singleton: true, lock, note: input.hostSandboxes.note } });
        expect(input).toEqual(original);
    });

    it("keeps unavailable/distinct discovery facts and macOS provider names without executable wiring", () => {
        const discovery = { hostSupported: true, available: true, missing: [], providers: [{ name: "tart", command: "/opt/tart" }, { name: "other", command: "/opt/other" }] };
        const input = { backend: "macos-vm", devices: [], discovery,
            hostVms: { providers: discovery.providers, available: false, missing: ["permission"], lazy: true, note: "Checks command availability only." } };
        expect(compactToolValue("device_inventory", input)).toEqual({ backend: "macos-vm", devices: [],
            discovery: { ...discovery, providers: [{ name: "tart" }, { name: "other" }] },
            hostVms: { available: false, missing: ["permission"], note: input.hostVms.note } });
        const unavailable = { backend: "macos-vm", devices: [], discovery: { hostSupported: false, available: false, missing: ["macos-host"], providers: [] } };
        expect(compactToolValue("device_inventory", unavailable)).toEqual(unavailable);
        const sandbox = { backend: "windows-sandbox", devices: [], discovery: { wsb: null, available: false, missing: ["wsb"] },
            hostSandboxes: { provider: "wsb", command: null, available: false, missing: ["wsb"], singleton: true, lock: null } };
        expect(compactToolValue("device_inventory", sandbox)).toEqual({ ...sandbox, discovery: { available: false, missing: ["wsb"] },
            hostSandboxes: { provider: "wsb", singleton: true, lock: null } });
    });

    it("returns compact real QEMU metadata over source MCP with exact detailed bypass", { timeout: TIMEOUT }, async () => {
        const env: Record<string, string> = {};
        const context = await createDeviceLabMcpTestContext({ env, setupHome(home) {
            const root = join(home, "labs");
            env.CCC_LAB_STATE_DIR = root;
            mkdirSync(join(root, "incoming"), { recursive: true });
            writeFileSync(join(root, "incoming", "base.qcow2"), "fixture-image");
        } });
        const call = async (name: string, args: Record<string, unknown>) => {
            const result = await context.client.callTool({ name, arguments: args });
            expect(result.isError, JSON.stringify(result)).not.toBe(true);
            return JSON.parse((result.content as Array<{ text: string }>)[0].text);
        };
        try {
            const created = await call("create_linux_vm", { name: "Compact lab", sourceImage: "incoming/base.qcow2", detail: true });
            const detailed = await call("status", { deviceId: created.device.deviceId, detail: true });
            const compact = await call("status", { deviceId: created.device.deviceId, detail: false });
            const { ok: _statusOk, ...expectedStatus } = compactToolValue("device_status", structuredClone(detailed));
            delete expectedStatus.device.paths.labDir;
            delete expectedStatus.device.paths.snapshotsDir;
            delete expectedStatus.device.fileOperations;
            expect(compact).toEqual(expectedStatus);
            expect(compact.device.paths).not.toHaveProperty("labDir");
            expect(compact.device.paths.artifactsDir).toBe(detailed.device.paths.artifactsDir);
            expect(await call("status", { deviceId: created.device.deviceId, detail: true })).toEqual(detailed);
            const rawInventory = await call("devices", { view: "available", backend: "linux-vm", detail: true });
            const inventory = await call("devices", { view: "available", backend: "linux-vm", detail: false });
            const { ok: _inventoryOk, ...expectedInventory } = compactToolValue("device_inventory", structuredClone(rawInventory));
            for (const device of expectedInventory.devices) {
                delete device.paths.labDir;
                delete device.paths.snapshotsDir;
                delete device.fileOperations;
            }
            expect(inventory).toEqual(expectedInventory);
            expect(inventory.discovery).not.toHaveProperty("qemu");
            expect(inventory.discovery).not.toHaveProperty("stateRoot");
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });
});
