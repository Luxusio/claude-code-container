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
    const publicPlan = hyperV ? redactHyperVResultSecrets(plan) : plan;
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
import type { BrokerAppiumResponse, BrokerAppiumExecution, BrokerAppiumTermination, BrokerAppiumVerification } from "../domain/broker-appium.js";
export class NativeBrokerExecutionReceipt {
    constructor(readonly value: ProviderCommandResult) { }
}
export class NativeRecordingSignalReceipt {
    constructor(readonly value: unknown) { }
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
    return reason === "invalid" ? 400 : reason === "forbidden" ? 403 : reason === "missing" ? 404 : reason === "unsupported" ? 501 : reason === "provider-failed" ? 502 : reason === "deadline" ? 504 : 409;
}
export function renderBrokerRecording(outcome: BrokerRecordingResponse): WireResult {
    if (outcome.kind === "refused" || outcome.kind === "uncertain") {
        const { kind: _kind, reason, unsupportedReason, signal, rollback, execution, executions, ...facts } = outcome;
        return { status: refusalStatus(reason, outcome.error), payload: { ok: false, ...facts,
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
        const { kind: _kind, reason, execution, signal, replaced, portCleanup, verification, runtime, instrumentationRecovery, rollback, statusObservation, sessionObservation, ...facts } = outcome;
        return { status: refusalStatus(reason, outcome.error), payload: { ok: false, ...facts,
                ...(execution ? { execution: appiumExecution(execution) } : {}), ...(signal ? { signal: appiumTermination(signal) } : {}),
                ...(replaced ? { replaced: appiumTermination(replaced) } : {}), ...(portCleanup ? { portCleanup: appiumTermination(portCleanup) } : {}),
                ...(verification ? { verification: appiumVerification(verification) } : {}),
                ...(runtime ? { runtime: appiumRuntimeFailure(runtime) } : {}),
                ...(instrumentationRecovery ? { instrumentationRecovery: appiumInstrumentation(instrumentationRecovery) } : {}),
                ...(rollback ? { rollback: "receipt" in rollback ? appiumTermination(rollback) : rollback } : {}),
                ...(statusObservation ? { status: statusObservation } : {}), ...(sessionObservation !== undefined ? { session: sessionObservation } : {}),
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
            return { status: 200, payload: { ok: true, result: { ...facts, authority: "host-broker" } } };
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
            return { status: 502, payload: { ok: false, error, result: { ...facts, authority: "host-broker" } } };
        }
        case "request-completed":
        case "request-failed": {
            const { kind, error, ...facts } = outcome;
            return { status: kind === "request-completed" ? 200 : 502, payload: { ok: kind === "request-completed", ...(error ? { error } : {}), result: { ...facts, authority: "host-broker" } } };
        }
    }
}
