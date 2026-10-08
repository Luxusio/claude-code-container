/** Arguments retain observable property access; callers must not clone them eagerly. */
export type FlowArguments = Record<string, any>;
export interface FlowSummary {
    isError: boolean;
    error?: string;
    [key: string]: unknown;
}
export interface FlowStepSummary extends FlowSummary {
    index: number;
    label: string;
    tool?: string;
}
export interface FlowValue {
    ok: boolean;
    error?: string;
    stoppedAt?: number;
    results: FlowStepSummary[];
}
export const FLOW_MAX_STEPS: 50;
export function sharedFlowTarget(args: FlowArguments, stepArgs: FlowArguments,
    targetProperties: Record<string, unknown> | undefined): FlowArguments;
