import type { AndroidPreviewAllocation, LifecyclePreviewRequest } from "../domain/broker-observation-command-plan.js";
import type { AndroidPreviewPortAllocationPorts, LifecyclePreviewPorts } from "../ports/broker-observation.js";

export function createAndroidPreviewPortAllocation<Parsed extends LifecyclePreviewRequest>(
    ports: AndroidPreviewPortAllocationPorts<Parsed>, minimum: number, maximum: number,
) {
    return function allocate(ownerId: string, parsed: Parsed, additionalUsedPorts: Iterable<number>): AndroidPreviewAllocation {
        const requested = parsed.create?.port;
        if (requested !== undefined && !ports.valid(requested)) return { kind: "invalid" };
        let used: Set<number>;
        try { used = ports.allocated(); }
        catch (error) { return { kind: "inventory-failed", detail: ports.inventoryError(error) }; }
        for (const port of additionalUsedPorts) if (ports.valid(port)) used.add(port);
        if (requested !== undefined) return used.has(requested as number) ? { kind: "conflict", port: requested as number } : { kind: "allocated", port: requested as number };
        const slotCount = ((maximum - minimum) / 2) + 1;
        const initialSlot = ports.seed(ownerId, parsed) % slotCount;
        for (let offset = 0; offset < slotCount; offset += 1) {
            const port = minimum + (((initialSlot + offset) % slotCount) * 2);
            if (!used.has(port)) return { kind: "allocated", port };
        }
        return { kind: "exhausted" };
    };
}

export function createLifecyclePreview<Parsed extends LifecyclePreviewRequest, Context, ProviderPlan, Allocation extends { ok: true; port: number } | { ok: false }>(
    ports: LifecyclePreviewPorts<Parsed, Context, ProviderPlan, Allocation>,
) {
    return function plan(ownerId: string, parsed: Parsed, context: Context | undefined) {
        let devices: unknown[];
        try { devices = ports.read(ownerId, parsed); }
        catch (error) { return { kind: "state-failed" as const, error }; }
        const device = devices.find(candidate => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        if (device && ports.hyperV(parsed) && parsed.command !== "device_create" && parsed.command !== "device_status") {
            if (!ports.validIncarnation(parsed)) return { kind: "incarnation-required" as const };
            const currentIncarnationId = device && typeof device === "object" && !Array.isArray(device) ? ports.incarnation(device as Record<string, unknown>) : null;
            if (currentIncarnationId !== parsed.expectedIncarnationId) return { kind: "incarnation-conflict" as const };
        }
        if (parsed.command === "device_create") {
            if (device) {
                if (ports.hyperV(parsed)) {
                    const record = device as Record<string, unknown>;
                    const conflicts = ports.conflicts(record, parsed);
                    if (conflicts.length === 0) return { kind: "equivalent-create" as const, value: {
                        ownerId, backend: parsed.backend, stateKey: parsed.stateKey, command: parsed.command, deviceId: parsed.deviceId,
                        device: record,
                    } };
                    return { kind: "configuration-conflict" as const, conflicts };
                }
                return { kind: "already-exists" as const };
            }
            let effectiveParsed = parsed;
            if (parsed.backend === "android-emulator") {
                const allocation = ports.androidPort(ownerId, parsed);
                if (!allocation.ok) return { kind: "allocation-failed" as const, evidence: allocation as Extract<Allocation, { ok: false }> };
                effectiveParsed = { ...parsed, create: { ...(parsed.create || {}), port: allocation.port } };
            }
            let plannedDevice: unknown;
            try {
                plannedDevice = ports.createDefinition(ownerId, effectiveParsed);
                ports.assertWritable(() => [...devices, plannedDevice]);
            } catch (error) { return { kind: "state-failed" as const, error }; }
            return { kind: "create" as const, value: {
                ownerId, backend: parsed.backend, stateKey: parsed.stateKey, command: parsed.command, deviceId: parsed.deviceId,
                force: parsed.force, dryRun: parsed.dryRun,
                device: plannedDevice,
                create: effectiveParsed.create,
                providerPlan: context ? ports.createPlan(ownerId, effectiveParsed, context) : null,
                providerAvailable: Boolean(context),
            } };
        }
        if (!device) {
            if (ports.hyperV(parsed) && parsed.command === "device_delete") return { kind: "missing-delete" as const, value: {
                ownerId, backend: parsed.backend, stateKey: parsed.stateKey, command: parsed.command, deviceId: parsed.deviceId,
            } };
            return { kind: "not-found" as const };
        }
        if ((parsed.stateKey === "android-device" || parsed.stateKey === "ios-device") && parsed.command === "device_start") {
            const record = device as Record<string, unknown>;
            const matches = ports.attachmentMatches(ownerId, parsed, record);
            if (record.status !== "attached" || !matches) return { kind: "not-attached" as const };
        }
        return { kind: "existing" as const, value: {
            ownerId, backend: parsed.backend, stateKey: parsed.stateKey, command: parsed.command, deviceId: parsed.deviceId,
            force: parsed.force, dryRun: parsed.dryRun,
            device,
            providerPlan: context ? ports.existingPlan(ownerId, parsed, device, context) : null,
            providerAvailable: Boolean(context),
        } };
    };
}
