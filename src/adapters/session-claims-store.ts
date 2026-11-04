import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import type { NativeSessionFileReceipt } from "../ports/session-claim-observation.js";
import type { SessionOwnershipReceipt } from "../ports/session-ownership.js";
import { sessionLockOwner } from "../domain/session-lock.js";
import { captureNativeSessionFile, captureNativeSessionOwnership, nativeSessionOwnershipMatches,
    removeCapturedNativeSessionOwnership } from "./session-ownership.js";

export function createSessionClaimsStore(location: { directory(): string; platform(): string }) {
    return {
        ensureDirectory(): undefined {
            mkdirSync(location.directory(), { recursive: true, mode: 0o700 });
            const observed = lstatSync(location.directory());
            if (!observed.isDirectory() || observed.isSymbolicLink()) {
                throw new Error("CCC session lock path must be a real directory");
            }
            if (location.platform() !== "win32") chmodSync(location.directory(), 0o700);
            return undefined;
        },
        listEntries(): string[] {
            return readdirSync(location.directory());
        },
        claimPath(name: string): string {
            return join(location.directory(), name);
        },
        claimName(path: string): string {
            return basename(path);
        },
        readClaim(name: string): string {
            return Buffer.from(captureNativeSessionFile(join(location.directory(), name), 4096).bytes, "base64").toString("utf8");
        },
        captureClaim(name: string) {
            const receipt = captureNativeSessionOwnership(join(location.directory(), name));
            return { receipt, content: Buffer.from(receipt.bytes, "base64").toString("utf8") };
        },
        matchesClaim: nativeSessionOwnershipMatches,
        retireClaim: removeCapturedNativeSessionOwnership,
        // The caller holds the lifecycle guard and has rechecked the owner is dead.
        // Sidecars are disposable after main revocation, irrespective of their JSON.
        retireStaleClaim(receipt: SessionOwnershipReceipt): undefined {
            const sidecars: NativeSessionFileReceipt[] = [];
            for (const [suffix, maximum] of [[".guardian.json", 16384], [".runtime.json", 65536]] as const) {
                try { sidecars.push(captureNativeSessionFile(receipt.path + suffix, maximum)); }
                catch { /* Missing, unreadable or oversized auxiliaries cannot keep a dead claim alive. */ }
            }
            removeCapturedNativeSessionOwnership(receipt);
            for (const captured of sidecars) {
                try {
                    try { lstatSync(receipt.path); return undefined; }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
                    const current = captureNativeSessionFile(captured.path, 65536);
                    if (current.bytes === captured.bytes && current.device === captured.device
                        && current.inode === captured.inode && current.birthtime === captured.birthtime) unlinkSync(captured.path);
                } catch { /* Main revocation is complete; preserve any changed auxiliary or successor. */ }
            }
            return undefined;
        },
        writeClaim(path: string, content: string): undefined {
            writeFileSync(path, content, { mode: 0o600, flag: "wx" });
            return undefined;
        },
        removeClaim(path: string): undefined {
            const receipt = captureNativeSessionOwnership(path);
            const owner = sessionLockOwner(Buffer.from(receipt.bytes, "base64").toString("utf8"));
            if (owner?.ownershipKind !== "direct" || owner.pid !== process.pid) {
                throw new Error("session-cleanup-responsibility-incomplete: Monitored or uncertain claims require qualified responsibility settlement.");
            }
            removeCapturedNativeSessionOwnership(receipt);
            return undefined;
        },
    };
}
