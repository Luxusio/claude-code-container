import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsSandboxCreate } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-create.mjs";
import type { WindowsSandboxCreatePorts } from "../../../packages/device-lab/providers/ports/lifecycle/windows-sandbox-create.mjs";
import { createBrokerWindowsSandboxCreate } from "../../../packages/device-lab/src/device-lab/application/lifecycle/windows-sandbox-create.js";
import type { BrokerWindowsSandboxCreatePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/windows-sandbox-create.js";

function contracts(direct: WindowsSandboxCreatePorts<{ scratch: string }>, broker: BrokerWindowsSandboxCreatePorts<{ name: string }, { id: string; createdAt: string }, { ok: boolean; receipt: "native" }>) {
    const sync = createWindowsSandboxCreate(direct).create({ backend: "windows-sandbox" });
    if (sync.kind === "created") { const scratch: string = sync.device.helper.scratch; const stopped: "stopped" = sync.device.status; void [scratch, stopped]; }
    // @ts-expect-error Direct create is synchronous.
    const promise: Promise<unknown> = sync;
    // @ts-expect-error Semantic ports are required.
    createWindowsSandboxCreate({ readDefinitions: () => [] });
    // @ts-expect-error Definitions read must be synchronous.
    createWindowsSandboxCreate({ ...direct, readDefinitions: async () => [] });
    // @ts-expect-error Owner read must be synchronous.
    createWindowsSandboxCreate({ ...direct, readOwnerId: async () => "owner" });
    // @ts-expect-error Derived IDs are synchronous strings.
    createWindowsSandboxCreate({ ...direct, deriveDeviceId: async () => "id" });
    // @ts-expect-error Helper metadata cannot be a thenable.
    createWindowsSandboxCreate({ ...direct, ensureHelperWorkspace: async () => ({ scratch: "private" }) });
    // @ts-expect-error Claim must be synchronous.
    createWindowsSandboxCreate({ ...direct, claimDefinition: async () => ({ ok: true as const }) });
    const asyncResult = createBrokerWindowsSandboxCreate(broker).create({ name: "Sandbox" });
    const requiredPromise: Promise<unknown> = asyncResult; void requiredPromise;
    asyncResult.then(result => { if (result.kind === "claim-exception" || result.kind === "claim-conflict") { const receipt: "native" = result.rollback.receipt; void receipt; } });
    // @ts-expect-error Parsed input retains the consumer's type.
    createBrokerWindowsSandboxCreate(broker).create({ name: 7 });
    // @ts-expect-error Broker create is asynchronous.
    const synchronous: { kind: string } = asyncResult;
    // @ts-expect-error Rollback is asynchronous evidence.
    createBrokerWindowsSandboxCreate({ ...broker, rollbackAfterClaimFailure: () => ({ ok: true, receipt: "native" as const }) });
    // @ts-expect-error Native record construction must return a typed record.
    createBrokerWindowsSandboxCreate({ ...broker, createRecord: (): unknown => ({}) });
    // @ts-expect-error No ambient port defaults.
    createBrokerWindowsSandboxCreate();
    // @ts-expect-error Native config publication is synchronous.
    createBrokerWindowsSandboxCreate({ ...broker, publishConfig: async () => "/config" });
    // @ts-expect-error Native compensation mutation is synchronous.
    createBrokerWindowsSandboxCreate({ ...broker, removeMatchingClaim: async () => [] });
    void [promise, synchronous];
}
describe("Sandbox create static public contracts", () => {
    it("makes the positive and negative strict type consumer reachable to architecture typecheck", () => { expect(contracts).toBeTypeOf("function"); });
    it("recursively keeps both inward module families free of native and ambient dependencies", () => {
        const root = fileURLToPath(new URL("../../../", import.meta.url)); const visited = new Set<string>();
        function inspect(path: string) {
            if (visited.has(path)) return; visited.add(path); const source = readFileSync(path, "utf8");
            expect(source, path).not.toMatch(/\b(?:process|globalThis|require|fetch|Date|Buffer)\b|node:|child_process|\b(?:readFileSync|writeFileSync|mkdirSync)\b/);
            for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)) {
                expect(match[1], path).toMatch(/^\.\.?\//); let target = resolve(dirname(path), match[1]); if (target.endsWith(".js")) target = target.slice(0, -3) + ".ts"; inspect(target);
            }
        }
        for (const extension of ["mjs", "ts"]) for (const layer of ["domain", "ports", "application"]) inspect(resolve(root, extension === "mjs" ? `packages/device-lab/providers/${layer}/lifecycle/windows-sandbox-create.mjs` : `packages/device-lab/src/device-lab/${layer}/lifecycle/windows-sandbox-create.ts`));
        expect(visited.size).toBe(6);
    });
});
