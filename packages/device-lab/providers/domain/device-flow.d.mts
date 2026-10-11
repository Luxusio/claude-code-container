export type FlowArguments = Record<string, unknown>;
export interface FlowFacts { ok?: boolean; matched?: boolean; found?: boolean; running?: boolean }
export interface FlowObservation<Payload> { transportFailed: boolean; values: FlowFacts[]; payload: Payload }
export interface FlowStepOutcome<Payload> { index: number; label: string; tool?: string; operation?: string; failed: boolean; error?: string; payload?: Payload }
export type FlowOutcome<Payload> = { kind: 'invalid'; message: string } | { kind: 'complete'; ok: boolean; stoppedAt?: number; results: FlowStepOutcome<Payload>[] };
export const FLOW_MAX_STEPS: 50;
export function flowFailure(operation: string, observation: FlowObservation<unknown>): { failed: boolean; error?: string };
export function sharedFlowTarget(args: FlowArguments, stepArgs: FlowArguments, targetProperties: Record<string, unknown> | undefined): FlowArguments;
export function isFlowArguments(value: unknown): value is FlowArguments;
