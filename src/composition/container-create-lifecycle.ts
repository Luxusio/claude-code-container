import { createNativeContainerCreatePorts } from "../adapters/container-create-lifecycle.js";
import type { NativeContainerCreateLifecycleContext } from "../adapters/container-create-lifecycle.js";
import { createContainerCreateLifecycle } from "../application/container-create-lifecycle.js";
import type { ContainerCreateLifecyclePorts } from "../ports/container-create-lifecycle.js";

export type { NativeContainerCreateLifecycleContext } from "../adapters/container-create-lifecycle.js";

export function createNativeContainerCreateLifecycle(
    ports: Omit<ContainerCreateLifecyclePorts<{ cli: string; args: string[] }>, keyof ReturnType<typeof createNativeContainerCreatePorts>>,
    context: NativeContainerCreateLifecycleContext,
) {
    return createContainerCreateLifecycle({
        ...ports,
        ...createNativeContainerCreatePorts(context),
    });
}
