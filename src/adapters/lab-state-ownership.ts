import { spawnSync } from "child_process";
import { runtimeCli, runtimeExtraRunArgs } from "../container-runtime.js";
import { normalizeImageId } from "../container-identity.js";
import type { LabOwnershipHelperScope } from "../domain/container/lab-state-ownership.js";
import type { LabStateOwnershipPorts } from "../ports/container/lab-state-ownership.js";

/** Native commands and decoding for one synchronous retained-state preparation. */
export function createNativeLabStateOwnershipPorts(): LabStateOwnershipPorts {
    return {
        normalizeImageId,
        observeVolume(volume) {
            const listed = spawnSync(runtimeCli(), ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf-8", timeout: 300_000 });
            if (listed.error || listed.status !== 0) return "unavailable";
            return listed.stdout.split("\n").includes(volume) ? "present" : "absent";
        },
        observeVolumeUsers(selected) {
            const users = spawnSync(runtimeCli(), ["ps", "-q", "--filter", `volume=${selected}`], { encoding: "utf-8", timeout: 300_000 });
            if (users.error || users.status !== 0) return "unavailable";
            return users.stdout.trim() ? "in-use" : "idle";
        },
        captureHelperScope: () => ["run", "--rm", "--network", "none", ...runtimeExtraRunArgs(), "--entrypoint", "/bin/sh"] as unknown as LabOwnershipHelperScope,
        observePreviousAccount(scope, selectedImage) {
            const runArgs = scope as unknown as string[];
            const old = spawnSync(runtimeCli(), [...runArgs, "--user", "ccc", selectedImage, "-c", 'printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"'], { encoding: "utf-8", timeout: 300_000 });
            const match = !old.error && old.status === 0 ? /^(\d+):(\d+)$/.exec(old.stdout.trim()) : null;
            if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0 || Number(match[1]) >= 0xffffffff || Number(match[2]) >= 0xffffffff) return { kind: "unavailable" };
            return { kind: "known", principal: { uid: Number(match[1]), gid: Number(match[2]) } };
        },
        applyOwnership(scope, selected, selectedImage, principal, intent) {
            const runArgs = scope as unknown as string[];
            // The helper receives only a named volume, never a host or credential bind.
            // Without an old container/image, do not guess ownership from the volume root.
            const script = intent.kind === "migrate"
                ? `set -eu; find -P /state -xdev -uid ${intent.oldUid} -exec chown -h ${principal.uid} {} +; find -P /state -xdev -gid ${intent.oldGid} -exec chgrp -h ${principal.gid} {} +; chown ${principal.uid}:${principal.gid} /state`
                : `test "$(stat -c %u:%g /state)" = ${principal.uid}:${principal.gid}`;
            const repaired = spawnSync(runtimeCli(), [...runArgs, "--user", "root", "--mount", `type=volume,source=${selected},target=/state`, selectedImage, "-c", script], { encoding: "utf-8", timeout: 300_000 });
            return repaired.error || repaired.status !== 0 ? "unconfirmed" : "applied";
        },
    };
}
