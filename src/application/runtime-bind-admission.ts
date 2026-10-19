import type { RuntimeBindAdmission, RuntimeBindAuthorityFacts, RuntimeBindUsers } from "../ports/runtime-bind-authority.js";

/** The caller must revalidate the native snapshot under the same guard before its effect. */
export function runtimeBindAdmission(history: RuntimeBindAuthorityFacts, users: RuntimeBindUsers): RuntimeBindAdmission {
    if (history.coverage === "unknown") return { allowed: false, reason: "history-unknown" };
    if (history.coverage !== "complete") return { allowed: false, reason: "coverage-incomplete" };
    if (history.pending) return { allowed: false, reason: "creation-pending" };
    if (users === "present") return { allowed: false, reason: "bind-present" };
    if (users !== "absent") return { allowed: false, reason: "bind-unknown" };
    return { allowed: true, reason: "clear" };
}
