import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { remoteLifecycleShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteSessionReservationShell, remoteStopShell, shellEscapeArg } from "../remote.js";
import { hashPath } from "../utils.js";

function runShell(command: string, home: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { env: { ...env, HOME: home }, stdio: "ignore" });
        child.once("error", reject);
        child.once("close", resolve);
    });
}

function spawnSignalTarget(command: string, home: string) {
    const child = spawn("/bin/sh", ["-c", command], {
        env: { ...process.env, HOME: home },
        detached: true,
        stdio: "ignore",
    });
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { child, completed };
}

async function waitForFile(file: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(file)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
        const runtime = join(home, ".ccc", "remote-runtime");
        await waitForFile(join(runtime, `lifecycle-${hashPath(containerName)}.lock`));
        const waiter = runShell(remoteLifecycleShell(containerName, "exit 99"), home);
        await new Promise((resolve) => setTimeout(resolve, 80));
        renameSync(runtime, join(home, ".ccc", "displaced-runtime"));
        mkdirSync(runtime, { mode: 0o700 });

        await expect(Promise.all([holder, waiter])).resolves.toEqual([0, 74]);
    });

    it.each([
        ["SIGHUP", 129],
        ["SIGINT", 130],
        ["SIGTERM", 143],
    ] as const)("releases the guard and exits immediately on %s", async (signal, expectedCode) => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-signal-home-"));
        roots.push(home);
        const order = join(home, "signal-order.txt");
        const containerName = `ccc-signal-${signal}`;
        const target = spawnSignalTarget(
            remoteLifecycleShell(containerName, `printf A >> ${shellEscapeArg(order)}; sleep 10; printf B >> ${shellEscapeArg(order)}`),
            home,
        );
        await waitForFile(order);
        process.kill(-target.child.pid!, signal);
        const follower = runShell(remoteLifecycleShell(containerName, `printf Cc >> ${shellEscapeArg(order)}`), home);

        const result = await target.completed;
        expect(result.code === expectedCode || result.signal === signal).toBe(true);
        await expect(follower).resolves.toBe(0);
        expect(readFileSync(order, "utf8")).toBe("ACc");
    });

    it("fails closed when neither flock nor shlock is installed", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-no-lock-tool-home-"));
        const bin = mkdtempSync(join(tmpdir(), "ccc-remote-no-lock-tool-bin-"));
        roots.push(home, bin);
        for (const tool of ["stat", "mkdir", "chmod", "rm"]) {
            const located = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
            symlinkSync(located, join(bin, tool));
        }

        await expect(runShell(remoteLifecycleShell("ccc-no-lock-tool", "exit 99"), home, { PATH: bin })).resolves.toBe(75);
    });

    it("keeps session writes on the bound runtime when its path is replaced", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-bound-runtime-home-"));
        roots.push(home);
        const containerName = "ccc-bound-runtime";
        const token = "c".repeat(32);
        const running = runShell(remoteSessionReservationShell(containerName, token, 60, "sleep 0.5"), home);
        const runtime = join(home, ".ccc", "remote-runtime");
        await waitForFile(join(runtime, `sessions-${hashPath(containerName)}`, token));
        const displaced = join(home, ".ccc", "displaced-runtime");
        renameSync(runtime, displaced);
        mkdirSync(runtime, { mode: 0o700 });

        await expect(running).resolves.toBe(74);
        expect(existsSync(join(runtime, `sessions-${hashPath(containerName)}`, token))).toBe(false);
        expect(existsSync(join(displaced, `sessions-${hashPath(containerName)}`, token))).toBe(true);
    });

    it("detects a session directory replacement before completing reservation", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-bound-session-home-"));
        roots.push(home);
        const containerName = "ccc-bound-session";
        const token = "d".repeat(32);
        const running = runShell(remoteSessionReservationShell(containerName, token, 60, "sleep 0.5"), home);
        const sessions = join(home, ".ccc", "remote-runtime", `sessions-${hashPath(containerName)}`);
        await waitForFile(join(sessions, token));
        const displaced = `${sessions}.displaced`;
        renameSync(sessions, displaced);
        mkdirSync(sessions, { mode: 0o700 });

        await expect(running).resolves.toBe(74);
        expect(existsSync(join(sessions, token))).toBe(false);
        expect(existsSync(join(displaced, token))).toBe(true);
    });

    it("preserves the start-time container ID across refresh and stop", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-pinned-home-"));
        const bin = mkdtempSync(join(tmpdir(), "ccc-remote-pinned-bin-"));
        roots.push(home, bin);
        const originalId = "a".repeat(64);
        const stoppedFile = join(home, "stopped.txt");
        const containerName = "ccc-pinned-remote";
        const docker = join(bin, "docker");
        writeFileSync(docker, [
            "#!/bin/sh",
            "if [ \"$1\" = inspect ] && [ \"$2\" = --format ] && [ \"$3\" = '{{.Name}}' ]; then printf '%s\\n' " + shellEscapeArg(`/${containerName}`) + "; exit 0; fi",
            "if [ \"$1\" = inspect ]; then printf '%s\\n' " + shellEscapeArg(originalId) + "; exit 0; fi",
            "if [ \"$1\" = stop ]; then printf '%s\\n' \"$2\" > " + shellEscapeArg(stoppedFile) + "; exit 0; fi",
            "exit 99",
        ].join("\n"));
        chmodSync(docker, 0o755);
        const env = { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(":") };
        const token = "e".repeat(32);

        await expect(runShell(
            remoteSessionReservationShell(containerName, token, 60, ":", true),
            home,
            env,
        )).resolves.toBe(0);
        const marker = join(home, ".ccc", "remote-runtime", "sessions-" + hashPath(containerName), token);
        expect(readFileSync(marker, "utf8").trim().split(/\s+/)[1]).toBe(originalId);

        await expect(runShell(remoteRefreshSessionShell(containerName, token, 60, true), home, env)).resolves.toBe(0);
        expect(readFileSync(marker, "utf8").trim().split(/\s+/)[1]).toBe(originalId);

        await expect(runShell(remoteStopShell(containerName, token), home, env)).resolves.toBe(0);
        expect(readFileSync(stoppedFile, "utf8").trim()).toBe(originalId);
    });

    it("refuses to stop from a legacy reservation without a pinned container ID", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-unpinned-home-"));
        roots.push(home);
        const containerName = "ccc-unpinned-remote";
        const token = "f".repeat(32);
        await expect(runShell(remoteSessionReservationShell(containerName, token, 60, ":"), home)).resolves.toBe(0);

        await expect(runShell(remoteStopShell(containerName, token), home)).resolves.toBe(74);
    });

    it("rejects a symlink that preclaims a reservation marker", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-marker-preclaim-home-"));
        const external = join(home, "external-marker");
        roots.push(home);
        const containerName = "ccc-marker-preclaim";
        const token = "1".repeat(32);
        const sessions = join(home, ".ccc", "remote-runtime", `sessions-${hashPath(containerName)}`);
        mkdirSync(sessions, { recursive: true, mode: 0o700 });
        writeFileSync(external, "unchanged\n");
        symlinkSync(external, join(sessions, token), "file");

        await expect(runShell(remoteSessionReservationShell(containerName, token, 60, ":"), home)).resolves.toBe(74);
        expect(readFileSync(external, "utf8")).toBe("unchanged\n");
    });

    it("rejects a marker replaced before refresh", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-marker-refresh-home-"));
        roots.push(home);
        const containerName = "ccc-marker-refresh";
        const token = "2".repeat(32);
        await expect(runShell(remoteSessionReservationShell(containerName, token, 60, ":"), home)).resolves.toBe(0);
        const marker = join(home, ".ccc", "remote-runtime", `sessions-${hashPath(containerName)}`, token);
        const displaced = `${marker}.displaced`;
        renameSync(marker, displaced);
        symlinkSync(displaced, marker, "file");

        await expect(runShell(remoteRefreshSessionShell(containerName, token, 60), home)).resolves.toBe(44);
    });

    it("rejects a marker replaced while the reservation command runs", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-marker-command-home-"));
        roots.push(home);
        const containerName = "ccc-marker-command";
        const token = "4".repeat(32);
        const external = join(home, "external-command-marker");
        writeFileSync(external, "unchanged\n");
        const command = `mv "$_ccc_marker" "$_ccc_marker.displaced"; ln -s ${shellEscapeArg(external)} "$_ccc_marker"`;

        await expect(runShell(remoteSessionReservationShell(containerName, token, 60, command), home)).resolves.toBe(74);
        expect(readFileSync(external, "utf8")).toBe("unchanged\n");
    });

    it("rejects a marker symlink substituted before stop without invoking docker", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-marker-stop-home-"));
        const bin = mkdtempSync(join(tmpdir(), "ccc-remote-marker-stop-bin-"));
        roots.push(home, bin);
        const containerName = "ccc-marker-stop";
        const token = "5".repeat(32);
        await expect(runShell(remoteSessionReservationShell(containerName, token, 60, ":"), home)).resolves.toBe(0);
        const marker = join(home, ".ccc", "remote-runtime", `sessions-${hashPath(containerName)}`, token);
        const displaced = `${marker}.displaced`;
        renameSync(marker, displaced);
        symlinkSync(displaced, marker, "file");
        const dockerCalled = join(home, "docker-called");
        const docker = join(bin, "docker");
        writeFileSync(docker, `#!/bin/sh\ntouch ${shellEscapeArg(dockerCalled)}\nexit 0\n`);
        chmodSync(docker, 0o755);
        const env = { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(":") };

        await expect(runShell(remoteStopShell(containerName, token), home, env)).resolves.toBe(44);
        expect(existsSync(dockerCalled)).toBe(false);
    });

    it("refuses to stop when the pinned ID no longer has the expected name", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-remote-name-fence-home-"));
        const bin = mkdtempSync(join(tmpdir(), "ccc-remote-name-fence-bin-"));
        roots.push(home, bin);
        const containerName = "ccc-expected-name";
        const token = "3".repeat(32);
        const pinnedId = "b".repeat(64);
        const stoppedFile = join(home, "stopped.txt");
        const docker = join(bin, "docker");
        writeFileSync(docker, [
            "#!/bin/sh",
            "if [ \"$1\" = inspect ] && [ \"$3\" = '{{.Name}}' ]; then printf '/ccc-replacement\\n'; exit 0; fi",
            "if [ \"$1\" = inspect ]; then printf '%s\\n' " + shellEscapeArg(pinnedId) + "; exit 0; fi",
            "if [ \"$1\" = stop ]; then touch " + shellEscapeArg(stoppedFile) + "; exit 0; fi",
            "exit 99",
        ].join("\n"));
        chmodSync(docker, 0o755);
        const env = { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(":") };
        await expect(runShell(remoteSessionReservationShell(containerName, token, 60, ":", true), home, env)).resolves.toBe(0);

        await expect(runShell(remoteStopShell(containerName, token), home, env)).resolves.toBe(74);
        expect(existsSync(stoppedFile)).toBe(false);
    });
});
