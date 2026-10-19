import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionLockOwner } from "../../domain/session-lock.js";

// Real plain-Node consumers of the built public facade. The coordinator builds
// in the private execution copy before this suite; no Docker/VM is started.
const facadeUrl = new URL("../../../dist/session.js", import.meta.url).href;
const roots: string[] = [];
const children: Array<{ child: ChildProcess; completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> = [];

function launch(root: string, program: string) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root, CCC_HOME: undefined, CCC_PROFILE: undefined },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", data => { stderr += String(data); });
    const messages: unknown[] = [];
    const waiters = new Set<() => void>();
    let terminal: Error | null = null;
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", error => { terminal = error; for (const waiter of waiters) waiter(); reject(error); });
        child.once("close", (code, signal) => {
            terminal = new Error(`child closed: ${code}/${signal}; ${stderr}`);
            for (const waiter of waiters) waiter(); resolve({ code, signal });
        });
    });
    // Register handlers before any assertion; teardown always joins both children.
    completed.catch(() => undefined);
    child.on("message", message => { messages.push(message); for (const waiter of waiters) waiter(); });
    children.push({ child, completed });
    function message(kind: string): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const inspect = () => {
                const found = messages.find(value => value !== null && typeof value === "object" && (value as Record<string, unknown>).kind === kind);
                if (found) { clearTimeout(timer); waiters.delete(inspect); resolve(found as Record<string, unknown>); }
                else if (terminal) { clearTimeout(timer); waiters.delete(inspect); reject(terminal); }
            };
            const timer = setTimeout(() => { waiters.delete(inspect); reject(new Error(`missing ${kind}; ${stderr}`)); }, 20000);
            waiters.add(inspect); inspect();
        });
    }
    return { child, completed, messages, message, stderr: () => stderr };
}

afterEach(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(children.splice(0).map(({ completed }) => completed));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session claim reservation and replacement share the native lifecycle guard", () => {
    it("excludes a second process after the replacement check and until its callback exits", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-session-claims-race-")); roots.push(root);
        const release = join(root, "release"); const entered = join(root, "reserved");
        const first = launch(root, `
import fs from 'node:fs';
const session = await import(${JSON.stringify(facadeUrl)});
const deadline = Date.now() + 25000;
const wait = new Int32Array(new SharedArrayBuffer(4));
const replaced = session.recreateContainerWithoutInterruptingSessions('race-project', 'absent-current.lock', () => {
  process.send({kind:'checked'});
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() > deadline) throw new Error('release handshake expired');
    Atomics.wait(wait, 0, 0, 10);
  }
  if (fs.existsSync(${JSON.stringify(entered)})) throw new Error('reservation entered replacement gap');
});
process.send({kind:'replaced', replaced});
process.disconnect();
`);
        await first.message("checked");
        const second = launch(root, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const originalOpen = fs.openSync;
let acknowledged = false;
fs.openSync = function (...args) {
  try { return originalOpen.apply(this,args); }
  catch(error) {
    if (!acknowledged && String(args[0]).endsWith('race-project.container-lifecycle.guard') && args[1] === 'wx' && error.code === 'EEXIST') {
      acknowledged = true;
      process.send({kind:'contended'});
    }
    throw error;
  }
};
syncBuiltinESMExports();
const session = await import(${JSON.stringify(facadeUrl)});
const claim = session.createSessionLock('race-project');
fs.writeFileSync(${JSON.stringify(entered)}, claim);
process.send({kind:'reserved',claim});
process.disconnect();
`);
        await second.message("contended");
        expect(existsSync(entered)).toBe(false);
        expect(second.messages.some(value => (value as { kind?: string }).kind === "reserved")).toBe(false);
        writeFileSync(release, "release");
        expect(await first.message("replaced")).toMatchObject({ replaced: true });
        const reserved = await second.message("reserved");
        expect(readFileSync(entered, "utf8")).toBe(reserved.claim);
        const content = readFileSync(String(reserved.claim), "utf8");
        const owner = sessionLockOwner(content);
        expect(owner).toMatchObject({ pid: second.child.pid, ownershipKind: "direct" });
        expect(JSON.parse(content)).toMatchObject({ version: 3, pid: second.child.pid, ownershipKind: "direct" });
        expect(owner?.startToken === undefined || typeof owner.startToken === "string").toBe(true);
        expect(await first.completed, first.stderr()).toEqual({ code: 0, signal: null });
        expect(await second.completed, second.stderr()).toEqual({ code: 0, signal: null });
    }, 45000);

    it("releases a failed replacement guard and preserves distinct setup/family/lifecycle keys", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-session-claims-keys-")); roots.push(root);
        const first = launch(root, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
const session = await import(${JSON.stringify(facadeUrl)});
assert.throws(() => session.recreateContainerWithoutInterruptingSessions('keys-project','absent.lock',() => { throw new Error('callback failed'); }), /callback failed/);
await session.withContainerSetupLockAsync('keys-project', async () => {
  session.withProjectFamilyLifecycleLock('keys-project', () => {
    session.withContainerLifecycleLock('keys-project', () => {
      const claim = session.createSessionLock('unrelated-project');
      const directory = claim.slice(0, Math.max(claim.lastIndexOf('/'), claim.lastIndexOf('\\\\')));
      for (const suffix of ['container-setup','project-family-lifecycle','container-lifecycle']) {
        assert.equal(fs.existsSync(directory + '/' + 'keys-project.' + suffix + '.guard'),true,suffix);
      }
    });
  });
});
process.send({kind:'released'});
process.disconnect();
`);
        await first.message("released");
        expect(await first.completed, first.stderr()).toEqual({ code: 0, signal: null });
        const second = launch(root, `
const session = await import(${JSON.stringify(facadeUrl)});
const claim = session.createSessionLock('keys-project');
process.send({kind:'reserved',claim});
process.disconnect();
`);
        const reserved = await second.message("reserved");
        expect(existsSync(String(reserved.claim))).toBe(true);
        expect(await second.completed, second.stderr()).toEqual({ code: 0, signal: null });
    }, 45000);
});
