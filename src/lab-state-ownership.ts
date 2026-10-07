import { spawnSync } from "child_process";
import { runtimeCli, runtimeExtraRunArgs } from "./container-runtime.js";
import { normalizeImageId, type ContainerIdentity } from "./container-identity.js";

/** Caller holds the shared startup lock; only this exact named volume is mounted. */
export function prepareLabStateOwnership(volume: string, imageId: string, identity: ContainerIdentity, previousImage?: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) throw new Error("Invalid lab state volume name.");
    imageId = normalizeImageId(imageId);
    if (previousImage) previousImage = normalizeImageId(previousImage);
    const listed = spawnSync(runtimeCli(), ["volume", "ls", "--format", "{{.Name}}"], { encoding: "utf-8", timeout: 300_000 });
    if (listed.error || listed.status !== 0) throw new Error("Unable to inspect lab state volumes.");
    if (!listed.stdout.split("\n").includes(volume)) return;
    const users = spawnSync(runtimeCli(), ["ps", "-q", "--filter", `volume=${volume}`], { encoding: "utf-8", timeout: 300_000 });
    if (users.error || users.status !== 0 || users.stdout.trim()) throw new Error(`Lab state volume ${volume} may be in use; finish its running work before retrying.`);
    const runArgs = ["run", "--rm", "--network", "none", ...runtimeExtraRunArgs(), "--entrypoint", "/bin/sh"];
    let oldUid = identity.uid;
    let oldGid = identity.gid;
    if (previousImage) {
        const old = spawnSync(runtimeCli(), [...runArgs, "--user", "ccc", previousImage, "-c", 'printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"'], { encoding: "utf-8", timeout: 300_000 });
        const match = !old.error && old.status === 0 ? /^(\d+):(\d+)$/.exec(old.stdout.trim()) : null;
        if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0 || Number(match[1]) >= 0xffffffff || Number(match[2]) >= 0xffffffff) throw new Error(`Cannot establish previous lab state owner for ${volume}; no ownership was changed.`);
        oldUid = Number(match[1]);
        oldGid = Number(match[2]);
    }
    // The helper receives only a named volume, never a host or credential bind.
    // Without an old container/image, do not guess ownership from the volume root.
    const script = previousImage
        ? `set -eu; find -P /state -xdev -uid ${oldUid} -exec chown -h ${identity.uid} {} +; find -P /state -xdev -gid ${oldGid} -exec chgrp -h ${identity.gid} {} +; chown ${identity.uid}:${identity.gid} /state`
        : `test "$(stat -c %u:%g /state)" = ${identity.uid}:${identity.gid}`;
    const repaired = spawnSync(runtimeCli(), [...runArgs, "--user", "root", "--mount", `type=volume,source=${volume},target=/state`, imageId, "-c", script], { encoding: "utf-8", timeout: 300_000 });
    if (repaired.error || repaired.status !== 0) throw new Error(`Lab state ownership preparation failed for ${volume}. Existing data was retained; repair its ownership before retrying.`);
}
