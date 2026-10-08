import type { FlowArguments, FlowSummary, FlowValue } from "../domain/device-flow.mjs";

export interface DeviceFlowPorts<Raw, Presented, Content, Reply extends { content: Content[] }, Policy> {
    toolInputError(tool: string, args: FlowArguments | undefined): string | null;
    flowOperationAllowed(tool: string, args: FlowArguments | undefined): boolean;
    toolOperation(tool: string, args: FlowArguments | undefined): string | undefined;
    flowStepArguments(tool: string, flow: FlowArguments, step: FlowArguments | undefined): FlowArguments;
    normalizePublicToolArgs(tool: string, args: FlowArguments): FlowArguments;
    withBrokerOperation(callback: () => Promise<Raw>): Promise<Raw>;
    dispatchTool(operation: string | undefined, args: FlowArguments, options: { detail: boolean | undefined }): Promise<Raw>;
    evaluateDestructivePolicy(operation: string | undefined, args: FlowArguments | undefined): Policy;
    policyDeniedResult(policy: Policy): Raw;
    unexpectedError(message: string): Raw;
    summarizeToolResult(operation: string | undefined, result: Raw | Presented, nativeContent: Content[]): FlowSummary;
    actionResult(tool: string, operation: string | undefined, result: Raw, options: { detail: boolean | undefined }): Presented;
    textFailure(message: string): Reply;
    renderFlow(value: FlowValue, options: { toolName: string; detail: boolean | undefined }): Reply;
}
export interface DeviceFlowOptions {
    toolName: string;
    toolAllowed(tool: string): boolean;
    detail?: boolean;
}
