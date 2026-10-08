import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { locksDir } from "./home-layout.js";
import { join } from "path";
import { getRuntimeInfo, runtimeCli, runtimeExtraRunArgs, type RuntimeInfo } from "./container-runtime.js";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";

import { prepareIdentityImage } from "./application/container/identity-image.js";
import { resolveIdentity, type ContainerIdentity, type IdentityImageObservation } from "./domain/container/identity-image.js";
export { IDENTITY_CONTRACT_VERSION, normalizeImageId, getIdentityLabels, getIdentityMiseVolumeName, getIdentityCodexPackagesVolumeName } from "./domain/container/identity-image.js";
export type { ContainerIdentity } from "./domain/container/identity-image.js";

const IDENTITY_BUILD_TIMEOUT_MS = 1_200_000;
// Cold ownership copy-up and layer export can exceed ten minutes. Give
// concurrent callers another minute for the final tag/account validation.
const IDENTITY_LOCK_WAIT_MS = IDENTITY_BUILD_TIMEOUT_MS + 60_000;

export function resolveContainerIdentity(
    runtime: RuntimeInfo = getRuntimeInfo(),
    platform: NodeJS.Platform = process.platform,
    uid: number | undefined = process.geteuid?.(),
    gid: number | undefined = process.getegid?.(),
): ContainerIdentity {
    return resolveIdentity(runtime, platform, uid, gid);
}

function checked(args: string[], input?: string): string {
    const timeout = args[0] === "build" ? IDENTITY_BUILD_TIMEOUT_MS : 600_000;
    const result = spawnSync(runtimeCli(), args, { encoding: "utf-8", input, timeout, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
        const detail = result.error?.message || `exit ${result.status}`;
        const recentStderr = result.stderr?.trim().slice(-4096);
        throw new Error(`Container identity ${args[0]} failed: ${detail}${recentStderr ? `\n${recentStderr}` : ""}`);
    }
    return result.stdout.trim();
}

function inspectImage(name: string): IdentityImageObservation | null {
    const result = spawnSync(runtimeCli(), ["image", "inspect", name], { encoding: "utf-8", timeout: 30_000 });
    if (result.error || result.status !== 0) return null;
    try {
        const [image] = JSON.parse(result.stdout);
        return image;
    } catch {
        return null;
    }
}

function observeAccount(image: IdentityImageObservation): string {
    const script = 'set -eu; test "$(id -un)" = ccc; test "$(getent passwd ccc | cut -d: -f6)" = /home/ccc; test "$(getent group ccc | cut -d: -f3)" = "$(id -g)"; sudo -n true; printf "%s:%s:%s:ccc\\n" "$(id -u)" "$(id -g)" "$HOME"';
    return checked(["run", "--rm", "--network", "none", ...runtimeExtraRunArgs(), "--user", "ccc", "--entrypoint", "/bin/sh", image.Id, "-c", script]);
}

function buildImage(baseTag: string, name: string, identity: ContainerIdentity, labels: Record<string, string>): undefined {
    const { uid, gid } = identity;
    const reconcile = [
        "set -eu",
        'old_uid=$(id -u ccc)',
        'old_gid=$(id -g ccc)',
        `collision=$(getent passwd ${uid} | cut -d: -f1 || true)`,
        'if [ -n "$collision" ] && [ "$collision" != ccc ]; then ' +
            `if [ "${uid}" = 1000 ] && [ "$collision" = ubuntu ] && [ "$(getent passwd ubuntu | cut -d: -f6)" = /home/ubuntu ]; then userdel ubuntu; ` +
            'else echo "Target UID belongs to an unrelated image account" >&2; exit 1; fi; fi',
        `groupmod -o -g ${gid} ccc`,
        `usermod -u ${uid} -g ccc ccc`,
        // usermod can update HOME first. Track old IDs before changing
        // either account; only matching owners/groups are reconciled.
        'for dir in /home/ccc /opt/ccc /host-stage; do if [ -d "$dir" ] && [ ! -L "$dir" ]; then ' +
            `if [ "$old_uid" != "${uid}" ]; then find -P "$dir" -xdev -uid "$old_uid" -exec chown -h ${uid} {} +; fi; ` +
            `if [ "$old_gid" != "${gid}" ]; then find -P "$dir" -xdev -gid "$old_gid" -exec chgrp -h ${gid} {} +; fi; fi; done`,
        `test "$(id -u ccc)" = ${uid}`,
        `test "$(id -g ccc)" = ${gid}`,
        'test "$(getent passwd ccc | cut -d: -f6)" = /home/ccc',
    ].join("; ");
    const dockerfile = [
        `FROM ${baseTag}`,
        "USER root",
        `RUN ${reconcile}`,
        "ENV HOME=/home/ccc",
        ...Object.entries(labels).map(([key, value]) => `LABEL ${key}="${value}"`),
        "USER ccc",
        "",
    ].join("\n");
    checked(["build", "--pull=false", "-t", name, "-"], dockerfile);
    return undefined;
}

/** Build-time account changes have no access to projects or credentials. */
export function ensureIdentityImage(baseImageId: string, identity: ContainerIdentity): string {
    return prepareIdentityImage(baseImageId, identity, {
        captureLabelsDigest: () => {
            const hash = createHash("sha256");
            const update: (data: string) => typeof hash = hash.update;
            return serialized => update.call(hash, serialized).digest("hex");
        },
        withIdentityLock: (key, operation) => {
            const lock = join(locksDir(), `identity-${key}.lock`);
            return withSharedMutationLock(lock, operation, { waitMs: IDENTITY_LOCK_WAIT_MS, reclaimStale: false });
        },
        inspectImage,
        observeAccount,
        tagBase: (originalBaseId, baseTag) => {
            checked(["tag", originalBaseId, baseTag]);
            return undefined;
        },
        buildImage,
        removeDerivedImage: name => {
            checked(["image", "rm", name]);
            return undefined;
        },
    });
}
