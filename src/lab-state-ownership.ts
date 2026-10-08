import { spawnSync } from "child_process";
import { runtimeCli, runtimeExtraRunArgs } from "./container-runtime.js";
import { normalizeImageId, type ContainerIdentity } from "./container-identity.js";
import { createLabStateOwnershipPreparation } from "./application/container/lab-state-ownership.js";
import type { LabOwnershipHelperScope } from "./domain/container/lab-state-ownership.js";

/** Caller holds the shared startup lock; only this exact named volume is mounted. */
export function prepareLabStateOwnership(volume: string, imageId: string, identity: ContainerIdentity, previousImage?: string): void {
    createLabStateOwnershipPreparation({
        normalizeImageId,
        listVolumeNames: () => spawnSync(runtimeCli(), ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf-8", timeout: 300_000 }),
        observeVolumeUsers: selected => spawnSync(runtimeCli(), ["ps", "-q", "--filter", `volume=${selected}`], { encoding: "utf-8", timeout: 300_000 }),
        captureHelperScope: () => ["run", "--rm", "--network", "none", ...runtimeExtraRunArgs(), "--entrypoint", "/bin/sh"] as unknown as LabOwnershipHelperScope,
        observePreviousAccount(scope, selectedImage) {
            const runArgs = scope as unknown as string[];
            return spawnSync(runtimeCli(), [...runArgs, "--user", "ccc", selectedImage, "-c", 'printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"'], { encoding: "utf-8", timeout: 300_000 });
        },
        applyOwnership(scope, selected, selectedImage, principal, intent) {
            const runArgs = scope as unknown as string[];
            // The helper receives only a named volume, never a host or credential bind.
            // Without an old container/image, do not guess ownership from the volume root.
            const script = intent.kind === "migrate"
                ? `set -eu; find -P /state -xdev -uid ${intent.oldUid} -exec chown -h ${principal.uid} {} +; find -P /state -xdev -gid ${intent.oldGid} -exec chgrp -h ${principal.gid} {} +; chown ${principal.uid}:${principal.gid} /state`
                : `test "$(stat -c %u:%g /state)" = ${principal.uid}:${principal.gid}`;
            return spawnSync(runtimeCli(), [...runArgs, "--user", "root", "--mount", `type=volume,source=${selected},target=/state`, selectedImage, "-c", script], { encoding: "utf-8", timeout: 300_000 });
        },
    }).run(volume, imageId, identity, previousImage);
}
