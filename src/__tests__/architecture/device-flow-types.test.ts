import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations } from "./core-boundary.js";
import type { DeviceFlowPorts } from "../../../packages/device-lab/providers/ports/device-flow.mjs";
import type { FlowValue } from "../../../packages/device-lab/providers/domain/device-flow.mjs";

type Raw = { kind: "raw"; failed: boolean };
type Presented = { kind: "presented"; shown: string };
type Content = { kind: "native"; id: string };
type Reply = { content: Content[]; summary: FlowValue };
type Ports = DeviceFlowPorts<Raw, Presented, Content, Reply, { admitted: boolean }>;

function requiredSemanticPorts(ports: Ports, raw: Raw, presented: Presented) {
    const { withBrokerOperation: missingScope, ...incomplete } = ports; void missingScope;
    // @ts-expect-error A fresh scope effect is required; there is no ambient default.
    const missing: Ports = incomplete;
    const asynchronousValidation: Ports = { ...ports,
        // @ts-expect-error Validation stays synchronous and before dispatch.
        toolInputError: async () => null,
    };
    const wrongDispatch: Ports = { ...ports,
        // @ts-expect-error Dispatch produces raw provider results, not presentation.
        dispatchTool: async () => presented,
    };
    // @ts-expect-error Action rendering must receive raw observations.
    ports.actionResult("click", "device_click", presented, { detail: undefined });
    // @ts-expect-error Aggregate renderer accepts a flow outcome, not raw observations.
    ports.renderFlow(raw, { toolName: "device_run_flow", detail: false });
    // @ts-expect-error The scope callback yields the raw dispatch result.
    ports.withBrokerOperation(async () => presented);
    // @ts-expect-error Native content is not the raw provider envelope.
    ports.summarizeToolResult("device_click", raw, [raw]);
    void [missing, asynchronousValidation, wrongDispatch];
}
void requiredSemanticPorts;

describe("device-flow inward type and dependency contracts", () => {
    it("scans actual domain, ports and application without ambient authority", () => {
        const root = resolve("packages/device-lab/providers");
        for (const layer of ["domain", "ports", "application"]) {
            const file = resolve(root, layer, "device-flow.mjs");
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root, language: "mjs" })).toEqual([]);
        }
    });
    it("rejects hidden native defaults and facade dependencies", () => {
        const root = resolve("packages/device-lab/providers");
        const file = resolve(root, "application/device-flow.mjs");
        for (const mutation of ['process.env.HOME;', 'Date.now();', 'fetch("native");',
            'import "node:child_process";', 'import "../backends/android.mjs";']) {
            expect(coreBoundaryViolations(mutation, file, { root, language: "mjs" }).length).toBeGreaterThan(0);
        }
    });
});
