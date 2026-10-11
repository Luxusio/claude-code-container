import type { FlowArguments, FlowOutcome } from '../domain/device-flow.mjs';
import type { DeviceFlowOptions, DeviceFlowPorts } from '../ports/device-flow.mjs';
export function runDeviceFlow<Payload>(args: FlowArguments, options: DeviceFlowOptions, ports: DeviceFlowPorts<Payload>): Promise<FlowOutcome<Payload>>;
