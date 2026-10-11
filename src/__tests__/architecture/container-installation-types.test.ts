import { createContainerToolInstallation } from "../../application/tooling/container-installation.js";
import type { BubblewrapSession, ContainerToolInstallationPorts } from "../../ports/tooling/container-installation.js";
import type * as Native from "../../container-setup.js";

function contracts(ports: ContainerToolInstallationPorts<symbol, symbol>, session: BubblewrapSession<symbol>, native: typeof Native) {
    const app = createContainerToolInstallation(ports);
    const claude: undefined = app.ensureClaude("target");
    const npm: undefined = app.ensureNpm("target", { name: "gemini" } as Parameters<typeof app.ensureNpm>[1]);
    const bubblewrap: undefined = app.ensureCodexBubblewrap("target");
    const uv: undefined = app.ensureUv("target");
    const publicClaude: void = native.ensureClaudeInContainer("target");
    const publicUv: void = native.ensureUvAvailable("target");
    // @ts-expect-error The target is required.
    app.ensureUv();
    // @ts-expect-error Application effects are synchronous.
    const pending: Promise<unknown> = app.ensureClaude("target");
    // @ts-expect-error The prepared native handle remains opaque.
    const script: string = ports.prepareClaudeProbe();
    // @ts-expect-error The historical native facade returns void.
    const strictPublic: undefined = native.ensureUvAvailable("target");
    // @ts-expect-error Required preparation capability cannot be absent.
    createContainerToolInstallation({ ...ports, prepareClaudeProbe: undefined });
    // @ts-expect-error Required confirmation capability cannot be absent.
    createContainerToolInstallation({ ...ports, confirmClaude: undefined });
    // @ts-expect-error Required failure rendering capability cannot be absent.
    createContainerToolInstallation({ ...ports, fail: undefined });
    // @ts-expect-error Required report capability cannot be absent.
    createContainerToolInstallation({ ...ports, report: undefined });
    // @ts-expect-error Native process receipts are not Claude observations.
    createContainerToolInstallation({ ...ports, probeClaude: () => ({ status: 0, stdout: "VALID", stderr: "" }) });
    // @ts-expect-error Native process receipts are not cache observations.
    createContainerToolInstallation({ ...ports, probeNpmCache: () => ({ status: 0, stdout: "READY", stderr: "" }) });
    // @ts-expect-error Native process receipts are not mutation outcomes.
    createContainerToolInstallation({ ...ports, installUv: () => ({ status: 0 }) });
    // @ts-expect-error Native process receipts are not dependency observations.
    const rawSession: BubblewrapSession<symbol> = { ...session, probe: () => ({ status: 42 }) };
    // @ts-expect-error Mutation effects must settle synchronously.
    createContainerToolInstallation({ ...ports, installClaude: async () => ({ kind: "succeeded" as const }) });
    // @ts-expect-error Observation effects must settle synchronously.
    createContainerToolInstallation({ ...ports, probeUv: async () => ({ kind: "available" as const }) });
    // @ts-expect-error Report effects must settle synchronously.
    createContainerToolInstallation({ ...ports, report: async () => undefined });
    // @ts-expect-error Failure capability terminates synchronously.
    createContainerToolInstallation({ ...ports, fail: async () => { throw new Error("refused"); } });
    // @ts-expect-error Session mutations must settle synchronously.
    const asyncSession: BubblewrapSession<symbol> = { ...session, install: async () => ({ kind: "succeeded" as const }) };
    void [claude, npm, bubblewrap, uv, publicClaude, publicUv, pending, script, strictPublic, rawSession, asyncSession];
}
void contracts;
import { expect, it } from "vitest";

it("completes an available uv check without scheduling installation", () => {
    const unused = (): never => { throw new Error("unexpected downstream effect"); };
    const ports: ContainerToolInstallationPorts<symbol, symbol> = {
        prepareClaudeProbe: unused, probeClaude: unused, confirmClaude: unused, installClaude: unused,
        getNpmTools: unused, probeNpmWrapper: unused, probeNpmCache: unused, cleanupNpmPackage: unused,
        cleanupNpmShim: unused, installNpm: unused, reshimNpm: unused, writeNpmWrapper: unused,
        createBubblewrapSession: unused, probeUv: () => ({ kind: "available" }), installUv: unused,
        report: unused, fail: unused,
    };
    expect(createContainerToolInstallation(ports).ensureUv("target")).toBeUndefined();
});
