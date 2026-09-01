import { randomUUID } from "crypto";
import { mkdir, open, readFile, rename, rm } from "fs/promises";
import { homedir, hostname } from "os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

import { runHyperVWindowsLibraryScenario } from "./hyper-v-windows-library-real.ts";

export { verifiedHyperVWindowsLibraryFixturePath } from "./hyper-v-windows-library-real.ts";

const LOCK_FILE_LIMIT_BYTES = 16 * 1024;

type LockRecord = {
    readonly token: string;
    readonly pid: number;
    readonly host: string;
    readonly createdAt: string;
};

function lockPath(home = homedir()): string {
    return join(home, ".ccc", "devices", "test-runs", "real-provider.lock");
}

async function readLock(file: string): Promise<LockRecord | null> {
    try {
        const value = await readFile(file, "utf8");
        if (Buffer.byteLength(value, "utf8") > LOCK_FILE_LIMIT_BYTES) return null;
        const parsed = JSON.parse(value) as Partial<LockRecord>;
        return typeof parsed.token === "string"
            && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(parsed.token)
            && Number.isInteger(parsed.pid) && Number(parsed.pid) > 0
            && typeof parsed.host === "string" && parsed.host.length > 0
            && typeof parsed.createdAt === "string"
            ? parsed as LockRecord
            : null;
    } catch {
        return null;
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function moveIfTokenMatches(file: string, token: string, suffix: string): Promise<boolean> {
    const moved = `${file}.${randomUUID()}.${suffix}`;
    try {
        await rename(file, moved);
    } catch {
        return false;
    }
    const movedLock = await readLock(moved);
    if (movedLock?.token === token) {
        await rm(moved, { force: true });
        return true;
    }
    try {
        await rename(moved, file);
    } catch {
        // A new owner acquired the canonical path; retain the moved file as evidence.
    }
    return false;
}

export async function withExclusiveHyperVLibraryRun<T>(
    operation: () => Promise<T>,
    options: { readonly home?: string; readonly lockFile?: string } = {},
): Promise<T> {
    const file = options.lockFile ?? lockPath(options.home);
    const token = randomUUID();
    const record: LockRecord = {
        token,
        pid: process.pid,
        host: hostname(),
        createdAt: new Date().toISOString(),
    };
    await mkdir(dirname(file), { recursive: true });
    try {
        const handle = await open(file, "wx", 0o600);
        try {
            await handle.writeFile(JSON.stringify(record), "utf8");
        } finally {
            await handle.close();
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLock(file);
        if (existing && existing.host === record.host && !processIsAlive(existing.pid)
            && await moveIfTokenMatches(file, existing.token, "stale")) {
            return withExclusiveHyperVLibraryRun(operation, options);
        }
        const detail = existing ? `pid=${existing.pid}, host=${existing.host}, startedAt=${existing.createdAt}` : "owner metadata unavailable";
        throw new Error(`real-provider-test-already-running (${detail})`);
    }

    let result: T | undefined;
    let operationFailure: unknown = null;
    try {
        result = await operation();
    } catch (error) {
        operationFailure = error;
    }
    const released = await moveIfTokenMatches(file, token, "release");
    if (!released) {
        const releaseFailure = new Error("real-provider-lock-release-refused");
        if (operationFailure) {
            throw new AggregateError([operationFailure, releaseFailure], "operation failed and real-provider lock release was refused");
        }
        throw releaseFailure;
    }
    if (operationFailure) throw operationFailure;
    return result as T;
}

export type HyperVWindowsLibraryLauncherDependencies = {
    readonly platform?: NodeJS.Platform;
    readonly stdout?: Pick<NodeJS.WriteStream, "write">;
    readonly stderr?: Pick<NodeJS.WriteStream, "write">;
    readonly withExclusiveRealProviderRunImpl?: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
    readonly runScenarioImpl?: typeof runHyperVWindowsLibraryScenario;
    readonly signal?: AbortSignal;
};

export async function runHyperVWindowsLibraryLevel3(
    dependencies: HyperVWindowsLibraryLauncherDependencies = {},
): Promise<number> {
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;
    if ((dependencies.platform ?? process.platform) !== "win32") {
        stdout.write("SKIP level 3 Hyper-V Windows library real-host test: Windows host required\n");
        stdout.write("SUMMARY real-tests total=1 pass=0 skip=1 fail=0 failOnSkip=false\n");
        return 0;
    }

    const runScenario = dependencies.runScenarioImpl ?? runHyperVWindowsLibraryScenario;
    const withExclusive = dependencies.withExclusiveRealProviderRunImpl
        ?? ((_label, operation) => withExclusiveHyperVLibraryRun(operation));
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (dependencies.signal?.aborted) controller.abort();
    else dependencies.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    if (!dependencies.signal) {
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            const handler = () => controller.abort();
            signalHandlers.set(signal, handler);
            process.once(signal, handler);
        }
    }
    try {
        const steps = await withExclusive(
            "test:level3:hyper-v:windows:library",
            () => runScenario({
                platform: "win32",
                log: (message) => stdout.write(`${message}\n`),
                signal: controller.signal,
            }),
        );
        if (controller.signal.aborted) throw new Error("hyper-v-library-scenario-cancelled");
        stdout.write(`PASS level 3 Hyper-V Windows library real-host test (${steps.length} checks)\n`);
        stdout.write("SUMMARY real-tests total=1 pass=1 skip=0 fail=0 failOnSkip=false\n");
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderr.write(`FAIL level 3 Hyper-V Windows library real-host test: ${message}\n`);
        stderr.write("SUMMARY real-tests total=1 pass=0 skip=0 fail=1 failOnSkip=false\n");
        return 1;
    } finally {
        dependencies.signal?.removeEventListener("abort", onExternalAbort);
        for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
}

export function isHyperVWindowsLibrarySourceEntrypoint(modulePath: string, argvPath: string | undefined): boolean {
    return Boolean(argvPath)
        && basename(modulePath) === "hyper-v-windows-library.ts"
        && modulePath === argvPath;
}

const modulePath = fileURLToPath(import.meta.url);
const isMain = isHyperVWindowsLibrarySourceEntrypoint(modulePath, process.argv[1]);
if (isMain) process.exitCode = await runHyperVWindowsLibraryLevel3();
