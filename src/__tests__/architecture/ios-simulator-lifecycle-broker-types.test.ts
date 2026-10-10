import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBrokerIosSimulatorLifecycle } from "../../../packages/device-lab/src/device-lab/application/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerIosLifecycleInput, BrokerIosLifecycleRequest, BrokerIosLifecycleResponse, BrokerIosPublication, BrokerIosPublicationChange, BrokerIosProviderResult } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerIosSimulatorLifecyclePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/ios-simulator-lifecycle.js";
import { coreBoundaryViolations } from "./core-boundary.js";

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
const allNativeLeavesRequired: [OptionalKeys<BrokerIosSimulatorLifecyclePorts>] extends [never] ? true : false = true;
void allNativeLeavesRequired;

// Compiled by the explicit skipLibCheck=false architecture/source/emission
// consumers. None of these declarations execute a fixture or native effect.
function strictContracts(ports: BrokerIosSimulatorLifecyclePorts, input: BrokerIosLifecycleInput): void {
    const lifecycle = createBrokerIosSimulatorLifecycle(ports);
    const outcomes: Promise<BrokerIosLifecycleResponse>[] = [lifecycle.create(input), lifecycle.start(input), lifecycle.stop(input), lifecycle.delete(input)];
    const mutable: Record<string, unknown> = lifecycle.createRecord(input.ownerId, input.parsed);
    mutable.raw = { arbitraryMutableNativeField: true };
    const { execute, ...missingExecution } = ports; void execute;
    // @ts-expect-error synchronous actual native execution is a required leaf
    createBrokerIosSimulatorLifecycle(missingExecution);
    // @ts-expect-error native command observation must not return a Promise
    const asyncExecution: BrokerIosSimulatorLifecyclePorts = { ...ports, execute: async () => ({ mode: "exec", provider: "xcrun", status: 0 }) };
    // @ts-expect-error committed auxiliary cleanup carries result, device and committed
    const weakCleanup: BrokerIosSimulatorLifecyclePorts = { ...ports, cleanupAuxiliary: () => ({ committed: true }) };
    // @ts-expect-error CAS publication preserves both matched and found
    const weakPublication: BrokerIosSimulatorLifecyclePorts = { ...ports, publish: () => ({ matched: true, device: null }) };
    // @ts-expect-error complete-record CAS is synchronously observed
    const asyncPublication: BrokerIosSimulatorLifecyclePorts = { ...ports, publish: async () => ({ matched: true, found: true, device: null }) };
    // @ts-expect-error native identity verification is synchronous
    const asyncIdentity: BrokerIosSimulatorLifecyclePorts = { ...ports, verifyOwnedTarget: async () => ({ ok: true, target: "udid" }) };
    // @ts-expect-error raw typed helper observes UDID synchronously
    const asyncUdid: BrokerIosSimulatorLifecyclePorts = { ...ports, createdUdid: async () => "udid" };
    // @ts-expect-error native timestamp remains synchronous, not a policy default
    const asyncTimestamp: BrokerIosSimulatorLifecyclePorts = { ...ports, timestamp: async () => "fixed" };
    const { timestamp, ...missingTimestamp } = ports; void timestamp;
    // @ts-expect-error the publication/record native clock is required
    createBrokerIosSimulatorLifecycle(missingTimestamp);
    // @ts-expect-error publication uses a finite semantic change, no arbitrary updater
    const arbitraryReplacement: BrokerIosPublicationChange = { kind: "start", replace: () => null };
    // @ts-expect-error native claim/execution request always carries owner-independent force/dryRun
    const weakRequest: BrokerIosLifecycleRequest = { ok: true, backend: "ios-simulator", stateKey: "ios", command: "device_start", deviceId: "fixture" };
    const nativeResult: BrokerIosProviderResult = { mode: "exec", provider: "xcrun", status: null, stdout: "raw", stderr: "raw", error: "raw" };
    const publication: BrokerIosPublication = { found: true, matched: true, device: mutable };
    void outcomes; void asyncExecution; void weakCleanup; void weakPublication; void asyncPublication;
    void asyncIdentity; void asyncUdid; void asyncTimestamp; void arbitraryReplacement; void weakRequest; void nativeResult; void publication;
}
void strictContracts;

describe("iOS broker source declaration and inward dependency contracts", () => {
    it("keeps all native leaves required and every concrete source in its admitted layer", () => {
        const root = fileURLToPath(new URL("../../../packages/device-lab/src/device-lab/", import.meta.url));
        for (const layer of ["application", "domain", "ports"] as const) {
            const file = fileURLToPath(new URL(`../../../packages/device-lab/src/device-lab/${layer}/lifecycle/ios-simulator-lifecycle.ts`, import.meta.url));
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root, language: "ts" })).toEqual([]);
        }
        expect(allNativeLeavesRequired).toBe(true);
    });
});
