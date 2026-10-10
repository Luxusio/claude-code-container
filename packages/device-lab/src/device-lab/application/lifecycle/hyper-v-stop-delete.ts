import { join } from "path";
import { hyperVField, hyperVSelectedDevice, hyperVStopReplacement, type HyperVOperationEvidence, type HyperVStopDeleteRequest, type HyperVStopDeleteResponse, type HyperVReplayResult, type HyperVPublication } from "../../domain/lifecycle/hyper-v-stop-delete.js";
import type { HyperVStopDeletePorts } from "../../ports/lifecycle/hyper-v-stop-delete.js";
export function createHyperVStopDeleteApplication(ports: HyperVStopDeletePorts) {
    async function reconcile(ownerId: string, backend: string, deviceId: string, deadlineAt = Number.POSITIVE_INFINITY, preserveNetwork = false): Promise<HyperVReplayResult> {
        let journal: HyperVOperationEvidence | null;
        try {
            journal = ports.readJournal(ownerId, backend, deviceId);
        }
        catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-operation-journal-invalid",
                detail: ports.errorCode(error, "hyper-v-operation-journal-invalid"),
            };
        }
        if (!journal)
            return { ok: true, reconciled: false };
        const currentDevice = hyperVSelectedDevice(ports.read(ownerId, backend), deviceId);
        if (currentDevice && ports.incarnation(currentDevice) !== journal.incarnationId) {
            return { ok: false, status: 409, error: "hyper-v-operation-incarnation-conflict" };
        }
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        if (!powershell)
            return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
        const deviceRoot = ports.deviceRoot(ownerId, backend, deviceId);
        const auxiliaryMediaPaths = [join(deviceRoot, "disks", backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")];
        if (journal.command === "device_delete") {
            try {
                let outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                ports.assertDeadline(deadlineAt);
                if (outcome.kind === "pending" && outcome.action === "remove") {
                    if (outcome.virtualMachine.state.toLowerCase() !== "off") {
                        await ports.replayPower(powershell, ownerId, journal, "stop", true, deadlineAt);
                        ports.assertDeadline(deadlineAt);
                        outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                    }
                    if (outcome.kind !== "pending" || outcome.action !== "remove") {
                        return { ok: false, status: 502, error: "hyper-v-delete-reconciliation-invalid-result" };
                    }
                    try {
                        await ports.replayRemoveVm(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                    }
                    catch (error) {
                        const confirmation = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                        if (confirmation.kind !== "absent" || !confirmation.satisfiesIntent) {
                            return {
                                ok: false,
                                status: 502,
                                error: "hyper-v-delete-reconciliation-failed",
                                detail: ports.errorCode(error, "hyper-v-delete-reconciliation-failed"),
                            };
                        }
                    }
                    ports.assertDeadline(deadlineAt);
                    outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                }
                if (outcome.kind !== "absent" || !outcome.satisfiesIntent) {
                    return { ok: false, status: 502, error: "hyper-v-delete-reconciliation-invalid-result" };
                }
                await ports.removeHostFiles(powershell, deviceRoot, [journal.diskPath], undefined, deadlineAt);
                await ports.removeHostFiles(powershell, deviceRoot, auxiliaryMediaPaths, ports.windowsDirectory(journal.diskPath), deadlineAt);
            }
            catch (error) {
                return {
                    ok: false,
                    status: 502,
                    error: "hyper-v-delete-reconciliation-failed",
                    detail: ports.errorCode(error, "hyper-v-delete-reconciliation-failed"),
                };
            }
            const allocation = await ports.releaseNetwork(ownerId, deviceId, journal.incarnationId, deadlineAt, preserveNetwork);
            const artifacts = allocation.ok
                ? ports.cleanupArtifacts(ownerId, backend, deviceId)
                : { ok: false, removed: false, error: "network-allocation-cleanup-failed" };
            if (!artifacts.ok || !allocation.ok) {
                return {
                    ok: false,
                    status: 502,
                    error: "hyper-v-delete-reconciliation-cleanup-failed",
                    detail: [artifacts.ok ? null : `artifacts:${artifacts.error}`, allocation.ok ? null : `allocation:${allocation.error}`].filter(Boolean).join("; "),
                };
            }
            ports.replayPublish(ownerId, backend, deviceId, null);
            return {
                ok: true,
                reconciled: true,
                hyperVNetworkAllocationCleanup: ports.publicNetwork(allocation),
            };
        }
        let outcome;
        try {
            outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
            ports.assertDeadline(deadlineAt);
            if (outcome.kind === "pending" && outcome.reason === "terminal-state-mismatch") {
                if (outcome.action === "start") {
                    await ports.replayPower(powershell, ownerId, journal, "start", false, deadlineAt);
                }
                else if (outcome.action === "stop") {
                    await ports.replayPower(powershell, ownerId, journal, "stop", false, deadlineAt);
                }
                ports.assertDeadline(deadlineAt);
                outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
            }
        }
        catch (error) {
            return {
                ok: false,
                status: 502,
                error: "hyper-v-state-reconciliation-failed",
                detail: ports.errorCode(error, "hyper-v-state-reconciliation-failed"),
            };
        }
        ports.assertDeadline(deadlineAt);
        if (outcome.kind === "pending" && outcome.reason === "transitioning-or-unknown") {
            return {
                ok: false, status: 409, error: "hyper-v-operation-still-transitioning", detail: outcome.virtualMachine.state
            };
        }
        if (outcome.kind !== "settled") {
            return { ok: false, status: 502, error: "hyper-v-state-reconciliation-invalid-result" };
        }
        const observation = outcome.virtualMachine;
        const state = observation.state.toLowerCase();
        ports.replayPublish(ownerId, backend, deviceId, {
            status: state === "running" ? "running" : "stopped", runtimeState: observation.state, hyperVStatus: observation.status, updatedAt: ports.timestamp()
        });
        ports.clearJournal(ownerId, backend, deviceId);
        return { ok: true, reconciled: true };
    }
    async function invoke(ownerId: string, parsed: HyperVStopDeleteRequest, deadlineAt = Number.POSITIVE_INFINITY, cleanupDeadlineAt = deadlineAt): Promise<HyperVStopDeleteResponse> {
        ports.assertDeadline(deadlineAt);
        const { backend, stateKey, deviceId } = parsed;
        if (!parsed.dryRun) {
            let expectedIncarnation: string | null;
            try {
                const current = hyperVSelectedDevice(ports.read(ownerId, stateKey), deviceId);
                expectedIncarnation = current ? ports.incarnation(current) : null;
                if (!expectedIncarnation)
                    expectedIncarnation = ports.readJournal(ownerId, backend, deviceId)?.incarnationId || null;
            }
            catch (error) {
                if (ports.stateErrorCode(error))
                    return ports.stateFailure(error, parsed);
                return {
                    status: 409, payload: {
                        ok: false, error: "hyper-v-operation-journal-invalid", ownerId, backend, deviceId, detail: ports.errorCode(error, "hyper-v-operation-journal-invalid")
                    }
                };
            }
            if (expectedIncarnation) {
                if (!ports.validIncarnation(parsed.expectedIncarnationId))
                    return {
                        status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend, deviceId }
                    };
                if (parsed.expectedIncarnationId !== expectedIncarnation)
                    return {
                        status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend, deviceId }
                    };
            }
        }
        const replay = await reconcile(ownerId, backend, deviceId, deadlineAt, parsed.command === "device_delete" ? parsed.preserveNetwork === true : true);
        if (!replay.ok)
            return {
                status: replay.status, payload: {
                    ok: false, error: replay.error, ownerId, backend, deviceId, ...(replay.detail ? { detail: replay.detail } : {})
                }
            };
        if (replay.reconciled && parsed.command === "device_delete" && !hyperVSelectedDevice(ports.read(ownerId, stateKey), deviceId)) {
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ownerId, backend, deviceId, command: parsed.command, reconciled: true, device: null,
                        ...(replay.hyperVNetworkAllocationCleanup ? { hyperVNetworkAllocationCleanup: replay.hyperVNetworkAllocationCleanup } : {}), invoked: true, dryRun: false
                    }
                }
            };
        }
        if (!parsed.dryRun) {
            let snapshotJournal: unknown;
            try {
                snapshotJournal = ports.readSnapshotJournal(ownerId, backend, deviceId);
            }
            catch (error) {
                return {
                    status: 409, payload: {
                        ok: false, error: "hyper-v-snapshot-journal-invalid", ownerId, backend, deviceId, detail: ports.errorCode(error, "hyper-v-snapshot-journal-invalid")
                    }
                };
            }
            if (snapshotJournal) {
                const current = hyperVSelectedDevice(ports.read(ownerId, stateKey), deviceId);
                if (!current)
                    return {
                        status: 409, payload: {
                            ok: false, error: "hyper-v-snapshot-reconciliation-metadata-invalid", ownerId, backend, deviceId
                        }
                    };
                const executable = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
                if (!executable)
                    return {
                        status: 400, payload: { ok: false, error: "missing-provider-command", missing: ["powershell"], backend, deviceId }
                    };
                const snapshot = await ports.repairSnapshots(ownerId, backend, deviceId, current, executable);
                if (!snapshot.ok) {
                    if (parsed.command === "device_delete" && parsed.force)
                        ports.clearSnapshotJournal(ownerId, backend, deviceId);
                    else
                        return {
                            status: snapshot.status, payload: {
                                ok: false, error: snapshot.error, ownerId, backend, deviceId, ...(snapshot.detail ? { detail: snapshot.detail } : {})
                            }
                        };
                }
            }
        }
        const result = await execute(ownerId, parsed, deadlineAt, cleanupDeadlineAt);
        return result;
    }
    async function execute(ownerId: string, parsed: HyperVStopDeleteRequest, deadlineAt: number, cleanupDeadlineAt: number, staged = false): Promise<HyperVStopDeleteResponse> {
        const { backend, stateKey, deviceId } = parsed;
        let device: Record<string, unknown> | undefined;
        try {
            device = hyperVSelectedDevice(ports.read(ownerId, stateKey), deviceId);
        }
        catch (error) {
            return ports.stateFailure(error, parsed);
        }
        let expected = ports.clone(device);
        const base = { ownerId, backend, stateKey, command: parsed.command, deviceId };
        if (!device) {
            if (parsed.command !== "device_delete")
                return { status: 404, payload: { ok: false, error: "owner-device-not-found", ownerId, backend, deviceId } };
            const result = { ...base, device: null, idempotent: true, alreadyMissing: true, providerCommand: null };
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...result, invoked: false, dryRun: parsed.dryRun, execution: {
                            mode: parsed.dryRun ? "dry-run" : "idempotent", providerExecution: parsed.dryRun ? "available" : "not-required", mutatesHost: false
                        }
                    }
                }
            };
        }
        // The shared preview also fences incarnation for dry-run requests.
        const incarnation = ports.incarnation(device);
        if (!ports.validIncarnation(parsed.expectedIncarnationId))
            return {
                status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend, deviceId }
            };
        if (incarnation !== parsed.expectedIncarnationId)
            return {
                status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend, deviceId }
            };
        const descriptor = ports.descriptor(ownerId, parsed, device);
        const plan = {
            ...base, force: parsed.force, dryRun: parsed.dryRun, device, providerCommand: descriptor, execution: { mode: "planned", providerExecution: "available", mutatesHost: false }
        };
        if (parsed.dryRun)
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ...ports.redactResult(plan), invoked: false, dryRun: true, execution: { mode: "dry-run", providerExecution: "available", mutatesHost: false }
                    }
                }
            };
        if (staged)
            return perform(ownerId, parsed, plan, descriptor, device, expected, deadlineAt, cleanupDeadlineAt);
        const journal = ports.writeJournal(ownerId, parsed);
        if (!journal.ok)
            return {
                status: 409, payload: {
                    ok: false, error: "hyper-v-operation-journal-write-failed", ownerId, backend, deviceId, detail: journal.error
                }
            };
        // Re-read the definition after journal publication, as the existing ordinary path does.
        const result = await execute(ownerId, parsed, deadlineAt, cleanupDeadlineAt, true);
        if (result.status < 500)
            ports.clearJournal(ownerId, backend, deviceId);
        return result;
    }
    async function perform(ownerId: string, parsed: HyperVStopDeleteRequest, plan: Record<string, unknown>, descriptor: ReturnType<HyperVStopDeletePorts["descriptor"]>, device: Record<string, unknown>, expected: unknown, deadlineAt: number, cleanupDeadlineAt: number): Promise<HyperVStopDeleteResponse> {
        const { backend, stateKey, deviceId } = parsed;
        if ("error" in descriptor)
            return {
                status: 400, payload: { ok: false, error: descriptor.error, missing: descriptor.missing, plan: ports.redactResult(plan) }
            };
        const auxiliary = ports.cleanupAuxiliary(ownerId, parsed, expected);
        if (auxiliary.committed)
            expected = ports.clone(auxiliary.device);
        if (!auxiliary.result.ok)
            return {
                status: 502, payload: {
                    ok: false, error: "auxiliary-runtime-cleanup-failed", result: {
                        ...ports.redactResult(plan), device: ports.redactDevice(auxiliary.device), auxiliaryCleanup: auxiliary.result, invoked: false, dryRun: false, execution: {
                            mode: "preflight", providerExecution: "blocked", mutatesHost: auxiliary.result.changed === true || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true
                        }
                    }
                }
            };
        const executable = descriptor.executable || "powershell.exe";
        const deleting = parsed.command === "device_delete";
        const execution = deleting ? await ports.executeDelete(ownerId, parsed, device, executable, deadlineAt) : await ports.executeStop(ownerId, parsed, device, executable, deadlineAt);
        if (ports.deadlineExpired(deadlineAt))
            return {
                status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend, deviceId }
            };
        const observation = execution.status === 0 && !execution.error ? ports.parseObservation(execution.stdout || "", deleting) : null;
        const expectedVmId = (hyperVField(device, "vmId") || "").toLowerCase();
        const success = Boolean(observation && expectedVmId && observation.vmId === expectedVmId && observation.vmName === hyperVField(device, "vmName")
            && (!deleting || ports.samePath(observation.diskPath || "", hyperVField(device, "diskPath") || "")));
        const network = success && deleting ? await ports.releaseNetwork(ownerId, deviceId, ports.incarnation(device), cleanupDeadlineAt, parsed.preserveNetwork === true) : null;
        const artifacts = success && deleting && network?.ok === true ? ports.cleanupArtifacts(ownerId, backend, deviceId) : null;
        if (artifacts?.ok === false || network?.ok === false)
            return {
                status: 502, payload: {
                    ok: false, error: "hyper-v-device-cleanup-failed", ownerId, backend, deviceId, result: {
                        ...ports.redactResult(plan), device: ports.redactDevice(device), hyperVDeviceArtifactCleanup: ports.publicArtifacts(artifacts), hyperVNetworkAllocationCleanup: ports.publicNetwork(network), invoked: true, dryRun: false, execution: {
                            mode: execution.mode, providerExecution: "executed", mutatesHost: true, command: ports.redactExecution(execution, "hyper-v-device-cleanup-failed")
                        }
                    }
                }
            };
        const publication: HyperVPublication | undefined = success ? ports.publish(ownerId, stateKey, deviceId, expected, current => deleting ? null : hyperVStopReplacement(current, observation, ports.timestamp())) : undefined;
        return {
            status: publication && !publication.matched ? 409 : success ? 200 : 502, payload: {
                ok: success && (!publication || publication.matched),
                ...(publication && !publication.matched ? { error: "owner-device-state-conflict", ownerId, backend, deviceId, found: publication.found } : {}),
                ...(success || (publication && !publication.matched) ? {} : {
                    error: "provider-command-failed", detail: ports.diagnosticCode(execution, "hyper-v-provider-command-failed") || "hyper-v-provider-command-failed"
                }),
                result: {
                    ...ports.redactResult(plan), providerCommand: { mode: descriptor.mode, provider: descriptor.provider }, device: ports.redactDevice(publication ? publication.device : device), auxiliaryCleanup: auxiliary.result,
                    ...(artifacts ? { hyperVDeviceArtifactCleanup: ports.publicArtifacts(artifacts) } : {}), ...(network ? { hyperVNetworkAllocationCleanup: ports.publicNetwork(network) } : {}),
                    invoked: true, dryRun: false, execution: {
                        mode: execution.mode, providerExecution: "executed", mutatesHost: success, command: ports.redactExecution(execution, success ? undefined : "hyper-v-provider-command-failed")
                    }
                }
            }
        };
    }
    return { invoke, reconcile };
}
