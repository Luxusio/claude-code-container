function boundedNumber(value, fallback, maximum) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(maximum, Math.max(1, Math.trunc(value)))
        : fallback;
}

export function createWaitBudget(timeoutMs, intervalMs) {
    const timeout = boundedNumber(timeoutMs, 10000, 600000);
    const interval = boundedNumber(intervalMs, 500, 60000);
    const deadline = performance.now() + timeout;
    const remaining = () => Math.max(0, deadline - performance.now());
    return {
        timeoutMs: timeout,
        remaining,
        requestTimeout(maximum = 120000) {
            return Math.min(maximum, Math.ceil(remaining()));
        },
        async pause() {
            const wakeAt = Math.min(deadline, performance.now() + interval);
            let delay;
            // Timer callbacks can arrive early. Recheck the same monotonic
            // target without restarting the interval or overall allowance.
            while ((delay = wakeAt - performance.now()) > 0) {
                await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay)));
            }
        },
    };
}
