import { createContainerRunContract } from "../../application/container-run-contract.js";
import { createNativeContainerRunContractPorts } from "../../adapters/container-run-contract-observations.js";
import type { ContainerRunContractPorts } from "../../ports/container-run-contract.js";

function contracts(
    options: Parameters<typeof createContainerRunContract>[0],
    ports: ContainerRunContractPorts,
    native: Parameters<typeof createNativeContainerRunContractPorts>[0],
) {
    const application = createContainerRunContract(options, ports);
    const strict: boolean | null = application.matches("image", "preflight");
    const live: boolean | null = application.matches("image", "live");
    const deferred: boolean = application.safeToDefer();
    const observed: ReturnType<ContainerRunContractPorts["inspect"]> = createNativeContainerRunContractPorts(native).inspect();
    const { inspect, ...withoutInspection } = ports;
    // @ts-expect-error Inspection is required; there are no ambient defaults.
    createContainerRunContract(options, withoutInspection);
    // @ts-expect-error All native bindings must be supplied explicitly.
    createContainerRunContract(options);
    // @ts-expect-error An asynchronous inspection cannot authorize synchronous admission.
    createContainerRunContract(options, { ...ports, inspect: async () => null });
    // @ts-expect-error Raw Docker records are not semantic inspection observations.
    createContainerRunContract(options, { ...ports, inspect: () => ({ Id: "container", HostConfig: {} }) });
    // @ts-expect-error Effective-user proof must settle before later mount observations.
    createContainerRunContract(options, { ...ports, effectiveUserMatches: async () => true });
    // @ts-expect-error Runtime failure classification must settle synchronously.
    createContainerRunContract(options, { ...ports, isRuntimeUnavailable: async () => false });
    // @ts-expect-error The admission phase is finite.
    application.matches("image", "replace");
    // @ts-expect-error A synchronous result cannot be consumed as a pending admission.
    const pending: Promise<boolean | null> = application.matches("image", "live");
    if (observed) {
        // @ts-expect-error Native HostConfig does not cross the inward boundary.
        observed.HostConfig;
        // @ts-expect-error A native inspection record cannot select its own runtime.
        observed.Runtime;
        // @ts-expect-error Mount proof policy does not include forced admission.
        observed.verifyMounts("force");
    }
    const { selectedRuntime, ...withoutRuntime } = native;
    // @ts-expect-error Native schema selection requires the captured runtime binding.
    createNativeContainerRunContractPorts(withoutRuntime);
    // @ts-expect-error Native inspection is synchronous.
    createNativeContainerRunContractPorts({ ...native, inspect: async () => null });
    void [strict, live, deferred, observed, inspect, pending, selectedRuntime];
}
void contracts;
