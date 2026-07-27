export class HyperVOperationDeadlineError extends Error {
    code = "hyper-v-operation-deadline-exceeded" as const;

    constructor() {
        super("hyper-v-operation-deadline-exceeded");
    }
}

export function hyperVRemainingTimeout(
    deadlineAt: number,
    maximumMs: number,
): number {
    if (!Number.isFinite(deadlineAt)) return maximumMs;
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining <= 0) throw new HyperVOperationDeadlineError();
    return Math.max(1, Math.min(maximumMs, remaining));
}

export function hyperVOperationDeadlineExpired(deadlineAt: number): boolean {
    return Number.isFinite(deadlineAt) && Date.now() >= deadlineAt;
}

export function assertHyperVOperationDeadline(deadlineAt: number): void {
    if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt) {
        throw new HyperVOperationDeadlineError();
    }
}
