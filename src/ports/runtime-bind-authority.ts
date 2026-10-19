import type { NativeRuntimeInvocation } from "./container-runtime-invocation.js";

declare const preparation: unique symbol;
declare const guard: unique symbol;
declare const snapshot: unique symbol;
declare const ticket: unique symbol;

/** Created only by the native exclusive-home bootstrap. A path alone is not genesis evidence. */
export interface RuntimeBindHomePreparation {
    readonly root: string;
    readonly [preparation]: true;
}

/** Valid only during its owning codex-state.lock callback; never a serialized permission. */
export interface RuntimeBindGuard {
    readonly root: string;
    readonly [guard]: true;
}

/** Sensitive native selectors stay in memory/private state, never in diagnostics. */
export interface RuntimeBindAuthorityFacts {
    readonly coverage: "complete" | "incomplete" | "unknown";
    readonly pending: boolean;
    readonly authorities: readonly NativeRuntimeInvocation[];
    readonly reason?: "coverage-incomplete" | "receiving-host-incomplete" | "history-unknown";
}

export interface RuntimeBindAuthoritySnapshot extends RuntimeBindAuthorityFacts {
    readonly [snapshot]: true;
}

/** Only the operation which published this ticket may settle it, while its guard is held. */
export interface RuntimeBindCreationTicket {
    readonly [ticket]: true;
}

export type RuntimeBindUsers = "absent" | "present" | "unknown";

export type RuntimeBindAdmission =
    | { readonly allowed: true; readonly reason: "clear" }
    | { readonly allowed: false; readonly reason: "history-unknown" | "coverage-incomplete" | "creation-pending" | "bind-present" | "bind-unknown" };
