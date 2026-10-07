import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { locksDir } from "./home-layout.js";
import { join } from "path";
import { getRuntimeInfo, runtimeCli, runtimeExtraRunArgs, type RuntimeInfo } from "./container-runtime.js";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";

export const IDENTITY_CONTRACT_VERSION = "1";
const IDENTITY_BUILD_TIMEOUT_MS = 1_200_000;
// Cold ownership copy-up and layer export can exceed ten minutes. Give
// concurrent callers another minute for the final tag/account validation.
const IDENTITY_LOCK_WAIT_MS = IDENTITY_BUILD_TIMEOUT_MS + 60_000;

/** Docker prefixes image IDs; Podman can report the same digest as bare hex. */
export function normalizeImageId(imageId: string): string {
    const match = /^(?:sha256:)?([a-f0-9]{64})$/.exec(imageId);
    if (!match) throw new Error("Container identity requires an immutable sha256 image ID.");
    return `sha256:${match[1]}`;
}

export interface ContainerIdentity {
    uid: number;
    gid: number;
    mapping: "host" | "podman-keep-id" | "desktop";
    contractVersion: string;
}

function validateId(value: number | undefined, name: string): asserts value is number {
    if (!Number.isSafeInteger(value) || value! <= 0 || value! >= 4294967295) {
        throw new Error(`Invalid host ${name}: ${value}. Run CCC as a non-root user with a valid UID and GID.`);
    }
}

export function resolveContainerIdentity(
    runtime: RuntimeInfo = getRuntimeInfo(),
    platform: NodeJS.Platform = process.platform,
    uid: number | undefined = process.geteuid?.(),
    gid: number | undefined = process.getegid?.(),
): ContainerIdentity {
    if (runtime.runtime === "docker" && (runtime.rootless || runtime.flavor === "docker-rootless")) {
        throw new Error("Rootless Docker identity mapping is unsupported. Use rootful Docker or rootless Podman to preserve project ownership.");
    }
    if (runtime.runtime === "podman" && (runtime.rootless || runtime.flavor === "podman-machine")) {
        return { uid: 1000, gid: 1000, mapping: "podman-keep-id", contractVersion: IDENTITY_CONTRACT_VERSION };
    }
    if (platform !== "linux") {
        return { uid: 1000, gid: 1000, mapping: "desktop", contractVersion: IDENTITY_CONTRACT_VERSION };
    }
    // WSL Linux files retain numeric ownership even with Docker Desktop.
    validateId(uid, "UID");
    validateId(gid, "GID");
    return { uid, gid, mapping: "host", contractVersion: IDENTITY_CONTRACT_VERSION };
}

export function getIdentityLabels(identity: ContainerIdentity): Record<string, string> {
    return {
        "ccc.identity.version": identity.contractVersion,
        "ccc.identity.uid": String(identity.uid),
        "ccc.identity.gid": String(identity.gid),
        "ccc.identity.mapping": identity.mapping,
    };
}

export function getIdentityMiseVolumeName(identity: ContainerIdentity): string {
    return `ccc-mise-cache-v${identity.contractVersion}-${identity.mapping}-${identity.uid}-${identity.gid}`;
}

export function getIdentityCodexPackagesVolumeName(identity: ContainerIdentity): string {
    return `ccc-codex-packages-v${identity.contractVersion}-${identity.mapping}-${identity.uid}-${identity.gid}`;
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

function validatedImage(name: string, labels: Record<string, string>, identity: ContainerIdentity): string | null {
    const result = spawnSync(runtimeCli(), ["image", "inspect", name], { encoding: "utf-8", timeout: 30_000 });
    if (result.error || result.status !== 0) return null;
    try {
        const [image] = JSON.parse(result.stdout);
        normalizeImageId(image.Id);
        if (image.Config?.User !== "ccc") return null;
        if (!Object.entries(labels).every(([key, value]) => image.Config.Labels?.[key] === value)) return null;
        const script = 'set -eu; test "$(id -un)" = ccc; test "$(getent passwd ccc | cut -d: -f6)" = /home/ccc; test "$(getent group ccc | cut -d: -f3)" = "$(id -g)"; sudo -n true; printf "%s:%s:%s:ccc\\n" "$(id -u)" "$(id -g)" "$HOME"';
        const observed = checked(["run", "--rm", "--network", "none", ...runtimeExtraRunArgs(), "--user", "ccc", "--entrypoint", "/bin/sh", image.Id, "-c", script]);
        return observed === `${identity.uid}:${identity.gid}:/home/ccc:ccc` ? image.Id : null;
    } catch {
        return null;
    }
}

/** Build-time account changes have no access to projects or credentials. */
export function ensureIdentityImage(baseImageId: string, identity: ContainerIdentity): string {
    const canonicalBaseId = normalizeImageId(baseImageId);
    validateId(identity.uid, "UID");
    validateId(identity.gid, "GID");
    if (!/^[a-zA-Z0-9.-]+$/.test(identity.contractVersion) || !["host", "podman-keep-id", "desktop"].includes(identity.mapping)) {
        throw new Error("Invalid container identity contract.");
    }
    const labels = { ...getIdentityLabels(identity), "ccc.identity.base": canonicalBaseId };
    const key = createHash("sha256").update(JSON.stringify(labels)).digest("hex");
    const name = `ccc-identity:${key}`;
    const lock = join(locksDir(), `identity-${key}.lock`);
    return withSharedMutationLock(lock, () => {
        const cached = validatedImage(name, labels, identity);
        if (cached) return cached;
        // FROM sha256:<id> is parsed as a registry name by some builders.
        // A content-addressed local tag works with Docker and Podman.
        const baseTag = `ccc-identity-base:${canonicalBaseId.slice(7)}`;
        checked(["tag", baseImageId, baseTag]);
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
        const built = validatedImage(name, labels, identity);
        if (!built) {
            // Remove only this derived tag, never the base or another image.
            checked(["image", "rm", name]);
            throw new Error("Built container identity image failed UID/GID, HOME, sudo or named-user validation. Retry after correcting the base image.");
        }
        return built;
    }, { waitMs: IDENTITY_LOCK_WAIT_MS, reclaimStale: false });
}
