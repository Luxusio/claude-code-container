import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { remoteLifecycleShell, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell } from "../../remote.js";
import { hashPath } from "../../utils.js";

const roots: string[] = []; const name = "ccc-audit"; const token = "b".repeat(32); const id = "a".repeat(64);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc-remote-native-audit-")); roots.push(root); const bin = join(root, "bin"); mkdirSync(bin, { mode: 0o700 }); const log = join(root, "calls"); writeFileSync(log, "");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALL_LOG"\ncase "$1 $2" in\n 'inspect --format') if [ "$3" = '{{.Name}}' ]; then if [ "$MISMATCH" = 1 ]; then printf '/foreign\\n'; else printf '/ccc-audit\\n'; fi; else printf '%s\\n' '${id}'; fi;;\n 'stop '*) exit 0;;\n *) exit 99;;\nesac\n`, { mode: 0o700 });
    for (const command of ["ssh", "mutagen", "tailscale", "ping"]) writeFileSync(join(bin, command), '#!/bin/sh\necho DENIED >> "$CALL_LOG"\nexit 99\n', { mode: 0o700 });
    const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log };
    const run = (shell: string, overrides: NodeJS.ProcessEnv = {}, timeout = 5000) => spawnSync("/bin/sh", ["-c", shell], { encoding: "utf-8", env: { ...env, ...overrides }, timeout });
    const sessions = join(root, ".ccc", "remote-runtime", `sessions-${hashPath(name)}`); const marker = join(sessions, token);
    const reserve = () => { const result = run(remoteSessionReservationShell(name, token, 300, ":", true)); expect(result.status, result.stderr).toBe(0); return result; };
    return { root, bin, log, env, run, reserve, sessions, marker };
}
function expectPeerVeto(f: ReturnType<typeof fixture>, timeout = 5000) {
    const result = f.run(remoteStopShell(name, token, id), {}, timeout);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(42);
    expect(result.stdout).toBe("ccc-remote-sessions-active\n");
    expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(f.log, "utf8")).not.toMatch(/^stop(?: |$)/m);
}

describe.runIf(process.platform !== "win32")("remote shell native authority", () => {
    it("reserves pinned ID, refreshes same ID, and refuses mismatched expected identity", () => {
        const { reserve, run, marker } = fixture(); reserve(); expect(readFileSync(marker, "utf8")).toContain(id);
        expect(run(remoteRefreshSessionShell(name, token, 300, true, id)).status).toBe(0);
        expect(run(remoteRefreshSessionShell(name, token, 300, true, "c".repeat(64))).status).toBe(74);
        expect(readFileSync(marker, "utf8")).toContain(id);
    });
    it("refuses symlink marker replacement and replacement during reservation body", () => {
        const f = fixture(); f.reserve(); const displaced = f.marker+".old"; renameSync(f.marker, displaced); symlinkSync(displaced, f.marker);
        expect(f.run(remoteRefreshSessionShell(name, token, 300, true, id)).status).toBe(44);
        const other = fixture(); const shell = remoteSessionReservationShell(name, token, 300, 'mv "$_ccc_marker" "$_ccc_marker.old"; ln -s "$_ccc_marker.old" "$_ccc_marker"', true);
        expect(other.run(shell).status).toBe(74); expect(readFileSync(other.log, "utf8")).not.toContain("stop");
    });
    it.each(["expired", "expired-legacy", "live", "live-legacy", "unknown-id-live"] as const)("preserves %s peer disposition before exact-ID stop", peer => {
        const f = fixture(); f.reserve(); const now = Math.floor(Date.now()/1000);
        const expired = peer === "expired" || peer === "expired-legacy";
        const contents = `${now+(expired ? -30 : 300)}${peer.endsWith("legacy") ? "" : ` ${peer === "unknown-id-live" ? "unknown-id" : id}`}\n`;
        const peerPath = join(f.sessions, "peer"); writeFileSync(peerPath, contents);
        if (expired) {
            const result = f.run(remoteStopShell(name, token, id));
            expect(result.status, result.stderr).toBe(0);
            expect(existsSync(f.marker)).toBe(false);
            expect(readFileSync(f.log, "utf8")).toContain(`stop ${id}`);
            expect(existsSync(peerPath)).toBe(false);
        } else {
            expectPeerVeto(f);
            expect(readFileSync(peerPath, "utf8")).toBe(contents);
        }
    });
    it.each(["empty", "malformed", "incomplete read", "out-of-range numeric"] as const)("preserves %s peer and vetoes exact-ID stop", peer => {
        const f = fixture(); f.reserve(); const expired = Math.floor(Date.now()/1000)-30;
        const contents = peer === "empty" ? "" : peer === "malformed" ? `unknown ${id}\n` : peer === "incomplete read" ? `${expired} ${id}` : `${"9".repeat(128)} ${id}\n`;
        const peerPath = join(f.sessions, "peer"); writeFileSync(peerPath, contents);
        expectPeerVeto(f);
        expect(readFileSync(peerPath, "utf8")).toBe(contents);
    });
    it("preserves an unreadable peer and vetoes exact-ID stop when mode 000 prevents shell access", ({ skip }) => {
        const f = fixture(); f.reserve(); const contents = `${Math.floor(Date.now()/1000)-30} ${id}\n`;
        const peerPath = join(f.sessions, "peer"); writeFileSync(peerPath, contents); chmodSync(peerPath, 0o000);
        const access = f.run('if ( : < "$CCC_PEER_PATH" ) 2>/dev/null; then exit 0; else exit 1; fi', { CCC_PEER_PATH: peerPath });
        expect(access.error).toBeUndefined();
        if (access.status === 0) { skip(); return; }
        const before = lstatSync(peerPath);
        expectPeerVeto(f);
        const after = lstatSync(peerPath);
        expect(after.ino).toBe(before.ino);
        expect(after.mode).toBe(before.mode);
        chmodSync(peerPath, 0o600);
        expect(readFileSync(peerPath, "utf8")).toBe(contents);
    });
    it.each(["regular target", "dangling target"] as const)("preserves a peer symlink and its %s without following it", targetKind => {
        const f = fixture(); f.reserve(); const peerPath = join(f.sessions, "peer"); const target = join(f.root, "peer-target");
        const contents = `${Math.floor(Date.now()/1000)-30} ${id}\n`;
        if (targetKind === "regular target") writeFileSync(target, contents);
        symlinkSync(target, peerPath); const before = lstatSync(peerPath);
        expectPeerVeto(f, 1000);
        expect(lstatSync(peerPath).isSymbolicLink()).toBe(true);
        expect(lstatSync(peerPath).ino).toBe(before.ino);
        expect(readlinkSync(peerPath)).toBe(target);
        if (targetKind === "regular target") expect(readFileSync(target, "utf8")).toBe(contents);
        else expect(existsSync(target)).toBe(false);
    });
    it.each(["directory", "FIFO"] as const)("preserves a %s peer and vetoes stop without blocking", peer => {
        const f = fixture(); f.reserve(); const peerPath = join(f.sessions, "peer");
        if (peer === "directory") mkdirSync(peerPath, { mode: 0o700 });
        else {
            const created = spawnSync("mkfifo", [peerPath], { encoding: "utf8", timeout: 1000 });
            expect(created.status, created.stderr).toBe(0);
        }
        const before = lstatSync(peerPath);
        expectPeerVeto(f, 1000);
        const after = lstatSync(peerPath);
        expect(after.ino).toBe(before.ino);
        expect(after.isDirectory()).toBe(peer === "directory");
        expect(after.isFIFO()).toBe(peer === "FIFO");
    });
    it("checks actual container name before removing marker or stopping", () => {
        const f = fixture(); f.reserve(); expect(f.run(remoteStopShell(name, token, id), { MISMATCH: "1" }).status).toBe(74); expect(existsSync(f.marker)).toBe(true); expect(readFileSync(f.log, "utf8")).not.toContain(`stop ${id}`);
    });
    it("refuses an unowned token and treats a hostile expected name literally", () => {
        const f = fixture(); f.reserve();
        expect(f.run(remoteStopShell(name, "c".repeat(32), id)).status).toBe(44);
        expect(existsSync(f.marker)).toBe(true);
        expect(readFileSync(f.log, "utf8")).not.toContain(`stop ${id}`);

        const other = fixture(); const injected = join(other.root, "injected");
        const hostileName = `ccc-name'; touch ${injected}; '`;
        const reserved = other.run(remoteSessionReservationShell(hostileName, token, 300, ":", true));
        expect(reserved.status, reserved.stderr).toBe(0);
        const hostileMarker = join(other.root, ".ccc", "remote-runtime", `sessions-${hashPath(hostileName)}`, token);
        const refused = other.run(remoteStopShell(hostileName, token, id));
        expect(refused.status, refused.stderr).toBe(74);
        expect(existsSync(hostileMarker)).toBe(true);
        expect(existsSync(injected)).toBe(false);
        expect(readFileSync(other.log, "utf8")).toContain(`inspect --format {{.Name}} ${id}`);
        expect(readFileSync(other.log, "utf8")).not.toContain(`stop ${id}`);
    });
    it("rejects unsafe private-root symlinks and writable root modes", () => {
        const f = fixture(); const external = mkdtempSync(join(tmpdir(), "ccc-remote-audit-outside-")); roots.push(external); symlinkSync(external, join(f.root, ".ccc"));
        expect(f.run(remoteLifecycleShell(name, "exit 99")).status).toBe(74);
        const other = fixture(); mkdirSync(join(other.root, ".ccc"), { mode: 0o777 }); chmodSync(join(other.root, ".ccc"), 0o777); expect(other.run(remoteLifecycleShell(name, "exit 99")).status).toBe(74);
    });
    it("refuses missing lock backends rather than executing the body", () => {
        const f = fixture(); const tools = join(f.root, "limited"); mkdirSync(tools);
        for (const command of ["stat", "mkdir", "chmod", "rm", "ln", "ps", "mv", "sleep", "date"]) {
            const found = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf-8" }).stdout.trim();
            if (found) symlinkSync(found, join(tools, command));
        }
        expect(f.run(remoteLifecycleShell(name, "exit 99"), { PATH: tools }).status).toBe(75);
    });
    it("times out behind a live holder and cleans final token without removing a successor", async () => {
        const f = fixture(); const ready = join(f.root, "ready"); const holder = spawn("/bin/sh", ["-c", remoteLifecycleShell(name, `printf ready > '${ready}'; sleep 0.8`)], { env: f.env });
        const finished = new Promise<number | null>((resolve, reject) => { holder.on("close", resolve); holder.on("error", reject); });
        for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
        expect(existsSync(ready)).toBe(true); expect(f.run(remoteLifecycleShell(name, "exit 99", 0.1)).status).toBe(73); expect(await finished).toBe(0);
        const lock = join(f.root, ".ccc", "remote-runtime", `lifecycle-${hashPath(name)}.lock`); expect(existsSync(lock)).toBe(false);
        const result = f.run(remoteLifecycleShell(name, 'printf "%s %s\\n" "$$" successor > "$_ccc_lock"'));
        expect(result.status, result.stderr).toBe(0); expect(readFileSync(lock, "utf8")).toContain("successor");
    });
    it("release removes only requested token and preserves a peer claim", () => {
        const f = fixture(); f.reserve(); const peer = join(f.sessions, "peer"); linkSync(f.marker, peer); expect(f.run(remoteReleaseSessionShell(name, token)).status).toBe(0); expect(existsSync(f.marker)).toBe(false); expect(existsSync(peer)).toBe(true);
    });
});
