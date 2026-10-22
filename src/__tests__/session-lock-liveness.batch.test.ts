import { describe, it, expect } from "vitest";
import { observeProcessStarts, parseProcessStartObservations, sessionLockLiveness } from "../session-lock-liveness.js";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

it.runIf(process.platform === "linux")("observes a real owned zombie and reclaims its unavailable-identity guards through both native facades", () => {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const script = `
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
const pid=Number(process.argv[1]);
const stat=readFileSync('/proc/'+pid+'/stat','utf8');
const fields=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/);
assert.equal(fields[0],'Z');
process.kill(pid,0);
const session=await import(${JSON.stringify(new URL("../session-lock-liveness.ts", import.meta.url).href)});
assert.equal(session.processStartToken(pid),null);
assert.equal(session.sessionLockLiveness(JSON.stringify({version:2,pid,startToken:'linux:'+fields[19]})),'stale');
assert.equal(session.sessionLockLiveness(String(pid)),'stale');
const modules=[await import(${JSON.stringify(new URL("../../packages/device-lab/src/device-lab-shared-state.ts", import.meta.url).href)}),await import(${JSON.stringify(new URL("../../packages/device-lab/providers/state/shared-mutation-lock.mjs", import.meta.url).href)})];
const root=mkdtempSync(join(tmpdir(),'ccc-owned-zombie-'));
try {
 for(const api of modules) for(const acquire of [api.withSharedMutationLock,api.withSharedMutationLockAsync]) {
  const file=join(root,'mutation.guard');
  writeFileSync(file,JSON.stringify({token:'0123456789abcdef0123456789abcdef',pid,host:hostname(),processIdentityStatus:'unavailable'}));
  let calls=0;
  assert.equal(await acquire(file,()=>{calls++;return 'admitted';},{waitMs:500}),'admitted');
  assert.equal(calls,1);assert.equal(existsSync(file),false);
 }
} finally {rmSync(root,{recursive:true,force:true});}
process.stdout.write('owned zombie qualified');
`;
    const python = `
import os,sys,time,subprocess
pid=os.fork()
if pid==0: os._exit(0)
try:
 deadline=time.monotonic()+3
 while True:
  stat=open('/proc/%d/stat'%pid).read()
  if stat[stat.rfind(')')+1:].split()[0]=='Z': break
  if time.monotonic()>deadline: raise RuntimeError('owned child did not become zombie')
  time.sleep(.01)
 result=subprocess.run([sys.argv[1],'--import',sys.argv[2],'--input-type=module','-e',sys.argv[3],str(pid)],capture_output=True,text=True,timeout=12)
 sys.stdout.write(result.stdout);sys.stderr.write(result.stderr)
 sys.exit(result.returncode)
finally:
 os.waitpid(pid,0)
`;
    const result = spawnSync("python3", ["-c", python, process.execPath, loader, script], { encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("owned zombie qualified");
}, 25_000);

// The saving this batches for is a Windows one — one `powershell.exe` per candidate lock file,
// on every `ccc` invocation, which is why the operator's report of PowerShell windows varied
// between runs: it scales with how many leftover locks a host carries, not with the work being
// done. That launch count cannot be observed from Linux, so these assert the property the
// saving rests on instead: a pre-observed pid is USED, and the single-pid probe is not
// consulted for it. The synthetic token cannot be produced for this pid by the real probe,
// so an "active" answer can only have come from the map. Native probes may reject this pid
// as outside their range and correctly leave its identity unknown.
describe("pre-observed process starts", () => {
    const absentPid = 999_999_000;
    const lock = (pid: number, startToken: string) => JSON.stringify({ version: 2, pid, startToken });

    it("answers from the map instead of probing the pid", () => {
        const observed = new Map([[absentPid, { status: "found" as const, token: "windows:8675309" }]]);

        expect(
            sessionLockLiveness(lock(absentPid, "windows:8675309"), observed),
            "the token matches what was observed, so the owner is live",
        ).toBe("active");
        expect(
            sessionLockLiveness(lock(absentPid, "windows:8675309")),
            "without the map the real probe cannot establish this synthetic identity",
        ).not.toBe("active");
    });

    it("keeps the map from ever inventing liveness", () => {
        expect(
            sessionLockLiveness(lock(absentPid, "windows:1"), new Map([[absentPid, { status: "found" as const, token: "windows:2" }]])),
            "a different token is a recycled pid, which is stale",
        ).toBe("stale");
        expect(
            sessionLockLiveness(lock(absentPid, "windows:1"), new Map([[absentPid, { status: "missing" as const }]])),
            "and missing is stale",
        ).toBe("stale");
        // `unknown` from the batch is not an answer, so it is not taken as one: the single-pid
        // path is asked, and ITS answer wins. For a pid that does not exist that answer is
        // stale, which is what the batch-free code has always said. QA found this: taking the
        // batch's `unknown` skipped the tasklist fallback behind the single-pid probe and
        // turned a live-but-unreadable owner from "active" into "unknown".
        expect(
            sessionLockLiveness(lock(absentPid, "windows:1"), new Map([[absentPid, { status: "unknown" as const }]])),
            "an unknown batch entry defers to the real probe",
        ).toBe(sessionLockLiveness(lock(absentPid, "windows:1")));
    });

    it("falls through for a pid the batch did not answer for", () => {
        // An empty map is the shape every non-Windows host gets, and the shape Windows gets
        // when the batch itself fails. It must change nothing.
        expect(sessionLockLiveness(lock(process.pid, "ps:whatever"), new Map()))
            .toBe(sessionLockLiveness(lock(process.pid, "ps:whatever")));
    });

    it("asks for nothing when there is nothing to ask about", () => {
        expect(observeProcessStarts([]).size).toBe(0);
        // Off Windows there is no batch to run: the per-pid probes there are `/proc` reads and
        // a single `ps`, which cost nothing worth batching.
        if (process.platform !== "win32") expect(observeProcessStarts([process.pid]).size).toBe(0);
    });
});

// The batch script only runs on Windows, so the parse is the only half of it a test on any
// other host can reach. Review found two mutations unkillable without this split — the token
// prefix, and MISSING silently becoming unknown — and the second of those is the difference
// between deleting a dead owner's lock and keeping it forever.
describe("the batch script's output", () => {
    const pids = [4242, 4243, 4244];

    it("reads each status as the single-pid probe would", () => {
        const parsed = parseProcessStartObservations(
            ["4242 FOUND:133000000000000000", "4243 MISSING", "4244 UNKNOWN"].join("\n"),
            pids,
        );

        expect(parsed.get(4242), "same prefix as every other windows token producer")
            .toEqual({ status: "found", token: "windows:133000000000000000" });
        expect(parsed.get(4243), "MISSING is what makes a lock deletable; it must not blur")
            .toEqual({ status: "missing" });
        expect(parsed.get(4244)).toEqual({ status: "unknown" });
    });

    it("ignores anything it was not asked about or cannot read", () => {
        const parsed = parseProcessStartObservations(
            [
                "9999 FOUND:1",            // never asked about
                "4242 FOUND:not-a-number", // malformed
                "garbage",
                "4243 MISSING",
                "4243 FOUND:5",            // a second answer for one pid
            ].join("\r\n"),
            pids,
        );

        expect(parsed.has(9999), "a pid we did not ask about is not ours to judge").toBe(false);
        expect(parsed.has(4242), "an unreadable answer is no answer").toBe(false);
        expect(parsed.get(4243), "first answer wins; a later one cannot overturn it")
            .toEqual({ status: "missing" });
    });

    it("returns nothing for empty output", () => {
        expect(parseProcessStartObservations("", pids).size).toBe(0);
    });
});
