import { brokerAndroidAvdName, brokerAndroidCommandSucceeded, brokerAndroidField, brokerAndroidNumber, brokerAndroidRecord, brokerAndroidReplacement, brokerAndroidSerial, brokerAndroidStartArgs } from "../../domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidBoot, BrokerAndroidLifecycleInput, BrokerAndroidLifecycleRequest, BrokerAndroidLifecycleResponse, BrokerAndroidProviderCommand, BrokerAndroidProviderResult } from "../../domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidCreatePortAllocation, BrokerAndroidCreatePortAllocationPorts, BrokerAndroidEmulatorLifecyclePorts } from "../../ports/lifecycle/android-emulator-lifecycle.js";

/** Live augmentation reuses the broker's already inward preview allocator. */
export function allocateBrokerAndroidCreatePort(ownerId: string, parsed: BrokerAndroidLifecycleRequest, ports: BrokerAndroidCreatePortAllocationPorts): BrokerAndroidCreatePortAllocation {
    const allocation = ports.previewAllocation(ownerId, parsed);
    if (!allocation.ok) return allocation;
    const live = ports.livePorts();
    if (!live.ok) return live;
    return live.ports.has(allocation.port) ? ports.previewAllocation(ownerId, parsed, live.ports) : allocation;
}

export function createBrokerAndroidRecord(ownerId: string, parsed: BrokerAndroidLifecycleRequest, ports: Pick<BrokerAndroidEmulatorLifecyclePorts, "timestamp" | "avdHome">): Record<string, unknown> {
    const create = parsed.create || {};
    const now = ports.timestamp();
    const name = String(create.name || parsed.deviceId);
    const avdName = brokerAndroidAvdName(ownerId, create, name);
    const root = ports.avdHome();
    return brokerAndroidRecord(ownerId, parsed, create, name, avdName, root, now);
}

export function planBrokerAndroidCreateCommand(ownerId: string, parsed: BrokerAndroidLifecycleRequest, ports: Pick<BrokerAndroidEmulatorLifecyclePorts, "ownedAvdName" | "executable">, create = parsed.create || {}): BrokerAndroidProviderCommand | { error: string; missing: string[] } {
    const systemImage = typeof create.systemImage === "string" ? create.systemImage : null;
    if (!systemImage) return { error: "missing-provider-metadata", missing: ["systemImage"] };
    const name = String(create.name || parsed.deviceId);
    const avdName = brokerAndroidAvdName(ownerId, create, name);
    if (!ports.ownedAvdName(avdName, ownerId)) return { error: "android-avd-name-not-owner-scoped", missing: ["owner-prefixed avdName"] };
    const executable = ports.executable("avdmanager");
    const args = ["create", "avd", "--name", avdName, "--package", systemImage, "--force"];
    if (typeof create.deviceProfile === "string" && create.deviceProfile) args.push("--device", create.deviceProfile);
    return { mode: "exec", provider: "avdmanager", executable: executable || undefined, args, input: "no\n" };
}

export function planBrokerAndroidExistingCommand(ownerId: string, parsed: BrokerAndroidLifecycleRequest, device: unknown, ports: Pick<BrokerAndroidEmulatorLifecyclePorts, "ownedAvdName" | "executable">): BrokerAndroidProviderCommand | { error: string; missing: string[] } {
    const adb = ports.executable("adb");
    const emulator = ports.executable("emulator");
    const serial = brokerAndroidSerial(device);
    const name = brokerAndroidField(device, "avdName");
    if (parsed.command === "device_status") {
        if (!serial) return { error: "missing-provider-metadata", missing: ["serial or port"] };
        return { mode: "exec", provider: "adb", executable: adb || undefined, args: ["-s", serial, "get-state"] };
    }
    if (parsed.command === "device_stop") {
        if (!serial) return { error: "missing-provider-metadata", missing: ["serial or port"] };
        return { mode: "exec", provider: "adb", executable: adb || undefined, args: ["-s", serial, "emu", "kill"] };
    }
    if (parsed.command === "device_delete") {
        if (parsed.deleteAvd === false) return { mode: "noop", provider: "host-broker-state", reason: "Android emulator deleteAvd=false deletes only owner broker metadata" };
        if (!name) return { error: "missing-provider-metadata", missing: ["avdName"] };
        if (!ports.ownedAvdName(name, ownerId)) return { error: "android-avd-name-not-owner-scoped", missing: ["owner-prefixed avdName"] };
        return { mode: "noop", provider: "host-broker-state", reason: "Owner-scoped Android AVD artifacts are removed through identity-fenced storage cleanup" };
    }
    if (!name) return { error: "missing-provider-metadata", missing: ["avdName"] };
    const port = brokerAndroidNumber(device, "port");
    return { mode: "detached", provider: "emulator", executable: emulator || undefined, args: ["-avd", name, ...(port ? ["-port", String(port)] : []), ...brokerAndroidStartArgs(parsed, device)], windowsHiddenLauncher: true };
}

/** Authenticated broker policy; it does not share the direct provider workflow. */
export function createBrokerAndroidEmulatorLifecycle(ports: BrokerAndroidEmulatorLifecyclePorts) {
    function refusal(input: BrokerAndroidLifecycleInput, status: number, error: string, extra: Record<string, unknown> = {}): BrokerAndroidLifecycleResponse {
        return { status, payload: { ok: false, error, ...extra, ownerId: input.ownerId, backend: input.parsed.backend, deviceId: input.parsed.deviceId } };
    }

    function inactive(name: string): boolean {
        const live = ports.liveAvds();
        if (!live.ok || live.names.has(name)) return false;
        const processes = ports.avdProcesses(name);
        return processes.ok && !processes.active;
    }

    async function rollbackClaim(device: Record<string, unknown>, existing: Record<string, unknown> | null, command: BrokerAndroidProviderCommand | null | undefined) {
        if (!command || command.mode === "noop") return { attempted: false, ok: true, reason: "no-provider-resource-created" };
        if (existing?.avdName === device.avdName) return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        const ownerId = brokerAndroidField(device, "ownerId");
        if (!ownerId) return { attempted: false, ok: false, reason: "created-avd-owner-id-missing" };
        const name = brokerAndroidField(device, "avdName");
        if (!name || !ports.ownedAvdName(name, ownerId)) return { attempted: false, ok: false, reason: "created-avd-identity-unverified" };
        const live = ports.liveAvds();
        if (!live.ok || live.names.has(name)) return { attempted: false, ok: false, reason: live.ok && live.names.has(name) ? "created-avd-active" : "created-avd-liveness-unverified" };
        const processes = ports.avdProcesses(name);
        if (!processes.ok || processes.active) return { attempted: false, ok: false, reason: processes.ok && processes.active ? "created-avd-active" : "created-avd-liveness-unverified" };
        const root = ports.approvedAvdRoot(brokerAndroidField(device, "avdRoot"));
        if (!root) return { attempted: false, ok: false, reason: "created-avd-root-unavailable" };
        try {
            const cleanup = ports.removeAvdArtifacts(name, ownerId, root, () => inactive(name));
            return { attempted: true, ok: true, artifactsRemoved: cleanup.removed };
        } catch { return { attempted: true, ok: false, reason: "android-avd-artifact-cleanup-failed" }; }
    }

    async function create(input: BrokerAndroidLifecycleInput): Promise<BrokerAndroidLifecycleResponse> {
        const { ownerId, parsed, plan, createAvdRoot } = input;
        const command = plan?.providerCommand;
        if (command && "error" in command) return { status: 400, payload: { ok: false, error: command.error, missing: command.missing || [], plan: plan || null } };
        if (parsed.create?.createAvd === true) {
            const name = brokerAndroidField(plan?.device, "avdName");
            if (!name || !createAvdRoot || !ports.ownedAvdName(name, ownerId)) return refusal(input, 409, "android-avd-create-identity-unavailable");
            try {
                if (ports.avdArtifacts(ownerId, createAvdRoot).some(artifact => artifact.name === name)) return refusal(input, 409, "android-avd-artifacts-already-exist");
            } catch { return refusal(input, 409, "android-avd-storage-preflight-failed"); }
        }
        let execution: BrokerAndroidProviderResult = { mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" };
        if (command && command.mode !== "noop") {
            execution = ports.execute(command, { timeoutMs: parsed.create?.createAvd === true ? 300000 : ports.commandTimeoutMs, outputLimit: ports.outputLimit });
            if (!brokerAndroidCommandSucceeded(execution)) {
                let rollback: Record<string, unknown> | null = null;
                if (parsed.create?.createAvd === true) {
                    const name = brokerAndroidField(plan?.device, "avdName");
                    if (name && createAvdRoot && ports.ownedAvdName(name, ownerId)) {
                        try {
                            const cleanup = ports.removeAvdArtifacts(name, ownerId, createAvdRoot, () => inactive(name));
                            rollback = { ok: true, artifactsRemoved: cleanup.removed };
                        } catch { rollback = { ok: false, error: "android-avd-artifact-cleanup-failed" }; }
                    } else { rollback = { ok: false, error: "android-avd-create-identity-unavailable" }; }
                }
                return { status: 502, payload: {
                    ok: false, error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", detail: ports.failureDetail(execution),
                    ...(rollback ? { rollback } : {}),
                    result: {
                        ...(plan ? { ...plan, device: ports.redactDevice(plan.device) } : {}),
                        invoked: true, dryRun: false,
                        execution: { mode: execution.mode, providerExecution: "executed", mutatesHost: false, command: execution },
                    },
                } };
            }
        }
        const persistedParsed = plan?.create && typeof plan.create === "object" ? { ...parsed, create: plan.create as Record<string, unknown> } : parsed;
        const device = createBrokerAndroidRecord(ownerId, persistedParsed, ports);
        if (parsed.create?.createAvd === true) {
            if (!createAvdRoot) return refusal(input, 502, "android-avd-root-unavailable");
            device.avdRoot = createAvdRoot;
        }
        let claim;
        try { claim = ports.claimDefinition(ownerId, persistedParsed, device); }
        catch (error) {
            const rollback = await rollbackClaim(device, null, command);
            if (!rollback.ok) return refusal(input, 502, "owner-device-state-rollback-failed", { stateError: ports.stateErrorCode(error) || "owner-state-write-failed", rollback });
            const failure = ports.stateFailure(error, parsed);
            return { ...failure, payload: { ...(failure.payload as Record<string, unknown>), rollback } };
        }
        if (!claim.ok) {
            const rollback = await rollbackClaim(device, claim.existing, command);
            return refusal(input, rollback.ok ? 409 : 502, rollback.ok ? claim.error : "owner-device-conflict-rollback-failed", {
                field: claim.field, value: claim.value, existing: ports.redactDevice(claim.existing), rollback,
            });
        }
        return { status: 200, payload: { ok: true, result: {
            ...(plan || {}), device: ports.redactDevice(device), invoked: true, dryRun: false,
            execution: {
                mode: execution.mode === "noop" ? "state" : execution.mode,
                providerExecution: execution.mode === "noop" ? "broker-state" : "executed", mutatesHost: true,
                ...(execution.mode === "noop" ? {} : { command: execution }),
            },
        } } };
    }

    function confirmStop(device: unknown): string | null {
        const serial = brokerAndroidSerial(device);
        const name = brokerAndroidField(device, "avdName");
        const adb = ports.executable("adb");
        if (!serial || !name || !/^[A-Za-z0-9._-]+$/.test(name) || !adb) return "identity-unavailable";
        const deadline = ports.now() + 30000;
        while (ports.now() < deadline) {
            let serialPresent: boolean;
            try {
                const remaining = deadline - ports.now();
                if (remaining <= 0) break;
                const inventory = ports.execute({ mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }, { timeoutMs: Math.min(10000, remaining), outputLimit: ports.outputLimit });
                const lines = String(inventory.stdout || "").split(/\r?\n/).map(line => line.trim());
                if (!brokerAndroidCommandSucceeded(inventory) || inventory.timedOut || inventory.outputLimitExceeded || !lines.includes("List of devices attached")) return "inventory-unavailable";
                serialPresent = lines.some(line => line.split(/\s+/)[0] === serial);
            } catch { return "inventory-unavailable"; }
            const remaining = deadline - ports.now();
            if (remaining <= 0) break;
            try {
                const processes = ports.avdProcesses(name, Math.min(10000, remaining), true);
                if (!processes.ok) return "process-inventory-unavailable";
                if (ports.now() >= deadline) break;
                if (!serialPresent && !processes.active) return null;
            } catch { return "process-inventory-unavailable"; }
            ports.sleep(Math.min(250, Math.max(0, deadline - ports.now())));
        }
        return "deadline-exceeded";
    }

    function confirmBoot(parsed: BrokerAndroidLifecycleRequest, device: unknown): BrokerAndroidBoot {
        if (parsed.waitForBoot !== true) return { ok: true, ready: false, skipped: true };
        const serial = brokerAndroidSerial(device);
        const adb = ports.executable("adb");
        if (!serial || !adb) return { ok: false, ready: false, error: {
            mode: "exec", provider: "adb", executable: adb || undefined,
            args: serial ? ["-s", serial, "shell", "getprop", "sys.boot_completed"] : [], status: null,
            error: serial ? "missing-executable: adb" : "missing-provider-metadata: serial or port",
        } };
        const timeout = Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000, Math.max(1000, Number(parsed.bootTimeoutMs))) : 60000;
        const deadline = ports.now() + timeout;
        const attempts: BrokerAndroidProviderResult[] = [];
        while (ports.now() < deadline) {
            const result = ports.execute({ mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "shell", "getprop", "sys.boot_completed"] }, {
                timeoutMs: Math.min(ports.commandTimeoutMs, Math.max(1000, deadline - ports.now())), outputLimit: ports.outputLimit,
            });
            attempts.push(result);
            if (brokerAndroidCommandSucceeded(result) && String(result.stdout || "").trim() === "1") return { ok: true, ready: true, result, attempts: attempts.slice(-4) };
            ports.sleep(Math.min(1000, Math.max(0, deadline - ports.now())));
        }
        const last = attempts.at(-1);
        return { ok: false, ready: false, error: {
            mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            status: last?.status ?? null, signal: last?.signal, stdout: last?.stdout, stderr: last?.stderr,
            error: `Timed out waiting for Android emulator ${serial} to boot`,
        }, attempts: attempts.slice(-8) };
    }

    async function invoke(input: BrokerAndroidLifecycleInput): Promise<BrokerAndroidLifecycleResponse> {
        const { ownerId, parsed, plan } = input;
        let expectedDevice = input.expectedDevice;
        const command = plan?.providerCommand;
        if (!command || "error" in command) return { status: 400, payload: {
            ok: false, error: command?.error || "missing-provider-command", missing: command?.missing || [],
            plan: plan ? { ...plan, device: ports.redactDevice(plan.device) } : null,
        } };
        if (parsed.command === "device_start") {
            const port = brokerAndroidNumber(plan?.device, "port");
            if (ports.validPort(port)) {
                const live = ports.livePorts();
                if (!live.ok) return refusal(input, live.status, live.error, { detail: live.detail });
                if (live.ports.has(port as number)) return refusal(input, 409, "android-emulator-port-conflict", { detail: `port-${port}-already-in-use` });
            }
        }
        if (parsed.command === "device_delete" && parsed.deleteAvd !== false) {
            const name = brokerAndroidField(plan?.device, "avdName");
            const root = ports.approvedAvdRoot(brokerAndroidField(plan?.device, "avdRoot"));
            if (!root || !name || !ports.ownedAvdName(name, ownerId)) return refusal(input, 409, !root ? "android-avd-root-unavailable" : "android-avd-identity-unavailable");
            const live = ports.liveAvds();
            if (!live.ok) return refusal(input, live.status, "android-avd-liveness-unverified", { detail: live.detail });
            if (live.names.has(name)) return refusal(input, 409, "android-avd-active");
            const processes = ports.avdProcesses(name);
            if (!processes.ok) return refusal(input, processes.status, "android-avd-liveness-unverified", { detail: processes.detail });
            if (processes.active) return refusal(input, 409, "android-avd-active");
        }
        const effectiveCommand: BrokerAndroidProviderCommand = parsed.command === "device_delete" && parsed.deleteAvd !== false
            ? { mode: "noop", provider: "host-broker-state", reason: "Android AVD artifacts are removed by identity-fenced storage cleanup" }
            : command;
        const auxiliary = parsed.command === "device_stop" || parsed.command === "device_delete" ? ports.cleanupAuxiliary(ownerId, parsed, expectedDevice) : null;
        if (auxiliary?.committed) expectedDevice = structuredClone(auxiliary.device);
        if (auxiliary?.result.ok === false) return { status: 502, payload: { ok: false, error: "auxiliary-runtime-cleanup-failed", result: {
            ...(plan || {}), device: ports.redactDevice(auxiliary.device), auxiliaryCleanup: auxiliary.result, invoked: false, dryRun: false,
            execution: { mode: "preflight", providerExecution: "blocked", mutatesHost: auxiliary.result.changed === true || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true },
        } } };
        const execution = ports.execute(effectiveCommand, { timeoutMs: parsed.command === "device_delete" && parsed.deleteAvd !== false ? 120000 : ports.commandTimeoutMs, outputLimit: ports.outputLimit });
        let success = brokerAndroidCommandSucceeded(execution);
        if (success && parsed.command === "device_stop") {
            const stopFailure = confirmStop(plan?.device);
            if (stopFailure) return refusal(input, 502, "android-emulator-stop-unconfirmed", { detail: stopFailure, result: {
                ...(plan || {}), device: ports.redactDevice(plan?.device), invoked: true, dryRun: false,
                execution: { mode: execution.mode, providerExecution: "executed", mutatesHost: true, command: execution },
            } });
        }
        if (parsed.command === "device_delete" && parsed.deleteAvd !== false) {
            const name = brokerAndroidField(plan?.device, "avdName");
            const root = ports.approvedAvdRoot(brokerAndroidField(plan?.device, "avdRoot"));
            try {
                if (!name || !root) throw new Error("missing-provider-metadata");
                ports.removeAvdArtifacts(name, ownerId, root, () => inactive(name));
                success = true;
            } catch { return refusal(input, 502, "android-avd-artifact-cleanup-failed"); }
        }
        let boot: BrokerAndroidBoot | null = null;
        if (success && parsed.command === "device_start") { boot = confirmBoot(parsed, plan?.device); if (!boot.ok) success = false; }
        const publication = success ? ports.transition(ownerId, parsed, expectedDevice, candidate => parsed.command === "device_delete" ? null : { ...brokerAndroidReplacement(candidate, parsed, boot), updatedAt: ports.timestamp() }) : null;
        const updatedDevice = success ? publication?.device : plan?.device;
        return { status: publication && !publication.matched ? 409 : success ? 200 : 502, payload: {
            ok: success && (!publication || publication.matched),
            ...(publication && !publication.matched ? { error: "owner-device-state-conflict", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, found: publication.found } : {}),
            ...(success || (publication && !publication.matched) ? {} : { error: "provider-command-failed", detail: ports.failureDetail(execution) }),
            result: {
                ...(plan || {}), providerCommand: effectiveCommand, device: ports.redactDevice(updatedDevice),
                ...(boot ? { boot: boot.ok ? { ready: boot.ready, skipped: boot.skipped === true, provider: "adb", result: boot.result || null } : { ready: false, skipped: false, provider: "adb", error: boot.error } } : {}),
                ...(auxiliary ? { auxiliaryCleanup: auxiliary.result } : {}), invoked: true, dryRun: false,
                execution: { mode: execution.mode, providerExecution: "executed", mutatesHost: success,
                    command: boot && !boot.ok ? { ...execution, registration: null, macosBoot: null, androidBoot: boot } : execution },
            },
        } };
    }

    function start(input: BrokerAndroidLifecycleInput) { return invoke(input); }
    function stop(input: BrokerAndroidLifecycleInput) { return invoke(input); }
    function deleteDevice(input: BrokerAndroidLifecycleInput) { return invoke(input); }
    return { create, start, stop, delete: deleteDevice };
}
