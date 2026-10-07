import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getRuntimeInfo, runtimeCli } from "./container-runtime.js";

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
export function proveWslBindSourceIdentity(source: string, expected: BindSourceIdentity, imageId: string): boolean | null {
    let scratch: string | undefined;
    let runtime: string | undefined;
    try {
        const info = getRuntimeInfo();
        if (process.platform !== "linux" || info.runtime !== "docker" || !info.dockerDesktop || info.rootless
            || !/microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf-8"))) return null;
        if (!/^\/run\/desktop\/mnt\/host\/wsl\/docker-desktop-bind-mounts\/[A-Za-z0-9_.-]+\/[a-f0-9]{64}$/.test(source)
            || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return null;
        const dev = numericIdentity(expected.dev);
        const ino = numericIdentity(expected.ino);
        if (dev === null || ino === null) return null;
        runtime = runtimeCli();
        scratch = mkdtempSync(join(tmpdir(), "ccc-wsl-bind-proof-"));
        const result = spawnSync(runtime, [
            "run", "--rm", "--cidfile", join(scratch, "cid"), "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0",
            "--mount", `type=bind,source=${source},target=/ccc-bind-proof,readonly`,
            "--entrypoint", "/usr/bin/stat", imageId, "-c", "%d:%i", "--", "/ccc-bind-proof",
        ], { encoding: "utf-8", timeout: 15_000, maxBuffer: 4096 });
        if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
        const observed = result.stdout.trim();
        if (!/^[0-9]+:[0-9]+$/.test(observed)) return null;
        return observed === `${dev}:${ino}`;
    } catch {
        return null;
    } finally {
        if (scratch) {
            // A timed-out Docker client may leave its helper alive. Only remove
            // the exact ID written by this invocation into our private directory.
            try {
                const cid = readFileSync(join(scratch, "cid"), "utf-8").trim();
                if (runtime && /^[a-f0-9]{64}$/.test(cid)) {
                    spawnSync(runtime, ["rm", "-f", cid], { encoding: "utf-8", timeout: 5000, stdio: "ignore" });
                }
            } catch { /* --rm may already have completed, or creation never succeeded. */ }
            rmSync(scratch, { recursive: true, force: true });
        }
    }
}
