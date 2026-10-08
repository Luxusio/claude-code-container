import type { FlowArguments } from "../domain/device-flow.mjs";
import type { DeviceFlowOptions, DeviceFlowPorts } from "../ports/device-flow.mjs";
export function runDeviceFlow<Raw, Presented, Content, Reply extends { content: Content[] }, Policy>(
    args: FlowArguments, options: DeviceFlowOptions,
    ports: DeviceFlowPorts<Raw, Presented, Content, Reply, Policy>): Promise<Reply>;
