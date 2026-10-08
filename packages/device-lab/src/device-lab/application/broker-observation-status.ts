import type { BrokerServicePorts, BrokerStatusPorts, ServiceQueryObservation } from "../ports/broker-observation.js";

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
