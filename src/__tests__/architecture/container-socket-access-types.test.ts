import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { createContainerSocketAccess } from "../../application/container-socket-access.js";
import type { ContainerSocketAccessPorts, ContainerSocketAccessProbe } from "../../ports/container-socket-access.js";

// Negative contracts are compiled but never invoked.
function compileContracts(ports: ContainerSocketAccessPorts, native: SpawnSyncReturns<string>) {
    const app = createContainerSocketAccess(ports);
    const ran: undefined = app.run("target");
    const reset: undefined = app.resetWarning();
    const warned: undefined = ports.warn();
    const observation: ContainerSocketAccessProbe = ports.probe("target");
    const granted: boolean = ports.grant("target", "ccc", "0").ok;
    if (observation.kind === "requires-group") {
        const user: string = observation.user;
        const gid: string = observation.gid;
        void [user, gid];
    }
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "usable" }) });
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "requires-group", user: "ccc", gid: "00042" }) });
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "unavailable" }) });
    createContainerSocketAccess({ ...ports, grant: () => ({ ok: false }) });
    void [ran, reset, warned, observation, granted];

    // @ts-expect-error All ports are required.
    createContainerSocketAccess();
    // @ts-expect-error Undefined cannot supply ports.
    createContainerSocketAccess(undefined);
    // @ts-expect-error Probe is required.
    createContainerSocketAccess({ grant: ports.grant, warn: ports.warn });
    // @ts-expect-error Grant is required.
    createContainerSocketAccess({ probe: ports.probe, warn: ports.warn });
    // @ts-expect-error Warn is required.
    createContainerSocketAccess({ probe: ports.probe, grant: ports.grant });
    // @ts-expect-error Probe must be callable.
    createContainerSocketAccess({ ...ports, probe: {} });
    // @ts-expect-error Grant must be callable.
    createContainerSocketAccess({ ...ports, grant: false });
    // @ts-expect-error Warn must be callable.
    createContainerSocketAccess({ ...ports, warn: undefined });
    // @ts-expect-error Probe must be synchronous.
    createContainerSocketAccess({ ...ports, probe: async () => ({ kind: "usable" }) });
    // @ts-expect-error Grant must be synchronous.
    createContainerSocketAccess({ ...ports, grant: async () => ({ ok: true }) });
    // @ts-expect-error Warn must be synchronous.
    createContainerSocketAccess({ ...ports, warn: async () => undefined });
    // @ts-expect-error Void does not prove synchronous completion.
    createContainerSocketAccess({ ...ports, warn: (): void => {} });
    // @ts-expect-error Warning effects cannot return values.
    createContainerSocketAccess({ ...ports, warn: () => true });
    // @ts-expect-error A native probe result cannot satisfy semantic permission facts.
    createContainerSocketAccess({ ...ports, probe: () => native });
    // @ts-expect-error A native grant result cannot satisfy semantic completion.
    createContainerSocketAccess({ ...ports, grant: () => native });
    // @ts-expect-error Probe discriminant is required.
    createContainerSocketAccess({ ...ports, probe: () => ({ status: 0 }) });
    // @ts-expect-error Probe kinds are a closed union.
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "failed" }) });
    // @ts-expect-error Group admission requires the observed user.
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "requires-group", gid: "0" }) });
    // @ts-expect-error Group admission requires the observed GID.
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "requires-group", user: "ccc" }) });
    // @ts-expect-error The observed GID remains a string.
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "requires-group", user: "ccc", gid: 0 }) });
    // @ts-expect-error The observed user remains a string.
    createContainerSocketAccess({ ...ports, probe: () => ({ kind: "requires-group", user: 1, gid: "0" }) });
    // @ts-expect-error Grant completion is required.
    createContainerSocketAccess({ ...ports, grant: () => ({}) });
    // @ts-expect-error Grant completion is a boolean.
    createContainerSocketAccess({ ...ports, grant: () => ({ ok: 0 }) });
    // @ts-expect-error Native process status is absent from inward observations.
    const status = observation.status;
    // @ts-expect-error Native process stdout is absent from inward observations.
    const stdout = observation.stdout;
    // @ts-expect-error Native process status is absent from inward grant completion.
    const grantStatus = ports.grant("target", "ccc", "0").status;
    // @ts-expect-error Group facts require discriminant narrowing.
    const user = observation.user;
    // @ts-expect-error Run requires a target.
    app.run();
    // @ts-expect-error Run requires a string target.
    app.run(1);
    // @ts-expect-error Probe requires a string target.
    ports.probe(1);
    // @ts-expect-error Grant requires all three arguments.
    ports.grant("target", "ccc");
    // @ts-expect-error Grant user is a string.
    ports.grant("target", 1, "0");
    // @ts-expect-error Grant GID remains a string.
    ports.grant("target", "ccc", 0);
    // @ts-expect-error Reset takes no arguments.
    app.resetWarning("target");
    // @ts-expect-error Run returns synchronous undefined.
    const promise: Promise<undefined> = app.run("target");
    // @ts-expect-error Reset returns synchronous undefined.
    const resetPromise: Promise<undefined> = app.resetWarning();
    // @ts-expect-error Run does not return a success boolean.
    const success: boolean = app.run("target");
    void [status, stdout, grantStatus, user, promise, resetPromise, success];
}
void compileContracts;

describe("container socket access compile contracts", () => {
    it("returns undefined through its strict synchronous methods", () => {
        const app = createContainerSocketAccess({ probe: () => ({ kind: "usable" }), grant: () => ({ ok: true }), warn: () => undefined });
        expect(app.run("target")).toBeUndefined();
        expect(app.resetWarning()).toBeUndefined();
    });
});
