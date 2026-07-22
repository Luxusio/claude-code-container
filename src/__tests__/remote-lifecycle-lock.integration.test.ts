import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { remoteLifecycleShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteSessionReservationShell, remoteStopShell, shellEscapeArg } from "../remote.js";
import { hashPath } from "../utils.js";

function runShell(command: string, home: string): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", command], { env: { ...process.env, HOME: home }, stdio: "ignore" });
        child.once("error", reject);
        child.once("close", resolve);
    });
}

describe.runIf(process.platform !== "win32")("remote lifecycle lock integration", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("serializes two clients without an uninitialized-owner window", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-lock-home-"));
        roots.push(home);
        const order = join(home, "order.txt");
        const first = remoteLifecycleShell("ccc-lock-race", `printf A >> ${shellEscapeArg(order)}; sleep 0.3; printf a >> ${shellEscapeArg(order)}`);
        const second = remoteLifecycleShell("ccc-lock-race", `printf B >> ${shellEscapeArg(order)}; sleep 0.1; printf b >> ${shellEscapeArg(order)}`);

        const firstRun = runShell(first, home);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const secondRun = runShell(second, home);

        await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([0, 0]);
        expect(readFileSync(order, "utf8")).toBe("AaBb");
        expect(statSync(join(home, ".ccc", "remote-runtime")).mode & 0o777).toBe(0o700);
    });

    it("rejects a symlink substituted for the private runtime root", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-lock-home-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-remote-lock-external-"));
        roots.push(home, external);
        symlinkSync(external, join(home, ".ccc"), "dir");

        const result = spawnSync("sh", ["-c", remoteLifecycleShell("ccc-lock-symlink", "exit 99")], {
            env: { ...process.env, HOME: home },
            encoding: "utf8",
        });

        expect(result.status).toBe(74);
    });

    it("rejects a symlink substituted for a container session directory", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-session-home-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-remote-session-external-"));
        roots.push(home, external);
        const runtime = join(home, ".ccc", "remote-runtime");
        mkdirSync(runtime, { recursive: true, mode: 0o700 });
        const containerName = "ccc-session-symlink";
        symlinkSync(external, join(runtime, `sessions-${hashPath(containerName)}`), "dir");

        const result = spawnSync("sh", ["-c", remoteSessionReservationShell(containerName, "a".repeat(32), 60, "exit 99")], {
            env: { ...process.env, HOME: home },
            encoding: "utf8",
        });

        expect(result.status).toBe(74);
        expect(statSync(external).isDirectory()).toBe(true);
    });

    it("serializes two simultaneous reclaimers of a stale owner", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-stale-home-"));
        roots.push(home);
        const runtime = join(home, ".ccc", "remote-runtime");
        mkdirSync(runtime, { recursive: true, mode: 0o700 });
        const containerName = "ccc-stale-race";
        writeFileSync(join(runtime, `lifecycle-${hashPath(containerName)}.lock`), "999999 stale-token\n");
        const order = join(home, "stale-order.txt");
        const first = remoteLifecycleShell(containerName, `printf A >> ${shellEscapeArg(order)}; sleep 0.2; printf a >> ${shellEscapeArg(order)}`);
        const second = remoteLifecycleShell(containerName, `printf B >> ${shellEscapeArg(order)}; sleep 0.2; printf b >> ${shellEscapeArg(order)}`);

        await expect(Promise.all([runShell(first, home), runShell(second, home)])).resolves.toEqual([0, 0]);
        expect(readFileSync(order, "utf8")).toMatch(/^(AaBb|BbAa)$/);
    });

    it.each(["home", "base", "runtime"])("rejects a group-writable %s directory", (kind) => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-mode-home-"));
        roots.push(home);
        const base = join(home, ".ccc");
        const runtime = join(base, "remote-runtime");
        mkdirSync(runtime, { recursive: true, mode: 0o700 });
        chmodSync(kind === "home" ? home : kind === "base" ? base : runtime, 0o770);

        const result = spawnSync("sh", ["-c", remoteLifecycleShell(`ccc-mode-${kind}`, "exit 99")], {
            env: { ...process.env, HOME: home },
            encoding: "utf8",
        });

        expect(result.status).toBe(74);
    });

    it("rejects a substituted session directory for every session operation", () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-session-ops-home-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-remote-session-ops-external-"));
        roots.push(home, external);
        const runtime = join(home, ".ccc", "remote-runtime");
        mkdirSync(runtime, { recursive: true, mode: 0o700 });
        const containerName = "ccc-session-ops-symlink";
        symlinkSync(external, join(runtime, `sessions-${hashPath(containerName)}`), "dir");
        const token = "b".repeat(32);
        const commands = [
            remoteSessionReservationShell(containerName, token, 60, "exit 99"),
            remoteRefreshSessionShell(containerName, token, 60),
            remoteReleaseSessionShell(containerName, token),
            remoteStopShell(containerName, token),
        ];

        for (const command of commands) {
            const result = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8" });
            expect(result.status).toBe(74);
        }
    });

    it("bounds kernel lock waiting and exits with status 73", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-timeout-home-"));
        roots.push(home);
        const containerName = "ccc-timeout";
        const holder = runShell(remoteLifecycleShell(containerName, "sleep 0.8"), home);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const startedAt = Date.now();
        const blocked = runShell(remoteLifecycleShell(containerName, "exit 99", 0.15), home);

        await expect(blocked).resolves.toBe(73);
        expect(Date.now() - startedAt).toBeLessThan(1000);
        await expect(holder).resolves.toBe(0);
    });

    it("rejects runtime replacement while waiting for the kernel guard", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-runtime-race-home-"));
        roots.push(home);
        const containerName = "ccc-runtime-race";
        const holder = runShell(remoteLifecycleShell(containerName, "sleep 0.5"), home);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const waiter = runShell(remoteLifecycleShell(containerName, "exit 99"), home);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const runtime = join(home, ".ccc", "remote-runtime");
        renameSync(runtime, join(home, ".ccc", "displaced-runtime"));
        mkdirSync(runtime, { mode: 0o700 });

        await expect(Promise.all([holder, waiter])).resolves.toEqual([0, 74]);
    });
});
