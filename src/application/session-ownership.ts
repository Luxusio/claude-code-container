import type {
    SessionOwnershipBinding, SessionOwnershipReceipt, SessionOwnershipPorts,
    SessionOwnershipHandle, SessionOwnershipMessage, SessionOwnershipGuardianPorts,
    SessionOwnershipRuntime,
} from "../ports/session-ownership.js";

export async function armSessionOwnership(
    binding: SessionOwnershipBinding,
    receipt: SessionOwnershipReceipt,
    ports: SessionOwnershipPorts,
    onFailure: (error: Error) => void,
): Promise<SessionOwnershipHandle> {
    for (const name of ["launch", "cleanup", "assertOwnership", "setTimer", "clearTimer"] as const) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Session ownership requires a callable ${name} port.`);
    }
    binding = Object.freeze({ ...binding });
    receipt = Object.freeze({ ...receipt });
    let channel: ReturnType<SessionOwnershipPorts["launch"]>;
    try {
        channel = ports.launch();
    } catch (error) {
        try {
            await ports.cleanup(binding, receipt);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Session ownership startup failed and rollback failed.", { cause: error });
        }
        throw error;
    }
    let phase: "starting" | "active" | "releasing" | "closed" = "starting";
    let sequence = 0;
    const currentPhase = () => phase;
    const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: unknown }>();
    const listeners: Array<() => void> = [];
    function dispose(error?: Error): void {
        if (phase === "closed") return;
        phase = "closed";
        for (const item of pending.values()) {
            ports.clearTimer(item.timer);
            item.reject(error ?? new Error("Session ownership guardian was released."));
        }
        pending.clear();
        for (const unsubscribe of listeners) unsubscribe();
        channel.close();
    }
    function lost(error: Error): void {
        if (phase === "closed") return;
        const active = phase === "active";
        dispose(error);
        if (active) onFailure(error);
    }
    function request(key: number, message: SessionOwnershipMessage): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = ports.setTimer(() => {
                if (pending.has(key)) lost(new Error("Session ownership guardian acknowledgement timed out."));
            }, ports.timeoutMs);
            pending.set(key, { resolve, reject, timer });
            void channel.send(message).catch((error: unknown) => lost(error instanceof Error ? error : new Error("Session ownership guardian IPC failed.")));
        });
    }
    listeners.push(channel.onMessage((message) => {
        if (!message || typeof message !== "object") return;
        const frame = message as { type?: unknown; sequence?: unknown };
        if (frame.type === "error") {
            lost(new Error("Session ownership guardian rejected ownership."));
            return;
        }
        const key = frame.type === "ready" && phase === "starting" ? 0
            : frame.type === "ack" && phase !== "starting" && typeof frame.sequence === "number"
                && frame.sequence > 0 ? frame.sequence : -1;
        const item = pending.get(key);
        if (!item) return;
        ports.clearTimer(item.timer);
        pending.delete(key);
        item.resolve();
    }));
    listeners.push(channel.onLoss(lost));
    try {
        await request(0, { type: "init", binding, receipt });
        if (currentPhase() === "closed") throw new Error("Session ownership guardian was lost during readiness.");
        phase = "active";
        channel.unref();
    } catch (error) {
        dispose(error instanceof Error ? error : new Error("Session ownership guardian startup failed."));
        try {
            await ports.cleanup(binding, receipt);
        } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Session ownership startup failed and rollback failed.", { cause: error });
        }
        throw error;
    }
    return {
        pid: channel.pid,
        assertOwnership() { ports.assertOwnership(binding, receipt); },
        async updateContainer(containerId, runtime, cleanupEnabled = false) {
            if (typeof cleanupEnabled !== "boolean") throw new TypeError("Invalid session cleanup authorization.");
            if (phase !== "active") throw new Error("Session ownership guardian is unavailable.");
            await request(++sequence, { type: "update", sequence, containerId, runtime, cleanupEnabled });
        },
        async release() {
            if (phase === "closed") return;
            phase = "releasing";
            try {
                await request(++sequence, { type: "release", sequence });
            } finally {
                dispose();
            }
        },
    };
}

export function createSessionOwnershipGuardian(ports: SessionOwnershipGuardianPorts) {
    for (const name of ["validate", "rollback", "cleanup", "send", "pause", "finish"] as const) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Session ownership guardian requires a callable ${name} port.`);
    }
    let ownership: { binding: SessionOwnershipBinding; receipt: SessionOwnershipReceipt } | null = null;
    let containerId: string | null = null;
    let runtime: SessionOwnershipRuntime = "docker";
    let cleanupEnabled = false;
    let finished = false;
    let sequence = 0;
    let queue: Promise<void> = Promise.resolve();
    function enqueue(operation: () => Promise<void> | void): Promise<void> {
        const result = queue.then(operation);
        queue = result.catch(() => undefined);
        return result;
    }
    async function cleanupAndFinish(status: 0 | 1 = 0, primary?: unknown): Promise<void> {
        if (finished) return;
        // The serial queue owns this terminal run, including all awaited attempts.
        finished = true;
        const failures: unknown[] = [];
        if (ownership) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    if (containerId === null || !cleanupEnabled) await ports.rollback(ownership.binding, ownership.receipt);
                    else await ports.cleanup(ownership.binding, ownership.receipt, containerId, runtime);
                } catch (error) {
                    failures.push(error);
                    if (attempt < 2) {
                        try {
                            await ports.pause(1000);
                        } catch (pauseError) {
                            failures.push(pauseError);
                            break;
                        }
                    }
                    continue;
                }
                ports.finish(status, primary);
                return;
            }
        }
        if (failures.length) {
            const cleanupError = new AggregateError(failures, "Session ownership guardian cleanup failed.", { cause: failures[0] });
            const terminalError = status === 1
                ? new AggregateError([primary, cleanupError], "Session ownership guardian failed and cleanup failed.", { cause: primary })
                : cleanupError;
            ports.finish(1, terminalError);
            throw terminalError;
        }
        ports.finish(status, primary);
    }
    function disconnect(): Promise<void> {
        // Wait for the native ACK write outcome before deciding which ID is owned.
        return enqueue(() => cleanupAndFinish());
    }
    function receive(message: unknown): Promise<void> {
        return enqueue(async () => {
            if (finished) return;
            try {
                if (!message || typeof message !== "object") throw new Error("Invalid ownership frame.");
                const frame = message as SessionOwnershipMessage;
                if (frame.type === "init" && !ownership) {
                    await ports.validate(frame.binding, frame.receipt);
                    ownership = { binding: Object.freeze({ ...frame.binding }), receipt: Object.freeze({ ...frame.receipt }) };
                    await ports.send({ type: "ready" });
                    return;
                }
                if (!ownership || !("sequence" in frame) || !Number.isSafeInteger(frame.sequence)
                    || frame.sequence <= sequence) throw new Error("Invalid ownership sequence.");
                if (frame.type === "update") {
                    if ((frame.containerId !== null && (typeof frame.containerId !== "string" || !/^[a-f0-9]{12,64}$/.test(frame.containerId)))
                        || (frame.runtime !== "docker" && frame.runtime !== "podman")
                        || typeof frame.cleanupEnabled !== "boolean") throw new Error("Invalid container handoff.");
                    await ports.send({ type: "ack", sequence: frame.sequence });
                    sequence = frame.sequence;
                    containerId = frame.containerId;
                    runtime = frame.runtime;
                    cleanupEnabled = frame.cleanupEnabled;
                } else if (frame.type === "release") {
                    await ports.send({ type: "ack", sequence: frame.sequence });
                    sequence = frame.sequence;
                    finished = true;
                    ports.finish();
                } else {
                    throw new Error("Invalid ownership frame.");
                }
            } catch (error) {
                try { await ports.send({ type: "error" }); } catch { /* retain the original failure */ }
                // Do not await the queued disconnect from inside this operation.
                await cleanupAndFinish(1, error);
                throw error;
            }
        });
    }
    return { receive, disconnect };
}
