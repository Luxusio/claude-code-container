import { lstatSync, readdirSync } from "fs";

export class DeviceLabProjectEnumerationError extends Error {
    readonly code = "project-namespace-read-failed";

    constructor(cause?: unknown) {
        super("Failed to enumerate device project namespaces");
        this.name = "DeviceLabProjectEnumerationError";
        this.cause = cause;
    }
}

export function deviceLabProjectEnumerationErrorCode(error: unknown): string | null {
    return error instanceof DeviceLabProjectEnumerationError ? error.code : null;
}

export function enumerateDeviceProjectIds(root: string, acceptName: (name: string) => boolean = () => true): string[] {
    let rootObserved = false;
    try {
        const before = lstatSync(root);
        rootObserved = true;
        if (!before.isDirectory() || before.isSymbolicLink()) {
            throw new Error("invalid-project-namespace-root");
        }
        const entries = readdirSync(root, { withFileTypes: true });
        if (entries.some((entry) => entry.isSymbolicLink())) {
            throw new Error("linked-project-namespace");
        }
        const after = lstatSync(root);
        if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
            throw new Error("project-namespace-root-changed");
        }
        return entries
            .filter((entry) => entry.isDirectory() && acceptName(entry.name))
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        if (!rootObserved && (error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        if (error instanceof DeviceLabProjectEnumerationError) throw error;
        throw new DeviceLabProjectEnumerationError(error);
    }
}
