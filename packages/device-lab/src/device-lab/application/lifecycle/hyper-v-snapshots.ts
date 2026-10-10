import { trackedHyperVSnapshots, snapshotInventoryConflict, snapshotField, snapshotCheckpointPolicy, snapshotActionReplacement } from "../../domain/lifecycle/hyper-v-snapshots.js";
import type { SnapshotRequest, SnapshotOwnerTarget, SnapshotRepairTarget, SnapshotRepairResult, SnapshotRpcResponse, SnapshotJournal, SnapshotTracked, SnapshotMutationObservation, SnapshotDeleteObservation } from "../../domain/lifecycle/hyper-v-snapshots.js";
import type { BrokerHyperVSnapshotPorts, SnapshotPublication } from "../../ports/lifecycle/hyper-v-snapshots.js";

export async function settleSnapshotInventory<T>(
    ownerId: string, tracked: readonly { id: string; name: string; providerName: string }[],
    first: readonly { snapshotId: string; snapshotName: string }[],
    readAgain: () => Promise<{ readonly ok: true; readonly snapshots: readonly { snapshotId: string; snapshotName: string }[] } | { readonly ok: false; readonly error: T }>,
    limits: { readonly deadlineAt: number; readonly timeoutError: T; readonly delayMilliseconds?: number },
    clock: { now(): number; sleep(ms: number): Promise<void> },
): Promise<{ readonly ok: true; readonly conflict: ReturnType<typeof snapshotInventoryConflict> } | { readonly ok: false; readonly error: T }> {
    let conflict = snapshotInventoryConflict(ownerId, tracked, first);
    for (let attempt = 0; attempt < 2 && (conflict.untracked.length > 0 || conflict.missing.length > 0); attempt += 1) {
        const delayMilliseconds = limits.delayMilliseconds ?? 300;
        if (clock.now() + delayMilliseconds >= limits.deadlineAt) return { ok: false, error: limits.timeoutError };
        await clock.sleep(delayMilliseconds);
        if (clock.now() >= limits.deadlineAt) return { ok: false, error: limits.timeoutError };
        const observed = await readAgain();
        if (!observed.ok) return observed;
        conflict = snapshotInventoryConflict(ownerId, tracked, observed.snapshots);
    }
    return { ok: true, conflict };
}

export function createBrokerHyperVSnapshotApplication(ports: BrokerHyperVSnapshotPorts) {
    function commandSucceeded(result: { status?: number | null; error?: string }) { return result.status === 0 && !result.error; }
    function settleHyperVSnapshotInventory<T>(ownerId: string, tracked: readonly SnapshotTracked[], first: readonly { snapshotId: string; snapshotName: string }[], readAgain: () => Promise<{ readonly ok: true; readonly snapshots: readonly { snapshotId: string; snapshotName: string }[] } | { readonly ok: false; readonly error: T }>, limits: { readonly deadlineAt: number; readonly timeoutError: T; readonly delayMilliseconds?: number }) {
        return settleSnapshotInventory(ownerId, tracked, first, readAgain, limits, ports);
    }
    async function reconcileSnapshotJournal(ownerId: string, backend: string, deviceId: string, device: Record<string, unknown>, powershell: string, retryRestoreSnapshotId?: string): Promise<SnapshotRepairResult> {
        let capturedJournal: SnapshotJournal | null;
        try {
            capturedJournal = ports.readJournal(ownerId, backend, deviceId);
        } catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-snapshot-journal-invalid",
                detail: ports.errorCode(error, "hyper-v-snapshot-journal-invalid"),
            };
        }
        const journal = capturedJournal;
        if (!journal) return { ok: true, device, reconciled: false };
        if (journal.tool === "device_snapshot_create" && journal.confirmationRequired && !journal.snapshotId) {
            return { ok: false, status: 409, error: "hyper-v-snapshot-create-outcome-indeterminate" };
        }
        const vmId = snapshotField(device, "vmId");
        const vmName = snapshotField(device, "vmName");
        const diskPath = snapshotField(device, "diskPath");
        const incarnationId = ports.incarnation(device);
        if (!vmId || !vmName || !diskPath || !incarnationId || incarnationId !== journal.incarnationId) return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
        const expectedCheckpointPolicy = snapshotCheckpointPolicy(backend);
        if (journal.providerName !== ports.providerName(ownerId, journal.snapshotName)) return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
        let repairObservation: { readonly checkpointPolicy: "Production" | "ProductionOnly"; readonly candidateCount: 0 | 1 };
        try {
            repairObservation = await ports.repairPolicy(powershell, {
                vmId,
                vmName,
                expectedNotes: ports.ownershipNotes(ownerId, deviceId, incarnationId),
                providerName: journal.providerName,
                expectedCheckpointPolicy,
            });
        } catch (error) {
            if (ports.isValidationError(error)) {
                return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
            }
            const lastExecution = ports.lastExecution();
            const detail = ports.diagnosticCode({
                error: ports.providerErrorCode(error) ?? lastExecution?.error,
                stdout: lastExecution?.stdout,
                stderr: lastExecution?.stderr,
            }, "hyper-v-snapshot-reconciliation-failed");
            return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-failed", detail };
        }
        if (repairObservation.checkpointPolicy !== expectedCheckpointPolicy) return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-invalid-result" };
        const execution = await ports.status({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId }, ports.now() + 30000, 30000);
        if (!commandSucceeded(execution)) return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-failed", detail: ports.diagnosticCode(execution, "hyper-v-snapshot-reconciliation-failed") };
        const observation = ports.parseStatus(execution.stdout || "");
        if (!observation || ports.observationMismatch(observation, { vmId, vmName, diskPath })
            || observation.checkpointPolicy !== expectedCheckpointPolicy) {
            return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-invalid-result" };
        }
        const live = (observation.snapshots || []).filter((snapshot) => snapshot.snapshotName.toLowerCase() === journal.providerName.toLowerCase());
        if (live.length > 1) return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-ambiguous" };
        if (live.length !== repairObservation.candidateCount) return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-invalid-result" };
        if (live.some((snapshot) => snapshot.snapshotName !== journal.providerName)) {
            return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
        }
        if (journal.tool === "device_snapshot_create" && journal.confirmationRequired
            && (live.length !== 1 || live[0].snapshotId.toLowerCase() !== (journal.snapshotId || "").toLowerCase())) {
            return { ok: false, status: 409, error: "hyper-v-snapshot-create-outcome-indeterminate" };
        }
        let preserveJournalForRestoreRetry = false;
        if (journal.tool === "device_snapshot_restore") {
            const snapshotId = (journal.snapshotId || "").toLowerCase();
            if (live.length !== 1 || live[0].snapshotId.toLowerCase() !== snapshotId) {
                return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
            }
            if (retryRestoreSnapshotId?.toLowerCase() !== snapshotId) {
                return { ok: false, status: 409, error: "hyper-v-snapshot-restore-outcome-indeterminate" };
            }
            preserveJournalForRestoreRetry = true;
        }
        const tracked = trackedHyperVSnapshots(device);
        if (journal.tool === "device_snapshot_delete" && live.length === 1
            && live[0].snapshotId.toLowerCase() !== (journal.snapshotId || "").toLowerCase()) {
            return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
        }
        let snapshots = tracked;
        let activeSnapshotId = typeof device.activeSnapshotId === "string" ? device.activeSnapshotId : null;
        if (journal.tool === "device_snapshot_create" && live.length === 1) {
            const snapshotId = live[0].snapshotId.toLowerCase();
            snapshots = [...tracked.filter((snapshot) => snapshot.name !== journal.snapshotName && snapshot.id.toLowerCase() !== snapshotId), {
                id: snapshotId,
                name: journal.snapshotName,
                providerName: journal.providerName,
                ...(live[0].snapshotType ? { snapshotType: live[0].snapshotType } : {}),
                createdAt: journal.startedAt,
            }];
        } else if (journal.tool === "device_snapshot_delete" && live.length === 0) {
            snapshots = tracked.filter((snapshot) => snapshot.id.toLowerCase() !== (journal.snapshotId || "").toLowerCase());
            if (activeSnapshotId?.toLowerCase() === (journal.snapshotId || "").toLowerCase()) activeSnapshotId = null;
        }
        const updated = ports.mergeRepair(ownerId, backend, deviceId, device, { snapshots, activeSnapshotId, runtimeState: observation.state, status: observation.state.toLowerCase() === "running" ? "running" : "stopped" });
        if (!preserveJournalForRestoreRetry) {
            ports.removeRepairJournal(ownerId, backend, deviceId);
        }
        return { ok: true, device: updated, reconciled: true };
    }

    function hyperVSnapshotStateConflict(ownerId: string, backend: string, deviceId: string, transition: SnapshotPublication, rollback?: unknown): SnapshotRpcResponse {
        return {
            status: 409,
            payload: {
                ok: false,
                error: "hyper-v-snapshot-state-conflict",
                ownerId,
                backend,
                deviceId,
                found: transition.found,
                currentDevice: ports.redactDevice(transition.device),
                ...(rollback ? { rollback } : {}),
            },
        };
    }

    async function invoke(ownerId: string, parsed: SnapshotRequest, match: SnapshotOwnerTarget): Promise<SnapshotRpcResponse> {
        const deviceId = String(parsed.deviceId);
        let device = match.device;
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        if (!powershell) return { status: 400, payload: { ok: false, error: "missing-provider-command", missing: ["powershell"], backend: match.backend, deviceId } };
        if ((parsed.tool === "device_snapshot_restore" || parsed.tool === "device_snapshot_delete")
            && parsed.params.confirmDestructive !== true) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: "destructive-confirmation-required",
                    confirmationField: "confirmDestructive",
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    tool: parsed.tool,
                },
            };
        }
        const initialIncarnationId = ports.incarnation(device);
        const pendingSnapshotJournal = ports.journalExists(ownerId, match.stateKey, deviceId);
        if (parsed.tool !== "device_snapshot_list" || pendingSnapshotJournal) {
            const expectedIncarnationId = parsed.params.incarnationId;
            if (!ports.validIncarnation(expectedIncarnationId)) {
                return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend: match.backend, deviceId, tool: parsed.tool } };
            }
            if (!initialIncarnationId || expectedIncarnationId !== initialIncarnationId) {
                return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: match.backend, deviceId, tool: parsed.tool } };
            }
        }
        const reconciliation = await reconcileSnapshotJournal(
            ownerId,
            match.stateKey,
            deviceId,
            device,
            powershell,
            parsed.tool === "device_snapshot_restore" && typeof parsed.params.snapshotId === "string"
                ? parsed.params.snapshotId
                : undefined,
        );
        if (!reconciliation.ok) return { status: reconciliation.status, payload: { ok: false, error: reconciliation.error, ownerId, backend: match.backend, deviceId, ...(reconciliation.detail ? { detail: reconciliation.detail } : {}) } };
        device = reconciliation.device;
        const vmId = typeof device.vmId === "string" ? device.vmId : null;
        const vmName = typeof device.vmName === "string" ? device.vmName : null;
        const diskPath = typeof device.diskPath === "string" ? device.diskPath : null;
        const incarnationId = ports.incarnation(device);
        if (!vmId || !vmName || !diskPath || !incarnationId) {
            return { status: 409, payload: { ok: false, error: "missing-provider-metadata", missing: ["vmId", "vmName", "diskPath", "incarnationId"], backend: match.backend, deviceId } };
        }
        if (parsed.tool === "device_snapshot_restore") {
            ports.forgetConsole(ownerId, match.backend || "", deviceId);
        }
        if (parsed.tool === "device_snapshot_list") {
            // The packaged MCP route allows 60 seconds for this tool. Keep all native reads,
            // including conflict retries, inside one shorter broker deadline.
            const listDeadlineAt = ports.now() + 45000;
            const execution = await ports.status({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId }, listDeadlineAt, 30000);
            if (!commandSucceeded(execution)) {
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-snapshot-list-provider-failed",
                        detail: ports.diagnosticCode(execution, "hyper-v-snapshot-list-provider-failed"),
                        ownerId,
                        backend: match.backend,
                        deviceId,
                        execution: ports.redactExecution(
                            execution,
                            true,
                            "hyper-v-snapshot-list-provider-failed",
                        ),
                    },
                };
            }
            const observation = ports.parseStatus(execution.stdout || "");
            const mismatch = ports.observationMismatch(observation, { vmId, vmName, diskPath });
            if (!observation || mismatch) {
                return { status: 502, payload: { ok: false, error: "hyper-v-snapshot-list-invalid-result", detail: mismatch, ownerId, backend: match.backend, deviceId } };
            }
            const tracked = trackedHyperVSnapshots(device);
            let observedOwnerSnapshotCount = observation.snapshots?.length ?? 0;
            const settled = await settleHyperVSnapshotInventory<SnapshotRpcResponse>(ownerId, tracked, observation.snapshots || [], async () => {
                const retryExecution = await ports.status({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId }, listDeadlineAt, 30000);
                if (!commandSucceeded(retryExecution)) {
                    return { ok: false as const, error: { status: 502, payload: { ok: false, error: "hyper-v-snapshot-list-provider-failed", ownerId, backend: match.backend, deviceId,
                        detail: ports.diagnosticCode(retryExecution, "hyper-v-snapshot-list-provider-failed"),
                        execution: ports.redactExecution(retryExecution, true, "hyper-v-snapshot-list-provider-failed") } } };
                }
                const retryObservation = ports.parseStatus(retryExecution.stdout || "");
                const retryMismatch = ports.observationMismatch(retryObservation, { vmId, vmName, diskPath });
                if (!retryObservation || retryMismatch) {
                    return { ok: false as const, error: { status: 502, payload: { ok: false, error: "hyper-v-snapshot-list-invalid-result", detail: retryMismatch, ownerId, backend: match.backend, deviceId } } };
                }
                observedOwnerSnapshotCount = retryObservation.snapshots?.length ?? 0;
                return { ok: true as const, snapshots: retryObservation.snapshots || [] };
            }, {
                deadlineAt: listDeadlineAt,
                timeoutError: { status: 502, payload: { ok: false, error: "hyper-v-snapshot-list-provider-failed", ownerId, backend: match.backend, deviceId,
                    detail: "hyper-v-status-timeout" } },
            });
            if (!settled.ok) return settled.error;
            const { untracked, missing } = settled.conflict;
            if (untracked.length > 0 || missing.length > 0) {
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "hyper-v-snapshot-inventory-conflict",
                        ownerId,
                        backend: match.backend,
                        deviceId,
                        observedOwnerSnapshotCount,
                        untracked,
                        missing,
                    },
                };
            }
            return {
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        ownerId,
                        backend: match.backend,
                        stateKey: match.stateKey,
                        deviceId,
                        tool: parsed.tool,
                        provider: "hyper-v",
                        snapshots: tracked,
                        activeSnapshotId: typeof device.activeSnapshotId === "string" ? device.activeSnapshotId : null,
                        startsDevices: false,
                    },
                },
            };
        }
    const requestedName = typeof parsed.params.snapshotName === "string" ? parsed.params.snapshotName : null;
        const requestedId = typeof parsed.params.snapshotId === "string" ? parsed.params.snapshotId.toLowerCase() : null;
        const snapshots = trackedHyperVSnapshots(device);
        let tracked: SnapshotTracked | null = null;
        if (parsed.tool !== "device_snapshot_create") {
            const matches = snapshots.filter((snapshot) => (!requestedName || snapshot.name === requestedName) && (!requestedId || snapshot.id.toLowerCase() === requestedId));
            if ((!requestedName && !requestedId) || matches.length !== 1) {
                return { status: 404, payload: { ok: false, error: "hyper-v-snapshot-not-found", ownerId, backend: match.backend, deviceId, snapshotName: requestedName, snapshotId: requestedId } };
            }
            tracked = matches[0];
        }
        if (parsed.tool === "device_snapshot_create") {
            if (!requestedName) return { status: 400, payload: { ok: false, error: "missing-snapshot-name", deviceId } };
            if (snapshots.some((snapshot) => snapshot.name === requestedName)) {
                return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-already-exists", ownerId, backend: match.backend, deviceId, snapshotName: requestedName } };
            }
        }
        const snapshotName = parsed.tool === "device_snapshot_create" ? String(requestedName) : String(tracked?.name);
        const expectedProviderName = ports.providerName(ownerId, snapshotName);
        const expectedCheckpointPolicy = snapshotCheckpointPolicy(match.backend);
        if (parsed.tool === "device_snapshot_create") {
            const statusExecution = await ports.status({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId }, ports.now() + 30000, 30000);
            const statusObservation = commandSucceeded(statusExecution) ? ports.parseStatus(statusExecution.stdout || "") : null;
            const mismatch = ports.observationMismatch(statusObservation, { vmId, vmName, diskPath });
            if (!statusObservation || mismatch) {
                return { status: 502, payload: { ok: false, error: "hyper-v-snapshot-preflight-failed", ownerId, backend: match.backend, deviceId,
                    detail: commandSucceeded(statusExecution) ? mismatch : ports.diagnosticCode(statusExecution, "hyper-v-snapshot-preflight-failed") } };
            }
            if (statusObservation.checkpointPolicy !== expectedCheckpointPolicy) {
                return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-policy-invalid", ownerId, backend: match.backend, deviceId } };
            }
        }
        const snapshotTarget = { vmId, providerName: expectedProviderName, snapshotId: tracked?.id || null };
        const snapshotCreateDeadlineAt = parsed.tool === "device_snapshot_create" ? ports.now() + 45000 : null;
        let snapshotConfirmationDeadlineAt: number | null = null;
        try {
            ports.writeJournal(ownerId, match.stateKey, deviceId, incarnationId, parsed.tool, snapshotName, expectedProviderName, tracked?.id, snapshotCheckpointPolicy(match.backend));
        } catch (error) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "hyper-v-snapshot-journal-write-failed",
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    detail: ports.errorCode(
                        error,
                        "hyper-v-snapshot-journal-write-failed",
                    ),
                },
            };
        }
        let observation: SnapshotMutationObservation | SnapshotDeleteObservation;
        try {
            observation = parsed.tool === "device_snapshot_create"
                ? await ports.create(powershell, snapshotTarget, {
                    operationDeadlineAt: snapshotCreateDeadlineAt ?? 0,
                    timeoutMilliseconds: () => ports.remainingTimeout(Math.min(snapshotCreateDeadlineAt ?? Number.POSITIVE_INFINITY, snapshotConfirmationDeadlineAt ?? Number.POSITIVE_INFINITY), 45000),
                    onConfirmationDeadline: (deadlineAt) => { snapshotConfirmationDeadlineAt = deadlineAt; return undefined; },
                    onCreatedId: (snapshotId) => ports.recordCreatedId(ownerId, match.stateKey, deviceId,
                        incarnationId, expectedProviderName, snapshotId,
                    ),
                })
                : parsed.tool === "device_snapshot_restore"
                    ? await ports.restore(powershell, snapshotTarget, {
                        force: parsed.params.force === true,
                        startAfterRestore: match.backend === "linux-vm",
                    })
                    : await ports.delete(powershell, snapshotTarget);
        } catch (error) {
            // Uncertain create evidence remains journaled; native report mismatches are
            // distinct from ownership/provider failures that require reconciliation.
            const boundedErrorCode = ports.errorCode(error, "");
            if (parsed.tool === "device_snapshot_create"
                && (boundedErrorCode === "hyper-v-snapshot-create-unconfirmed"
                    || boundedErrorCode === "hyper-v-snapshot-create-identity-conflict"
                    || boundedErrorCode === "hyper-v-snapshot-created-id-invalid"
                    || boundedErrorCode === "hyper-v-snapshot-created-id-journal-mismatch")) {
                // The staged create journal keeps the returned ID when one was trustworthy.
                // Leave it in place and let a later exact-ID reconciliation resolve the outcome.
                return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-create-outcome-indeterminate",
                    ownerId, backend: match.backend, deviceId, detail: boundedErrorCode } };
            }
            if (boundedErrorCode === "hyper-v-snapshot-delete-unconfirmed"
                || boundedErrorCode === "hyper-v-snapshot-result-mismatch") {
                return { status: 502, payload: { ok: false, error: "hyper-v-snapshot-invalid-result", ownerId, backend: match.backend, deviceId } };
            }
            // A validation failure before native mutation clears the staged intent.
            if (ports.isValidationError(error)) {
                ports.clearJournal(ownerId, match.stateKey, deviceId);
                return { status: 400, payload: { ok: false, error: "invalid-hyper-v-snapshot-options", ownerId, backend: match.backend, deviceId } };
            }
            // Capture primary execution evidence before repair issues its own commands.
            const execution = (ports.lastExecution() ?? { mode: "exec", provider: "hyper-v", status: null });
            const reconciliation = await reconcileSnapshotJournal(ownerId, match.stateKey, deviceId, device, powershell);
            return {
                status: reconciliation.ok ? 502 : reconciliation.status,
                payload: {
                    ok: false,
                    error: reconciliation.ok ? "hyper-v-snapshot-provider-failed" : reconciliation.error,
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    execution: ports.redactExecution(
                        execution,
                        true,
                        ports.errorCode(error, "hyper-v-snapshot-provider-failed"),
                    ),
                    ...(!reconciliation.ok && reconciliation.detail ? { detail: reconciliation.detail } : {}),
                },
            };
        }
        if (parsed.tool === "device_snapshot_restore" && match.backend === "linux-vm") {
            // A production checkpoint restore leaves the VM off (no saved memory), and device_exec does not
            // auto-start devices. The restore command starts the VM; here we wait for the guest to be
            // SSH-ready so the restored device is immediately usable.
            const restoreDeviceRoot = snapshotField(device, "deviceRoot");
            const restorePrivateRoot = snapshotField(device, "privateRoot");
            const restoreSshPrivateKeyPath = snapshotField(device, "sshPrivateKeyPath");
            const restoreKnownHostsPath = snapshotField(device, "sshKnownHostsPath");
            const restoreGuestUsername = snapshotField(device, "guestUsername");
            const restoreNetworkAddress = snapshotField(device, "networkAddress");
            const restoreSsh = ports.executable("ssh.exe") || ports.executable("ssh");
            if (!restoreSsh || !restoreDeviceRoot || !restoreSshPrivateKeyPath || !restoreKnownHostsPath || !restoreGuestUsername || !restoreNetworkAddress) {
                return { status: 409, payload: { ok: false, error: "hyper-v-linux-guest-metadata-invalid", ownerId, backend: match.backend, deviceId } };
            }
            const restoreReadyDeadline = ports.now() + 120000;
            let restoreGuestReady = false;
            while (ports.now() < restoreReadyDeadline) {
                const restoreReadyExecution = await ports.sshReady(restoreSsh, {
                    deviceRoot: restoreDeviceRoot,
                    ...(restorePrivateRoot ? { privateRoot: restorePrivateRoot } : {}),
                    sshPrivateKeyPath: restoreSshPrivateKeyPath,
                    knownHostsPath: restoreKnownHostsPath,
                    guestUsername: restoreGuestUsername,
                    networkAddress: restoreNetworkAddress,
                });
                if (commandSucceeded(restoreReadyExecution) && String(restoreReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready")) {
                    restoreGuestReady = true;
                    break;
                }
                await ports.sleep(2000);
            }
            if (!restoreGuestReady) {
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-guest-provider-failed", ownerId, backend: match.backend, deviceId } };
            }
        }
        const now = ports.timestamp();
        const snapshot: SnapshotTracked = tracked || {
            id: observation.snapshotId.toLowerCase(),
            name: snapshotName,
            providerName: observation.snapshotName,
            ...(observation.snapshotType ? { snapshotType: observation.snapshotType } : {}),
            createdAt: now,
        };
        const replacement = snapshotActionReplacement(device, parsed.tool, match.backend, snapshots, snapshot, observation.state, now);
        const transition = ports.publish(ownerId, match.stateKey, deviceId, device, replacement);
        if (!transition.matched) {
            if (parsed.tool === "device_snapshot_create") {
                let rollbackObservation: SnapshotDeleteObservation | null = null;
                try {
                    rollbackObservation = await ports.delete(powershell, {
                        vmId,
                        providerName: expectedProviderName,
                        snapshotId: snapshot.id,
                    });
                } catch {
                    rollbackObservation = null;
                }
                const rollback = (ports.lastExecution() ?? { mode: "exec", provider: "hyper-v", status: null });
                const rollbackConfirmed = Boolean(rollbackObservation
                    && rollbackObservation.snapshotId.toLowerCase() === snapshot.id.toLowerCase()
                    && rollbackObservation.snapshotName === expectedProviderName);
                return hyperVSnapshotStateConflict(ownerId, String(match.backend), deviceId, transition, {
                    execution: ports.redactExecution(
                        rollback,
                        true,
                        "hyper-v-snapshot-rollback-failed",
                    ),
                    confirmed: rollbackConfirmed,
                    ...(!rollbackConfirmed ? { error: "hyper-v-snapshot-rollback-unconfirmed" } : {}),
                });
            }
            return hyperVSnapshotStateConflict(ownerId, String(match.backend), deviceId, transition);
        }
        ports.clearJournal(ownerId, match.stateKey, deviceId);
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    deviceId,
                    tool: parsed.tool,
                    provider: "hyper-v",
                    snapshot,
                    device: ports.redactDevice(transition.device),
                    // The last primitive the adapter issued for this tool call, kept so the success
                    // payload keeps reporting a provider execution exactly as it did before.
                    execution: ports.redactExecution(
                        (ports.lastExecution() ?? { mode: "exec", provider: "hyper-v", status: 0 }),
                        true,
                    ),
                    startsDevices: false,
                },
            },
        };

    }

    return { invoke, repair: (ownerId: string, target: SnapshotRepairTarget, retryRestoreSnapshotId?: string) => reconcileSnapshotJournal(ownerId, target.backend, target.deviceId, target.device, target.executable, retryRestoreSnapshotId) };
}
