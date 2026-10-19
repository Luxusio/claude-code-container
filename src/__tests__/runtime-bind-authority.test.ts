import {
    chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
    statSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    assertRuntimeBindAuthorityCurrent, beginRuntimeBindCreation, prepareRuntimeBindHome,
    readRuntimeBindAuthority, recordRuntimeBindAuthority, settleRuntimeBindCreation,
    withRuntimeBindGuard, withRuntimeBindGuardAsync,
} from "../adapters/runtime-bind-authority.js";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeSelector } from "../ports/container-runtime-invocation.js";
import type { RuntimeBindCreationTicket, RuntimeBindGuard } from "../ports/runtime-bind-authority.js";
import { fileSymlinkOrSkip } from "./helpers/file-symlink-fixture.js";

let fixture: string;
let root: string;
const history = () => join(root, "runtime-bind-authority", "history.json");

function invocation(host = "unix:///fixture/first.sock") {
    return {
        version: 1 as const, runtime: "docker" as const, executable: process.execPath,
        transport: { kind: "docker" as const, host, configDirectory: join(fixture, "docker-config"),
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as Record<NativeRuntimeSelector, string | null>,
    };
}

function freshHome() {
    const home = prepareRuntimeBindHome(root);
    withRuntimeBindGuard(home, guard => {
        const snapshot = readRuntimeBindAuthority(guard);
        expect(snapshot).toMatchObject({ coverage: "complete", pending: false, authorities: [] });
        assertRuntimeBindAuthorityCurrent(guard, snapshot);
    });
    return home;
}

beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "ccc-runtime-bind-authority-"));
    chmodSync(fixture, 0o700);
    root = join(fixture, "home");
});
afterEach(() => {
    // Restore only the private fixture permissions needed for its removal.
    for (const path of [root, join(root, "runtime-bind-authority")]) {
        try { chmodSync(path, 0o700); } catch { /* absent or already moved by the test */ }
    }
    rmSync(fixture, { recursive: true, force: true });
});

describe("retained runtime bind authority on private native files", () => {
    it("accepts only the exclusive fresh creator and uses the existing codex-state claim", () => {
        const home = prepareRuntimeBindHome(root);
        withRuntimeBindGuard(home, guard => {
            const claim = JSON.parse(readFileSync(join(root, "codex-state.lock"), "utf8")) as { pid: number; token: string };
            expect(claim.pid).toBe(process.pid);
            expect(claim.token).toBeTypeOf("string");
            expect(claim.token).not.toBe("");
            const snapshot = readRuntimeBindAuthority(guard);
            expect(snapshot).toMatchObject({ coverage: "complete", pending: false, authorities: [] });
            assertRuntimeBindAuthorityCurrent(guard, snapshot);
        });
        expect(existsSync(join(root, "codex-state.lock"))).toBe(false);
        if (process.platform !== "win32") {
            expect(statSync(history()).mode & 0o777).toBe(0o600);
            expect(statSync(dirname(history())).mode & 0o777).toBe(0o700);
        }
    });

    it("does not promote an existing home merely because history is missing", () => {
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(join(root, "user-data"), "preserve", { mode: 0o600 });
        withRuntimeBindGuard(prepareRuntimeBindHome(root), guard => {
            expect(readRuntimeBindAuthority(guard)).toMatchObject({ coverage: "incomplete", pending: false });
            expect(recordRuntimeBindAuthority(guard, invocation()).coverage).toBe("incomplete");
        });
        expect(readFileSync(join(root, "user-data"), "utf8")).toBe("preserve");
    });

    it("cannot reuse an earlier fresh-creator capability to replace lost history as complete", () => {
        const home = freshHome();
        rmSync(history());
        withRuntimeBindGuard(home, guard => {
            expect(readRuntimeBindAuthority(guard).coverage).not.toBe("complete");
        });
    });

    it("a losing creator or a crash between mkdir and publication cannot invent genesis", () => {
        const first = prepareRuntimeBindHome(root);
        const loser = prepareRuntimeBindHome(root);
        withRuntimeBindGuard(loser, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("incomplete"));
        withRuntimeBindGuard(first, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("incomplete"));

        root = join(fixture, "interrupted-home");
        prepareRuntimeBindHome(root); // The creator dies before it publishes authority history.
        withRuntimeBindGuard(root, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("incomplete"));
    });

    it("a fresh creator capability cannot initialize a different root at the same path", () => {
        const home = prepareRuntimeBindHome(root);
        renameSync(root, join(fixture, "original-home"));
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(join(root, "successor"), "untouched", { mode: 0o600 });
        expect(() => withRuntimeBindGuard(home, guard => recordRuntimeBindAuthority(guard, invocation()))).toThrow();
        expect(readFileSync(join(root, "successor"), "utf8")).toBe("untouched");
        expect(existsSync(history())).toBe(false);
    });

    it("retains complete invocation records and deduplicates the full DTO rather than an alias or endpoint", () => {
        const home = freshHome();
        const first = invocation();
        first.selectors.DOCKER_CONTEXT = "mutable-alias";
        const proxyChanged = structuredClone(first);
        proxyChanged.selectors.HTTPS_PROXY = "http://fixture-proxy.invalid:8123";
        const endpointChanged = structuredClone(first);
        endpointChanged.transport.host = "unix:///fixture/second.sock";
        withRuntimeBindGuard(home, guard => {
            recordRuntimeBindAuthority(guard, first);
            expect(recordRuntimeBindAuthority(guard, structuredClone(first)).authorities).toHaveLength(1);
            recordRuntimeBindAuthority(guard, proxyChanged);
            const all = recordRuntimeBindAuthority(guard, endpointChanged);
            expect(all.authorities).toEqual([first, proxyChanged, endpointChanged]);
        });
        first.executable = join(fixture, "different-executable");
        first.transport.host = "unix:///fixture/rebound.sock";
        first.selectors.DOCKER_CONTEXT = "removed-alias";
        withRuntimeBindGuard(home, guard => {
            const all = readRuntimeBindAuthority(guard);
            expect(all.authorities).toHaveLength(3);
            expect(all.authorities[0]).toMatchObject({ executable: process.execPath,
                transport: { host: "unix:///fixture/first.sock" }, selectors: { DOCKER_CONTEXT: "mutable-alias" } });
            expect(all.coverage).toBe("complete");
        });
    });

    it("refuses the sixty-fifth authority without evicting old authority or dispatching the effect", () => {
        const home = freshHome();
        withRuntimeBindGuard(home, guard => {
            for (let index = 0; index < 64; index++) recordRuntimeBindAuthority(guard, invocation(`unix:///fixture/engine-${index}.sock`));
            const before = readFileSync(history());
            let effects = 0;
            expect(() => {
                beginRuntimeBindCreation(guard, invocation("unix:///fixture/engine-64.sock"));
                effects++;
            }).toThrow();
            expect(effects).toBe(0);
            expect(readFileSync(history())).toEqual(before);
            const all = readRuntimeBindAuthority(guard);
            expect(all.authorities).toHaveLength(64);
            expect(all.authorities[0]?.transport).toMatchObject({ host: "unix:///fixture/engine-0.sock" });
        });
    });

    it("refuses an oversized native selector before publishing or dispatching a creation", () => {
        const home = freshHome();
        const oversized = invocation();
        oversized.selectors.HTTPS_PROXY = "x".repeat(8193);
        const before = readFileSync(history());
        let effects = 0;
        withRuntimeBindGuard(home, guard => {
            expect(() => { beginRuntimeBindCreation(guard, oversized); effects++; }).toThrow();
        });
        expect(effects).toBe(0);
        expect(readFileSync(history())).toEqual(before);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed private-file publication does not dispatch its native effect", () => {
        const home = freshHome();
        const before = readFileSync(history());
        const inode = lstatSync(history()).ino;
        let effects = 0;
        let entered = false;
        let refusedBeforeEntry = false;
        chmodSync(dirname(history()), 0o500);
        try {
            try {
                withRuntimeBindGuard(home, guard => {
                    entered = true;
                    expect(() => { beginRuntimeBindCreation(guard, invocation()); effects++; }).toThrow();
                });
            } catch (cause) {
                if (entered) throw cause;
                expect(cause).toBeInstanceOf(Error);
                refusedBeforeEntry = true;
            }
            expect(entered || refusedBeforeEntry).toBe(true);
            expect(effects).toBe(0);
            expect(readFileSync(history())).toEqual(before);
            expect(lstatSync(history()).ino).toBe(inode);
        } finally { chmodSync(dirname(history()), 0o700); }
    });

    it.each(["unfinished JSON", JSON.stringify({ version: 999 }), ""])("preserves malformed history and refuses an admitted creation (%j)", invalid => {
        const home = freshHome();
        writeFileSync(history(), invalid, { mode: 0o600 });
        const before = readFileSync(history());
        const inode = lstatSync(history()).ino;
        let effects = 0;
        withRuntimeBindGuard(home, guard => {
            const snapshot = readRuntimeBindAuthority(guard);
            expect(snapshot.coverage).toBe("unknown");
            expect(() => assertRuntimeBindAuthorityCurrent(guard, snapshot)).toThrow();
            expect(() => {
                beginRuntimeBindCreation(guard, invocation());
                effects++;
            }).toThrow();
        });
        expect(effects).toBe(0);
        expect(readFileSync(history())).toEqual(before);
        expect(lstatSync(history()).ino).toBe(inode);
    });

    it("bounds oversized history without replacing it with an empty complete record", () => {
        const home = freshHome();
        writeFileSync(history(), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
        const inode = lstatSync(history()).ino;
        withRuntimeBindGuard(home, guard => {
            expect(readRuntimeBindAuthority(guard).coverage).toBe("unknown");
            expect(() => recordRuntimeBindAuthority(guard, invocation())).toThrow();
        });
        expect(lstatSync(history()).size).toBe(4 * 1024 * 1024 + 1);
        expect(lstatSync(history()).ino).toBe(inode);
    });

    it("does not follow a history symlink or touch its target", context => {
        const home = freshHome();
        const target = join(fixture, "foreign-history");
        renameSync(history(), target);
        const before = readFileSync(target);
        fileSymlinkOrSkip(context, target, history());
        withRuntimeBindGuard(home, guard => {
            expect(readRuntimeBindAuthority(guard).coverage).toBe("unknown");
            expect(() => recordRuntimeBindAuthority(guard, invocation())).toThrow();
        });
        expect(lstatSync(history()).isSymbolicLink()).toBe(true);
        expect(readFileSync(target)).toEqual(before);
    });

    it.skipIf(process.platform === "win32").each(["file", "directory"] as const)("refuses unsafe private %s permissions without changing data", kind => {
        const home = freshHome();
        const path = kind === "file" ? history() : dirname(history());
        const before = readFileSync(history());
        let entered = false;
        let refusedBeforeEntry = false;
        chmodSync(path, kind === "file" ? 0o644 : 0o755);
        try {
            try {
                withRuntimeBindGuard(home, guard => {
                    entered = true;
                    expect(readRuntimeBindAuthority(guard).coverage).toBe("unknown");
                    expect(() => beginRuntimeBindCreation(guard, invocation())).toThrow();
                });
            } catch (cause) {
                if (entered) throw cause;
                expect(cause).toBeInstanceOf(Error);
                refusedBeforeEntry = true;
            }
            expect(entered || refusedBeforeEntry).toBe(true);
            expect(readFileSync(history())).toEqual(before);
        } finally { chmodSync(path, kind === "file" ? 0o600 : 0o700); }
    });

    it("keeps a receiving-host incomplete marker as a permanent absence veto", () => {
        const home = freshHome();
        const marker = join(dirname(history()), "receiving-host-incomplete");
        writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
        withRuntimeBindGuard(home, guard => {
            expect(readRuntimeBindAuthority(guard)).toMatchObject({ coverage: "incomplete" });
            const ticket = beginRuntimeBindCreation(guard, invocation());
            expect(settleRuntimeBindCreation(guard, ticket)).toMatchObject({ coverage: "incomplete", pending: false });
        });
        expect(existsSync(marker)).toBe(true);
    });

    it("settles only the current operation's positive creation under its live guard", () => {
        const home = freshHome();
        withRuntimeBindGuard(home, guard => {
            const ticket = beginRuntimeBindCreation(guard, invocation());
            expect(readRuntimeBindAuthority(guard)).toMatchObject({ coverage: "complete", pending: true });
            const settled = settleRuntimeBindCreation(guard, ticket);
            expect(settled).toMatchObject({ coverage: "complete", pending: false });
            expect(settled.authorities).toEqual([invocation()]);
            assertRuntimeBindAuthorityCurrent(guard, settled);
        });
    });

    it("an interrupted native callback leaves pending state and later success cannot clear its uncertainty", () => {
        const home = freshHome();
        expect(() => withRuntimeBindGuard(home, guard => {
            beginRuntimeBindCreation(guard, invocation());
            throw new Error("native client timed out before a settled result");
        })).toThrow("native client timed out");
        withRuntimeBindGuard(home, guard => {
            expect(readRuntimeBindAuthority(guard)).toMatchObject({ coverage: "complete", pending: true });
            const later = beginRuntimeBindCreation(guard, invocation("unix:///fixture/later.sock"));
            expect(settleRuntimeBindCreation(guard, later)).toMatchObject({ coverage: "incomplete", pending: false });
        });
        withRuntimeBindGuard(home, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("incomplete"));
    });

    it("rejects stale, foreign and expired tickets while preserving the current pending operation", () => {
        const home = freshHome();
        let oldGuard!: RuntimeBindGuard;
        let oldTicket!: RuntimeBindCreationTicket;
        withRuntimeBindGuard(home, guard => {
            oldGuard = guard;
            oldTicket = beginRuntimeBindCreation(guard, invocation());
            settleRuntimeBindCreation(guard, oldTicket);
            const current = beginRuntimeBindCreation(guard, invocation("unix:///fixture/current.sock"));
            expect(() => settleRuntimeBindCreation(guard, oldTicket)).toThrow();
            expect(readRuntimeBindAuthority(guard).pending).toBe(true);
            settleRuntimeBindCreation(guard, current);
        });
        expect(() => beginRuntimeBindCreation(oldGuard, invocation())).toThrow();
        expect(() => settleRuntimeBindCreation(oldGuard, oldTicket)).toThrow();

        const other = prepareRuntimeBindHome(join(fixture, "other-home"));
        withRuntimeBindGuard(home, guard => {
            const liveForeignTicket = beginRuntimeBindCreation(guard, invocation());
            withRuntimeBindGuard(other, otherGuard => {
                const ticket = beginRuntimeBindCreation(otherGuard, invocation());
                expect(() => settleRuntimeBindCreation(otherGuard, liveForeignTicket)).toThrow();
                expect(readRuntimeBindAuthority(otherGuard).pending).toBe(true);
                settleRuntimeBindCreation(otherGuard, ticket);
            });
            settleRuntimeBindCreation(guard, liveForeignTicket);
        });
        withRuntimeBindGuard(home, guard => expect(() => settleRuntimeBindCreation(guard, oldTicket)).toThrow());
    });

    it("an asynchronous rejected creation also retains its durable pending barrier", async () => {
        const home = freshHome();
        await expect(withRuntimeBindGuardAsync(home, async guard => {
            beginRuntimeBindCreation(guard, invocation());
            await Promise.resolve();
            throw new Error("interrupted after native dispatch");
        })).rejects.toThrow("interrupted after native dispatch");
        withRuntimeBindGuard(home, guard => expect(readRuntimeBindAuthority(guard).pending).toBe(true));
    });

    it("retains the published pending barrier after its exact creator is killed", async () => {
        freshHome();
        const script = `
            import { writeSync } from "node:fs";
            const { withRuntimeBindGuard, beginRuntimeBindCreation } = await import(${JSON.stringify(new URL("../adapters/runtime-bind-authority.ts", import.meta.url).href)});
            withRuntimeBindGuard(process.argv[1], guard => {
                beginRuntimeBindCreation(guard, JSON.parse(process.argv[2]));
                writeSync(1, "PENDING-PUBLISHED\\n");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            });
        `;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, JSON.stringify(invocation())], {
            cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        let terminal = false;
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", text => { stderr += String(text); });
        const exited = new Promise<void>(resolve => { child.once("close", () => { terminal = true; resolve(); }); });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Owned creator did not publish pending state: ${stderr}`)), 10_000);
                const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
                child.once("error", error => finish(error));
                child.once("close", () => {
                    if (!stdout.includes("PENDING-PUBLISHED\n")) finish(new Error(`Owned creator exited before publication: ${stderr}`));
                });
                child.stdout.on("data", text => {
                    stdout += String(text);
                    if (stdout.includes("PENDING-PUBLISHED\n")) finish();
                });
            });
            expect(child.kill("SIGKILL")).toBe(true);
            await exited;
            withRuntimeBindGuard(root, guard => {
                expect(readRuntimeBindAuthority(guard)).toMatchObject({ coverage: "complete", pending: true });
                const later = beginRuntimeBindCreation(guard, invocation("unix:///fixture/after-kill.sock"));
                const settled = settleRuntimeBindCreation(guard, later);
                expect(settled).toMatchObject({ coverage: "incomplete", pending: false });
                expect(settled.authorities).toHaveLength(2);
            }, { waitMs: 5_000 });
        } finally {
            if (!terminal) child.kill("SIGKILL");
            await exited;
        }
    });

    it.each(["history", "authority directory"] as const)("rejects a same-byte %s successor before the admitted effect", kind => {
        const home = freshHome();
        withRuntimeBindGuard(home, guard => {
            const snapshot = readRuntimeBindAuthority(guard);
            const source = kind === "history" ? history() : dirname(history());
            renameSync(source, join(fixture, "displaced"));
            if (kind === "authority directory") mkdirSync(dirname(history()), { mode: 0o700 });
            const bytes = kind === "history" ? readFileSync(join(fixture, "displaced")) : readFileSync(join(fixture, "displaced", "history.json"));
            writeFileSync(history(), bytes, { mode: 0o600, flag: "wx" });
            const successor = lstatSync(history()).ino;
            let effects = 0;
            expect(() => { assertRuntimeBindAuthorityCurrent(guard, snapshot); effects++; }).toThrow();
            expect(effects).toBe(0);
            expect(lstatSync(history()).ino).toBe(successor);
            expect(readFileSync(history())).toEqual(bytes);
        });
    });

    it("refuses a replaced root after qualification and preserves the successor's files", () => {
        const home = freshHome();
        let effects = 0;
        let rejected = false;
        try {
            withRuntimeBindGuard(home, guard => {
                const snapshot = readRuntimeBindAuthority(guard);
                renameSync(root, join(fixture, "displaced-home"));
                mkdirSync(root, { mode: 0o700 });
                writeFileSync(join(root, "successor"), "untouched", { mode: 0o600 });
                try { assertRuntimeBindAuthorityCurrent(guard, snapshot); effects++; }
                catch { rejected = true; }
            });
        } catch { /* The displaced global claim may also refuse release. */ }
        expect(rejected).toBe(true);
        expect(effects).toBe(0);
        expect(readFileSync(join(root, "successor"), "utf8")).toBe("untouched");
        expect(existsSync(history())).toBe(false);
    });

    it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer or replacing the special file", () => {
        const home = freshHome();
        const original = join(fixture, "saved-history");
        renameSync(history(), original);
        const before = readFileSync(original);
        const fifo = spawnSync("mkfifo", ["-m", "600", history()], { encoding: "utf8", timeout: 2_000, windowsHide: true });
        expect(fifo.error).toBeUndefined();
        expect(fifo.status, fifo.stderr).toBe(0);
        const script = `
            const { withRuntimeBindGuard, readRuntimeBindAuthority } = await import(${JSON.stringify(new URL("../adapters/runtime-bind-authority.ts", import.meta.url).href)});
            let rejected = false;
            try {
                withRuntimeBindGuard(process.argv[1], guard => {
                    rejected = readRuntimeBindAuthority(guard).coverage === "unknown";
                });
            } catch { rejected = true; }
            if (!rejected) process.exitCode = 1;
            console.log(JSON.stringify({ rejected }));
        `;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home.root], {
            cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 5_000, windowsHide: true,
        });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout.trim())).toEqual({ rejected: true });
        expect(lstatSync(history()).isFIFO()).toBe(true);
        expect(readFileSync(original)).toEqual(before);
    });
});
