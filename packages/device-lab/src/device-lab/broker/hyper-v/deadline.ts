export class HyperVOperationDeadlineError extends Error {
    code = "hyper-v-operation-deadline-exceeded" as const;

    constructor() {
        super("hyper-v-operation-deadline-exceeded");
    }
}

export function hyperVRemainingTimeout(
    deadlineAt: number,
    maximumMs: number,
    now: () => number = () => Date.now(),
): number {
    if (!Number.isFinite(deadlineAt)) return maximumMs;
    const remaining = Math.floor(deadlineAt - now());
    if (remaining <= 0) throw new HyperVOperationDeadlineError();
    return Math.max(1, Math.min(maximumMs, remaining));
}

export function hyperVOperationDeadlineExpired(deadlineAt: number, now: () => number = () => Date.now()): boolean {
    return Number.isFinite(deadlineAt) && now() >= deadlineAt;
}

export function assertHyperVOperationDeadline(deadlineAt: number, now: () => number = () => Date.now()): void {
    if (Number.isFinite(deadlineAt) && now() >= deadlineAt) {
        throw new HyperVOperationDeadlineError();
    }
}
