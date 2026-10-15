import type { HyperVWindowsExecutor } from "@ccc/hyper-v/index.js";
import {
    HyperVElevatedNetworkSessionError,
    type HyperVElevatedNetworkAcquisitionSettlement,
    type HyperVElevatedNetworkErrorCode,
} from "./elevated-network-session.js";

// Codes that settle an acquisition before Windows can have shown a consent prompt: the caller's
// REQUEST hook threw so the relay never approved RunAs, ShellExecute failed for a reason other
// than a declined prompt, Node could not start the relay, or refused its PowerShell path. None
// of them cost the person anything, so none of them may use up the one attempt.
const PRE_PROMPT_FAILURES: ReadonlySet<HyperVElevatedNetworkErrorCode> = new Set([
    "hyper-v-network-elevation-request-failed",
    "hyper-v-network-elevation-launch-failed",
    "hyper-v-network-elevation-relay-spawn-failed",
    "hyper-v-network-elevation-executable-rejected",
]);
const SUPPRESSED_CODE = "hyper-v-network-elevation-suppressed" satisfies HyperVElevatedNetworkErrorCode;
// The relay asked for approval and the scope ended before it reported how that went.
const UNREPORTED_REFUSAL_CODE = "hyper-v-network-elevation-scope-closed" satisfies HyperVElevatedNetworkErrorCode;

// Stands in for the elevated executor once the gate has refused. Every call fails before
// anything is started, and the code is in the network adapter's proven-not-started set.
export const HYPER_V_ELEVATION_SUPPRESSED_EXECUTOR: HyperVWindowsExecutor = Object.freeze({
    execute: () => ({ status: null, stdout: "", error: SUPPRESSED_CODE }),
});

export type HyperVElevationGateStatus =
    | { readonly state: "never-asked" }
    | {
        readonly state: "refused";
        readonly code: HyperVElevatedNetworkErrorCode;
        readonly at: string;
    };

// Module scoped, like the session pool: an unattended run must see at most one UAC prompt per
// broker process, and every administrator transaction in the process opens its own elevation
// scope. Deliberately in memory only. The gate can only deny — nothing it holds can skip or
// answer consent — so the worst a stale state could do is suppress a prompt, and restarting the
// broker is the remedy. An approval is not recorded: the next administrator need asks again.
let refusal: { readonly code: HyperVElevatedNetworkErrorCode; readonly at: number } | null = null;
// Attempts are serialized so a second transaction waits for the first one's verdict instead of
// raising its own prompt beside it. A turn is handed on as soon as the attempt's acquisition
// settles, not when its transaction ends. A scope reports its settlement before it returns, even
// while its relay is still starting, so the release in `finally` never runs ahead of a verdict.
// Hyper-V mutations are already serialized by the host lock; this does not rely on that.
let turns: Promise<void> = Promise.resolve();

function refusalFrom(
    settlement: HyperVElevatedNetworkAcquisitionSettlement,
): HyperVElevatedNetworkErrorCode | null {
    if (!settlement.prompted || settlement.ready) return null;
    if (settlement.code && PRE_PROMPT_FAILURES.has(settlement.code)) return null;
    return settlement.code ?? UNREPORTED_REFUSAL_CODE;
}

/**
 * Run one administrator transaction behind the gate. While the gate is open, `elevate` is called
 * with the listener to hand `withElevatedHyperVNetworkExecutor` as `onAcquisitionSettled`. Once a
 * prompt has been declined or left unanswered, `elevate` is never called again in this process:
 * `operation` runs against an executor that fails every call with
 * `hyper-v-network-elevation-suppressed`, so no relay starts and no REQUEST is logged.
 */
export async function withHyperVElevationGate<T>(
    elevate: (
        onAcquisitionSettled: (settlement: HyperVElevatedNetworkAcquisitionSettlement) => void,
    ) => Promise<T>,
    operation: (executor: HyperVWindowsExecutor) => T | Promise<T>,
    options?: { readonly remainingMilliseconds?: () => number },
): Promise<T> {
    let releaseTurn = () => undefined as void;
    const turn = new Promise<void>((resolve) => {
        releaseTurn = resolve;
    });
    const previous = turns;
    turns = previous.then(() => turn);
    try {
        if (options?.remainingMilliseconds) {
            const remainingMilliseconds = options.remainingMilliseconds;
            await new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | null = null;
                let settled = false;
                const finish = (expired: boolean) => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    if (expired) reject(new HyperVElevatedNetworkSessionError(
                        "hyper-v-network-elevation-deadline-exceeded",
                    ));
                    else resolve();
                };
                const expire = () => {
                    const remaining = remainingMilliseconds();
                    if (remaining <= 0) {
                        finish(true);
                        return;
                    }
                    if (Number.isFinite(remaining)) timer = setTimeout(expire,
                        Math.max(1, Math.min(2_147_483_647, remaining)));
                };
                expire();
                previous.then(() => finish(remainingMilliseconds() <= 0), () => finish(true));
            });
        } else {
            await previous;
        }
        if (options?.remainingMilliseconds && options.remainingMilliseconds() <= 0) {
            throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-deadline-exceeded");
        }
        if (refusal) {
            releaseTurn();
            return await operation(HYPER_V_ELEVATION_SUPPRESSED_EXECUTOR);
        }
        return await elevate((settlement) => {
            const code = refusalFrom(settlement);
            if (code && !refusal) refusal = { code, at: Date.now() };
            releaseTurn();
        });
    } finally {
        releaseTurn();
    }
}

export function hyperVElevationGateStatus(): HyperVElevationGateStatus {
    return refusal
        ? { state: "refused", code: refusal.code, at: new Date(refusal.at).toISOString() }
        : { state: "never-asked" };
}

/** Test hook: forget any refusal and any attempt still holding the turn. */
export function resetHyperVElevationGateForTest(): void {
    refusal = null;
    turns = Promise.resolve();
}
