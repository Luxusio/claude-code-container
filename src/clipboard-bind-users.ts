import { spawnSync } from "child_process";
import { realpathSync } from "fs";
import { isAbsolute, relative, sep } from "path";
import { runtimeCli } from "./container-runtime.js";

/** A legacy daemon unlinks its port file on exit. Unknown mount users defer exit. */
export function clipboardPortMayHaveBindUsers(portFile: string): boolean {
    try {
        const port = realpathSync(portFile);
        const runtime = runtimeCli();
        const options = { encoding: "utf-8" as const, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 };
        const listed = spawnSync(runtime, ["ps", "-q", "--no-trunc"], options);
        if (listed.error || listed.status !== 0 || typeof listed.stdout !== "string") return true;
        const ids = listed.stdout.trim() ? listed.stdout.trim().split(/\s+/) : [];
        if (ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) return true;
        if (!ids.length) return false;
        const inspected = spawnSync(runtime, ["inspect", ...ids], options);
        if (inspected.error || inspected.status !== 0 || typeof inspected.stdout !== "string") return true;
        const containers = JSON.parse(inspected.stdout);
        if (!Array.isArray(containers) || containers.length !== ids.length) return true;
        const remaining = new Set(ids);
        for (const container of containers) {
            if (!container || !remaining.delete(container.Id) || typeof container.State?.Running !== "boolean" || !Array.isArray(container.Mounts)) return true;
            if (!container.State.Running) continue;
            for (const mount of container.Mounts) {
                if (!mount || !["bind", "volume", "tmpfs", "npipe"].includes(mount.Type) || typeof mount.Destination !== "string" || !mount.Destination) return true;
                if (mount.Type !== "bind") continue;
                if (typeof mount.Source !== "string" || !isAbsolute(mount.Source)) return true;
                // Desktop opaque aliases and inaccessible sources cannot establish
                // absence of users. Never guess their host-side translations.
                const source = realpathSync(mount.Source);
                const suffix = relative(source, port);
                if (!suffix || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) return true;
            }
        }
        return remaining.size !== 0;
    } catch {
        return true;
    }
}
