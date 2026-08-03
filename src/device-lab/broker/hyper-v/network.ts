import { createHash, randomBytes } from "crypto";
import { lstatSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { readDeviceLabStateFile, readDeviceLabTextFile } from "../../../device-lab-state-file.js";
import { writeJsonFileAtomically } from "../../../device-lab-shared-state.js";
import {
    HYPER_V_NETWORK_GATEWAY,
    HYPER_V_NETWORK_MARKER,
    HYPER_V_NETWORK_NAT,
    HYPER_V_NETWORK_PREFIX,
    HYPER_V_NETWORK_PREFIX_LENGTH,
    HYPER_V_NETWORK_SWITCH,
    hyperVCleanupNetworkCommand,
    hyperVEnsureNetworkCommand,
    parseHyperVNetworkCleanupObservation,
    parseHyperVNetworkObservation,
    type HyperVProviderCommand,
} from "../../../host-control/hyper-v/index.js";
import { assertHyperVOperationDeadline, hyperVRemainingTimeout } from "./deadline.js";
import {
    hyperVBoundedErrorCode,
    hyperVProviderDiagnosticCode,
    redactProviderCommandInput,
} from "./public-response.js";
import { validHyperVIncarnationId } from "./state.js";

const HYPER_V_NETWORK_STATE_LIMIT_BYTES = 256 * 1024;
const HYPER_V_ELEVATED_TERMINATION_GRACE_MS = 10_000;

export type HyperVNetworkCommandResult = {
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
};

export interface HyperVNetworkStateRuntime {
    privateRoot: string;
    assertSafePath(path: string, label: string): void;
}

export interface HyperVNetworkRuntime extends HyperVNetworkStateRuntime {
    resolveExecutable(name: string): string | null;
    resolveElevationExecutable(standardExecutable: string): string;
    run(
        command: HyperVProviderCommand,
        options: { timeoutMs: number; outputLimit: number },
    ): Promise<HyperVNetworkCommandResult>;
    commandOutputBytes: number;
}

export type HyperVNetworkAllocation = {
    ownerId: string;
    deviceId: string;
    incarnationId?: string;
    address: string;
    macAddress: string;
    allocatedAt: string;
};

type HyperVNetworkState = {
    version: 1;
    switchName: string;
    switchId: string;
    marker: string;
    natName: string;
    natInstanceId?: string;
    prefix: string;
    gateway: string;
    outboundPolicy: "nat";
    managedNat: boolean;
    allocations: HyperVNetworkAllocation[];
};

type HyperVNetworkIntent = {
    version: 1;
    token: string;
    switchName: string;
    natName: string;
    marker: string;
    prefix: string;
    gateway: string;
    createdAt: string;
};

export type HyperVNetworkRelease = {
    ok: boolean;
    released: boolean;
    statePresent: boolean;
    remaining: number;
    managedNat?: boolean;
    switchName?: string;
    switchId?: string;
    natName?: string;
    marker?: string;
    natInstanceId?: string;
    error?: string;
};

export function hyperVDeterministicMacAddress(ownerId: string, deviceId: string, salt = 0): string {
    const digest = createHash("sha256").update(`${ownerId}\0${deviceId}\0${salt}`).digest();
    const bytes = [0x02, digest[0], digest[1], digest[2], digest[3], digest[4]];
    return bytes.map((value) => value.toString(16).padStart(2, "0")).join(":");
}

export function hyperVDeterministicNetworkAddresses(ownerId: string, deviceId: string): string[] {
    const digest = createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest();
    const start = digest.readUInt32BE(0) % 241;
    let step = (digest.readUInt32BE(4) % 240) + 1;
    while (step % 241 === 0) step += 1;
    return Array.from({ length: 241 }, (_, index) => `172.29.0.${10 + ((start + index * step) % 241)}`);
}

function isGuid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function stateFile(runtime: HyperVNetworkStateRuntime): string {
    return join(runtime.privateRoot, "network", "hyper-v.json");
}

function intentFile(runtime: HyperVNetworkStateRuntime): string {
    return join(runtime.privateRoot, "network", "hyper-v-intent.json");
}

function ensureStateRoot(runtime: HyperVNetworkStateRuntime): void {
    const root = dirname(stateFile(runtime));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    runtime.assertSafePath(root, "hyper-v-network-state-root");
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("hyper-v-network-state-root-invalid");
}

function readState(runtime: HyperVNetworkStateRuntime): HyperVNetworkState | null {
    return readDeviceLabStateFile(stateFile(runtime), (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hyper-v-network-state-invalid");
        const state = parsed as Record<string, unknown>;
        if (state.version !== 1
            || state.switchName !== HYPER_V_NETWORK_SWITCH
            || typeof state.switchId !== "string" || !isGuid(state.switchId)
            || (state.natName !== HYPER_V_NETWORK_NAT && !/^CCCDeviceLab-[a-f0-9]{24}$/.test(String(state.natName || "")))
            || (state.marker !== undefined && (typeof state.marker !== "string" || !/^ccc-device-lab:hyper-v-network:(?:v1|[a-f0-9]{24})$/.test(state.marker)))
            || (state.natInstanceId !== undefined && (typeof state.natInstanceId !== "string" || !state.natInstanceId || state.natInstanceId.length > 256 || /[\u0000-\u001f]/.test(state.natInstanceId)))
            || (state.managedNat === true && (typeof state.natInstanceId !== "string" || !state.natInstanceId))
            || state.prefix !== HYPER_V_NETWORK_PREFIX
            || state.gateway !== HYPER_V_NETWORK_GATEWAY
            || (state.outboundPolicy !== undefined && state.outboundPolicy !== "nat")
            || (state.managedNat !== undefined && typeof state.managedNat !== "boolean")
            || !Array.isArray(state.allocations)) throw new Error("hyper-v-network-state-invalid");
        const identities = new Set<string>();
        const addresses = new Set<string>();
        const macAddresses = new Set<string>();
        const allocations = state.allocations.map((candidate) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("hyper-v-network-allocation-invalid");
            const allocation = candidate as Record<string, unknown>;
            if (typeof allocation.ownerId !== "string" || !/^[a-f0-9]{16}$/.test(allocation.ownerId)
                || typeof allocation.deviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._:-]{1,128}$/.test(allocation.deviceId)
                || (allocation.incarnationId !== undefined && !validHyperVIncarnationId(allocation.incarnationId))
                || typeof allocation.address !== "string" || !/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/.test(allocation.address)
                || (allocation.macAddress !== undefined && (typeof allocation.macAddress !== "string" || !/^02(?::[a-f0-9]{2}){5}$/.test(allocation.macAddress)))
                || typeof allocation.allocatedAt !== "string") throw new Error("hyper-v-network-allocation-invalid");
            const identity = `${allocation.ownerId}:${allocation.deviceId}`;
            const macAddress = typeof allocation.macAddress === "string"
                ? allocation.macAddress
                : hyperVDeterministicMacAddress(allocation.ownerId as string, allocation.deviceId as string);
            if (identities.has(identity) || addresses.has(allocation.address as string) || macAddresses.has(macAddress)) {
                throw new Error("hyper-v-network-allocation-conflict");
            }
            identities.add(identity);
            addresses.add(allocation.address as string);
            macAddresses.add(macAddress);
            return { ...allocation, macAddress } as HyperVNetworkAllocation;
        });
        return {
            ...(state as Omit<HyperVNetworkState, "allocations" | "outboundPolicy" | "managedNat" | "marker">),
            marker: typeof state.marker === "string" ? state.marker : HYPER_V_NETWORK_MARKER,
            outboundPolicy: "nat",
            managedNat: state.managedNat === true,
            allocations,
        } as HyperVNetworkState;
    }, "hyper-v-network-state", HYPER_V_NETWORK_STATE_LIMIT_BYTES);
}

function readIntent(runtime: HyperVNetworkStateRuntime): HyperVNetworkIntent | null {
    return readDeviceLabStateFile(intentFile(runtime), (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("hyper-v-network-intent-invalid");
        const intent = parsed as Record<string, unknown>;
        if (intent.version !== 1
            || typeof intent.token !== "string" || !/^[a-f0-9]{24}$/.test(intent.token)
            || intent.switchName !== HYPER_V_NETWORK_SWITCH
            || intent.natName !== `${HYPER_V_NETWORK_NAT}-${intent.token}`
            || intent.marker !== `ccc-device-lab:hyper-v-network:${intent.token}`
            || intent.prefix !== HYPER_V_NETWORK_PREFIX
            || intent.gateway !== HYPER_V_NETWORK_GATEWAY
            || typeof intent.createdAt !== "string") throw new Error("hyper-v-network-intent-invalid");
        return intent as HyperVNetworkIntent;
    }, "hyper-v-network-intent", HYPER_V_NETWORK_STATE_LIMIT_BYTES);
}

function createIntent(runtime: HyperVNetworkStateRuntime): HyperVNetworkIntent {
    const token = randomBytes(12).toString("hex");
    const intent: HyperVNetworkIntent = {
        version: 1,
        token,
        switchName: HYPER_V_NETWORK_SWITCH,
        natName: `${HYPER_V_NETWORK_NAT}-${token}`,
        marker: `ccc-device-lab:hyper-v-network:${token}`,
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        createdAt: new Date().toISOString(),
    };
    ensureStateRoot(runtime);
    writeJsonFileAtomically(intentFile(runtime), intent);
    return intent;
}

function removeIntentBestEffort(runtime: HyperVNetworkStateRuntime): void {
    try {
        rmSync(intentFile(runtime), { recursive: true, force: true });
    } catch {
        // A later allocation reconciles stale intent against committed state.
    }
}

function commandSucceeded(result: HyperVNetworkCommandResult): boolean {
    return result.status === 0 && !result.error;
}

function elevationRequired(result: HyperVNetworkCommandResult): boolean {
    const diagnostic = [result.error, result.stderr, result.stdout].map((value) => String(value || "")).join("\n");
    return diagnostic.includes("hyper-v-network-elevation-required")
        || diagnostic.includes("PermissionDenied")
        || diagnostic.includes("Windows System Error 5")
        || /access (?:is )?denied/i.test(diagnostic);
}

async function runWithElevation(
    runtime: HyperVNetworkRuntime,
    standard: HyperVProviderCommand,
    elevated: (deadlineUnixMs: number) => HyperVProviderCommand,
    deadlineAt: number,
): Promise<HyperVNetworkCommandResult> {
    let execution = await runtime.run(standard, {
        timeoutMs: hyperVRemainingTimeout(deadlineAt, 120000),
        outputLimit: runtime.commandOutputBytes,
    });
    if (!commandSucceeded(execution) && elevationRequired(execution)) {
        const timeoutMs = hyperVRemainingTimeout(deadlineAt, 180000);
        const elevatedDeadlineUnixMs = Date.now() + Math.max(1, timeoutMs - HYPER_V_ELEVATED_TERMINATION_GRACE_MS);
        let elevatedCommand: HyperVProviderCommand;
        try {
            elevatedCommand = elevated(elevatedDeadlineUnixMs);
        } catch (error) {
            return { ...execution, status: 1, error: error instanceof Error ? error.message : String(error) };
        }
        execution = await runtime.run(elevatedCommand, {
            timeoutMs,
            outputLimit: runtime.commandOutputBytes,
        });
    }
    return execution;
}

export async function ensureHyperVNetworkAllocation(
    runtime: HyperVNetworkRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<
    | { ok: true; switchName: string; address: string; macAddress: string; gateway: string; prefix: string; outboundPolicy: "nat" }
    | { ok: false; status: number; error: string; detail?: string; execution?: Record<string, unknown>; preserveEvidence?: boolean }
> {
    const powershell = runtime.resolveExecutable("powershell.exe")
        || runtime.resolveExecutable("pwsh")
        || runtime.resolveExecutable("powershell");
    if (!powershell) return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
    if (!validHyperVIncarnationId(incarnationId)) return { ok: false, status: 409, error: "hyper-v-network-incarnation-invalid" };
    let current: HyperVNetworkState | null;
    let intent: HyperVNetworkIntent | null = null;
    try {
        current = readState(runtime);
        if (current) {
            let staleIntent: HyperVNetworkIntent | null = null;
            try {
                staleIntent = readIntent(runtime);
            } catch {
                // Committed state is authoritative.
            }
            if (staleIntent && (current.switchName !== staleIntent.switchName
                || current.natName !== staleIntent.natName
                || current.marker !== staleIntent.marker)) {
                throw new Error("hyper-v-network-intent-state-conflict");
            }
            removeIntentBestEffort(runtime);
        } else {
            intent = readIntent(runtime);
            if (!intent) intent = createIntent(runtime);
        }
    } catch (error) {
        return {
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-failed",
            detail: hyperVBoundedErrorCode(error, "hyper-v-network-allocation-failed"),
        };
    }
    const networkOptions = {
        executable: powershell,
        switchName: current?.switchName || intent!.switchName,
        natName: current?.natName || intent!.natName,
        marker: current?.marker || intent!.marker,
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
        allowExistingNat: Boolean(current?.natInstanceId) || Boolean(intent),
        expectedSwitchId: current?.switchId,
        expectedNatInstanceId: current?.natInstanceId,
    };
    const execution = await runWithElevation(
        runtime,
        hyperVEnsureNetworkCommand(networkOptions),
        (elevatedDeadlineUnixMs) => hyperVEnsureNetworkCommand({
            ...networkOptions,
            executable: runtime.resolveElevationExecutable(powershell),
            elevated: true,
            elevatedDeadlineUnixMs,
        }),
        deadlineAt,
    );
    assertHyperVOperationDeadline(deadlineAt);
    if (!commandSucceeded(execution)) {
        return {
            ok: false,
            status: 502,
            error: "hyper-v-network-setup-failed",
            detail: hyperVProviderDiagnosticCode(execution, "hyper-v-network-setup-failed"),
            execution: redactProviderCommandInput(execution, true, "hyper-v-network-setup-failed"),
            preserveEvidence: true,
        };
    }
    const observation = parseHyperVNetworkObservation(execution.stdout || "");
    if (!observation
        || observation.switchName !== (current?.switchName || intent!.switchName)
        || observation.natName !== (current?.natName || intent!.natName)
        || observation.prefix !== HYPER_V_NETWORK_PREFIX
        || observation.gateway !== HYPER_V_NETWORK_GATEWAY) {
        return { ok: false, status: 502, error: "hyper-v-network-setup-invalid-result", preserveEvidence: true };
    }
    try {
        if (current && current.switchId.toLowerCase() !== observation.switchId.toLowerCase()) {
            throw new Error("hyper-v-network-switch-identity-conflict");
        }
        if (current?.natInstanceId && current.natInstanceId !== observation.natInstanceId) {
            throw new Error("hyper-v-network-nat-identity-conflict");
        }
        const allocations = current?.allocations || [];
        const existing = allocations.find((allocation) => allocation.ownerId === ownerId && allocation.deviceId === deviceId);
        if (existing) {
            if (existing.incarnationId !== incarnationId) throw new Error("hyper-v-network-allocation-incarnation-conflict");
            return {
                ok: true,
                switchName: observation.switchName,
                address: existing.address,
                macAddress: existing.macAddress,
                gateway: observation.gateway,
                prefix: observation.prefix,
                outboundPolicy: "nat",
            };
        }
        const used = new Set(allocations.map((allocation) => allocation.address));
        const address = hyperVDeterministicNetworkAddresses(ownerId, deviceId).find((candidate) => !used.has(candidate));
        if (!address) throw new Error("hyper-v-network-address-space-exhausted");
        const usedMacs = new Set(allocations.map((allocation) => allocation.macAddress));
        let macSalt = 0;
        let macAddress = hyperVDeterministicMacAddress(ownerId, deviceId, macSalt);
        while (usedMacs.has(macAddress) && macSalt < 1024) {
            macAddress = hyperVDeterministicMacAddress(ownerId, deviceId, ++macSalt);
        }
        if (usedMacs.has(macAddress)) throw new Error("hyper-v-network-mac-space-exhausted");
        const next: HyperVNetworkState = {
            version: 1,
            switchName: observation.switchName,
            switchId: observation.switchId.toLowerCase(),
            marker: current?.marker || intent!.marker,
            natName: observation.natName,
            natInstanceId: observation.natInstanceId,
            prefix: observation.prefix,
            gateway: observation.gateway,
            outboundPolicy: "nat",
            managedNat: current?.managedNat === true || Boolean(intent),
            allocations: [
                ...allocations,
                { ownerId, deviceId, incarnationId, address, macAddress, allocatedAt: new Date().toISOString() },
            ],
        };
        ensureStateRoot(runtime);
        writeJsonFileAtomically(stateFile(runtime), next);
        removeIntentBestEffort(runtime);
        return {
            ok: true,
            switchName: observation.switchName,
            address,
            macAddress,
            gateway: observation.gateway,
            prefix: observation.prefix,
            outboundPolicy: "nat",
        };
    } catch (error) {
        let cleanupFailure: string | null = null;
        if (!current && (observation.createdSwitch || observation.createdNat)) {
            try {
                const cleanupOptions = {
                    executable: powershell,
                    switchName: intent!.switchName,
                    natName: intent!.natName,
                    marker: intent!.marker,
                    prefix: HYPER_V_NETWORK_PREFIX,
                    gateway: HYPER_V_NETWORK_GATEWAY,
                    prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
                    removeNat: observation.createdNat,
                    expectedSwitchId: observation.switchId,
                    expectedNatInstanceId: observation.createdNat ? observation.natInstanceId : undefined,
                };
                const cleanupExecution = await runWithElevation(
                    runtime,
                    hyperVCleanupNetworkCommand(cleanupOptions),
                    (elevatedDeadlineUnixMs) => hyperVCleanupNetworkCommand({
                        ...cleanupOptions,
                        executable: runtime.resolveElevationExecutable(powershell),
                        elevated: true,
                        elevatedDeadlineUnixMs,
                    }),
                    deadlineAt,
                );
                if (!commandSucceeded(cleanupExecution)) {
                    cleanupFailure = hyperVProviderDiagnosticCode(cleanupExecution, "hyper-v-network-cleanup-failed")
                        || "hyper-v-network-cleanup-failed";
                } else if (!parseHyperVNetworkCleanupObservation(cleanupExecution.stdout || "")) {
                    cleanupFailure = "hyper-v-network-cleanup-invalid-result";
                }
            } catch (cleanupError) {
                cleanupFailure = hyperVBoundedErrorCode(cleanupError, "hyper-v-network-cleanup-failed");
            }
        }
        const allocationDetail = hyperVBoundedErrorCode(error, "hyper-v-network-allocation-failed");
        return {
            ok: false,
            status: cleanupFailure ? 502 : 409,
            error: cleanupFailure ? "hyper-v-network-allocation-cleanup-failed" : "hyper-v-network-allocation-failed",
            detail: cleanupFailure || allocationDetail,
            ...(cleanupFailure ? { preserveEvidence: true } : {}),
        };
    }
}

export function releaseHyperVNetworkAllocation(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId?: string | null,
): HyperVNetworkRelease {
    try {
        const current = readState(runtime);
        if (!current) return { ok: true, released: false, statePresent: false, remaining: 0 };
        const matched = current.allocations.find((allocation) => allocation.ownerId === ownerId && allocation.deviceId === deviceId);
        const identity = {
            managedNat: current.managedNat,
            switchName: current.switchName,
            switchId: current.switchId,
            natName: current.natName,
            marker: current.marker,
            natInstanceId: current.natInstanceId,
        };
        if (matched?.incarnationId && matched.incarnationId !== incarnationId) {
            return {
                ok: false,
                released: false,
                statePresent: true,
                remaining: current.allocations.length,
                ...identity,
                error: "hyper-v-network-allocation-incarnation-conflict",
            };
        }
        const allocations = current.allocations.filter((allocation) => allocation !== matched);
        if (allocations.length === current.allocations.length) {
            return { ok: true, released: false, statePresent: true, remaining: allocations.length, ...identity };
        }
        if (allocations.length === 0 && current.managedNat) {
            return { ok: true, released: true, statePresent: true, remaining: 0, ...identity };
        }
        ensureStateRoot(runtime);
        writeJsonFileAtomically(stateFile(runtime), { ...current, allocations });
        return { ok: true, released: true, statePresent: true, remaining: allocations.length, ...identity };
    } catch (error) {
        return {
            ok: false,
            released: false,
            statePresent: true,
            remaining: -1,
            error: hyperVBoundedErrorCode(error, "hyper-v-network-state-update-failed"),
        };
    }
}

export async function releaseHyperVNetworkAllocationAndCleanup(
    runtime: HyperVNetworkRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string | null | undefined,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    const release = releaseHyperVNetworkAllocation(runtime, ownerId, deviceId, incarnationId);
    if (!release.ok || !release.statePresent || !release.released || release.remaining !== 0) {
        return { ...release, networkCleanup: null };
    }
    if (release.managedNat !== true) {
        return { ...release, networkCleanup: { skipped: true, reason: "hyper-v-network-nat-ownership-unproven" } };
    }
    if (!release.switchId) {
        return { ...release, ok: false, error: "hyper-v-network-switch-identity-unproven", networkCleanup: null };
    }
    if (!release.switchName || !release.natName || !release.marker) {
        return { ...release, ok: false, error: "hyper-v-network-identity-unproven", networkCleanup: null };
    }
    if (!release.natInstanceId) {
        return { ...release, ok: false, error: "hyper-v-network-nat-identity-unproven", networkCleanup: null };
    }
    const powershell = runtime.resolveExecutable("powershell.exe")
        || runtime.resolveExecutable("pwsh")
        || runtime.resolveExecutable("powershell");
    if (!powershell) return { ...release, ok: false, error: "missing-provider-command", networkCleanup: null };
    const cleanupOptions = {
        executable: powershell,
        switchName: release.switchName,
        natName: release.natName,
        marker: release.marker,
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
        removeNat: true,
        expectedSwitchId: release.switchId,
        expectedNatInstanceId: release.natInstanceId,
    };
    const execution = await runWithElevation(
        runtime,
        hyperVCleanupNetworkCommand(cleanupOptions),
        (elevatedDeadlineUnixMs) => hyperVCleanupNetworkCommand({
            ...cleanupOptions,
            executable: runtime.resolveElevationExecutable(powershell),
            elevated: true,
            elevatedDeadlineUnixMs,
        }),
        deadlineAt,
    );
    if (!commandSucceeded(execution)) {
        const diagnosticCode = hyperVProviderDiagnosticCode(execution, "hyper-v-network-cleanup-failed");
        return {
            ...release,
            ok: false,
            error: diagnosticCode,
            networkCleanup: redactProviderCommandInput(execution, true, diagnosticCode),
        };
    }
    const observation = parseHyperVNetworkCleanupObservation(execution.stdout || "");
    if (!observation) {
        return {
            ...release,
            ok: false,
            error: "hyper-v-network-cleanup-invalid-result",
            networkCleanup: redactProviderCommandInput(execution, true, "hyper-v-network-cleanup-invalid-result"),
        };
    }
    rmSync(stateFile(runtime), { force: true });
    return { ...release, ok: true, networkCleanup: observation };
}

export function validateHyperVLinuxSshHostIdentity(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    expectedFingerprint: string,
): boolean {
    const allocation = readState(runtime)?.allocations.find(
        (candidate) => candidate.ownerId === ownerId && candidate.deviceId === deviceId,
    );
    if (!allocation || allocation.address !== networkAddress) return false;
    const publicKey = readDeviceLabTextFile(hostPublicKeyPath, "hyper-v-linux-ssh-host-public-key", 64 * 1024)?.trim() || "";
    const knownHosts = readDeviceLabTextFile(knownHostsPath, "hyper-v-linux-ssh-known-hosts", 64 * 1024)?.trim() || "";
    const match = /^ssh-ed25519 ([A-Za-z0-9+/=]+)(?: .*)?$/.exec(publicKey);
    if (!match || knownHosts !== `${networkAddress} ${publicKey}`) return false;
    let actualFingerprint = "";
    try {
        actualFingerprint = `SHA256:${createHash("sha256").update(Buffer.from(match[1], "base64")).digest("base64").replace(/=+$/, "")}`;
    } catch {
        return false;
    }
    return actualFingerprint === expectedFingerprint;
}
