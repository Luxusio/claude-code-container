import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { withSharedMutationLock, writeJsonFileAtomically } from "../device-lab-shared-state.js";

const repoRoot = join(__dirname, "../..");
const sharedStateModule = pathToFileURL(join(repoRoot, "src", "device-lab-shared-state.ts")).href;
const mcpSharedStateModule = pathToFileURL(join(repoRoot, "device-lab-mcp", "src", "state", "shared-mutation-lock.mjs")).href;
const roots: string[] = [];

type Phase = "lock-held" | "temp-written" | "renamed";
type State = { devices: Array<{ id: string; generation: number; recovered?: boolean }> };
type SharedStateApi = {
    withSharedMutationLock<T>(file: string, operation: () => T, options?: { waitMs?: number; staleMs?: number }): T;
    writeJsonFileAtomically(file: string, value: unknown): void;
};

const implementations: Array<{ name: string; moduleUrl: string; load: () => Promise<SharedStateApi> }> = [
    {
        name: "host state writer",
        moduleUrl: sharedStateModule,
        load: async () => ({ withSharedMutationLock, writeJsonFileAtomically }),
    },
    {
        name: "packaged MCP state writer",
        moduleUrl: mcpSharedStateModule,
        load: async () => await import(mcpSharedStateModule) as SharedStateApi,
    },
];

function waitForReady(child: ChildProcess): Promise<{ temporaryFile: string | null }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("crash fixture did not reach its requested phase")), 10000);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("message", (message) => {
            clearTimeout(timer);
            resolve(message as { temporaryFile: string | null });
        });
        child.once("exit", (status, signal) => {
            clearTimeout(timer);
            reject(new Error(`crash fixture exited before ready: status=${status} signal=${signal}`));
        });
    });
}

function stopChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("crash fixture did not terminate")), 10000);
        child.once("close", () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill("SIGKILL");
    });
}

function spawnCrashFixture(moduleUrl: string, phase: Phase, stateFile: string, lockFile: string, nextState: State): ChildProcess {
    const script = `
        import { existsSync, readFileSync, writeFileSync } from "fs";
        import { withSharedMutationLock, writeJsonFileAtomically } from ${JSON.stringify(moduleUrl)};
        const [phase, stateFile, lockFile, nextJson] = process.argv.slice(1);
        const generation = (file) => JSON.parse(readFileSync(file, "utf8")).devices.find((device) => device.id === "target")?.generation;
        withSharedMutationLock(lockFile, () => {
            const lock = JSON.parse(readFileSync(lockFile, "utf8"));
            if (!existsSync(lockFile) || lock.pid !== process.pid || generation(stateFile) !== 1) {
                throw new Error("lock-held phase was not established");
            }
            let temporaryFile = null;
            if (phase === "temp-written") {
                temporaryFile = stateFile + "." + process.pid + ".0123456789abcdef.tmp";
                writeFileSync(temporaryFile, nextJson, { flag: "wx", mode: 0o600 });
                if (!existsSync(temporaryFile) || readFileSync(temporaryFile, "utf8") !== nextJson || generation(stateFile) !== 1) {
                    throw new Error("temp-written phase was not established");
                }
            } else if (phase === "renamed") {
                writeJsonFileAtomically(stateFile, JSON.parse(nextJson));
                if (generation(stateFile) !== 2) throw new Error("renamed phase was not established");
            }
            process.send({ temporaryFile, generation: generation(stateFile), lockPid: lock.pid });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }, { waitMs: 2000, staleMs: 100 });
    `;
    return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, phase, stateFile, lockFile, JSON.stringify(nextState)], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
    });
}

function readState(file: string): State {
    return JSON.parse(readFileSync(file, "utf8")) as State;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("device-lab state crash recovery", () => {
    for (const implementation of implementations) {
        for (const phase of ["lock-held", "temp-written", "renamed"] as const) {
            it(`${implementation.name} recovers after termination while ${phase}`, async () => {
                const api = await implementation.load();
                const root = mkdtempSync(join(tmpdir(), "ccc-state-crash-"));
                roots.push(root);
                const stateFile = join(root, ".ccc", "devices", "owners", "owner-a", "android", "devices.json");
                const lockFile = join(dirname(stateFile), "devices.mutation.lock");
                const oldState: State = { devices: [{ id: "target", generation: 1 }, { id: "unrelated", generation: 7 }] };
                const nextState: State = { devices: [{ id: "target", generation: 2 }, { id: "unrelated", generation: 7 }] };
                api.writeJsonFileAtomically(stateFile, oldState);

                const child = spawnCrashFixture(implementation.moduleUrl, phase, stateFile, lockFile, nextState);
                let stderr = "";
                child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
                try {
                    await waitForReady(child);
                    await stopChild(child);
                } catch (error) {
                    if (child.exitCode === null) child.kill("SIGKILL");
                    throw new Error(`${(error as Error).message}: ${stderr}`);
                }

                expect(existsSync(lockFile)).toBe(true);
                const committed = readState(stateFile);
                expect(committed.devices.find((device) => device.id === "target")?.generation).toBe(phase === "renamed" ? 2 : 1);
                expect(committed.devices.find((device) => device.id === "unrelated")).toEqual({ id: "unrelated", generation: 7 });

                await new Promise((resolve) => setTimeout(resolve, 150));
                const startedAt = Date.now();
                api.withSharedMutationLock(lockFile, () => {
                    const current = readState(stateFile);
                    api.writeJsonFileAtomically(stateFile, {
                        devices: current.devices.map((device) => device.id === "target" ? { ...device, recovered: true } : device),
                    });
                }, { waitMs: 2000, staleMs: 100 });
                expect(Date.now() - startedAt).toBeLessThan(2000);

                const recovered = readState(stateFile);
                expect(recovered.devices.find((device) => device.id === "target")?.recovered).toBe(true);
                expect(recovered.devices.find((device) => device.id === "unrelated")).toEqual({ id: "unrelated", generation: 7 });
                expect(existsSync(lockFile)).toBe(false);
                expect(readdirSync(dirname(stateFile)).filter((entry) => entry.startsWith("devices.json.") && entry.endsWith(".tmp"))).toEqual([]);
                expect(readdirSync(dirname(stateFile)).filter((entry) => entry.startsWith("devices.mutation.lock."))).toEqual([]);

                api.withSharedMutationLock(lockFile, () => {
                    expect(existsSync(lockFile)).toBe(true);
                }, { waitMs: 500, staleMs: 100 });
                expect(existsSync(lockFile)).toBe(false);
            }, 20000);
        }
    }

    it("does not scavenge a live writer's atomic temporary file", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-state-live-temp-"));
        roots.push(root);
        const stateFile = join(root, ".ccc", "devices", "owners", "owner-a", "android", "devices.json");
        writeJsonFileAtomically(stateFile, { devices: [] });
        const liveTemporaryFile = `${stateFile}.${process.pid}.0123456789abcdef.tmp`;
        writeFileSync(liveTemporaryFile, "live", { flag: "wx" });

        writeJsonFileAtomically(stateFile, { devices: [{ id: "target", generation: 1 }] });

        expect(readFileSync(liveTemporaryFile, "utf8")).toBe("live");
    });
});
