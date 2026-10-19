import { chmodSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
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
