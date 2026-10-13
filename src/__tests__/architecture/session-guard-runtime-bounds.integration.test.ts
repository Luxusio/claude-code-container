import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));

// The fixture runs built public modules in a separate process. Only its private executable is
// dispatched; the parent watchdog also kills that process group on regressions.
describe.skipIf(process.platform === "win32")("guarded native runtime bounds (POSIX SIGTERM fixture)", () => {
    it.each(["info", "stop", "rm"] as const)("refuses a stubborn %s client and releases the native guard", async operation => {
        const root = mkdtempSync(join(tmpdir(), "ccc-runtime-bound-"));
        const executable = join(root, "runtime.cjs");
        const trace = join(root, "trace.jsonl");
        writeFileSync(executable, `
const fs = require('node:fs');
const operation = process.argv[2];
fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({kind:'executed', operation})+'\\n');
if (operation === process.env.FIXTURE_HANG) {
  process.on('SIGTERM', () => {});
  fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({kind:'stubborn', operation})+'\\n');
  setInterval(() => {}, 1000);
}
`);
        const program = join(root, "consumer.mjs");
        writeFileSync(program, `
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const originalSpawnSync = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command !== 'docker' && command !== 'podman') return originalSpawnSync(command,args,options);
  const operation = args[0];
  fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({kind:'options',operation,timeout:options?.timeout,killSignal:options?.killSignal})+'\\n');
  // An absent production bound is deliberately left absent: only the independent
  // parent watchdog can rescue that regression. Keep the production kill signal.
  const timeout = Number.isFinite(options?.timeout) && options.timeout > 0 ? 350 : options?.timeout;
  return originalSpawnSync(process.execPath,[${JSON.stringify(executable)},...args],{...options,timeout});
};
syncBuiltinESMExports();
const {withContainerLifecycleLock} = await import(${JSON.stringify(resolve(repository, "dist/session.js"))});
const {locksDir} = await import(${JSON.stringify(resolve(repository, "dist/home-layout.js"))});
const {ensureDockerRunning} = await import(${JSON.stringify(resolve(repository, "dist/docker.js"))});
const {_setRuntimeInfoForTest} = await import(${JSON.stringify(resolve(repository, "dist/container-runtime.js"))});
_setRuntimeInfoForTest({runtime:'docker'});
const {createNativeContainerDestructiveLifecycle} = await import(${JSON.stringify(resolve(repository, "dist/composition/container-destructive-lifecycle.js"))});
const prefix = 'private-runtime-bounds';
const guard = locksDir()+'/'+prefix+'.container-lifecycle.guard';
let guarded = false;
let outcome;
const lifecycle = createNativeContainerDestructiveLifecycle({
  resolvePath: p => p, projectId: () => prefix, containerName: () => 'private',
  withLifecycleLock: (key, callback) => withContainerLifecycleLock(key, () => {
    guarded = fs.existsSync(guard);
    return callback();
  }),
  sessionClaims: () => [], ensureRuntime: process.env.FIXTURE_HANG === 'info' ? ensureDockerRunning : () => {},
  managedIdentity: () => ({containerId:'a'.repeat(64),running:true}), cleanupDevices: () => {},
});
try {
  lifecycle.remove('private');
} catch (error) { outcome = error.message; }
const released = !fs.existsSync(guard);
const reacquired = withContainerLifecycleLock(prefix, () => fs.existsSync(guard));
fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({kind:'result',guarded,outcome,released,reacquired,finallyReleased:!fs.existsSync(guard)})+'\\n');
`);
        let output = "";
        const child = spawn(process.execPath, [program], {
            cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HOME: root, USERPROFILE: root, CCC_HOME: undefined, CCC_PROFILE: undefined,
                CCC_RUNTIME: "docker", FIXTURE_TRACE: trace, FIXTURE_HANG: operation },
        });
        child.stdout!.on("data", data => { output += String(data); });
        child.stderr!.on("data", data => { output += String(data); });
        let watchdogExpired = false;
        const killGroup = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
        const watchdog = setTimeout(() => { watchdogExpired = true; killGroup(); }, 15_000);
        try {
            const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveChild, reject) => {
                child.once("error", reject);
                child.once("close", (code, signal) => resolveChild({ code, signal }));
            });
            expect(watchdogExpired, output).toBe(false);
            expect(result, output).toEqual({ code: 0, signal: null });
            const rows = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
            const options = rows.filter(row => row.kind === "options");
            expect(options.map(row => row.operation)).toEqual(operation === "rm" ? ["stop", "rm"] : [operation]);
            for (const row of options) {
                expect(row.timeout).toBe(row.operation === "info" ? 10_000 : 30_000);
                expect(row.killSignal).toBe("SIGKILL");
            }
            expect(rows.filter(row => row.kind === "stubborn")).toEqual([{ kind: "stubborn", operation }]);
            expect(rows.at(-1)).toEqual({ kind: "result", guarded: true,
                outcome: operation === "info" ? "docker is not running." : operation === "stop" ? "Failed to stop container." : "Failed to remove container.",
                released: true, reacquired: true, finallyReleased: true });
        } finally {
            clearTimeout(watchdog);
            killGroup();
            rmSync(root, { recursive: true, force: true });
        }
    });
});
