import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {spawn, type ChildProcess} from "node:child_process";
import {chmodSync, chownSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {request} from "node:http";
import {connect, type Socket} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {prepareRuntimeBindHome, withRuntimeBindGuard} from "../adapters/runtime-bind-authority.js";
import {readDeviceRuntimeProcessStartToken} from "@ccc/device-lab/device-lab-process-identity.js";

// Use the coordinator's genuinely emitted closure, not hand-transpiled modules
// with an invented bind predicate. C/dist is rebuilt after Source/test freeze.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const product = (name: string) => pathToFileURL(join(repository, "dist", name)).href;
const processIdentityModule = pathToFileURL(createRequire(import.meta.url).resolve("@ccc/device-lab/device-lab-process-identity.js")).href;
interface RecordValue {port: number; token: string; bytes: string}

describe.skipIf(process.platform === "win32").each(["legacy", "run"] as const)("real clipboard state preservation with POSIX runtime fixture (%s layout)", layout => {
    let root: string, home: string, portFile: string, driver: string;
    const children: ChildProcess[] = [], descriptors: number[] = [], sockets: Socket[] = [];
    const daemons: Array<{pid: number; startToken: string}> = [];
    const childDiagnostics = new Map<ChildProcess, () => string>();
    let latestStartup: Promise<{code: number | null; stdout: string; stderr: string}> | undefined;
    beforeEach(() => {
        latestStartup = undefined;
        root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-clipboard-state-"))); home = join(root, "home"); mkdirSync(home, {mode: 0o700});
        const prepared = prepareRuntimeBindHome(join(home, ".ccc")); withRuntimeBindGuard(prepared, () => {});
        const data = join(home, ".ccc", ...(layout === "run" ? ["run"] : []));
        mkdirSync(join(data, "locks"), {recursive: true, mode: 0o700});
        portFile = join(data, "clipboard.port"); driver = join(root, "driver.mjs");
        const inertRuntime = join(root, "runtime.mjs");
        writeFileSync(inertRuntime, `#!${process.execPath}
const args=process.argv.slice(2); if(!args.includes('ps')) process.exit(91);
`);
        chmodSync(inertRuntime, 0o700);
        writeFileSync(driver, `
import {join} from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const {readDeviceRuntimeProcessStartToken}=await import(${JSON.stringify(processIdentityModule)});
const nativeSpawn=childProcess.spawn;
childProcess.spawn=function(...args){const child=nativeSpawn.apply(this,args);
 if(args[0]===process.execPath&&Array.isArray(args[1])&&args[1].includes('--serve')&&child.pid){
  const startToken=readDeviceRuntimeProcessStartToken(child.pid);if(startToken)process.send?.({spawned:{pid:child.pid,startToken}});
 }
 return child;
};syncBuiltinESMExports();
const runtime=await import(${JSON.stringify(product("container-runtime.js"))});
const {NATIVE_RUNTIME_SELECTOR_KEYS}=await import(${JSON.stringify(product("ports/container-runtime-invocation.js"))});
runtime._setRuntimeInvocationForTest({version:1,runtime:'docker',executable:${JSON.stringify(inertRuntime)},transport:{kind:'docker',host:'unix:///inert/state.sock',configDirectory:${JSON.stringify(root)},tls:{enabled:false,verify:false,caFile:null,certFile:null,keyFile:null}},selectors:Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key=>[key,null]))});
const action=process.argv[2];
if(action==='serve')process.argv=[process.execPath,join(${JSON.stringify(root)},'clipboard-server.js'),'--serve'];
const clipboard=await import(${JSON.stringify(product("clipboard-server.js"))});
if(action==='stop')await clipboard.stopClipboardServerIfLast(false);
else if(action==='retire')await clipboard.retireClipboardServerFromPortFile(${JSON.stringify(portFile)});
else if(action==='ensure')console.log(JSON.stringify(await clipboard.ensureClipboardSelection()));
`);
    });
    afterEach(async () => {
        for (const socket of sockets) socket.destroy();
        try {await send(readRecord(), "/shutdown", "POST");} catch { /* The owned publication may be absent or retired. */ }
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        for (const daemon of daemons) if (readDeviceRuntimeProcessStartToken(daemon.pid) === daemon.startToken) {
            try {process.kill(daemon.pid, "SIGKILL");} catch { /* The exact owned child has exited. */ }
        }
        await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
            : new Promise<void>(resolve => child.once("close", () => resolve()))));
        for (const descriptor of descriptors) closeSync(descriptor);
        children.length = descriptors.length = sockets.length = daemons.length = 0; childDiagnostics.clear(); rmSync(root, {recursive: true, force: true});
    });
    function start(action: string) {
        const child = spawn(process.execPath, [driver, action], {cwd: root,
            env: {...process.env, HOME: home, USERPROFILE: home, CCC_HOME: undefined, CCC_PROFILE: undefined, NODE_OPTIONS: undefined, VITEST: undefined},
            stdio: ["ignore", "pipe", "pipe", "ipc"]});
        children.push(child); let stdout = "", stderr = "";
        childDiagnostics.set(child, () => stderr.slice(-2048));
        child.stdout!.on("data", chunk => { stdout += String(chunk); }); child.stderr!.on("data", chunk => { stderr += String(chunk); });
        child.on("message", (message: unknown) => {
            if (message && typeof message === "object" && "spawned" in message) daemons.push(message.spawned as {pid: number; startToken: string});
        });
        const exited = new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
            child.once("error", reject); child.once("close", code => resolve({code, stdout, stderr}));
        });
        if (action === "serve") latestStartup = exited;
        return {child, exited};
    }
    function readRecord(): RecordValue {
        const bytes = readFileSync(portFile, "utf8"), [port, token] = bytes.split(":");
        return {port: Number(port), token, bytes};
    }
    function send(record: RecordValue, path: string, method = "GET"): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = request({hostname: "127.0.0.1", port: record.port, path, method, timeout: 1000,
                headers: {Authorization: `Bearer ${record.token}`, Connection: "close"}}, response => {
                let body = ""; response.on("data", chunk => { body += String(chunk); }); response.once("end", () => resolve(body)); response.once("error", reject);
            });
            req.once("error", reject); req.once("timeout", () => req.destroy(new Error("owned daemon response timed out"))); req.end();
        });
    }
    async function published(previous?: string) {
        // A visible authenticated listener can precede IPC commit and release
        // of its parent's startup slot. Subsequent commands begin only after
        // the actual public --serve operation has completed.
        if (latestStartup) {
            const completed = await latestStartup;
            if (completed.code !== 0) throw new Error(`Owned clipboard startup failed: ${completed.code}; stderr=${completed.stderr.slice(-2048) || "empty"}`);
        }
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
            try {
                const value = readRecord();
                const health = JSON.parse(await send(value, "/health"));
                if (value.bytes !== previous && /^\d+:[a-f0-9]{32}$/.test(value.bytes)
                    && health.valid === true && health.retirement === "writer-settlement-v1") return value;
            } catch { /* A private owned daemon may still be starting. */ }
            const failed = children.find(child => child.exitCode !== null && child.exitCode !== 0);
            if (failed) throw new Error(`Owned clipboard startup exited before publication: ${failed.exitCode}; stderr=${childDiagnostics.get(failed)?.() || "empty"}`);
            await new Promise(resolve => setTimeout(resolve, 15));
        }
        throw new Error("Owned clipboard daemon did not publish");
    }

    it("publishes private metadata for a genuinely missing port file", async () => {
        start("serve"); await published(); const after = statSync(portFile);
        if (process.platform !== "win32") expect(after.mode & 0o777).toBe(0o600);
    }, 15_000);

    it.each(["empty", "permissive"] as const)("refuses an existing %s unqualified publication without repairing its bytes or mode", async state => {
        writeFileSync(portFile, "", {mode: state === "permissive" ? 0o644 : 0o600}); const before = statSync(portFile);
        const result = await start("serve").exited; expect(result.code).toBe(1);
        expect(readFileSync(portFile, "utf8")).toBe("");
        expect(statSync(portFile)).toMatchObject({ino: before.ino, mode: before.mode, uid: before.uid, size: before.size});
        expect(daemons).toEqual([]);
    }, 15_000);

    it("terminal retirement and republishing keep a held descriptor on the original inode", async () => {
        start("serve"); const old = await published(), descriptor = openSync(portFile, "r"); descriptors.push(descriptor);
        const inode = fstatSync(descriptor).ino;
        const stopped = await start("stop").exited; expect(stopped.code, stopped.stderr).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(`retired-v1:${old.bytes}`); expect(statSync(portFile).ino).toBe(inode);
        start("serve"); const next = await published(old.bytes);
        expect(next.token).not.toBe(old.token); expect(statSync(portFile).ino).toBe(inode); expect(readFileSync(descriptor, "utf8")).toBe(next.bytes);
    }, 15_000);

    it("explicit retirement records settled writer state without unlinking the shared bind source", async () => {
        start("serve"); const old = await published(), inode = statSync(portFile).ino;
        const stopped = await start("retire").exited; expect(stopped.code, stopped.stderr).toBe(0);
        expect(statSync(portFile).ino).toBe(inode);
        expect(readFileSync(portFile, "utf8")).toBe(`retired-v1:${old.bytes}`);
    }, 15_000);

    it("an old daemon cannot unlink or overwrite its successor after acknowledged listener settlement", async () => {
        start("serve"); const old = await published();
        const originalDaemon = daemons.at(-1); expect(originalDaemon).toBeDefined();
        if (!originalDaemon) throw new Error("Owned daemon identity was not captured");
        expect(readDeviceRuntimeProcessStartToken(originalDaemon.pid)).toBe(originalDaemon.startToken);
        const pending = connect(old.port, "127.0.0.1"); sockets.push(pending); pending.on("error", () => {});
        await new Promise<void>(resolve => pending.once("connect", resolve));
        pending.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        const retired = await start("retire").exited; expect(retired.code, retired.stderr).toBe(0);
        // The ACK must progress while another old connection remains open.
        expect(readFileSync(portFile, "utf8")).toBe(`retired-v1:${old.bytes}`);
        start("serve"); const successor = await published(old.bytes); const inode = statSync(portFile).ino;
        pending.destroy();
        const exactDaemonCeased = () => {
            if (process.platform === "linux") {
                try {
                    const stat = readFileSync(`/proc/${originalDaemon.pid}/stat`, "utf8");
                    const close = stat.lastIndexOf(")"), fields = stat.slice(close + 1).trim().split(/\s+/);
                    if (!stat.startsWith(`${originalDaemon.pid} (`) || close < 0 || !/^[0-9]+$/.test(fields[19] ?? "")) return false;
                    const token = `linux:${fields[19]}`;
                    return token !== originalDaemon.startToken || fields[0] === "Z";
                } catch (error) {return (error as NodeJS.ErrnoException).code === "ENOENT";}
            }
            const token = readDeviceRuntimeProcessStartToken(originalDaemon.pid);
            if (token && token !== originalDaemon.startToken) return true;
            try {process.kill(originalDaemon.pid, 0); return false;}
            catch (error) {return (error as NodeJS.ErrnoException).code === "ESRCH";}
        };
        const deadline = performance.now() + 10_000;
        while (!exactDaemonCeased()) {
            if (performance.now() >= deadline) throw new Error("Exact old clipboard daemon did not cease");
            await new Promise(resolve => setTimeout(resolve, 15));
        }
        expect(readFileSync(portFile, "utf8")).toBe(successor.bytes); expect(statSync(portFile).ino).toBe(inode);
        expect(JSON.parse(await send(successor, "/health")).valid).toBe(true);
    }, 15_000);

    it("another live or unreadable session keeps the current daemon and exact publication intact", async () => {
        start("serve"); const old = await published(), inode = statSync(portFile).ino;
        writeFileSync(join(home, ".ccc", ...(layout === "run" ? ["run"] : []), "locks", "other.lock"), "unknown-owner", {mode: 0o600});
        const stopped = await start("stop").exited; expect(stopped.code, stopped.stderr).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(old.bytes); expect(statSync(portFile).ino).toBe(inode);
        expect(JSON.parse(await send(old, "/health")).valid).toBe(true);
    }, 15_000);

    for (const kind of ["symlink", "hardlink", "directory"] as const) {
        it.skipIf(kind === "symlink" && process.platform === "win32")(`refuses a ${kind} target without modifying its sentinel`, async () => {
            const sentinel = join(root, "sentinel"); writeFileSync(sentinel, "private-sentinel", {mode: 0o640});
            if (kind === "symlink") symlinkSync(sentinel, portFile);
            else if (kind === "hardlink") linkSync(sentinel, portFile);
            else {mkdirSync(portFile); writeFileSync(join(portFile, "sentinel"), "directory-sentinel");}
            const before = statSync(sentinel), named = lstatSync(portFile), result = await start("serve").exited;
            expect(result.code).toBe(1);
            expect(readFileSync(sentinel, "utf8")).toBe("private-sentinel");
            expect(statSync(sentinel)).toMatchObject({ino: before.ino, mode: before.mode, uid: before.uid, size: before.size});
            expect(lstatSync(portFile)).toMatchObject({ino: named.ino, mode: named.mode});
            if (kind === "directory") expect(readFileSync(join(portFile, "sentinel"), "utf8")).toBe("directory-sentinel");
        }, 15_000);
    }
    it.skipIf(process.platform === "win32")("refuses a dangling symlink without creating its target", async () => {
        const target = join(root, "must-remain-missing"); symlinkSync(target, portFile); const before = lstatSync(portFile);
        const result = await start("serve").exited; expect(result.code).toBe(1); expect(existsSync(target)).toBe(false);
        expect(lstatSync(portFile)).toMatchObject({ino: before.ino, mode: before.mode});
    }, 15_000);
    it.skipIf(process.getuid?.() !== 0)("refuses foreign ownership without rewriting bytes or permissions", async () => {
        writeFileSync(portFile, "foreign-owner-sentinel", {mode: 0o666}); chownSync(portFile, 65534, 65534); const before = statSync(portFile);
        expect((await start("serve").exited).code).toBe(1); expect(readFileSync(portFile, "utf8")).toBe("foreign-owner-sentinel");
        expect(statSync(portFile)).toMatchObject({ino: before.ino, mode: before.mode, uid: before.uid, size: before.size});
    }, 15_000);
});
