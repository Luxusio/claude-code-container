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
function finish(status: 0 | 1 = 0): void {
    if (status === 1) {
        exitStatus = 1;
        console.error("[ccc] Ended host session cleanup failed; no successful container shutdown was confirmed.");
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
