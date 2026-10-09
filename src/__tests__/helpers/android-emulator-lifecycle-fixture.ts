import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAndroidMcpContext, cleanupFakeAndroidMcpContext, type FakeAndroidMcpContext } from "./fake-android-mcp-fixture.js";
import type { AndroidEmulatorCommandResult, AndroidEmulatorDevice, AndroidEmulatorLifecyclePorts, AndroidEmulatorProcessHandle } from "../../../packages/device-lab/providers/ports/lifecycle/android-emulator-lifecycle.mjs";
import type { BrokerAndroidLifecycleInput, BrokerAndroidLifecycleRequest } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidEmulatorLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/android-emulator-lifecycle.js";

// Original provenance only. Current tests never require an ignored archive or
// reject a candidate because its complete policy source hash changed.
export const ORIGINAL_ANDROID_LIFECYCLE_SOURCE = "da5c4bd2ff4121c8ca2ab0f8ff9d0e3332007c8d";
export const ANDROID_SYSTEM_IMAGE = "system-images;android-35;google_apis;x86_64";
export const ANDROID_PORT_ALLOWED = "even integer 5554-5682";
// Minimal immutable values observed against the reconciled ORIGINAL public and
// native bindings in capture run03. Full receipts are diagnostic evidence, not
// a dependency of these durable tests. Keep variant differences explicit.
export const ORIGINAL_ANDROID_LIFECYCLE = Object.freeze({
    allocationOwner: "0123456789abcdef", allocationId: "android-original-allocation", firstPort: 5630, nextPort: 5632,
    directOddPortError: "create Android port must be even and from 5554 to 5682",
    directAllocatedDuplicateError: "android-emulator-port-conflict: port-5670-already-allocated",
    directDuplicateError: "Device already exists for this owner: android-duplicate",
    brokerSuccessorStatus: 409, brokerSuccessorError: "owner-device-state-conflict",
    directAccessorReads: Object.freeze(["deviceId", "deviceId", "backend", "backend", "backend", "name", "deviceId", "avdName", "port"]),
});
// Capture configuration belongs to this controller, before the existing owner
// isolation deliberately clears inherited CCC settings from native requests.
const observationRoot = process.env.CCC_ANDROID_LIFECYCLE_CAPTURE_DIR;
const project = fileURLToPath(new URL("../../../", import.meta.url));

export function assertCurrentAndroidLifecycleEmission(): void {
    for (const relative of ["backends/android.mjs", "state/android-emulator-port-allocation.mjs", "domain/lifecycle/android-emulator-lifecycle.mjs", "ports/lifecycle/android-emulator-lifecycle.mjs", "application/lifecycle/android-emulator-lifecycle.mjs"]) {
        const source = join(project, "packages/device-lab/providers", relative), emitted = join(project, "dist/packages/device-lab/providers", relative);
        if (!existsSync(emitted)) throw Error("Mandatory genuine lifecycle emission missing: " + emitted);
        if (readFileSync(source, "utf8") !== readFileSync(emitted, "utf8")) throw Error("Current lifecycle emission differs: " + emitted);
    }
    const adapter = join(project, "dist/device-lab-mcp/server.mjs");
    if (!existsSync(adapter) || !readFileSync(adapter, "utf8").includes("function createAndroidEmulatorLifecycle(")) throw Error("Genuine MCP assembly must include current canonical Android lifecycle");
}

export function toolText(result: unknown): string {
    if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) throw Error("Missing MCP content");
    const first: unknown = result.content[0];
    if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") throw Error("Missing MCP text");
    return first.text;
}
export function toolJson(result: unknown): Record<string, unknown> {
    const value: unknown = JSON.parse(toolText(result));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error("Expected MCP JSON object");
    return value as Record<string, unknown>;
}
export function originalObservation(name: string, value: unknown): void {
    const capture = observationRoot;
    if (!capture) return;
    if (!/^[a-z0-9-]+$/.test(name)) throw Error("Unsafe observation name");
    mkdirSync(capture, { recursive: true });
    writeFileSync(join(capture, name + ".json"), JSON.stringify({ source: ORIGINAL_ANDROID_LIFECYCLE_SOURCE, value }, null, 2) + "\n", { flag: "wx" });
}
export function androidStatePath(home: string, ownerId: string): string {
    return join(home, ".ccc", "devices", "owners", ownerId, "android", "devices.json");
}
export function androidRawState(home: string, ownerId: string): { devices: Record<string, unknown>[] } {
    const path = androidStatePath(home, ownerId);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { devices: Record<string, unknown>[] } : { devices: [] };
}

// Reuse the existing fake SDK and real MCP/native storage/locks. Preserve the
// first assertion failure even when teardown also fails. This wrapper adds no
// syscall sandbox; PATH and existing native identity/file guards remain the
// authorities, with provider counters in the broker tests reported separately.
export async function withAndroidLifecycleFixture(name: string, check: (context: FakeAndroidMcpContext, ownerId: string) => Promise<void>): Promise<void> {
    const context = await createFakeAndroidMcpContext();
    const failures: unknown[] = [];
    let ownerId: string | undefined;
    const unknown = join(context.homeDir, "unknown-retained");
    writeFileSync(unknown, "unallocated resource retained\n", { flag: "wx" });
    try {
        const inventory = toolJson(await context.client.callTool({ name: "devices", arguments: { view: "available", backend: "android-emulator" } }));
        if (typeof inventory.ownerId !== "string") throw Error("Missing fixture owner");
        ownerId = inventory.ownerId;
        await check(context, ownerId);
    } catch (error) { failures.push(error); }
    finally {
        try {
            if (ownerId) for (const device of androidRawState(context.homeDir, ownerId).devices) {
                // Only a genuine runtime allocated by this direct fixture needs
                // joining. Metadata-only successor/refusal controls stay intact.
                if (device.runtime && typeof device.id === "string") {
                    await context.client.callTool({ name: "stop", arguments: { deviceId: device.id } });
                }
            }
            if (readFileSync(unknown, "utf8") !== "unallocated resource retained\n") throw Error("Unknown resource changed");
            originalObservation(name + "-terminal", {
                log: readFileSync(context.logPath, "utf8"), state: ownerId && androidRawState(context.homeDir, ownerId),
                unknownRetained: true, assertionFailures: failures.map(error => String(error)),
            });
        } catch (error) { failures.push(error); }
        try { await cleanupFakeAndroidMcpContext(context); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, name + ": assertion precedes cleanup failures");
}

export function privateBrokerHome(): { home: string; remove: () => void } {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-lifecycle-broker-"));
    return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}

export type DirectLifecycleResult = { ok: boolean; payload?: unknown; text?: string; failure?: AndroidEmulatorCommandResult };
export interface DirectOwnedChild extends AndroidEmulatorProcessHandle { readonly pid: number; readonly nativeHandle: object }

// Pure application effect fixture. Public/native witnesses above remain the
// authority for storage, real process identity and teardown; this fixture tests
// only the moved policy against its precise current step contracts.
export function directLifecyclePorts(initial?: AndroidEmulatorDevice) {
    let current = initial, clockReads = 0;
    const trace: string[] = [], transitions: Array<{ expected: AndroidEmulatorDevice; replacement: AndroidEmulatorDevice | null }> = [];
    const child: DirectOwnedChild = { pid: 424242, nativeHandle: {} };
    const discovery = { adb: "adb", emulator: "emulator", avdmanager: "avdmanager", available: true, missing: [], provisioningAvailable: true, provisioningMissing: [] };
    const ports: AndroidEmulatorLifecyclePorts<DirectLifecycleResult, DirectOwnedChild> = {
        androidAvdHome: () => "/owned-avd",
        androidAvdIsInactive: () => { trace.push("inactive"); return true; },
        androidDeviceId: () => "android-unit",
        androidDiscovery: () => { trace.push("discovery"); return discovery; },
        androidEmulatorStartArgs: () => ["-no-window"],
        androidLifecycleConflict: (deviceId, operation, transition, rollback) => ({ ok: false, payload: { error: "owner-device-state-conflict", deviceId, operation, ...transition, ...(rollback === undefined ? {} : { rollback }) } }),
        androidSerial: device => device.serial || (device.port ? "emulator-" + device.port : undefined),
        appiumPortForDevice: () => 4723,
        approvedAndroidAvdRoot: () => "/owned-avd",
        claimAndroidDevice: device => { trace.push("claim"); current = device; return { ok: true }; },
        deleteOwnedAndroidAvd: (_avd, options) => { trace.push("remove-avd"); if (!options.verifyInactive()) return { ok: false, error: "native-liveness-unverified" }; return { ok: true, artifactsRemoved: 2 }; },
        fail: failure => ({ ok: false, failure }),
        findAndroidDevice: () => current,
        isOwnedAvdName: (name: unknown): name is string => typeof name === "string",
        isSafeDeviceProfile: () => true,
        isSafeProvisionedAvdName: () => true,
        isSafeSystemImage: () => true,
        jsonResult: payload => ({ ok: true, payload }),
        listOwnedAndroidAvdArtifacts: () => [],
        liveAndroidEmulatorPortsForAllocation: () => { trace.push("live-ports"); return { ok: true, ports: new Set() }; },
        ownerAvdPrefix: () => "ccc-owner-",
        ownerId: () => "owner",
        publicAndroidDevice: device => device,
        readAndroidDevices: () => { trace.push("read"); return current ? [current] : []; },
        refreshOwnedRuntimeProcessIdentity: runtime => runtime,
        resolveAndroidEmulatorPort: (_owner, _id, port) => { trace.push("allocate"); return { ok: true, port: port || 5630 }; },
        run: (_exe, args) => { trace.push("run:" + args.join(" ")); return { status: 0, stdout: "", stderr: "" }; },
        runWithInput: (_exe, _args, input, options) => { trace.push("provision:" + input + ":" + options.timeout); return { status: 0, stdout: "", stderr: "" }; },
        signalOwnedRuntimeProcess: () => { trace.push("recorder-signal"); return { signaled: false }; },
        slug: () => "unit",
        spawnAndroidEmulator: async () => { trace.push("spawn"); return child; },
        terminateFreshAndroidEmulatorProcessTree: async received => { trace.push("terminate-fresh"); if (received !== child) throw Error("Lost native child handle"); return { ok: true, exited: true }; },
        terminateOwnedRuntimeProcessTree: async (_runtime, label, options) => { trace.push("terminate:" + label + ":" + options.timeoutMs); return { exited: true }; },
        textResult: (ok, text) => ({ ok, text }),
        transitionAndroidDevice: (_id, expected, replacement) => { trace.push("transition"); transitions.push({ expected, replacement }); const matched = current === expected; if (matched) current = replacement || undefined; return { matched, found: Boolean(current) }; },
        waitForAndroidBoot: async (_discovery, _device, _timeout, received) => { trace.push("boot"); if (received !== child) throw Error("Lost native child handle"); return { ready: true }; },
        waitForProcessExit: async (_pid, timeout) => { trace.push("wait-exit:" + timeout); return true; },
        waitForProcessIdentity: async (_pid, timeout) => { trace.push("identity:" + timeout); return { startToken: "native-token" }; },
        runtimeId: () => "unit-runtime",
        wallTimestamp: () => "timestamp-" + ++clockReads,
    };
    return { ports, child, discovery, trace, transitions, current: () => current, replace: (next: AndroidEmulatorDevice | undefined) => { current = next; }, clockReads: () => clockReads };
}

export function brokerLifecyclePorts(initial: Record<string, unknown> | undefined = undefined) {
    let current = initial, time = 0;
    const trace: string[] = [], publications: unknown[] = [], commands: Array<{ provider: string; args?: string[]; timeoutMs: number }> = [];
    const ports: { -readonly [K in keyof BrokerAndroidEmulatorLifecyclePorts]: BrokerAndroidEmulatorLifecyclePorts[K] } = {
        execute: (command, options) => { trace.push("execute:" + command.provider); commands.push({ provider: command.provider, args: command.args, timeoutMs: options.timeoutMs }); return { ...command, status: 0, stdout: command.args?.includes("sys.boot_completed") ? "1\n" : command.args?.[0] === "devices" ? "List of devices attached\n" : "raw native output", stderr: "" }; },
        executable: name => name,
        now: () => time,
        sleep: ms => { time += ms; trace.push("sleep:" + ms); return undefined; },
        timestamp: () => { trace.push("timestamp"); return "native-timestamp"; },
        avdHome: () => "/owned-avd",
        validPort: port => typeof port === "number" && port % 2 === 0 && port >= 5554 && port <= 5682,
        livePorts: () => { trace.push("live-ports"); return { ok: true, ports: new Set() }; },
        liveAvds: () => { trace.push("live-avds"); return { ok: true, names: new Set() }; },
        avdProcesses: () => { trace.push("processes"); return { ok: true, active: false }; },
        ownedAvdName: (name, owner) => name.startsWith("ccc-" + owner + "-"),
        approvedAvdRoot: () => "/owned-avd",
        avdArtifacts: () => [],
        removeAvdArtifacts: (_name, _owner, _root, verifyInactive) => { trace.push("remove-avd"); if (!verifyInactive()) throw Error("Native liveness unavailable"); return { removed: [] }; },
        claimDefinition: (_owner, _parsed, device) => { trace.push("claim"); current = device; return { ok: true, device }; },
        cleanupAuxiliary: (_owner, _parsed, expected) => { trace.push("cleanup"); return { committed: false, device: expected, result: { ok: true, changed: false, appium: {}, recording: {}, minimizeWatchdog: {} } }; },
        transition: (_owner, _parsed, expected, replace) => {
            trace.push("publish"); publications.push(expected);
            if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return { found: Boolean(current), matched: false, device: current };
            const next = replace(current);
            if (next === null) current = undefined;
            else if (typeof next === "object" && !Array.isArray(next)) current = next as Record<string, unknown>;
            else throw Error("Invalid policy replacement");
            return { found: true, matched: true, device: current || null };
        },
        redactDevice: device => device,
        stateErrorCode: error => error instanceof Error ? error.message : null,
        stateFailure: error => ({ status: 500, payload: { ok: false, error: String(error) } }),
        failureDetail: result => [result.error && "error: " + result.error, result.stderr && "stderr: " + result.stderr, result.stdout && "stdout: " + result.stdout].filter(Boolean).join("\n"),
        commandTimeoutMs: 5000,
        outputLimit: 32768,
    };
    const input = (command: "device_create" | "device_start" | "device_stop" | "device_delete", overrides: Partial<BrokerAndroidLifecycleRequest> = {}): BrokerAndroidLifecycleInput => {
        const parsed: BrokerAndroidLifecycleRequest = { ok: true, backend: "android-emulator", stateKey: "android", command, deviceId: "android-unit", force: false, dryRun: false, ...overrides,
            ...(command === "device_create" ? { create: { port: 5630, ...overrides.create } } : {}) };
        const plannedDevice = command === "device_create" ? { id: parsed.deviceId, backend: parsed.backend, avdName: "ccc-owner-unit", port: 5630, status: "stopped", ...parsed.create } : current;
        return { ownerId: "owner", parsed, expectedDevice: current, createAvdRoot: "/owned-avd",
            plan: { device: plannedDevice, create: parsed.create, providerCommand: { mode: command === "device_start" ? "detached" : "exec", provider: command === "device_create" || command === "device_delete" ? "avdmanager" : command === "device_start" ? "emulator" : "adb", executable: command === "device_start" ? "emulator" : command === "device_create" || command === "device_delete" ? "avdmanager" : "adb", args: command === "device_stop" ? ["-s", "emulator-5630", "emu", "kill"] : command === "device_start" ? ["-avd", "ccc-owner-unit", "-port", "5630"] : command === "device_create" ? ["create", "avd", "--name", "ccc-owner-unit", "--package", "system-images;android-35;google_apis;x86_64", "--force"] : [] } } };
    };
    return { ports, input, trace, publications, commands, current: () => current, replace: (next: Record<string, unknown> | undefined) => { current = next; } };
}
