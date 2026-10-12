import { writeSync } from "fs";
import { sessionLockLiveness } from "./session-lock-liveness.js";
import { createSessionOwnershipGuardian } from "./application/session-ownership.js";
import { assertNativeSessionOwnership, rollbackCapturedNativeSessionOwnership, validateNativeSessionOwnership } from "./composition/session-ownership-native.js";

const ownerPid = Number(process.argv[2]);
if (!process.send || !process.connected || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    process.exit(1);
}
let pendingSends = 0;
let finishing = false;
let exitStatus: 0 | 1 = 0;
function failureEvidence(error: unknown, depth = 0): object {
    if (depth >= 4) return { kind: "truncated" };
    if (!(error instanceof Error)) return { kind: "non-error" };
    const evidence: Record<string, unknown> = {
        kind: error instanceof AggregateError ? "aggregate"
            : error instanceof TypeError ? "type-error" : error instanceof RangeError ? "range-error" : "error",
    };
    const operations: Record<string, string> = {
        "Session ownership guardian cleanup failed.": "cleanup",
        "Session ownership guardian failed and cleanup failed.": "guardian",
        "Session ownership validation failed and rollback failed.": "validation",
        "Invalid ownership frame.": "protocol",
        "Invalid ownership sequence.": "protocol",
        "Invalid container handoff.": "protocol",
        "Session ownership guardian IPC is closed.": "ipc",
        "Session ownership guardian IPC write timed out.": "ipc",
        "Session ownership guardian IPC write failed.": "ipc",
        "Session ownership guardian IPC parent does not match its owner.": "validation",
    };
    if (Object.hasOwn(operations, error.message)) evidence.operation = operations[error.message];
    const stop = /^Container shutdown failed \(status=(-?\d{1,10}|unknown), signal=(none|SIG[A-Z0-9]{1,12}), error=([A-Z0-9_]{1,32}|unknown)\); session cleanup remains incomplete\.$/.exec(error.message);
    if (stop) {
        evidence.operation = "container-stop";
        const status = Number(stop[1]);
        evidence.status = Number.isInteger(status) && status >= -2147483648 && status <= 2147483647 ? status : "unknown";
        evidence.signal = ["none", "SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGABRT", "SIGSEGV"].includes(stop[2]) ? stop[2] : "unknown";
        evidence.code = ["ENOENT", "ETIMEDOUT", "EACCES", "EPERM", "EIO", "ENOMEM", "ENOBUFS", "unknown"].includes(stop[3]) ? stop[3] : "unknown";
    }
    if (error instanceof AggregateError) evidence.errors = error.errors.slice(0, 3).map((failure: unknown) => failureEvidence(failure, depth + 1));
    if (error.cause !== undefined) evidence.cause = failureEvidence(error.cause, depth + 1);
    return evidence;
}
function finish(status: 0 | 1 = 0, error?: unknown): void {
    if (status === 1) {
        exitStatus = 1;
        try {
            writeSync(2, `[ccc] Session ownership guardian failure: ${JSON.stringify(failureEvidence(error))}\n`);
        } catch { /* A closed diagnostic stream must not prevent terminal completion. */ }
    }
    finishing = true;
    if (pendingSends === 0) process.exit(exitStatus);
}
const guardian = createSessionOwnershipGuardian({
    async validate(binding, receipt) {
        validateNativeSessionOwnership(binding, receipt, ownerPid);
        assertNativeSessionOwnership(receipt);
        if (process.ppid !== ownerPid) {
            // A parent can die before its queued initialization is received.
            // Preserve uncertain owners; only a proven dead receipt permits cleanup.
            if (sessionLockLiveness(Buffer.from(receipt.bytes, "base64").toString("utf8")) === "stale") {
                const error = new Error("Session ownership guardian IPC parent does not match its owner.");
                try {
                    await rollbackCapturedNativeSessionOwnership(binding, receipt);
                } catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], "Session ownership validation failed and rollback failed.", { cause: error });
                }
                throw error;
            }
            throw new Error("Session ownership guardian IPC parent does not match its owner.");
        }
    },
    rollback: rollbackCapturedNativeSessionOwnership,
    async cleanup(binding, receipt, containerId, runtime) {
        const { cleanupCapturedNativeSessionOwnership } = await import("./composition/session-ownership.js");
        await cleanupCapturedNativeSessionOwnership(binding, receipt, containerId, runtime);
    },
    send(message) {
        return new Promise<void>((resolve, reject) => {
            if (!process.connected) {
                reject(new Error("Session ownership guardian IPC is closed."));
                return;
            }
            pendingSends++;
            let settled = false;
            const timer = setTimeout(() => settle(new Error("Session ownership guardian IPC write timed out.")), 5000);
            function settle(error?: Error | null): void {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) { exitStatus = 1; reject(error); } else resolve();
                pendingSends--;
                if (finishing && pendingSends === 0) process.exit(exitStatus);
            }
            try { process.send!(message, settle); } catch (error) {
                settle(error instanceof Error ? error : new Error("Session ownership guardian IPC write failed."));
            }
        });
    },
    pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    finish,
});
process.on("message", (message) => {
    void guardian.receive(message).catch(() => { /* the guardian owns terminal completion */ });
});
process.once("disconnect", () => {
    void guardian.disconnect().catch(() => { /* the guardian owns terminal completion */ });
});
