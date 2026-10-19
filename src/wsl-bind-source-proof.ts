import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getRuntimeInfo, getRuntimeInvocation, bindNativeRuntimeInvocation, type BoundNativeRuntimeRunner } from "./container-runtime.js";
import { cccHome } from "./home-layout.js";
import { beginRuntimeBindCreation, settleRuntimeBindCreation, withRuntimeBindGuard } from "./adapters/runtime-bind-authority.js";
import type { RuntimeBindGuard } from "./ports/runtime-bind-authority.js";

export interface BindSourceIdentity {
    dev: string | number | bigint;
    ino: string | number | bigint;
}

function numericIdentity(value: string | number | bigint): string | null {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    const text = String(value);
    return /^(0|[1-9][0-9]*)$/.test(text) ? text : null;
}

/**
 * Read daemon-reported WSL opaque bind metadata through a disposable helper.
 * True = exact identity; false = different identity; null = unsupported/unproven.
 * Caller must revalidate the trusted host object before/after and retain its
 * normal live mount challenge. Labels and path strings alone never prove identity.
 */
export function proveWslBindSourceIdentity(source: string, expected: BindSourceIdentity, imageId: string, bindGuard?: RuntimeBindGuard): boolean | null {
    try {
        const invocation = getRuntimeInvocation();
        const runner: BoundNativeRuntimeRunner = bindNativeRuntimeInvocation(invocation);
        const info = getRuntimeInfo();
        if (process.platform !== "linux" || info.runtime !== "docker" || !info.dockerDesktop || info.rootless
            || !/microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf-8"))) return null;
        if (!/^\/run\/desktop\/mnt\/host\/wsl\/docker-desktop-bind-mounts\/[A-Za-z0-9_.-]+\/[a-f0-9]{64}$/.test(source)
            || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return null;
        const dev = numericIdentity(expected.dev);
        const ino = numericIdentity(expected.ino);
        if (dev === null || ino === null) return null;
        const prove = (guard: RuntimeBindGuard): boolean | null => {
            if (guard.root !== cccHome()) return null;
            const scratch = mkdtempSync(join(tmpdir(), "ccc-wsl-bind-proof-"));
            try {
                const ticket = beginRuntimeBindCreation(guard, invocation);
                let result: ReturnType<BoundNativeRuntimeRunner["spawnSync"]>;
                try {
                    result = runner.spawnSync([
                        "run", "--rm", "--cidfile", join(scratch, "cid"), "--network", "none", "--read-only",
                        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0",
                        "--mount", `type=bind,source=${source},target=/ccc-bind-proof,readonly`,
                        "--entrypoint", "/usr/bin/stat", imageId, "-c", "%d:%i", "--", "/ccc-bind-proof",
                    ], { encoding: "utf-8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 4096 });
                } finally {
                    // An interrupted client may still have created its helper.
                    // Keep exact cleanup inside the guard, without inferring that
                    // an interrupted native creation request has settled.
                    try {
                        const cid = readFileSync(join(scratch, "cid"), "utf-8").trim();
                        if (/^[a-f0-9]{64}$/.test(cid)) {
                            runner.spawnSync(["rm", "-f", cid], {
                                encoding: "utf-8", timeout: 5000, killSignal: "SIGKILL", stdio: "ignore",
                            });
                        }
                    } catch { /* Missing CID or failed cleanup never grants settlement. */ }
                }
                if (result.error || result.status !== 0) return null;
                // A completed bound --rm request is positive creation settlement;
                // any remaining AutoRemove metadata is visible to ps -aq.
                settleRuntimeBindCreation(guard, ticket);
                if (typeof result.stdout !== "string") return null;
                const observed = result.stdout.trim();
                if (!/^[0-9]+:[0-9]+$/.test(observed)) return null;
                return observed === `${dev}:${ino}`;
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        };
        // A proof can be requested while its caller owns a lifecycle lock. It
        // must not wait for the global→lifecycle order used by ordinary startup.
        return bindGuard ? prove(bindGuard) : withRuntimeBindGuard(cccHome(), prove, { waitMs: 0 });
    } catch {
        return null;
    }
}
