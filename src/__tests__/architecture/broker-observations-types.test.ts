import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokerServicePorts, LifecyclePreviewPorts, MetadataObservationPorts, ProviderPlanObservation } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { LifecyclePreviewRequest } from "@ccc/device-lab/device-lab/domain/broker-observation-command-plan.js";
import { coreBoundaryViolations } from "./core-boundary.js";

function requiredSynchronousContracts(metadata: MetadataObservationPorts,
    service: BrokerServicePorts<object, "status", { supported: boolean; definitionPath: string | null }, { ownerId: string } | null, object, { mode: string; provider: string }, object>,
    preview: LifecyclePreviewPorts<LifecyclePreviewRequest, object, unknown, unknown, ProviderPlanObservation, { ok: true; port: number } | { ok: false }>) {
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
        existingPlan: async () => ({ mode: "intent", provider: "native" }),
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
    it("rejects real clocks, native defaults, wire imports and dependency inversion", () => {
        const root = resolve("packages/device-lab/src/device-lab"); const file = resolve(root, "application/broker-observation-leases.ts");
        for (const mutation of ['Date.now();', 'process.env.HOME;', 'import {opendirSync} from "node:fs";', 'import "../../device-lab-broker.js";', 'import("node:child_process");']) {
            expect(coreBoundaryViolations(mutation, file, { root, language: "ts" }).length).toBeGreaterThan(0);
        }
    });
});
