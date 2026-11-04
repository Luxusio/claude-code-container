import { collectRuntimeBindUsers } from "./adapters/runtime-bind-users.js";
import { runtimeBindAdmission } from "./application/runtime-bind-admission.js";
import type { RuntimeBindAdmission, RuntimeBindGuard } from "./ports/runtime-bind-authority.js";

/** Preserve the reason a shared publication cannot be changed. */
export function clipboardPortBindAdmission(portFile: string, guard?: RuntimeBindGuard): RuntimeBindAdmission {
    if (!guard) return { allowed: false, reason: "history-unknown" };
    const observed = collectRuntimeBindUsers([portFile], guard);
    return runtimeBindAdmission(observed.history, observed.users);
}

/** Unknown authority or retained mounts defer any shared clipboard mutation. */
export function clipboardPortMayHaveBindUsers(portFile: string, guard?: RuntimeBindGuard): boolean {
    return !clipboardPortBindAdmission(portFile, guard).allowed;
}
