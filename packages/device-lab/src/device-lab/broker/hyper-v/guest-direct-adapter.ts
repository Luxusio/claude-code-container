import { win32 } from "path";

import {
    createHyperVGuestDirectClient,
    type HyperVGuestDirectAction,
    type HyperVGuestDirectIdentity,
    type HyperVGuestDirectResult,
} from "@ccc/hyper-v/index.js";
import {
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";
import { HyperVOperationDeadlineError, hyperVRemainingTimeout } from "./deadline.js";

export async function invokeDeviceLabHyperVGuestDirect(
    options: Omit<DeviceLabHyperVWindowsClientOptions, "session" | "record"> & {
        readonly identity: HyperVGuestDirectIdentity;
        readonly action: HyperVGuestDirectAction;
    },
): Promise<HyperVGuestDirectResult> {
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    const initialTimeout = typeof options.timeoutMilliseconds === "function"
        ? options.timeoutMilliseconds() : options.timeoutMilliseconds;
    let deadline = startedAt + initialTimeout;
    const remaining = () => {
        const sampledAt = now();
        const inherited = typeof options.timeoutMilliseconds === "function"
            ? options.timeoutMilliseconds() : initialTimeout;
        const budget = Math.min(deadline - sampledAt, inherited);
        if (!Number.isFinite(budget) || Math.floor(budget) < 1) throw new HyperVOperationDeadlineError();
        deadline = Math.min(deadline, sampledAt + inherited);
        return hyperVRemainingTimeout(deadline, initialTimeout, now);
    };
    const invoke = async (
        action: HyperVGuestDirectAction,
        timeoutMilliseconds = remaining(),
    ): Promise<HyperVGuestDirectResult> => {
        // Credential-bearing actions never accept a pooled session or replay a request.
        let callbackRefusal: HyperVOperationDeadlineError | undefined;
        const client = createHyperVGuestDirectClient(createDeviceLabHyperVWindowsExecutor({
            executable: options.executable,
            timeoutMilliseconds: () => {
                try {
                    return remaining();
                } catch (error) {
                    if (error instanceof HyperVOperationDeadlineError) callbackRefusal = error;
                    throw error;
                }
            },
            run: options.run,
        }));
        let result: HyperVGuestDirectResult;
        try {
            result = await client.invoke({ ...options.identity, ...action }, timeoutMilliseconds);
        } catch (error) {
            // The typed client wraps executor throws. Restore only our own refusal before dispatch;
            // native, protocol and transport failures retain their original evidence.
            throw callbackRefusal ?? error;
        }
        if (result.action !== "exec" || result.status === 0) remaining();
        return result;
    };
    // Preserve the library's validation of the original duration before rounding elapsed time.
    if (options.action.action === "upload") {
        const parent = win32.dirname(options.action.remotePath);
        await invoke({ action: "mkdir", remotePath: parent }, initialTimeout);
        return invoke(options.action);
    }
    return invoke(options.action, initialTimeout);
}
