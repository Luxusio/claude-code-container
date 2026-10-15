import type { HyperVLifecycleOutcome, HyperVPlannedFacts, HyperVNativeExecution, HyperVRollback, HyperVCreateRecovery, HyperVLifecycleFailureReason } from "../../domain/lifecycle/hyper-v-create-start.js";
import type { HyperVStopDeleteOutcome, HyperVReplayResult, HyperVNetworkCleanupEvidence } from "../../domain/lifecycle/hyper-v-stop-delete.js";
import type { SnapshotExecution, SnapshotOutcome, SnapshotRepairResult } from "../../domain/lifecycle/hyper-v-snapshots.js";
import type { ProviderCommand, ProviderCommandResult } from "../../../device-lab-broker.js";
import type { DeviceLabHyperVCommandResult } from "./lifecycle-adapter.js";
import { publicHyperVArtifactCleanup, publicHyperVNetworkCleanup, redactHyperVDeviceSecrets, redactHyperVResultSecrets, redactProviderCommandInput } from "./public-response.js";
import { hyperVImageResolutionToWire } from "./image-store.js";
import { hyperVNetworkFailureToWire, renderHyperVNetworkReceipt } from "./network.js";
type HyperVWireResponse = {
    status: number;
    payload: unknown;
};
export type NativeHyperVConnection = {
    executable: string;
    plannedCommand?: ProviderCommand;
};
function stateFailureStatus(error: string, fallback: number): number {
    return error === "owner-devices-file-too-large" ? 413 : error === "owner-devices-state-read-failed" ? 503 : fallback;
}
function lifecycleFailureStatus(error: string, reason: HyperVLifecycleFailureReason): number {
    return stateFailureStatus(error, reason === "unsupported" ? 501 : reason === "invalid" ? 400 : reason === "forbidden" ? 403 : reason === "missing" ? 404 : reason === "conflict" ? 409 : reason === "provider-unavailable" ? 503 : reason === "deadline" ? 504 : reason === "state-write-failed" ? 500 : 502);
}

function renderHyperVCreateRecovery(outcome: HyperVCreateRecovery) {
    if (outcome.ok) return outcome;
    const {reason, ...facts} = outcome;
    return {...facts, status: lifecycleFailureStatus(outcome.error, reason)};
}

function renderHyperVNetworkCleanup(outcome: HyperVNetworkCleanupEvidence | null | undefined) {
    return publicHyperVNetworkCleanup(outcome ? {
        ...outcome, networkCleanup: renderHyperVNetworkReceipt(outcome.networkCleanup)
    } : outcome);
}
export function renderHyperVReplay(outcome: HyperVReplayResult) {
    if (outcome.ok)
        return {
            ok: true as const, reconciled: outcome.reconciled, ...(outcome.networkCleanup ? {
                hyperVNetworkAllocationCleanup: renderHyperVNetworkCleanup(outcome.networkCleanup)
            } : {})
        };
    return {
        ok: false as const, status: stateFailureStatus(outcome.error, outcome.reason === "conflict" ? 409 : outcome.reason === "provider-unavailable" ? 503 : 502), error: outcome.error, ...(outcome.detail ? {
            detail: outcome.detail
        } : {})
    };
}
export function renderHyperVSnapshotRepair(outcome: SnapshotRepairResult) {
    if (outcome.ok)
        return {
            ok: true as const, device: outcome.device, reconciled: outcome.reconciled
        };
    return {
        ok: false as const, status: outcome.reason === "conflict" ? 409 : 502, error: outcome.error, ...(outcome.detail ? {
            detail: outcome.detail
        } : {})
    };
}
function snapshotExecutionReceipt(execution: SnapshotExecution<DeviceLabHyperVCommandResult>) {
    return execution.receipt ?? { mode: "exec", provider: "hyper-v", status: execution.ok ? 0 : null };
}
export function renderHyperVSnapshot(outcome: SnapshotOutcome<DeviceLabHyperVCommandResult>): HyperVWireResponse {
    const { kind, journalDisposition: _journalDisposition, ...facts } = outcome;
    if (kind === "refused" || kind === "uncertain") {
        const { reason, execution, executionDiagnostic, rollback, currentDevice, ...failure } = outcome;
        const { kind: _discardedKind, journalDisposition: _discardedJournal, ...publicFailure } = failure;
        return {
            status: reason === "invalid" ? 400 : reason === "missing" ? 404 : reason === "conflict" ? 409 : 502, payload: {
                ok: false, ...publicFailure,
                ...(outcome.error === "destructive-confirmation-required" ? {confirmationField: "confirmDestructive"} : {}),
                ...(currentDevice !== undefined ? {
                    currentDevice: redactHyperVDeviceSecrets(currentDevice)
                } : {}),
                ...(execution ? {
                    execution: redactProviderCommandInput({
                        ...snapshotExecutionReceipt(execution)
                    }, true, executionDiagnostic)
                } : {}),
                ...(rollback ? {
                    rollback: {
                        ...rollback, execution: redactProviderCommandInput({
                            ...snapshotExecutionReceipt(rollback.execution)
                        }, true, "hyper-v-snapshot-rollback-failed")
                    }
                } : {}),
            }
        };
    }
    const { device, execution, ...result } = facts;
    return {
        status: 200, payload: {
            ok: true, result: {
                ...result,
                ...(device !== undefined ? {
                    device: redactHyperVDeviceSecrets(device)
                } : {}),
                ...(execution ? {
                    execution: redactProviderCommandInput({
                        ...snapshotExecutionReceipt(execution)
                    }, true)
                } : {}),
            }
        }
    };
}
function renderHyperVPlan(plan: HyperVPlannedFacts<NativeHyperVConnection>) {
    const { availability, ...facts } = plan;
    return redactHyperVResultSecrets({
        ...facts, providerCommand: availability.kind === "available" ? availability.connection.plannedCommand ?? null : availability.kind === "unavailable" ? {
            error: availability.error, missing: availability.missing
        } : null,
        execution: {
            mode: facts.idempotent ? "idempotent" : "planned", providerExecution: facts.idempotent ? "not-required" : availability.kind === "available" ? "available" : "deferred", mutatesHost: false
        }
    });
}
function renderHyperVExecution(observation: HyperVNativeExecution<ProviderCommandResult>, fallback?: string) {
    const { receipt, ...facts } = observation;
    return redactProviderCommandInput({
        ...receipt, ...facts
    }, true, fallback);
}
export function renderHyperVCreateRollback(rollback: HyperVRollback<ProviderCommandResult>) {
    if (!rollback.attempted)
        return rollback;
    const { execution, providerRecovery, artifacts, ...facts } = rollback;
    return {
        ...facts, ...(execution ? {
            result: renderHyperVExecution(execution, "hyper-v-rollback-command-failed")
        } : providerRecovery ? {
            result: {
                mode: "exec", provider: "hyper-v", status: 0,
                stdoutPresent: true, stderrPresent: false, outputRedacted: true,
                diagnosticCode: "hyper-v-rollback-command-failed",
            }
        } : {}), ...(artifacts ? {
            artifacts
        } : {})
    };
}
export function renderHyperVCreateStart(outcome: HyperVLifecycleOutcome<NativeHyperVConnection, ProviderCommandResult>): HyperVWireResponse {
    const { kind, journalDisposition: _journalDisposition, recoveryDisposition: _recoveryDisposition, imageFailure, networkFailure, lifecycleFailure, rollback, artifactCleanup, execution, failureExecution, provisioning, plan, device, ...facts } = outcome;
    const publicExecution = execution ? {
        ...execution, ...(execution.command ? {
            command: {
                ...renderHyperVExecution(execution.command,
                    ("reason" in outcome && outcome.reason === "provider-failed") || outcome.providerFailure !== undefined
                        ? "hyper-v-provider-command-failed" : undefined), ...(execution.command.guestReadiness ? {
                    guestReadiness: execution.command.guestReadiness
                } : {})
            }
        } : {})
    } : undefined;
    const rendered = {
        ...facts,
        ...(facts.existing !== undefined ? {
            existing: redactHyperVDeviceSecrets(facts.existing)
        } : {}),
        ...(device !== undefined ? {
            device: redactHyperVDeviceSecrets(device)
        } : {}),
        ...(plan ? {
            plan: renderHyperVPlan(plan)
        } : {}),
        ...(execution ? {
            execution: publicExecution
        } : {}),
        ...(provisioning ? {
            provisioning: renderHyperVExecution(provisioning, outcome.error === "hyper-v-linux-seed-failed" ? "hyper-v-linux-seed-command-failed" : "hyper-v-guest-provision-command-failed")
        } : {}),
        ...(rollback ? {
            rollback: "attempted" in rollback ? renderHyperVCreateRollback(rollback) : renderHyperVCreateRecovery(rollback)
        } : {}),
        ...(artifactCleanup ? {
            artifactCleanup: publicHyperVArtifactCleanup(artifactCleanup)
        } : {}),
        ...(lifecycleFailure ? {
            lifecycleFailure: renderHyperVCreateStart(lifecycleFailure).payload
        } : {}),
    };
    const publicResult = {
        ...(plan ? renderHyperVPlan(plan) : {}),
        ...redactHyperVResultSecrets(facts),
        ...(device !== undefined ? {
            device: redactHyperVDeviceSecrets(device)
        } : {}),
        ...(facts.boot ? {
            boot: facts.boot
        } : {}),
        ...(execution ? {
            execution: publicExecution
        } : {}),
        ...(kind === "started" || kind === "rebooted" || (execution?.command && plan?.availability.kind === "available") ? {
            providerCommand: {
                mode: plan?.availability.kind === "available" ? plan.availability.connection.plannedCommand?.mode : "exec", provider: plan?.availability.kind === "available" ? plan.availability.connection.plannedCommand?.provider : "hyper-v"
            }
        } : {}),
    };
    switch (outcome.kind) {
        case "preview":
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...renderHyperVPlan(outcome.plan), invoked: false, dryRun: true, execution: {
                            mode: "dry-run", providerExecution: "available", mutatesHost: false
                        }
                    }
                }
            };
        case "idempotent":
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...publicResult, idempotent: true, execution: {
                            mode: "idempotent", providerExecution: "not-required", mutatesHost: false
                        }
                    }
                }
            };
        case "created":
        case "started":
        case "rebooted":
            return {
                status: 200, payload: {
                    ok: true, result: publicResult
                }
            };
        case "admission-refused":
        case "operation-failed":
        case "uncertain": {
            const { reason: _reason, ...failure }: typeof rendered & {
                reason?: string;
            } = rendered;
            const status = imageFailure ? hyperVImageResolutionToWire(imageFailure).status : networkFailure && outcome.error === networkFailure.error ? hyperVNetworkFailureToWire(networkFailure).status : lifecycleFailureStatus(outcome.error, outcome.reason);
            return {
                status, payload: {
                    ok: false, ...(failureExecution ? {
                        error: outcome.error, detail: renderHyperVExecution(failureExecution, "hyper-v-provider-command-failed").diagnosticCode, ...(outcome.operation ? {
                            operation: outcome.operation
                        } : {}), ...(outcome.nativeHResult !== undefined ? {
                            nativeHResult: outcome.nativeHResult
                        } : {}), ...(outcome.nativeErrorCategory !== undefined ? {
                            nativeErrorCategory: outcome.nativeErrorCategory
                        } : {}), ...(rollback ? {
                            rollback: "attempted" in rollback ? renderHyperVCreateRollback(rollback) : renderHyperVCreateRecovery(rollback)
                        } : {}), result: publicResult
                    } : execution?.command ? {
                        error: outcome.error, detail: outcome.detail, ...(outcome.found !== undefined ? {
                            ownerId: outcome.ownerId, backend: outcome.backend, deviceId: outcome.deviceId, found: outcome.found, ...(outcome.providerFailure ? {
                                providerFailure: outcome.providerFailure
                            } : {})
                        } : {}), result: publicResult
                    } : failure), ...(imageFailure ? {
                        error: imageFailure.error, detail: imageFailure.detail, remedy: imageFailure.remedy
                    } : {}), ...(networkFailure ? {
                        detail: networkFailure.detail, ...(networkFailure.receipt ? {
                            execution: renderHyperVNetworkReceipt(networkFailure.receipt)
                        } : {})
                    } : {})
                }
            };
        }
    }
}

export function renderHyperVStopDelete(outcome: HyperVStopDeleteOutcome<NativeHyperVConnection, ProviderCommandResult>): HyperVWireResponse {
    const { kind: _kind, journalDisposition: _journalDisposition, preparation, execution, device, networkCleanup, artifactCleanup, auxiliaryCleanup, mutatesHost, ...facts } = outcome;
    const descriptor = preparation?.kind === "prepared" ? preparation.connection.plannedCommand : undefined;
    const result = {
        ownerId: facts.ownerId, backend: facts.backend, stateKey: facts.stateKey, command: facts.command, deviceId: facts.deviceId, force: facts.force,
        providerCommand: descriptor ? {
            mode: descriptor.mode, provider: descriptor.provider
        } : preparation?.kind === "unavailable" ? {
            error: preparation.error, missing: preparation.missing
        } : null,
        device: redactHyperVDeviceSecrets(device), ...(auxiliaryCleanup ? {
            auxiliaryCleanup
        } : {}),
        ...(networkCleanup ? {
            hyperVNetworkAllocationCleanup: renderHyperVNetworkCleanup(networkCleanup)
        } : {}),
        ...(artifactCleanup ? {
            hyperVDeviceArtifactCleanup: publicHyperVArtifactCleanup(artifactCleanup)
        } : {}),
        invoked: facts.invoked, dryRun: facts.dryRun,
        execution: execution ? {
            mode: execution.mode, providerExecution: "executed", mutatesHost, command: renderHyperVExecution(execution, facts.error === "hyper-v-device-cleanup-failed" ? facts.error : facts.error ? "hyper-v-provider-command-failed" : undefined)
        } : {
            mode: facts.invoked === false && auxiliaryCleanup ? "preflight" : "idempotent", providerExecution: auxiliaryCleanup ? "blocked" : "not-required", mutatesHost: mutatesHost ?? false
        },
    };
    switch (outcome.kind) {
        case "preview":
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...redactHyperVResultSecrets(result), invoked: false, dryRun: true, execution: {
                            mode: "dry-run", providerExecution: "available", mutatesHost: false
                        }
                    }
                }
            };
        case "already-missing":
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...result, idempotent: true, alreadyMissing: true, execution: {
                            mode: facts.dryRun ? "dry-run" : "idempotent", providerExecution: facts.dryRun ? "available" : "not-required", mutatesHost: false
                        }
                    }
                }
            };
        case "replayed":
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ownerId: facts.ownerId, backend: facts.backend, deviceId: facts.deviceId, command: facts.command, reconciled: true, device: null, ...(networkCleanup ? {
                            hyperVNetworkAllocationCleanup: renderHyperVNetworkCleanup(networkCleanup)
                        } : {}), invoked: true, dryRun: false
                    }
                }
            };
        case "stopped":
        case "deleted":
            return {
                status: 200, payload: {
                    ok: true, result
                }
            };
        case "refused":
        case "uncertain": {
            const { reason, error, ownerId, backend, deviceId, detail, missing, found } = outcome;
            const status = stateFailureStatus(error, reason === "invalid" ? 400 : reason === "missing" ? 404 : reason === "conflict" ? 409 : reason === "provider-unavailable" ? 503 : reason === "deadline" ? 504 : reason === "state-write-failed" ? 409 : 502);
            if (preparation?.kind === "unavailable")
                return {
                    status, payload: {
                        ok: false, error, missing, plan: redactHyperVResultSecrets({
                            ...result, execution: {
                                mode: "planned", providerExecution: "available", mutatesHost: false
                            }
                        })
                    }
                };
            if (auxiliaryCleanup && !execution)
                return {
                    status, payload: {
                        ok: false, error, result
                    }
                };
            if (execution)
                return {
                    status, payload: {
                        ok: false, error,
                        ...(error === "owner-device-state-conflict" || error === "hyper-v-device-cleanup-failed" ? {
                            ownerId, backend, deviceId, ...(found !== undefined ? {
                                found
                            } : {})
                        } : {}),
                        ...(detail !== undefined ? {
                            detail
                        } : {}), result
                    }
                };
            return {
                status, payload: {
                    ok: false, error,
                    ...(ownerId !== undefined ? {
                        ownerId
                    } : {}), ...(backend !== undefined ? {
                        backend
                    } : {}),
                    ...(deviceId !== undefined ? {
                        deviceId
                    } : {}), ...(detail !== undefined ? {
                        detail
                    } : {}),
                    ...(missing ? {
                        missing
                    } : {}), ...(outcome.stateKey ? {
                        stateKey: outcome.stateKey
                    } : {}),
                }
            };
        }
    }
}
