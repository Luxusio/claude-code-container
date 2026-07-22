import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { remoteLifecycleShell, remoteSessionReservationShell, shellEscapeArg } from "../remote.js";
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
});
