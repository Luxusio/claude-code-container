import type {
    HyperVLifecycleRetryContext,
    HyperVLifecycleRetryOptions,
    HyperVVirtualMachineReconciliationOutcome,
} from "./contracts.js";

function abortError(): Error {
    const error = new Error("hyper-v-lifecycle-aborted");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError();
}

async function defaultSleeper(delayMilliseconds: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (delayMilliseconds === 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, delayMilliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function validateOptions(options: HyperVLifecycleRetryOptions): void {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
        throw new TypeError("hyper-v-lifecycle-max-attempts-invalid");
    }
    if (typeof options.delayMilliseconds === "number"
        && (!Number.isFinite(options.delayMilliseconds) || options.delayMilliseconds < 0)) {
        throw new TypeError("hyper-v-lifecycle-delay-invalid");
    }
}

function retryDelay(options: HyperVLifecycleRetryOptions, completedAttempts: number): number {
    const delay = typeof options.delayMilliseconds === "function"
        ? options.delayMilliseconds(completedAttempts)
        : options.delayMilliseconds ?? 0;
    if (!Number.isFinite(delay) || delay < 0) {
        throw new TypeError("hyper-v-lifecycle-delay-invalid");
    }
    return delay;
}

export async function retryHyperVLifecycle(
    operation: (context: HyperVLifecycleRetryContext) => HyperVVirtualMachineReconciliationOutcome
        | Promise<HyperVVirtualMachineReconciliationOutcome>,
    options: HyperVLifecycleRetryOptions,
): Promise<HyperVVirtualMachineReconciliationOutcome> {
    validateOptions(options);
    const sleeper = options.sleeper ?? defaultSleeper;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        throwIfAborted(options.signal);
        let outcome: HyperVVirtualMachineReconciliationOutcome;
        try {
            outcome = await operation({
                attempt,
                ...(options.signal ? { signal: options.signal } : {}),
            });
        } catch (error) {
            throwIfAborted(options.signal);
            if (attempt === options.maxAttempts || !options.shouldRetryError?.(error, attempt)) throw error;
            await sleeper(retryDelay(options, attempt), options.signal);
            throwIfAborted(options.signal);
            continue;
        }
        throwIfAborted(options.signal);
        if (outcome.kind !== "pending" || attempt === options.maxAttempts) return outcome;
        await sleeper(retryDelay(options, attempt), options.signal);
        throwIfAborted(options.signal);
    }

    throw new TypeError("hyper-v-lifecycle-max-attempts-invalid");
}
