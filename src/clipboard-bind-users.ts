import { collectRuntimeBindUsers } from "./adapters/runtime-bind-users.js";
import { runtimeBindAdmission } from "./application/runtime-bind-admission.js";
import type { RuntimeBindGuard } from "./ports/runtime-bind-authority.js";

/** Unknown authority or retained mounts defer any shared clipboard mutation. */
export function clipboardPortMayHaveBindUsers(portFile: string, guard?: RuntimeBindGuard): boolean {
    if (!guard) return true;
    const observed = collectRuntimeBindUsers([portFile], guard);
    return !runtimeBindAdmission(observed.history, observed.users).allowed;
}
