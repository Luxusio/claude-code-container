import { expect, it } from "vitest";
import { createDockerEndpointResolver } from "../../application/docker-endpoint-selection.js";
import type { DockerEndpointSelectionPorts } from "../../ports/docker-endpoint-selection.js";
import { bindMountArgs } from "../../container-runtime.js";
function contracts(ports: DockerEndpointSelectionPorts) {
    const resolver: () => string | null = createDockerEndpointResolver(ports);
    const endpoint: string | null = resolver();
    const clientMount: string[] = bindMountArgs("/source", "/destination", { sourceNamespace: "client" });
    const daemonMount: string[] = bindMountArgs("/source", "/destination", { sourceNamespace: "daemon", readonly: true });
    // @ts-expect-error Namespace must be an explicitly supported literal.
    bindMountArgs("/source", "/destination", { sourceNamespace: "vm" });
    // @ts-expect-error Namespace cannot be a boolean.
    bindMountArgs("/source", "/destination", { sourceNamespace: true });
    // @ts-expect-error Every capability is required.
    createDockerEndpointResolver({ readContextOverride: ports.readContextOverride, readHostOverride: ports.readHostOverride });
    // @ts-expect-error Ports are required.
    createDockerEndpointResolver();
    // @ts-expect-error Context observation must be synchronous.
    createDockerEndpointResolver({ ...ports, readContextOverride: async () => "colima" });
    // @ts-expect-error Host observation must be synchronous.
    createDockerEndpointResolver({ ...ports, readHostOverride: async () => "host" });
    // @ts-expect-error Inspection must be synchronous.
    createDockerEndpointResolver({ ...ports, inspectContextEndpoint: async () => null });
    // @ts-expect-error Inspection cannot return an unknown endpoint.
    createDockerEndpointResolver({ ...ports, inspectContextEndpoint: () => undefined });
    // @ts-expect-error Context operand must be a string or undefined.
    ports.inspectContextEndpoint(5);
    // @ts-expect-error Resolved result is synchronous.
    const asyncResult: Promise<string | null> = resolver();
    void [endpoint, asyncResult, clientMount, daemonMount];
}
void contracts;
it("returns a synchronous endpoint resolver", () => expect(createDockerEndpointResolver({ readContextOverride: () => "selected", readHostOverride: () => undefined, inspectContextEndpoint: () => null })()).toBeNull());
