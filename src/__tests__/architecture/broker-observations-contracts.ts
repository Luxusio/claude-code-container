import type { BrokerServicePorts, LifecyclePreviewPorts, MetadataObservationPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { LifecyclePreviewRequest } from "@ccc/device-lab/device-lab/domain/broker-observation-command-plan.js";
import { createBrokerDeviceStatus } from "@ccc/device-lab/device-lab/application/broker-observation-status.js";
import type { BrokerDeviceStatusPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { DeviceStatusExecution, DeviceStatusRequest, DeviceStatusOutcome } from "@ccc/device-lab/device-lab/domain/broker-observation.js";

function consumedDeviceStatus<Connection, Receipt>(ports: BrokerDeviceStatusPorts<Connection, Receipt>, request: DeviceStatusRequest): void {
    const result: Promise<DeviceStatusOutcome<Connection, Receipt>> = createBrokerDeviceStatus(ports).invoke("owner", request, {}, 1000);
    const { typedStatus, ...withoutTypedObservation } = ports;
    // @ts-expect-error Exact typed VM observation is required for status.
    createBrokerDeviceStatus(withoutTypedObservation);
    const asyncObservation: BrokerDeviceStatusPorts<Connection, Receipt> = { ...ports, observe: async connection => await ports.observe(connection) };
    const thenableObservation: BrokerDeviceStatusPorts<Connection, Receipt> = { ...ports, observe: connection => {
        const pending: PromiseLike<DeviceStatusExecution<Receipt>> = Promise.resolve(ports.observe(connection));
        return pending;
    } };
    // @ts-expect-error A settled asynchronous status observation still needs command success and its receipt.
    createBrokerDeviceStatus({ ...ports, observe: async () => ({ mode: "exec", provider: "adb", adbState: null, vm: null }) });
    // @ts-expect-error Deadline admission must complete before recovery effects.
    createBrokerDeviceStatus({ ...ports, assertDeadline: async () => undefined });
    // @ts-expect-error Device status does not expose a CCC HTTP response envelope.
    const payload = (outcome: DeviceStatusOutcome<Connection, Receipt>) => outcome.payload;
    // @ts-expect-error Captured status connections have no arbitrary native runner in the core.
    ports.execute({ executable: "provider", args: [] });
    void [result, typedStatus, payload, asyncObservation, thenableObservation];
}
void consumedDeviceStatus;

function requiredSynchronousContracts(metadata: MetadataObservationPorts,
    service: BrokerServicePorts<object, "status", { supported: boolean; definitionPath: string | null }, { ownerId: string } | null, object, { mode: string; provider: string }, object>,
    preview: LifecyclePreviewPorts<LifecyclePreviewRequest, object, { readonly key: symbol }, { ok: true; port: number } | { ok: false }>) {
    const metadataCopy: MetadataObservationPorts = { ...metadata,
        // @ts-expect-error A metadata query cannot return an asynchronous observation.
        read: async () => [],
    };
    const serviceCopy: typeof service = { ...service,
        // @ts-expect-error A status query must be synchronous and have required result facts.
        query: async () => ({ mode: "observed", provider: "service" }),
    };
    const previewCopy: typeof preview = { ...preview,
        // @ts-expect-error Native provider intent evidence cannot be a Promise.
        existingPlan: async () => ({ key: Symbol("native") }),
    };
    const { read: omitted, ...incomplete } = metadata; void omitted;
    // @ts-expect-error There is no default owner state reader.
    const missing: MetadataObservationPorts = incomplete;
    // @ts-expect-error There is no arbitrary native process executor in preview.
    preview.run({ executable: "provider", args: [] });
    void [metadataCopy, serviceCopy, previewCopy, missing];
}
void requiredSynchronousContracts;
