import { createHash } from "crypto";
import { join } from "path";
import { getCodexConfigFile } from "./utils.js";
import { cccHome, locksDir, normalizeProfile } from "./home-layout.js";
import { withSharedMutationLock } from "@ccc/device-lab/device-lab-shared-state.js";

// Projects using the same resolved profile share one host-owned lock. Keep it
// outside the credential bind so container UIDs cannot displace the owner.
export function withCodexConfigLock<T>(operation: () => T, profile?: string): T {
    if (process.env.container === "docker") {
        throw new Error("Codex configuration cannot be changed from inside a container because the host configuration lock is unavailable. Run CCC from the host shell.");
    }
    const key = createHash("sha256").update(getCodexConfigFile(profile)).digest("hex");
    // Older CCC releases already use this stable default-profile fence. Keep
    // sharing it while old invocations finish, including after layout migration.
    const lock = normalizeProfile(profile) === undefined
        ? join(cccHome(), "codex-config.lock")
        : join(locksDir(), `codex-config-${key}.lock`);
    return withSharedMutationLock(lock, operation, { waitMs: 300_000, reclaimStale: false });
}
