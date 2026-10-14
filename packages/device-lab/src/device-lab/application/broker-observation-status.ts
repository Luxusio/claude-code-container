import type { DeviceStatusRequest, DeviceStatusOutcome, DeviceStatusRefusal, DeviceStatusFailureReason } from "../domain/broker-observation.js";
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


export function createBrokerDeviceStatus<Connection, Receipt>(ports: BrokerDeviceStatusPorts<Connection, Receipt>) {
    function failure(ownerId: string, request: DeviceStatusRequest, reason: DeviceStatusFailureReason, error: string, detail?: string): DeviceStatusRefusal<Connection> {
        return {kind: "refused", reason, error, ownerId, backend: request.backend, deviceId: request.deviceId, ...(detail ? {detail} : {})};
    }
    async function execute(ownerId: string, request: DeviceStatusRequest, params: unknown, deadline = Number.POSITIVE_INFINITY): Promise<DeviceStatusOutcome<Connection, Receipt>> {
        const preview = ports.preview(ownerId, request, params);
        if (preview.kind === "refused") return preview;
        const plan = preview.plan;
        const hyperV = deviceStatusHyperV(request.backend);
        if (request.dryRun) return {kind: "preview", plan};
        if (request.stateKey === "android-device" || request.stateKey === "ios-device") {
            if (!deviceStatusRecord(plan.device)) return failure(ownerId, request, "missing", "owner-device-not-found");
            const admission = ports.refreshPhysicalLease(ownerId, request, plan.device);
            if (admission.kind === "refused") return {
                ...failure(ownerId, request, "conflict", "physical-device-not-attached"),
                ...(admission.failure ? {leaseFailure: admission.failure} : {}),
            };
        }
        const availability = plan.availability;
        if (availability.kind !== "available") return {
            ...failure(ownerId, request, "invalid", availability.kind === "unavailable" ? availability.error : "missing-provider-command"),
            missing: availability.kind === "unavailable" ? availability.missing : [], plan,
        };
        const device = deviceStatusRecord(plan.device) ? plan.device : null;
        const text = (key: string): string => {
            const value = device?.[key];
            return typeof value === "string" ? value : "";
        };
        const execution = hyperV && device ? await ports.typedStatus(availability.connection, {
            ownerId, deviceId: request.deviceId, incarnationId: ports.incarnation(device) || "", vmId: text("vmId"), vmName: text("vmName"),
        }, deadline) : hyperV ? await ports.observeHyperVFallback(availability.connection, deadline) : ports.observe(availability.connection);
        if (hyperV && ports.deadlineExpired(deadline)) return failure(ownerId, request, "deadline", "hyper-v-operation-deadline-exceeded");
        let success = ports.succeeded(execution) || deviceStatusStoppedAndroid(request, plan.device, execution);
        const observation = hyperV && success ? ports.parseVm(execution.stdout || "") : null;
        if (success && hyperV) success = Boolean(observation && text("vmId") && observation.vmId === text("vmId").toLowerCase() && observation.vmName === text("vmName"));
        const projected = success ? projectDeviceStatus(ownerId, request, plan.device, execution, observation, ports.succeeded(execution), ports.timestamp) : plan.device;
        if (success) return {kind: "observed", plan, device: projected, execution};
        return {kind: "provider-failed", error: "provider-command-failed", plan, device: projected, execution,
            ...(hyperV ? {diagnostic: ports.diagnosticCode(execution, "hyper-v-provider-command-failed") || "hyper-v-provider-command-failed"} : {}),
        };
    }
    async function recover(ownerId: string, request: DeviceStatusRequest, deadline: number): Promise<DeviceStatusRefusal<Connection> | null> {
        ports.assertDeadline(deadline);
        const operation = await ports.reconcileOperation(ownerId, request.backend, request.deviceId, deadline, true);
        if (!operation.ok) return failure(ownerId, request, operation.reason, operation.error, operation.detail);
        let snapshot: {operationId: string} | null;
        try { snapshot = ports.readSnapshotJournal(ownerId, request.backend, request.deviceId); }
        catch (error) { return failure(ownerId, request, "conflict", "hyper-v-snapshot-journal-invalid", ports.errorCode(error, "hyper-v-snapshot-journal-invalid")); }
        if (snapshot) {
            const current = ports.readDevices(ownerId, request.stateKey).find(candidate => deviceStatusRecord(candidate) && candidate.id === request.deviceId);
            if (!deviceStatusRecord(current)) return failure(ownerId, request, "conflict", "hyper-v-snapshot-reconciliation-metadata-invalid");
            const connection = ports.recoveryConnection();
            if (!connection) return {kind: "refused", reason: "invalid", error: "missing-provider-command", missing: ["powershell"], backend: request.backend, deviceId: request.deviceId};
            const repaired = await ports.repairSnapshots(ownerId, request.backend, request.deviceId, current, connection);
            if (!repaired.ok) return failure(ownerId, request, repaired.reason, repaired.error, repaired.detail);
        }
        return null;
    }
    async function invoke(ownerId: string, request: DeviceStatusRequest, params: unknown, deadline = Number.POSITIVE_INFINITY): Promise<DeviceStatusOutcome<Connection, Receipt>> {
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
            return failure(ownerId, request, "conflict", "hyper-v-host-operation-lock-failed", ports.errorCode(error, "hyper-v-host-operation-lock-failed"));
        }
    }
    return {execute, invoke};
}
