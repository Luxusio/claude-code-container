import type { FlowArguments, FlowObservation } from '../domain/device-flow.mjs';
export interface DeviceFlowPorts<Payload> {
    toolInputError(tool: string, args: FlowArguments | undefined): string | null;
    flowOperationAllowed(tool: string, args: FlowArguments | undefined): boolean;
    toolOperation(tool: string, args: FlowArguments | undefined): string;
    flowStepArguments(tool: string, flow: FlowArguments, step: FlowArguments | undefined): FlowArguments;
    normalizePublicToolArgs(tool: string, args: FlowArguments): FlowArguments;
    withBrokerOperation(callback: () => Promise<FlowObservation<Payload>>): Promise<FlowObservation<Payload>>;
    dispatchTool(operation: string, args: FlowArguments): Promise<FlowObservation<Payload>>;
    destructiveDenial(operation: string, args: FlowArguments | undefined): FlowObservation<Payload>;
    dispatchFailure(error: unknown): FlowObservation<Payload>;
}
export interface DeviceFlowOptions { toolName: string; toolAllowed(tool: string): boolean }
