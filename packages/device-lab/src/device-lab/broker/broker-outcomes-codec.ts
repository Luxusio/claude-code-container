import type { BrokerOwnerResolution } from "../domain/broker-owner.js";
import type { DeviceStatusOutcome, DeviceStatusPlan } from "../domain/broker-observation.js";
import type { ProviderCommand, ProviderCommandResult } from "../../device-lab-broker.js";
import { redactHyperVDeviceSecrets, redactHyperVResultSecrets, redactProviderCommandInput, hyperVProviderDiagnosticCode } from "./hyper-v/public-response.js";
export type NativeStatusConnection = {
    command: ProviderCommand;
};
type WireResult = {
    status: number;
    payload: unknown;
};
export function renderBrokerOwnerResolution(outcome: BrokerOwnerResolution): WireResult {
    switch (outcome.kind) {
        case "resolved": return { status: 200, payload: { ok: true, result: { ...outcome.identity, profile: outcome.identity.profile ?? null } } };
        case "invalid-request": return { status: 400, payload: { ok: false, error: "invalid-project-owner-request", projectMountPath: outcome.projectMountPath, profile: outcome.profile } };
        case "registration-invalid": return { status: 409, payload: { ok: false, error: "project-owner-registration-invalid" } };
        case "unavailable": return { status: 404, payload: { ok: false, error: "project-owner-unavailable" } };
        case "auth-provisioning-failed": return { status: 503, payload: { ok: false, error: "owner-auth-provisioning-failed" } };
    }
}
function statusPlan(plan: DeviceStatusPlan<NativeStatusConnection>) {
    const { availability, ...facts } = plan;
    const providerCommand = availability.kind === "available" ? availability.connection.command
        : availability.kind === "unavailable" ? { error: availability.error, missing: availability.missing } : null;
    return { ...facts, providerCommand, execution: { mode: "planned", providerExecution: availability.kind === "available" ? "available" : "deferred", mutatesHost: false } };
}
export function renderBrokerDeviceStatus(outcome: DeviceStatusOutcome<NativeStatusConnection, ProviderCommandResult>, redactDevice: (device: unknown) => unknown, failureDetail: (execution: ProviderCommandResult) => string): WireResult {
    if (outcome.kind === "refused") {
        const { kind: _kind, reason, plan, leaseFailure, ...facts } = outcome;
        const status = outcome.error === "owner-devices-file-too-large" ? 413 : outcome.error === "owner-devices-state-read-failed" ? 503
            : reason === "invalid" ? 400 : reason === "missing" ? 404 : reason === "unsupported" ? 501
                : reason === "provider-unavailable" ? 503 : reason === "deadline" ? 504 : reason === "state-write-failed" ? 500 : reason === "provider-failed" ? 502 : 409;
        const publicPlan = plan ? statusPlan(plan) : undefined;
        return { status, payload: { ok: false, ...facts, ...(leaseFailure ? { leaseError: leaseFailure.error } : {}), ...(outcome.error === "physical-device-not-attached" && !outcome.remedy ? { remedy: "attach the physical device before using host-backed device tools" } : {}),
                ...(plan && publicPlan ? { plan: plan.backend === "windows-vm" || plan.backend === "linux-vm" ? redactHyperVResultSecrets(publicPlan) : { ...publicPlan, device: redactDevice(plan.device) } } : {}) } };
    }
    const hyperV = outcome.plan.backend === "windows-vm" || outcome.plan.backend === "linux-vm";
    const plan = statusPlan(outcome.plan);
    const publicPlan = hyperV ? redactHyperVResultSecrets(plan) : { ...plan, device: redactDevice(plan.device) };
    if (outcome.kind === "preview")
        return { status: 200, payload: { ok: true, result: { ...publicPlan, invoked: false, dryRun: true,
                    execution: { mode: "dry-run", providerExecution: "available", mutatesHost: false } } } };
    const success = outcome.kind === "observed";
    const execution = outcome.execution.receipt ?? outcome.execution;
    const descriptor = outcome.plan.availability.kind === "available" ? outcome.plan.availability.connection.command : null;
    return { status: success ? 200 : 502, payload: { ok: success,
            ...(success ? {} : { error: "provider-command-failed", detail: hyperV ? hyperVProviderDiagnosticCode(execution, "hyper-v-provider-command-failed") || "hyper-v-provider-command-failed" : failureDetail(execution) }),
            result: { ...publicPlan, providerCommand: hyperV && descriptor ? { mode: descriptor.mode, provider: descriptor.provider } : descriptor,
                device: hyperV ? redactHyperVDeviceSecrets(outcome.device) : redactDevice(outcome.device), invoked: true, dryRun: false,
                execution: { mode: outcome.execution.mode, providerExecution: "executed", mutatesHost: false,
                    command: hyperV ? redactProviderCommandInput(execution, true, success ? undefined : "hyper-v-provider-command-failed") : execution } } } };
}
import type { BrokerRecordingResponse, BrokerRecordingExecution, BrokerRecordingSignal } from "../domain/broker-recording.js";
import type { BrokerAppiumResponse, AppiumEffectObservation, BrokerAppiumExecution, BrokerAppiumTermination, BrokerAppiumVerification } from "../domain/broker-appium.js";
export class NativeBrokerExecutionReceipt {
    constructor(readonly value: ProviderCommandResult, readonly preparedCommand?: ProviderCommand) { }
}
export class NativeRecordingSignalReceipt {
    constructor(readonly value: unknown) { }
}
export class NativeAppiumResponseReceipt {
    constructor(readonly value: {ok: boolean; status: number | null; body: unknown}) { }
}
export class NativeAppiumTerminationReceipt {
    constructor(readonly value: unknown) { }
}
export class NativeAppiumVerificationReceipt {
    constructor(readonly value: unknown) { }
}
export class NativeAppiumRuntimeReceipt {
    constructor(readonly value: {
        packageRoot: string;
        runtimeRoot: string;
        executable: string;
        entry: string;
        sourcePackage: string;
        sourceLock: string;
    }) { }
}
export class NativeAppiumInstrumentationReceipt {
    constructor(readonly value: {
        adb: string | null;
        serial: string;
    }) { }
}
function recordingExecution(observation: BrokerRecordingExecution) {
    const { receipt, ...facts } = observation;
    return receipt instanceof NativeBrokerExecutionReceipt ? receipt.value : facts;
}
function recordingSignal(observation: BrokerRecordingSignal) {
    const { receipt, ...facts } = observation;
    return receipt instanceof NativeRecordingSignalReceipt ? receipt.value : facts;
}
function refusalStatus(reason: string, error: string) {
    if (error === "owner-devices-file-too-large")
        return 413;
    if (error === "owner-devices-state-read-failed")
        return 503;
    return reason === "invalid" ? 400 : reason === "forbidden" ? 403 : reason === "missing" ? 404 : reason === "unsupported" ? 501 : reason === "provider-failed" ? 502 : reason === "provider-unavailable" ? 503 : reason === "state-write-failed" ? 500 : reason === "deadline" ? 504 : 409;
}
export function renderBrokerRecording(outcome: BrokerRecordingResponse): WireResult {
    if (outcome.kind === "refused" || outcome.kind === "uncertain") {
        const { kind: _kind, reason, unsupportedReason, signal, rollback, execution, executions, ...facts } = outcome;
        return { status: refusalStatus(reason, outcome.error), payload: { ok: false, ...facts,
                ...(outcome.error === "recording-process-still-running" || outcome.error === "recording-stop-command-failed" ? {startsDevices: false} : {}),
                ...(unsupportedReason ? { reason: unsupportedReason } : {}), ...(signal ? { signal: recordingSignal(signal) } : {}),
                ...(rollback ? { rollback: recordingSignal(rollback) } : {}), ...(execution ? { execution: recordingExecution(execution) } : {}),
                ...(executions ? { executions: executions.map(recordingExecution) } : {}) } };
    }
    switch (outcome.kind) {
        case "observed": {
            const { kind: _kind, ...facts } = outcome;
            return { status: 200, payload: { ok: true, result: { ...facts, source: "host-broker-owner-state", startsDevices: false } } };
        }
        case "started": {
            const { kind: _kind, execution, ...facts } = outcome;
            return { status: 200, payload: { ok: true, result: { ...facts, source: "host-broker-owner-state", startsDevices: false, execution: recordingExecution(execution) } } };
        }
        case "stopped":
        case "stopped-with-copy-failure": {
            const { kind, error, signal, executions, ...facts } = outcome;
            return { status: kind === "stopped" ? 200 : 502, payload: { ok: kind === "stopped", ...(error ? { error } : {}), result: { ...facts, stopped: true, source: "host-broker-owner-state", startsDevices: false, signal: recordingSignal(signal), executions: executions.map(recordingExecution) } } };
        }
    }
}
function appiumExecution(observation: BrokerAppiumExecution) {
    const { receipt, ...facts } = observation;
    return receipt instanceof NativeBrokerExecutionReceipt ? receipt.value : facts;
}
function appiumResponse(observation: AppiumEffectObservation) {
    return observation.receipt instanceof NativeAppiumResponseReceipt ? observation.receipt.value : {ok: observation.ok};
}
function appiumTermination(observation: BrokerAppiumTermination) {
    const { receipt, ...facts } = observation;
    return receipt instanceof NativeAppiumTerminationReceipt ? receipt.value : facts;
}
function appiumVerification(observation: BrokerAppiumVerification) {
    const { receipt, ...facts } = observation;
    return receipt instanceof NativeAppiumVerificationReceipt ? receipt.value : facts;
}
function appiumRuntimeFailure(failure: import("../domain/broker-appium.js").BrokerAppiumRuntimeFailure) {
    const { receipt, execution, ...facts } = failure;
    const native = receipt instanceof NativeAppiumRuntimeReceipt ? receipt.value : null;
    const paths = !native ? {} : failure.error === "appium-runtime-manifest-missing" || failure.error === "appium-runtime-manifest-invalid"
        ? { sourcePackage: native.sourcePackage, sourceLock: native.sourceLock }
        : execution ? { runtimeRoot: native.runtimeRoot, executable: native.executable, entry: native.entry } : { runtimeRoot: native.runtimeRoot };
    return { ...facts, ...paths, ...(execution ? { execution: appiumExecution(execution) } : {}) };
}
function appiumInstrumentation(recovery: import("../domain/broker-appium.js").BrokerAppiumInstrumentationRecovery) {
    const { receipt, results, ...facts } = recovery;
    return { ...facts, ...(receipt instanceof NativeAppiumInstrumentationReceipt ? receipt.value : {}), results: results.map(appiumExecution) };
}
export function renderBrokerAppium(outcome: BrokerAppiumResponse): WireResult {
    if (outcome.kind === "refused") {
        const { kind: _kind, reason, execution, signal, replaced, portCleanup, verification, runtime, instrumentationRecovery, response, readiness, rollback, statusObservation, sessionObservation, ...facts } = outcome;
        return { status: refusalStatus(reason, outcome.error), payload: { ok: false, ...facts,
                ...(execution ? { execution: appiumExecution(execution) } : {}), ...(signal ? { signal: appiumTermination(signal) } : {}),
                ...(replaced ? { replaced: appiumTermination(replaced) } : {}), ...(portCleanup ? { portCleanup: appiumTermination(portCleanup) } : {}),
                ...(verification ? { verification: appiumVerification(verification) } : {}),
                ...(runtime ? { runtime: appiumRuntimeFailure(runtime) } : {}),
                ...(instrumentationRecovery ? { instrumentationRecovery: appiumInstrumentation(instrumentationRecovery) } : {}),
                ...(response !== undefined ? {response: appiumResponse(response)} : {}),
                ...(readiness ? {readiness: {ok: readiness.ok, response: readiness.response === null ? null : appiumResponse(readiness.response)}} : {}),
                ...(rollback ? { rollback: rollback.receipt instanceof NativeAppiumResponseReceipt ? appiumResponse(rollback) : appiumTermination(rollback) } : {}),
                ...(statusObservation ? { status: appiumResponse(statusObservation) } : {}), ...(sessionObservation !== undefined ? { session: sessionObservation === null ? null : appiumResponse(sessionObservation) } : {}),
                ...(outcome.error === "appium-runtime-state-conflict" && signal ? { authority: "host-broker" } : {}) } };
    }
    switch (outcome.kind) {
        case "metadata-recorded":
        case "metadata-cleared":
        case "server-reused":
        case "session-created":
        case "session-reused":
        case "session-deleted": {
            const { kind: _kind, ...facts } = outcome;
            return { status: 200, payload: { ok: true, result: { ...facts, ...("response" in outcome && outcome.response !== undefined ? {response: appiumResponse(outcome.response)} : {}), authority: "host-broker" } } };
        }
        case "server-started": {
            const { kind: _kind, execution, replaced, portCleanup, ...facts } = outcome;
            return { status: 200, payload: { ok: true, result: { ...facts, authority: "host-broker", execution: appiumExecution(execution), replaced: appiumTermination(replaced), portCleanup: appiumTermination(portCleanup) } } };
        }
        case "server-stopped": {
            const { kind: _kind, signal, ...facts } = outcome;
            return { status: 200, payload: { ok: true, result: { ...facts, authority: "host-broker", signal: appiumTermination(signal) } } };
        }
        case "session-delete-failed": {
            const { kind: _kind, error, ...facts } = outcome;
            return { status: 502, payload: { ok: false, error, result: { ...facts, ...("response" in outcome && outcome.response !== undefined ? {response: appiumResponse(outcome.response)} : {}), authority: "host-broker" } } };
        }
        case "request-completed":
        case "request-failed": {
            const { kind, error, ...facts } = outcome;
            return { status: kind === "request-completed" ? 200 : 502, payload: { ok: kind === "request-completed", ...(error ? { error } : {}), result: { ...facts, ...("response" in outcome && outcome.response !== undefined ? {response: appiumResponse(outcome.response)} : {}), authority: "host-broker" } } };
        }
    }
}

export class NativeProviderLifecycleEffect {
    constructor(readonly command: ProviderCommand) { }
}
import type { BrokerAndroidLifecycleOutcome, BrokerAndroidBoot } from "../domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerIosLifecycleResponse } from "../domain/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerMacosLifecycleResponse, BrokerMacosBoot } from "../domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerWindowsSandboxOutcome } from "../domain/lifecycle/windows-sandbox-lifecycle.js";
export type NativeLifecyclePresentation = {
    ownerId: string;
    backend: string;
    stateKey: string;
    deviceId: string;
    command: string;
    deleteAvd?: boolean;
    plan: Record<string, unknown> | undefined;
};
type LifecycleObservation = {
    receipt?: unknown;
    mode?: string;
    provider?: string;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
};
export function renderBrokerLifecycleObservation(observed: LifecycleObservation): ProviderCommandResult {
    const { receipt, ...facts } = observed;
    return receipt instanceof NativeBrokerExecutionReceipt ? { ...receipt.value, ...facts, mode: observed.mode ?? receipt.value.mode, provider: observed.provider ?? receipt.value.provider }
        : { ...facts, mode: observed.mode ?? "exec", provider: observed.provider ?? "wsb" };
}
export function renderBrokerProviderRollback(rollback: {
    attempted?: boolean;
    ok: boolean;
    reason?: string;
    result?: LifecycleObservation;
}) {
    return { ...rollback, ...(rollback.result ? { result: renderBrokerLifecycleObservation(rollback.result) } : {}) };
}
export function renderBrokerMacosBoot(boot: BrokerMacosBoot, command: ProviderCommand) {
    if (boot.ok)
        return { ...boot, ...(boot.result ? { result: renderBrokerLifecycleObservation(boot.result) } : {}), ...(boot.attempts ? { attempts: boot.attempts.map(renderBrokerLifecycleObservation) } : {}) };
    const observed = boot.last ? renderBrokerLifecycleObservation(boot.last) : {};
    return { ok: false as const, error: { ...observed, mode: "exec", provider: "tart", executable: command.executable,
            args: boot.instance ? ["ip", boot.instance] : ["ip"], status: boot.last?.status ?? null,
            error: boot.reason === "missing-target" ? "missing-provider-metadata: providerInstance" : `Timed out waiting for Tart IP for ${boot.instance}` },
        ...(boot.attempts ? { attempts: boot.attempts.map(renderBrokerLifecycleObservation) } : {}) };
}
function androidBoot(boot: BrokerAndroidBoot<NativeBrokerExecutionReceipt>) {
    return boot.ok ? { ...boot, ...(boot.result ? { result: renderBrokerLifecycleObservation(boot.result) } : {}), ...(boot.attempts ? { attempts: boot.attempts.map(renderBrokerLifecycleObservation) } : {}) }
        : { ...boot, error: renderBrokerLifecycleObservation(boot.error), ...(boot.attempts ? { attempts: boot.attempts.map(renderBrokerLifecycleObservation) } : {}) };
}
function lifecycleResult(context: NativeLifecyclePresentation, device: unknown, execution: LifecycleObservation | undefined, invoked: boolean, mutatesHost: boolean) {
    return { ...context.plan, device, invoked, dryRun: false, execution: { mode: context.command === "device_create" && execution?.mode === "noop" ? "state" : execution?.mode,
            providerExecution: invoked ? context.command === "device_create" && execution?.mode === "noop" ? "broker-state" : "executed" : "blocked", mutatesHost,
            ...(execution && !(context.command === "device_create" && execution.mode === "noop") ? { command: renderBrokerLifecycleObservation(execution) } : {}) } };
}
export function renderBrokerAndroidLifecycle(outcome: BrokerAndroidLifecycleOutcome<NativeProviderLifecycleEffect, NativeBrokerExecutionReceipt>, context: NativeLifecyclePresentation, redactDevice: (device: unknown) => unknown, stateFailure: (cause: unknown, target: {
    backend: string;
    stateKey: string;
}) => {
    status: number;
    payload: Record<string, unknown>;
}, failureDetail: (result: ProviderCommandResult) => string): WireResult {
    if (outcome.kind === "state-exception") {
        const failure = stateFailure(outcome.cause, { backend: outcome.backend, stateKey: outcome.stateKey });
        return { ...failure, payload: { ...failure.payload, rollback: outcome.rollback } };
    }
    const base = { ownerId: context.ownerId, backend: context.backend, deviceId: context.deviceId };
    switch (outcome.kind) {
        case "refused": {
            const { kind: _kind, reason, plan: _plan, device, existing, execution: _execution, boot: _boot, auxiliaryCleanup: _auxiliary, invoked: _invoked, mutatesHost: _mutates, ...facts } = outcome;
            const status = refusalStatus(reason, outcome.error);
            return { status: outcome.error === "owner-device-state-rollback-failed" || outcome.error === "owner-device-conflict-rollback-failed" ? 502 : status,
                payload: { ok: false, ...facts, ...("existing" in outcome ? { existing: redactDevice(existing) } : {}), ...(device !== undefined ? { device: redactDevice(device) } : {}), ...(outcome.plan ? { plan: { ...context.plan, device: redactDevice(outcome.plan.device) } } : {}) } };
        }
        case "provider-failed": return { status: 502, payload: { ok: false, error: outcome.error,
                detail: failureDetail(renderBrokerLifecycleObservation(outcome.execution)), ...(outcome.rollback ? { rollback: outcome.rollback } : {}), result: { ...lifecycleResult(context, redactDevice(outcome.device ?? outcome.plan?.device), outcome.execution, true, false),
                    ...(outcome.boot ? { boot: outcome.boot.ok ? { ready: outcome.boot.ready, skipped: outcome.boot.skipped === true, provider: "adb", result: outcome.boot.result ? renderBrokerLifecycleObservation(outcome.boot.result) : null } : { ready: false, skipped: false, provider: "adb", error: renderBrokerLifecycleObservation(outcome.boot.error) } } : {}),
                    ...(outcome.boot && !outcome.boot.ok ? { execution: { mode: outcome.execution.mode, providerExecution: "executed", mutatesHost: false, command: { ...renderBrokerLifecycleObservation(outcome.execution), registration: null, macosBoot: null, androidBoot: androidBoot(outcome.boot) } } } : {}),
                    ...(outcome.auxiliaryCleanup ? { auxiliaryCleanup: outcome.auxiliaryCleanup } : {}) } } };
        case "auxiliary-failed": return { status: 502, payload: { ok: false, error: outcome.error,
                result: { ...lifecycleResult(context, redactDevice(outcome.device), undefined, false, outcome.mutatesHost === true), auxiliaryCleanup: outcome.auxiliaryCleanup, execution: { mode: "preflight", providerExecution: "blocked", mutatesHost: outcome.mutatesHost === true } } } };
        case "stop-unconfirmed": return { status: 502, payload: { ok: false, error: outcome.error, detail: outcome.detail, ...base,
                result: lifecycleResult(context, redactDevice(outcome.device), outcome.execution, true, true) } };
        case "publication-conflict": return { status: 409, payload: { ok: false, error: outcome.error, ...base, found: outcome.found,
                result: { ...lifecycleResult(context, redactDevice(outcome.device), outcome.execution, true, outcome.mutatesHost),
                    ...(outcome.boot ? { boot: outcome.boot.ok ? { ready: outcome.boot.ready, skipped: outcome.boot.skipped === true, provider: "adb", result: outcome.boot.result ? renderBrokerLifecycleObservation(outcome.boot.result) : null } : { ready: false, skipped: false, provider: "adb", error: renderBrokerLifecycleObservation(outcome.boot.error) } } : {}),
                    ...(outcome.auxiliaryCleanup ? { auxiliaryCleanup: outcome.auxiliaryCleanup } : {}) } } };
        case "created":
        case "completed": return { status: 200, payload: { ok: true, result: { ...lifecycleResult(context, redactDevice(outcome.device), outcome.execution, true, outcome.mutatesHost),
                    ...(context.command === "device_delete" && context.deleteAvd !== false ? { providerCommand: { mode: "noop", provider: "host-broker-state", reason: "Android AVD artifacts are removed by identity-fenced storage cleanup" } } : {}),
                    ...(outcome.boot ? { boot: outcome.boot.ok ? { ready: outcome.boot.ready, skipped: outcome.boot.skipped === true, provider: "adb", result: outcome.boot.result ? renderBrokerLifecycleObservation(outcome.boot.result) : null } : { ready: false, skipped: false, provider: "adb", error: renderBrokerLifecycleObservation(outcome.boot.error) } } : {}), ...(outcome.auxiliaryCleanup ? { auxiliaryCleanup: outcome.auxiliaryCleanup } : {}) } } };
    }
}
export function renderBrokerIosMacosLifecycle(outcome: BrokerIosLifecycleResponse<NativeProviderLifecycleEffect> | BrokerMacosLifecycleResponse<NativeProviderLifecycleEffect>, context: NativeLifecyclePresentation, redactDevice: (device: unknown) => unknown, stateFailure: (cause: unknown, target: {
    backend: string;
    stateKey: string;
}) => {
    status: number;
    payload: Record<string, unknown>;
}, failureDetail: (result: ProviderCommandResult) => string): WireResult {
    const base = { ownerId: context.ownerId, backend: context.backend, deviceId: context.deviceId };
    switch (outcome.kind) {
        case "refused": return { status: 400, payload: { ok: false, error: outcome.error, missing: outcome.missing, plan: outcome.plan ? { ...context.plan, device: redactDevice(outcome.plan.device) } : null } };
        case "state-failed": {
            const failure = stateFailure(outcome.cause, { backend: context.backend, stateKey: context.stateKey });
            return { ...failure, payload: { ...failure.payload, rollback: renderBrokerProviderRollback(outcome.rollback) } };
        }
        case "rollback-failed": return { status: 502, payload: { ok: false, ...base, error: outcome.error, stateError: outcome.stateError, rollback: renderBrokerProviderRollback(outcome.rollback) } };
        case "claim-conflict": return { status: outcome.rollback.ok ? 409 : 502, payload: { ok: false, ...base, error: outcome.error, field: outcome.field, value: outcome.value, existing: redactDevice(outcome.existing), rollback: renderBrokerProviderRollback(outcome.rollback) } };
        case "provider-failed": return outcome.error === "ios-simulator-create-invalid-udid" ? { status: 502, payload: { ok: false, error: outcome.error, ownerId: context.ownerId, deviceId: context.deviceId } }
            : { status: 502, payload: { ok: false, error: outcome.error, detail: failureDetail(renderBrokerLifecycleObservation(outcome.execution)), result: lifecycleResult(context, redactDevice(outcome.plan?.device), outcome.execution, true, false) } };
        case "auxiliary-failed": return { status: 502, payload: { ok: false, error: "auxiliary-runtime-cleanup-failed",
                result: { ...lifecycleResult(context, redactDevice(outcome.device), undefined, false, (outcome.auxiliary.changed || outcome.auxiliary.appium.cleared === true || outcome.auxiliary.recording.cleared === true || outcome.auxiliary.minimizeWatchdog.cleared === true)), auxiliaryCleanup: outcome.auxiliary, execution: { mode: "preflight", providerExecution: "blocked", mutatesHost: outcome.auxiliary.changed || outcome.auxiliary.appium.cleared === true || outcome.auxiliary.recording.cleared === true || outcome.auxiliary.minimizeWatchdog.cleared === true } } } };
        case "completed":
        case "state-conflict":
        case "operation-failed": {
            const boot = "boot" in outcome && outcome.boot && context.plan && cleanupCommand(context.plan.providerCommand) ? renderBrokerMacosBoot(outcome.boot, context.plan.providerCommand) : undefined;
            return { status: outcome.kind === "state-conflict" ? 409 : outcome.success ? 200 : 502, payload: { ok: outcome.success && outcome.kind !== "state-conflict",
                    ...(outcome.kind === "state-conflict" ? { error: "owner-device-state-conflict", ...base, found: outcome.publication?.found } : !outcome.success ? { error: "provider-command-failed", detail: failureDetail(renderBrokerLifecycleObservation(outcome.execution)) } : {}),
                    result: { ...lifecycleResult(context, redactDevice(outcome.device), outcome.execution, true, outcome.success), ...(outcome.auxiliary ? { auxiliaryCleanup: outcome.auxiliary } : {}), ...(boot && !boot.ok ? { execution: { mode: outcome.execution.mode, providerExecution: "executed", mutatesHost: outcome.success, command: { ...renderBrokerLifecycleObservation(outcome.execution), registration: null, macosBoot: boot, androidBoot: null } } } : {}) } } };
        }
    }
}
function cleanupCommand(command: unknown): command is ProviderCommand {
    return command !== null && typeof command === "object" && "mode" in command && (command.mode === "exec" || command.mode === "detached" || command.mode === "noop") && "provider" in command && typeof command.provider === "string";
}
function sandboxRegistration(observation: LifecycleObservation, context: NativeLifecyclePresentation) {
    if (observation.receipt instanceof NativeBrokerExecutionReceipt)
        return renderBrokerLifecycleObservation(observation);
    const descriptor = context.plan && cleanupCommand(context.plan.providerCommand) ? context.plan.providerCommand : null;
    return { ...renderBrokerLifecycleObservation(observation), executable: descriptor?.executable,
        args: observation.error === "windows-sandbox-start-missing-registration-metadata" ? descriptor?.args || [] : ["list", "--raw"] };
}
export function renderBrokerSandboxLifecycle(outcome: BrokerWindowsSandboxOutcome<NativeBrokerExecutionReceipt>, context: NativeLifecyclePresentation, redactDevice: (device: unknown) => unknown, failureDetail: (result: ProviderCommandResult) => string): WireResult {
    const facts = outcome.facts;
    const execution = facts?.execution;
    const executedCommand = execution?.receipt instanceof NativeBrokerExecutionReceipt ? execution.receipt.preparedCommand : undefined;
    const descriptor = executedCommand ?? (context.plan && cleanupCommand(context.plan.providerCommand) ? context.plan.providerCommand : undefined);
    const success = outcome.kind === "completed" && outcome.success;
    const publicationConflict = facts?.publication?.matched === false;
    const result = facts ? { ...lifecycleResult(context, redactDevice(facts.device), execution, facts.invoked, facts.mutatesHost),
        ...(facts.runtime && descriptor ? { providerCommand: { ...descriptor, ...(facts.runtime.sandboxId ? { sandboxId: facts.runtime.sandboxId } : {}), ...(facts.runtime.requestedSandboxId ? { requestedSandboxId: facts.runtime.requestedSandboxId } : {}) } } : {}),
        ...(facts.watchdog ? { minimizeWatchdog: renderBrokerLifecycleObservation(facts.watchdog) } : {}),
        ...(facts.confirmation ? { minimizeConfirmation: renderBrokerLifecycleObservation({ ...facts.confirmation, ...(facts.confirmation.error === "windows-sandbox-window-baseline-unavailable" ? { mode: "exec", provider: "windows-sandbox-window" } : {}) }) } : {}), ...(facts.watchdogCleanup ? { minimizeWatchdogCleanup: facts.watchdogCleanup } : {}),
        ...(facts.auxiliaryCleanup ? { auxiliaryCleanup: facts.auxiliaryCleanup } : {}), ...(facts.artifactCleanup ? { windowsDeviceArtifactCleanup: facts.artifactCleanup } : {}),
        ...(!facts.invoked ? { execution: { mode: "preflight", providerExecution: "blocked", mutatesHost: facts.mutatesHost, ...(execution ? { command: renderBrokerLifecycleObservation(execution) } : {}) } } : {}),
        ...(facts.registration && execution ? { execution: { mode: renderBrokerLifecycleObservation(execution).mode, providerExecution: "executed", mutatesHost: facts.mutatesHost, command: { ...renderBrokerLifecycleObservation(execution), registration: sandboxRegistration(facts.registration, context), macosBoot: null, androidBoot: null } } } : {}) } : undefined;
    if (outcome.kind === "refused") {
        const plan = context.plan ? { ...context.plan, device: redactDevice(context.plan.device) } : null;
        return { status: refusalStatus(outcome.category, outcome.error), payload: { ok: false, error: outcome.error,
            ...(outcome.error === "windows-sandbox-config-refresh-failed" || outcome.error === "windows-sandbox-device-artifact-cleanup-failed" || outcome.error === "owner-device-state-conflict" ? {ownerId: context.ownerId, backend: context.backend, deviceId: context.deviceId} : {}),
            ...(outcome.error === "owner-device-state-conflict" ? {found: facts?.publication?.found} : {}),
                ...(outcome.detail ? { detail: outcome.detail } : outcome.error === "windows-sandbox-runtime-snapshot-failed" && execution ? { detail: failureDetail(renderBrokerLifecycleObservation(execution)) } : {}), ...(outcome.missing ? { missing: outcome.missing, plan } : {}), ...(outcome.lock !== undefined ? { lock: outcome.lock, plan } : {}), ...(result ? { result } : {}) } };
    }
    return { status: publicationConflict ? 409 : success ? 200 : 502, payload: { ok: success && !publicationConflict,
            ...(publicationConflict ? { error: "owner-device-state-conflict", ownerId: context.ownerId, backend: context.backend, deviceId: context.deviceId, found: facts?.publication?.found } : !success ? { error: "provider-command-failed", detail: failureDetail(renderBrokerLifecycleObservation(execution || {})) } : {}), result } };
}
