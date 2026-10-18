import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeAndroidMcpContext, cleanupFakeAndroidMcpContext, type FakeAndroidMcpContext } from "./fake-android-mcp-fixture.js";
import type { AndroidEmulatorLifecycleOutcome, AndroidEmulatorDevice, AndroidEmulatorLifecyclePorts, AndroidEmulatorProcessHandle } from "../../../packages/device-lab/providers/ports/lifecycle/android-emulator-lifecycle.mjs";
import type { BrokerAndroidLifecycleInput, BrokerAndroidLifecycleRequest } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidEmulatorLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/android-emulator-lifecycle.js";

export const ANDROID_SYSTEM_IMAGE = "system-images;android-35;google_apis;x86_64";
export const ANDROID_PORT_ALLOWED = "even integer 5554-5682";
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
        } catch (error) { failures.push(error); }
        try { await cleanupFakeAndroidMcpContext(context); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, name + ": assertion precedes cleanup failures");
}

export function privateBrokerHome(): { home: string; remove: () => void } {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-lifecycle-broker-"));
    return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}

export type DirectLifecycleResult = AndroidEmulatorLifecycleOutcome;
export interface DirectOwnedChild extends AndroidEmulatorProcessHandle { readonly pid: number; readonly nativeHandle: object }

// Pure application effect fixture. Public/native witnesses above remain the
// authority for storage, real process identity and teardown; this fixture tests
// only the moved policy against its precise current step contracts.
export function directLifecyclePorts(initial?: AndroidEmulatorDevice) {
    let current = initial, clockReads = 0;
    const trace: string[] = [], transitions: Array<{ expected: AndroidEmulatorDevice; replacement: AndroidEmulatorDevice | null }> = [];
    const child: DirectOwnedChild = { pid: 424242, nativeHandle: {} };
    const discovery = { adbAvailable: true, native: {}, available: true, missing: [], provisioningAvailable: true, provisioningMissing: [] };
    const ports: AndroidEmulatorLifecyclePorts<DirectOwnedChild> = {
        androidAvdHome: () => "/owned-avd",
        androidAvdIsInactive: () => { trace.push("inactive"); return true; },
        androidDeviceId: () => "android-unit",
        androidEmulatorSerial: port => `emulator-${port}`,
        androidDiscovery: () => { trace.push("discovery"); return discovery; },
        appiumPortForDevice: () => 4723,
        approvedAndroidAvdRoot: () => "/owned-avd",
        claimAndroidDevice: device => { trace.push("claim"); current = device; return { ok: true }; },
        deleteOwnedAndroidAvd: (_avd, options) => { trace.push("remove-avd"); if (!options.verifyInactive()) return { ok: false, error: "native-liveness-unverified" }; return { ok: true, artifactsRemoved: 2 }; },
        findAndroidDevice: () => current,
        isOwnedAvdName: (name: unknown): name is string => typeof name === "string",
        isSafeDeviceProfile: () => true,
        isSafeProvisionedAvdName: () => true,
        isSafeSystemImage: () => true,
        listOwnedAndroidAvdArtifacts: () => [],
        liveAndroidEmulatorPortsForAllocation: () => { trace.push("live-ports"); return { ok: true, ports: new Set() }; },
        ownerAvdPrefix: () => "ccc-owner-",
        ownerId: () => "owner",
        readAndroidDevices: () => { trace.push("read"); return current ? [current] : []; },
        refreshOwnedRuntimeProcessIdentity: runtime => runtime,
        resolveAndroidEmulatorPort: (_owner, _id, port) => { trace.push("allocate"); return { ok: true, port: port || 5630 }; },
        observeAndroidEmulator: () => { trace.push("observe-emulator"); return { live: true }; },
        stopAndroidEmulator: () => { trace.push("stop-emulator"); return { ok: true, diagnostic: {} }; },
        stopAndroidRecorder: () => { trace.push("stop-recorder"); },
        provisionAndroidAvd: () => { trace.push("provision"); return { ok: true, diagnostic: {} }; },
        signalAndroidRecorder: () => { trace.push("recorder-signal"); return { signaled: false }; },
        slug: () => "unit",
        launchAndroidEmulator: async () => { trace.push("spawn"); return child; },
        terminateFreshAndroidEmulatorProcessTree: async received => { trace.push("terminate-fresh"); if (received !== child) throw Error("Lost native child handle"); return { ok: true, exited: true }; },
        terminateOwnedRuntimeProcessTree: async (_runtime, label, options) => { trace.push("terminate:" + label + ":" + options.timeoutMs); return { exited: true }; },
        transitionAndroidDevice: (_id, expected, replacement) => { trace.push("transition"); transitions.push({ expected, replacement }); const matched = current === expected; if (matched) current = replacement || undefined; return { matched, found: Boolean(current) }; },
        waitForAndroidBoot: async (_discovery, _device, _timeout, received) => { trace.push("boot"); if (received !== child) throw Error("Lost native child handle"); return { ready: true }; },
        waitForProcessExit: async (_pid, timeout) => { trace.push("wait-exit:" + timeout); return true; },
        waitForProcessIdentity: async (_pid, timeout) => { trace.push("identity:" + timeout); return { startToken: "native-token" }; },
        runtimeId: () => "unit-runtime",
        wallTimestamp: () => "timestamp-" + ++clockReads,
    };
    return { ports, child, discovery, trace, transitions, current: () => current, replace: (next: AndroidEmulatorDevice | undefined) => { current = next; }, clockReads: () => clockReads };
}

export type BrokerAndroidTestEffect = { action: "create" | "start" | "stop" | "delete" | "stop-inventory" | "boot-probe" };
export type BrokerAndroidTestReceipt = { sequence: number; native?: object };
export type BrokerAndroidTestPorts = BrokerAndroidEmulatorLifecyclePorts<BrokerAndroidTestEffect, BrokerAndroidTestReceipt>;

export function brokerLifecyclePorts(initial: Record<string, unknown> | undefined = undefined) {
    let current = initial, time = 0, runtimeSequence = 0;
    const trace: string[] = [], publications: unknown[] = [], commands: Array<{ effect: BrokerAndroidTestEffect; timeoutMs: number }> = [];
    const observeEffect = (effect: BrokerAndroidTestEffect, options: {timeoutMs: number; outputLimit: number}): Awaited<ReturnType<BrokerAndroidTestPorts["executePrepared"]>> => {
        const provider = effect.action === "create" || effect.action === "delete" ? "avdmanager" : effect.action === "start" ? "emulator" : "adb";
        trace.push("execute:" + provider); commands.push({ effect, timeoutMs: options.timeoutMs });
        return { ok: true, mode: effect.action === "start" ? "detached" : "exec", provider, receipt: { sequence: commands.length } };
    };
    const ports: { -readonly [K in keyof BrokerAndroidTestPorts]: BrokerAndroidTestPorts[K] } = {
        executePrepared: observeEffect,
        observeStopInventory: async (effect, _serial, options) => ({ ...await observeEffect(effect, options), available: true, serialPresent: false }),
        observeBootProbe: async (effect, options) => ({ ...await observeEffect(effect, options), ready: true }),
        metadataObservation: () => ({ ok: true, mode: "noop", provider: "host-broker-state" }),
        prepareStopInventory: () => ({ kind: "ready", effect: { action: "stop-inventory" } }),
        prepareBootProbe: () => ({ kind: "ready", effect: { action: "boot-probe" } }),
        now: () => time,
        sleep: ms => { time += ms; trace.push("sleep:" + ms); return undefined; },
        timestamp: () => { trace.push("timestamp"); return "native-timestamp"; },
        runtimeId: () => "android-broker-runtime-" + ++runtimeSequence,
        avdHome: () => "/owned-avd",
        validPort: port => typeof port === "number" && port % 2 === 0 && port >= 5554 && port <= 5682,
        livePorts: () => { trace.push("live-ports"); return { ok: true, ports: new Set() }; },
        liveAvds: () => { trace.push("live-avds"); return { ok: true, names: new Set() }; },
        avdProcesses: () => { trace.push("processes"); return { ok: true, active: false }; },
        ownedAvdName: (name, owner) => name.startsWith("ccc-" + owner + "-"),
        approvedAvdRoot: () => "/owned-avd",
        avdArtifacts: () => [],
        removeAvdArtifacts: async (_name, _owner, _root, verifyInactive) => { trace.push("remove-avd"); if (!await verifyInactive()) throw Error("Native liveness unavailable"); return { removed: [] }; },
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
        stateErrorCode: () => null,
        commandTimeoutMs: 5000,
        outputLimit: 32768,
    };
    const input = (command: "device_create" | "device_start" | "device_stop" | "device_delete", overrides: Partial<BrokerAndroidLifecycleRequest> = {}): BrokerAndroidLifecycleInput<BrokerAndroidTestEffect> => {
        const parsed: BrokerAndroidLifecycleRequest = { ok: true, backend: "android-emulator", stateKey: "android", command, deviceId: "android-unit", force: false, dryRun: false, ...overrides,
            ...(command === "device_create" ? { create: { port: 5630, ...overrides.create } } : {}) };
        const plannedDevice = command === "device_create" ? { id: parsed.deviceId, backend: parsed.backend, avdName: "ccc-owner-unit", port: 5630, status: "stopped", ...parsed.create } : current;
        return { ownerId: "owner", parsed, expectedDevice: current, createAvdRoot: "/owned-avd",
            plan: { device: plannedDevice, create: parsed.create, preparation: { kind: "ready", mode: command === "device_start" ? "detached" : "exec", provider: command === "device_create" || command === "device_delete" ? "avdmanager" : command === "device_start" ? "emulator" : "adb", effect: { action: command === "device_create" ? "create" : command === "device_start" ? "start" : command === "device_stop" ? "stop" : "delete" } } } };
    };
    return { ports, input, trace, publications, commands, current: () => current, replace: (next: Record<string, unknown> | undefined) => { current = next; }, advanceTime: (milliseconds: number) => { time += milliseconds; } };
}

/** A held native effect; tests release every gate even when an assertion fails. */
export function deferredAndroidEffect<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
    return { promise, resolve, reject };
}
