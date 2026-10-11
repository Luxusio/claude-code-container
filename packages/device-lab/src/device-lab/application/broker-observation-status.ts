import type { DeviceStatusRequest, DeviceStatusResponse } from "../domain/broker-observation.js";
import { deviceStatusHyperV, deviceStatusRecord, deviceStatusStoppedAndroid, projectDeviceStatus } from "../domain/broker-observation.js";
import type { BrokerDeviceStatusPorts, BrokerServicePorts, BrokerStatusPorts, ServiceQueryObservation } from "../ports/broker-observation.js";

export function createBrokerStatus<Context, Service, Owner extends { ownerId: string } | null, Address, Paths, Persistence, ServiceFacts, Elevation>(
    ports: BrokerStatusPorts<Context, Service, Owner, Address, Paths, Persistence, ServiceFacts, Elevation>,
) {
    return function observe(ownerId: string, context: Context) {
        const root = ports.root();
        const service = ports.service(context);
        const serviceOwner = ports.serviceOwner();
        const runtimeFile = ports.runtimeFile();
        const runtime = ports.runtime();
        const address = ports.address(context);
        const hostId = ports.hostId();
        const currentProcess = { pid: ports.pid(), startToken: ports.startToken() };
        const startedAt = ports.startedAt(context);
        const paths = ports.paths(root, ownerId);
        const rootExists = ports.exists(root);
        const runtimeFacts = { file: runtimeFile, present: runtime !== null, metadata: runtime };
        const deviceStateMounted = ports.exists(root);
        const persistence = ports.persistence(ownerId);
        const serviceFacts = ports.serviceFacts(service);
        const ownedByCurrentOwner = serviceOwner?.ownerId === ownerId;
        const elevation = ports.elevation();
        return { root, address, ownerId, hostId, currentProcess, startedAt, paths, runtimeFile, rootExists, runtimeFacts,
            deviceStateMounted, persistence, serviceFacts, serviceOwner, ownedByCurrentOwner, elevation };
    };
}

export function createBrokerService<Context, Action extends string, Plan extends { supported: boolean; definitionPath: string | null }, Owner extends { ownerId: string } | null, Command, Result extends ServiceQueryObservation, Projection>(
    ports: BrokerServicePorts<Context, Action, Plan, Owner, Command, Result, Projection>, actions: ReadonlySet<string>,
) {
    return function observe(ownerId: string, action: string, context: Context) {
        const requested = actions.has(action as Action) ? action as Action : null;
        if (!requested) return { kind: "invalid-action" as const, action, allowed: [...actions] };
        const plan = ports.plan(context);
        const commands = ports.commands(requested, plan, context);
        const dryRun = ports.dryRun(context);
        const serviceOwner = ports.owner();
        const ownedByCurrentOwner = serviceOwner?.ownerId === ownerId;
        const installedBefore = plan.definitionPath ? ports.installed(plan) : serviceOwner ? true : null;
        if (!plan.supported) return { kind: "unsupported" as const, value: {
            ownerId, action: requested, dryRun, service: ports.projection(plan, commands), serviceOwner, ownedByCurrentOwner,
            installed: installedBefore, running: null, results: [], changed: false, diagnostics: ports.diagnostics(plan),
        } };
        if (dryRun) return { kind: "dry-run" as const, value: {
            ownerId, action: requested, dryRun, service: ports.projection(plan, commands), serviceOwner, ownedByCurrentOwner,
            installed: installedBefore, running: null, results: [], changed: false, diagnostics: ports.diagnostics(plan),
        } };
        const results = commands.map(command => ports.query(context, command));
        const running = results.length > 0 ? ports.succeeded(results[0]) : null;
        return { kind: "observed" as const, value: {
            ownerId, action: requested, dryRun, service: ports.projection(plan, commands), serviceOwner, ownedByCurrentOwner,
            installed: installedBefore, installedBefore, running, results, changed: false, diagnostics: ports.diagnostics(plan),
        } };
    };
}


export function createBrokerDeviceStatus(ports: BrokerDeviceStatusPorts) {
    function failure(ownerId: string, request: DeviceStatusRequest, status: number, error: string, detail?: string): DeviceStatusResponse {
        return { status, payload: { ok: false, error, ownerId, backend: request.backend, deviceId: request.deviceId, ...(detail ? { detail } : {}) } };
    }
    async function execute(ownerId: string, request: DeviceStatusRequest, params: unknown, deadline = Number.POSITIVE_INFINITY): Promise<DeviceStatusResponse> {
        const preview = ports.preview(ownerId, request, params);
        if (!preview.ok) return preview.response;
        const plan = preview.plan;
        const hyperV = deviceStatusHyperV(request.backend);
        if (request.dryRun) return { status: 200, payload: { ok: true, result: {
            ...(hyperV ? ports.redactPlan(plan) : plan), invoked: false, dryRun: true,
            execution: { mode: "dry-run", providerExecution: "available", mutatesHost: false },
        } } };
        if (request.stateKey === "android-device" || request.stateKey === "ios-device") {
            if (!deviceStatusRecord(plan.device)) return failure(ownerId, request, 404, "owner-device-not-found");
            const refusal = ports.refreshPhysicalLease(ownerId, request, plan.device);
            if (refusal) return refusal;
        }
        const command = plan.providerCommand;
        if (!command || "error" in command) return { status: 400, payload: {
            ok: false, error: command?.error || "missing-provider-command", missing: command?.missing || [],
            plan: hyperV ? ports.redactPlan(plan) : { ...plan, device: ports.redactDevice(plan.device, false) },
        } };
        const device = deviceStatusRecord(plan.device) ? plan.device : null;
        const text = (key: string): string => {
            const value = device?.[key];
            return typeof value === "string" ? value : "";
        };
        const execution = hyperV && device ? await ports.typedStatus({
            executable: command.executable || "powershell.exe", ownerId, deviceId: request.deviceId,
            incarnationId: ports.incarnation(device) || "", vmId: text("vmId"), vmName: text("vmName"),
        }, deadline) : hyperV ? await ports.executeHyperV(command, deadline) : ports.execute(command);
        if (hyperV && ports.deadlineExpired(deadline)) return failure(ownerId, request, 504, "hyper-v-operation-deadline-exceeded");
        let success = ports.succeeded(execution) || deviceStatusStoppedAndroid(request, plan.device, execution);
        const observation = hyperV && success ? ports.parseVm(execution.stdout || "") : null;
        if (success && hyperV) success = Boolean(observation && text("vmId") && observation.vmId === text("vmId").toLowerCase() && observation.vmName === text("vmName"));
        const projected = success ? projectDeviceStatus(ownerId, request, plan.device, execution, observation, ports.succeeded(execution), ports.timestamp) : plan.device;
        return { status: success ? 200 : 502, payload: {
            ok: success,
            ...(success ? {} : { error: "provider-command-failed", detail: hyperV
                ? ports.diagnosticCode(execution, "hyper-v-provider-command-failed") || "hyper-v-provider-command-failed"
                : ports.failureDetail(execution) }),
            result: {
                ...(hyperV ? ports.redactPlan(plan) : plan),
                providerCommand: hyperV ? { mode: command.mode, provider: command.provider } : command,
                device: ports.redactDevice(projected, hyperV), invoked: true, dryRun: false,
                execution: { mode: execution.mode, providerExecution: "executed", mutatesHost: false,
                    command: hyperV ? ports.redactExecution(execution, success ? undefined : "hyper-v-provider-command-failed") : execution },
            },
        } };
    }
    async function recover(ownerId: string, request: DeviceStatusRequest, deadline: number): Promise<DeviceStatusResponse | null> {
        ports.assertDeadline(deadline);
        // Snapshot recovery requires incarnation admission. Operation-only compensation retains its accepted admission.
        if (ports.snapshotPending(ownerId, request.backend, request.deviceId)) {
            let expected: string | null;
            try {
                const current = ports.readDevices(ownerId, request.stateKey).find(candidate => deviceStatusRecord(candidate) && candidate.id === request.deviceId);
                expected = deviceStatusRecord(current) ? ports.incarnation(current) : null;
                if (!expected) expected = ports.readOperationJournal(ownerId, request.backend, request.deviceId)?.incarnationId || null;
            } catch (error) {
                if (ports.stateErrorCode(error)) return ports.stateFailure(error, request);
                return failure(ownerId, request, 409, "hyper-v-operation-journal-invalid", ports.errorCode(error, "hyper-v-operation-journal-invalid"));
            }
            if (expected) {
                if (!ports.validIncarnation(request.expectedIncarnationId)) return failure(ownerId, request, 409, "hyper-v-incarnation-required");
                if (request.expectedIncarnationId !== expected) return failure(ownerId, request, 409, "hyper-v-incarnation-conflict");
            }
        }
        const operation = await ports.reconcileOperation(ownerId, request.backend, request.deviceId, deadline, true);
        if (!operation.ok) return failure(ownerId, request, operation.status, operation.error, operation.detail);
        let snapshot: { operationId: string } | null;
        try { snapshot = ports.readSnapshotJournal(ownerId, request.backend, request.deviceId); }
        catch (error) { return failure(ownerId, request, 409, "hyper-v-snapshot-journal-invalid", ports.errorCode(error, "hyper-v-snapshot-journal-invalid")); }
        if (snapshot) {
            const current = ports.readDevices(ownerId, request.stateKey).find(candidate => deviceStatusRecord(candidate) && candidate.id === request.deviceId);
            if (!deviceStatusRecord(current)) return failure(ownerId, request, 409, "hyper-v-snapshot-reconciliation-metadata-invalid");
            const executable = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
            if (!executable) return { status: 400, payload: { ok: false, error: "missing-provider-command", missing: ["powershell"], backend: request.backend, deviceId: request.deviceId } };
            const repaired = await ports.repairSnapshots(ownerId, request.backend, request.deviceId, current, executable);
            if (!repaired.ok) return failure(ownerId, request, repaired.status, repaired.error, repaired.detail);
        }
        return null;
    }
    async function invoke(ownerId: string, request: DeviceStatusRequest, params: unknown, deadline = Number.POSITIVE_INFINITY): Promise<DeviceStatusResponse> {
        const pending = deviceStatusHyperV(request.backend) && !request.dryRun
            && (ports.operationPending(ownerId, request.backend, request.deviceId) || ports.snapshotPending(ownerId, request.backend, request.deviceId));
        if (!pending) return execute(ownerId, request, params, deadline);
        try {
            return await ports.withHostLock(deadline, async () => {
                const refusal = await recover(ownerId, request, deadline);
                return refusal || execute(ownerId, request, params, deadline);
            });
        } catch (error) {
            if (!ports.lockTimedOut(error)) throw error;
            return failure(ownerId, request, 409, "hyper-v-host-operation-lock-failed", ports.errorCode(error, "hyper-v-host-operation-lock-failed"));
        }
    }
    return { execute, invoke };
}
