import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(), read: vi.fn(), powershell: vi.fn(), tasklist: vi.fn(),
}));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: mocks.spawn,
}));
vi.mock("fs", async original => ({
    ...await original<typeof import("node:fs")>(), readFileSync: mocks.read,
}));
vi.mock("@ccc/device-lab/windows-system-powershell.js", async original => ({
    ...await original<typeof import("@ccc/device-lab/windows-system-powershell.js")>(),
    canonicalWindowsPowerShellPath: mocks.powershell,
    canonicalWindowsTasklistPath: mocks.tasklist,
}));
const facade = await import("../../session-lock-liveness.js");
const { spawnSync: nativeSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const killDescriptor = Object.getOwnPropertyDescriptor(process, "kill")!;
const pid = 4242;
const lock = (token: string) => JSON.stringify({ version: 2, pid, startToken: token });
const options = (timeout: number) => ({ encoding: "utf-8", timeout, windowsHide: true });
const result = (stdout = "", status: number | null = 0, stderr = "") => ({ stdout, status, stderr });
const taskRow = (owner: number) => `"fixture.exe","${owner}","Console","1","1,000 K"`;
function platform(value: string): void {
    Object.defineProperty(process, "platform", { configurable: true, value });
}

describe("session liveness public facade preserves native adapters", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        platform("linux");
        mocks.powershell.mockReturnValue("C:\\fixture\\powershell.exe");
        mocks.tasklist.mockReturnValue("C:\\fixture\\tasklist.exe");
        mocks.read.mockImplementation(() => { throw Object.assign(new Error("unexpected proc read"), { code: "EACCES" }); });
        mocks.spawn.mockImplementation(() => { throw new Error("unexpected spawn"); });
        Object.defineProperty(process, "kill", { configurable: true, value: vi.fn(() => { throw new Error("unexpected probe"); }) });
    });
    afterEach(() => {
        Object.defineProperty(process, "platform", platformDescriptor);
        Object.defineProperty(process, "kill", killDescriptor);
        vi.restoreAllMocks();
    });

    it("keeps the original runtime exports, decoder and parser", () => {
        expect(Object.keys(facade).sort()).toEqual([
            "observeProcessStarts", "parseProcessStartObservations", "processStartToken", "sessionLockLiveness", "sessionLockOwner",
        ].sort());
        expect(facade.sessionLockOwner(JSON.stringify({ version: 2, pid, startToken: " ", extra: true })))
            .toEqual({ pid, startToken: " " });
        expect(facade.sessionLockOwner(" 4242\n")).toEqual({ pid });
        expect(facade.sessionLockOwner("04242")).toBeNull();
        expect([...facade.parseProcessStartObservations(" 04242 UNKNOWN\r\n4242 FOUND:9\n9 MISSING\n4243 FOUND:7", [pid, 4243])])
            .toEqual([[pid, { status: "unknown" }], [4243, { status: "found", token: "windows:7" }]]);
    });

    it("invalid and cached versioned records leave platform and kill getters untouched", () => {
        const touched = vi.fn(() => { throw new Error("eager native getter"); });
        Object.defineProperty(process, "platform", { configurable: true, get: touched });
        Object.defineProperty(process, "kill", { configurable: true, get: touched });
        expect(facade.sessionLockLiveness("invalid")).toBe("unknown");
        expect(facade.sessionLockLiveness(lock("opaque"), new Map([[pid, { status: "found", token: "opaque" }]]))).toBe("active");
        expect(touched).not.toHaveBeenCalled();
        expect(mocks.read).not.toHaveBeenCalled();
        expect(mocks.spawn).not.toHaveBeenCalled();
    });



    it("Linux proc stat uses the final close parenthesis and original start-time field", () => {
        mocks.read.mockReturnValue(`4242 (fixture ) name) ${["S", ...Array(18).fill("0"), "987", "later"].join(" ")}`);
        expect(facade.processStartToken(pid)).toBe("linux:987");
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith(`/proc/${pid}/stat`, "utf-8");
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each(["Z", "X"])("Linux exited state %s is stale even when its birth ticks match", state => {
        mocks.read.mockReturnValue(`4242 (fixture ) name) ${[state, ...Array(18).fill("0"), "987"].join(" ")}`);
        expect(facade.sessionLockLiveness(lock("linux:987"))).toBe("stale");
        expect(facade.sessionLockLiveness(String(pid))).toBe("stale");
        expect(facade.processStartToken(pid)).toBeNull();
        expect(process.kill).not.toHaveBeenCalled();
    });

    it.each(["R", "S"])("Linux running state %s keeps matching ownership active", state => {
        mocks.read.mockReturnValue(`4242 (fixture) ${[state, ...Array(18).fill("0"), "987"].join(" ")}`);
        expect(facade.sessionLockLiveness(lock("linux:987"))).toBe("active");
        expect(facade.sessionLockLiveness(lock("linux:986"))).toBe("stale");
        Object.defineProperty(process, "kill", { configurable: true, value: vi.fn(() => true) });
        expect(facade.sessionLockLiveness(String(pid))).toBe("active");
    });

    it.each(["malformed", "4242 (fixture) S 0", `4242 (fixture) ${["S", ...Array(18).fill("0"), "invalid"].join(" ")}`])("incomplete Linux stat %s remains unknown", stat => {
        mocks.read.mockReturnValue(stat);
        expect(facade.sessionLockLiveness(lock("linux:987"))).toBe("unknown");
        expect(facade.processStartToken(pid)).toBeNull();
        Object.defineProperty(process, "kill", { configurable: true, value: vi.fn(() => true) });
        expect(facade.sessionLockLiveness(String(pid))).toBe("active");
    });
    it.each([["ENOENT", "stale"], ["EACCES", "unknown"]])("Linux %s keeps its conservative result", (code, expected) => {
        mocks.read.mockImplementation(() => { throw Object.assign(new Error("fixture"), { code }); });
        expect(facade.sessionLockLiveness(lock("linux:987"))).toBe(expected);
        Object.defineProperty(process, "kill", { configurable: true, value: vi.fn(() => true) });
        expect(facade.sessionLockLiveness(String(pid))).toBe(code === "ENOENT" ? "stale" : "active");
        expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it.each([
        [result(" Tue Jan 2 03:04:05 2024\n"), "ps:Tue Jan 2 03:04:05 2024", "active"],
        [result("", 1), null, "stale"], [result("", 0), null, "unknown"],
        [result("date", 2), null, "unknown"], [result("date", 0, "warning"), null, "unknown"],
        [{ ...result("date"), error: new Error("fixture") }, null, "unknown"],
    ])("ps observation retains status/diagnostic handling %#", (answer, token, expected) => {
        platform("darwin"); mocks.spawn.mockReturnValue(answer);
        expect(facade.processStartToken(pid)).toBe(token);
        expect(facade.sessionLockLiveness(lock("ps:Tue Jan 2 03:04:05 2024"))).toBe(expected);
        expect(mocks.spawn.mock.calls).toEqual(Array(2).fill(["/bin/ps", ["-p", String(pid), "-o", "lstart="], options(1000)]));
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it("Windows single observation retains its hidden PowerShell script and timeout", () => {
        platform("win32"); mocks.spawn.mockReturnValue(result("FOUND:123\r\n"));
        expect(facade.processStartToken(pid)).toBe("windows:123");
        const script = [
            "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
            `try { $P = [System.Diagnostics.Process]::GetProcessById(${pid}) }`,
            "catch [System.ArgumentException] { Write-Output 'MISSING'; exit 0 }",
            "catch { Write-Output 'UNKNOWN'; exit 0 }",
            "try { Write-Output ('FOUND:' + $P.StartTime.ToUniversalTime().Ticks) }", "catch { Write-Output 'UNKNOWN' }",
        ].join("\n");
        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("C:\\fixture\\powershell.exe",
            ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", script], options(5000));
        expect(mocks.tasklist).not.toHaveBeenCalled();
    });

    it.each([result("UNKNOWN"), result("FOUND:not-numeric"), result("", 1), result("", 0, "warning"),
        { ...result(), error: new Error("fixture") }])("inconclusive PowerShell falls back to tasklist %#", answer => {
        platform("win32"); mocks.spawn.mockReturnValueOnce(answer).mockReturnValueOnce(result(taskRow(pid)));
        expect(facade.sessionLockLiveness(String(pid), new Map([[pid, { status: "unknown" }]]))).toBe("active");
        expect(mocks.spawn).toHaveBeenCalledTimes(2);
        expect(mocks.spawn.mock.calls[1]).toEqual(["C:\\fixture\\tasklist.exe", ["/FO", "CSV", "/NH"], options(5000)]);
    });
    it("PowerShell MISSING is authoritative without tasklist", () => {
        platform("win32"); mocks.spawn.mockReturnValue(result("MISSING\n"));
        expect(facade.sessionLockLiveness(String(pid))).toBe("stale");
        expect(mocks.spawn).toHaveBeenCalledTimes(1); expect(mocks.tasklist).not.toHaveBeenCalled();
    });
    it.each([
        [result(taskRow(pid)), "active"], [result(taskRow(77)), "stale"],
        [result(""), "unknown"], [result(`${taskRow(pid)}\ninvalid`), "unknown"],
        [result(taskRow(pid), 1), "unknown"], [result(taskRow(pid), 0, "warning"), "unknown"],
    ])("missing PowerShell uses conservative tasklist CSV behavior %#", (answer, expected) => {
        platform("win32"); mocks.powershell.mockReturnValue(null); mocks.spawn.mockReturnValue(answer);
        expect(facade.sessionLockLiveness(String(pid))).toBe(expected);
        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("C:\\fixture\\tasklist.exe", ["/FO", "CSV", "/NH"], options(5000));
    });
    it("missing both Windows tools preserves unknown", () => {
        platform("win32"); mocks.powershell.mockReturnValue(null); mocks.tasklist.mockReturnValue(null);
        expect(facade.sessionLockLiveness(String(pid))).toBe("unknown"); expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it("Windows batch preserves deduplication, numeric filtering, exact script and parsed outcomes", () => {
        platform("win32"); mocks.spawn.mockReturnValue(result("4242 FOUND:123\r\n4243 MISSING\n4244 UNKNOWN\n9999 MISSING"));
        expect([...facade.observeProcessStarts([pid, pid, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 4243, 4244])])
            .toEqual([[pid, { status: "found", token: "windows:123" }], [4243, { status: "missing" }], [4244, { status: "unknown" }]]);
        const script = [
            "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'", "foreach ($id in @(4242,4243,4244)) {",
            "  try { $P = [System.Diagnostics.Process]::GetProcessById($id) }",
            "  catch [System.ArgumentException] { Write-Output ([string]$id + ' MISSING'); continue }",
            "  catch { Write-Output ([string]$id + ' UNKNOWN'); continue }",
            "  try { Write-Output ([string]$id + ' FOUND:' + $P.StartTime.ToUniversalTime().Ticks) }",
            "  catch { Write-Output ([string]$id + ' UNKNOWN') }", "}",
        ].join("\n");
        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith("C:\\fixture\\powershell.exe",
            ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", script], options(5000));
    });
    it.each([result("4242 MISSING", 1), result("4242 MISSING", 0, "warning"),
        { ...result(), error: new Error("fixture") }])("batch failure returns an empty fallback map %#", answer => {
        platform("win32"); mocks.spawn.mockReturnValue(answer);
        expect(facade.observeProcessStarts([pid, 4243]).size).toBe(0); expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
    it("batch throws/missing tool return empty, and small/non-Windows batches avoid discovery", () => {
        expect(facade.observeProcessStarts([pid, 4243]).size).toBe(0);
        platform("win32"); expect(facade.observeProcessStarts([pid, pid, 0]).size).toBe(0);
        expect(mocks.powershell).not.toHaveBeenCalled();
        expect(facade.observeProcessStarts([pid, 4243]).size).toBe(0);
        mocks.powershell.mockReturnValue(null);
        expect(facade.observeProcessStarts([pid, 4243]).size).toBe(0);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
    });
});

// These are real Node imports, separate from Vitest's module mocks. No native
// Versioned outcomes are cached. Legacy probes use the actual host platform:
// Unix keeps its kill fixture; Windows consumes pre-observed presence facts.
describe.each(["source", "built"] as const)("direct Node %s session liveness facade", artifact => {
    it("validates exports, codecs and cached/current liveness classifications", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-session-facade-"));
        const home = join(root, "home"); mkdirSync(home);
        try {
            const moduleUrl = new URL(artifact === "source" ? "../../session-lock-liveness.ts" : "../../../dist/session-lock-liveness.js", import.meta.url);
            const loader = createRequire(import.meta.url).resolve("tsx");
            const child = nativeSpawn(process.execPath, [
                ...(artifact === "source" ? ["--import", pathToFileURL(loader).href] : []),
                "--input-type=module", "-e", `
import assert from 'node:assert/strict';
const nativePlatform = process.platform;
let calls = [];
process.kill = function (pid, signal) { calls.push([pid, signal]); };
const api = await import(${JSON.stringify(moduleUrl.href)});
Object.defineProperty(process, 'platform', {configurable:true,get() { throw new Error('eager platform read'); }});
assert.deepEqual(Object.keys(api).sort(), ['observeProcessStarts', 'parseProcessStartObservations', 'processStartToken', 'sessionLockLiveness', 'sessionLockOwner'].sort());
const lock = JSON.stringify({version: 2, pid: 4242, startToken: 'opaque'});
assert.deepEqual(api.sessionLockOwner(lock), {pid: 4242, startToken: 'opaque'});
assert.deepEqual(api.sessionLockOwner(' 4242\\n'), {pid: 4242});
assert.equal(api.sessionLockOwner('04242'), null);
assert.deepEqual([...api.parseProcessStartObservations('4242 UNKNOWN\\r\\n4242 FOUND:9\\n4243 MISSING', [4242,4243])], [[4242,{status:'unknown'}],[4243,{status:'missing'}]]);
for (const [observation, expected] of [[{status:'found',token:'opaque'},'active'],[{status:'found',token:'other'},'stale'],[{status:'missing'},'stale'],[{status:'present'},'unknown']]) {
  assert.equal(api.sessionLockLiveness(lock,new Map([[4242,observation]])), expected);
}
assert.equal(api.sessionLockLiveness('invalid'), 'unknown');
Object.defineProperty(process, 'platform', {configurable:true,value:nativePlatform});
if (nativePlatform === 'win32') {
  assert.equal(api.sessionLockLiveness(String(process.pid),new Map([[process.pid,{status:'found',token:'windows:123'}]])), 'active');
  assert.equal(api.sessionLockLiveness(String(process.pid),new Map([[process.pid,{status:'missing'}]])), 'stale');
  assert.deepEqual(calls, []);
} else {
assert.equal(api.sessionLockLiveness(String(process.pid)), 'active');
process.kill = function (pid, signal) { calls.push([pid,signal]); throw Object.assign(new Error('fixture'),{code:'ESRCH'}); };
assert.equal(api.sessionLockLiveness(String(process.pid)), 'stale');
assert.deepEqual(calls, [[process.pid,0],[process.pid,0]]);
}
process.stdout.write('facade behavior passed');
`,
            ], { cwd: root, env: { HOME: home, USERPROFILE: home, PATH: "", TMPDIR: home, TEMP: home, TMP: home },
                encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
            expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
            expect(child.stderr).toBe(""); expect(child.stdout).toBe("facade behavior passed");
        } finally { rmSync(root, { recursive: true, force: true }); }
    }, 30000);
});
