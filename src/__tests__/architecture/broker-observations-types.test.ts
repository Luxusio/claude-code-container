import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokerServicePorts, LifecyclePreviewPorts, MetadataObservationPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { LifecyclePreviewRequest } from "@ccc/device-lab/device-lab/domain/broker-observation-command-plan.js";
import { coreBoundaryViolations } from "./core-boundary.js";
import { createBrokerDeviceStatus } from "@ccc/device-lab/device-lab/application/broker-observation-status.js";
import type { BrokerDeviceStatusPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { DeviceStatusRequest, DeviceStatusOutcome } from "@ccc/device-lab/device-lab/domain/broker-observation.js";

function consumedDeviceStatus<Connection, Receipt>(ports: BrokerDeviceStatusPorts<Connection, Receipt>, request: DeviceStatusRequest): void {
    const result: Promise<DeviceStatusOutcome<Connection, Receipt>> = createBrokerDeviceStatus(ports).invoke("owner", request, {}, 1000);
    const { typedStatus, ...withoutTypedObservation } = ports;
    // @ts-expect-error Exact typed VM observation is required for status.
    createBrokerDeviceStatus(withoutTypedObservation);
    // @ts-expect-error Non-Hyper-V command execution must return a settled result.
    createBrokerDeviceStatus({ ...ports, observe: async connection => ports.observe(connection) });
    // @ts-expect-error Deadline admission must complete before recovery effects.
    createBrokerDeviceStatus({ ...ports, assertDeadline: async () => undefined });
    // @ts-expect-error Device status does not expose a CCC HTTP response envelope.
    const payload = (outcome: DeviceStatusOutcome<Connection, Receipt>) => outcome.payload;
    // @ts-expect-error Captured status connections have no arbitrary native runner in the core.
    ports.execute({ executable: "provider", args: [] });
    void [result, typedStatus, payload];
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

describe("broker observation inward contracts", () => {
    it("scans actual domain, ports and every observation application with the existing guard", () => {
        const root = resolve("packages/device-lab/src/device-lab");
        for (const name of ["domain/broker-observation", "domain/broker-observation-command-plan", "ports/broker-observation", "application/broker-observation-inventory", "application/broker-observation-leases", "application/broker-observation-appium", "application/broker-observation-status", "application/broker-observation-command-plan"]) {
            const file = resolve(root, name + ".ts"); expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root, language: "ts" })).toEqual([]);
        }
    });
});
