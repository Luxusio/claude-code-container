import { nodeProviderFixturePreloadSource } from "./node-provider-fixture.js";
import { deviceLabTestHomeEnvironment } from "./device-lab-test-environment.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, existsSync, openSync, closeSync, fstatSync, readSync, constants as fsConstants } from "fs";
import { createHash, randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { inspectProcessIdentity, readProcessIdentity } from "@ccc/device-lab/providers/state/process-identity.mjs";
import { waitForExpectedRuntimeExitAsync, type RuntimeExitObservation } from "@ccc/device-lab/device-lab/adapters/process/runtime-exit.js";
import { tmpdir } from "os";
import { join } from "path";
import { installDefaultImplicitBroker, repoRoot, TIMEOUT } from "./device-lab-mcp-fixture.js";

export { TIMEOUT };

export interface FakeIosMcpContext {
    client: Client;
    homeDir: string;
    binDir: string;
    logPath: string;
    lifetimeEvidence?: string;
}

type Identity = { pid: number; startToken: string; commandHash: string };
type Observation = { status: string; liveness?: string };
export interface FakeIosLifetimeEffects {
    inspect(identity: Identity, pid: number): Observation;
    waitForExit(identity: Identity, timeoutMs: number): Promise<RuntimeExitObservation>;
    signal(pid: number, signal: NodeJS.Signals): void;
    beforeSignal?(pid: number): void;
    remove(path: string): void;
}
const nativeEffects: FakeIosLifetimeEffects = {
    inspect: (identity, pid) => {
        if (process.platform === "linux") {
            try {
                const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
                const fields = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
                if ((fields[0] === "Z" || fields[0] === "X") && `linux:${fields[19]}` === identity.startToken) return { status: "exited", liveness: "exited" };
            } catch { /* Null identity alone never proves exit; use native liveness below. */ }
        }
        return inspectProcessIdentity(identity, pid);
    },
    waitForExit: (identity, timeoutMs) => waitForExpectedRuntimeExitAsync(identity, timeoutMs),
    signal: (pid, signal) => { process.kill(pid, signal); },
    remove: path => rmSync(path, { recursive: true, force: true }),
};
type Runtime = { pid: number; identity: Identity; commandHash: string };
type PendingAllocation = { schema: 1; kind: "pending"; token: string; allocationId: string; pid: number; port: number };
type Allocation = Omit<PendingAllocation, "kind"> & { kind: "allocation"; identity: Identity };
type Journal = { path: string; header: string; dev: string; ino: string; mtimeNs: string; ctimeNs: string };
type Owner = {
    readonly token: string; readonly homeDir: string; readonly binDir: string; readonly logPath: string; readonly client: Client;
    readonly roots: ReadonlyArray<Readonly<{ path: string; dev: number; ino: number }>>;
    readonly journal: Readonly<Journal>;
    transport?: StdioClientTransport; mcp?: Runtime; snapshots: string[];
    activeRequests: number; historyBytes: string; coverageError?: string;
    transportStarted: boolean; transportClosed: boolean; transportClosing: boolean;
    closeObserved?: Promise<void>; reportTransportClosed?: () => void;
};
const owners = new WeakMap<FakeIosMcpContext, Owner>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// Native Windows identity hashes the unmodified command line produced by libuv.
// Model only Node's fixed non-verbatim argv; never derive authority from a marker.
function nodeInvocationHash(args: readonly string[]): string {
    const quote = (argument: string): string => {
        if (argument !== "" && !/[ \t"]/.test(argument)) return argument;
        let quoted = '"', backslashes = 0;
        for (const character of argument) {
            if (character === "\\") { backslashes++; continue; }
            quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
            backslashes = 0;
        }
        return quoted + "\\".repeat(backslashes * 2) + '"';
    };
    return hash((process.platform === "win32" ? args.map(quote) : args).join(" "));
}
function appiumInvocationHashes(owner: Pick<Owner, "binDir">, port: number): readonly string[] {
    const args = [process.execPath, join(owner.binDir, "appium"), "server", "--port", String(port)];
    // Existing direct lifetime controls use the first vector; the public provider
    // adds its fixed base-path flag. Neither admits arbitrary extra arguments.
    return [nodeInvocationHash(args), nodeInvocationHash([...args, "--base-path", "/"])];
}

function plainFile(path: string): boolean {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}
function contextMatches(context: FakeIosMcpContext, owner: Owner): boolean {
    return context.homeDir === owner.homeDir && context.binDir === owner.binDir && context.logPath === owner.logPath && context.client === owner.client;
}
function ownedRoots(owner: Owner): boolean {
    return owner.roots.every(root => {
        const stat = lstatSync(root.path);
        return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === root.dev && stat.ino === root.ino;
    });
}
function readAllocationJournal(owner: Owner): { allocations: Allocation[]; pending: PendingAllocation[]; bytes: string } {
    const expected = owner.journal;
    const path = lstatSync(expected.path, { bigint: true });
    const matches = (stat: typeof path, pathname = false) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n
        && BigInt(expected.dev) > 0n && stat.ino > 0n && String(stat.ino) === expected.ino
        && (String(stat.dev) === expected.dev || pathname && process.platform === "win32" && stat.dev === 0n);
    if (!matches(path, true)) throw new Error("allocation journal identity unavailable");
    const descriptor = openSync(expected.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        if (!matches(opened) || !matches(lstatSync(expected.path, { bigint: true }), true)) throw new Error("allocation journal changed");
        const buffer = Buffer.alloc(32769);
        let count = 0;
        while (count < buffer.length) {
            const read = readSync(descriptor, buffer, count, buffer.length - count, null);
            if (!read) break;
            count += read;
        }
        if (count > 32768) throw new Error("allocation journal exceeds byte bound");
        const bytes = buffer.subarray(0, count).toString("utf8");
        if (!bytes.startsWith(expected.header) || !bytes.endsWith("\n")) throw new Error("allocation journal incomplete/foreign");
        const lines = bytes.slice(expected.header.length).split("\n"); lines.pop();
        if (lines.length > 64) throw new Error("allocation journal exceeds record bound");
        if (!lines.length && (String(opened.mtimeNs) !== expected.mtimeNs || String(opened.ctimeNs) !== expected.ctimeNs)) throw new Error("known-empty allocation journal was mutated");
        const generations = new Set<string>(), started = new Set<string>();
        const pending = new Map<string, PendingAllocation>();
        const allocations: Allocation[] = [];
        for (const line of lines) {
            const record = JSON.parse(line) as PendingAllocation | Allocation;
            const keys = record && Object.keys(record).sort().join(",");
            if (!record || record.schema !== 1 || record.token !== owner.token || !["pending", "allocation"].includes(record.kind)
                || typeof record.allocationId !== "string" || !/^[a-f0-9-]{36}$/.test(record.allocationId)
                || !Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw new Error("allocation journal schema unavailable");
            if (record.kind === "pending") {
                if (keys !== "allocationId,kind,pid,port,schema,token" || started.has(record.allocationId)) throw new Error("invalid/duplicate pending allocation");
                started.add(record.allocationId); pending.set(record.allocationId, record); continue;
            }
            const start = pending.get(record.allocationId);
            if (keys !== "allocationId,identity,kind,pid,port,schema,token" || !start || start.pid !== record.pid || start.port !== record.port
                || !record.identity || Object.keys(record.identity).sort().join(",") !== "commandHash,pid,startToken"
                || record.identity.pid !== record.pid || typeof record.identity.startToken !== "string" || !record.identity.startToken || record.identity.startToken.length > 512
                || !appiumInvocationHashes(owner, record.port).includes(record.identity.commandHash)) throw new Error("allocation journal generation unavailable");
            const key = `${record.pid}:${record.identity.startToken}`;
            if (generations.has(key)) throw new Error("duplicate allocation generation");
            generations.add(key); pending.delete(record.allocationId); allocations.push(record);
        }
        const final = fstatSync(descriptor, { bigint: true });
        if (!matches(final) || final.size !== opened.size || final.mtimeNs !== opened.mtimeNs
            || final.ctimeNs !== opened.ctimeNs || !matches(lstatSync(expected.path, { bigint: true }), true)) throw new Error("allocation journal changed during read");
        return { allocations, pending: [...pending.values()], bytes };
    } finally { closeSync(descriptor); }
}
function retainAllocationHistory(owner: Owner): void {
    try {
        const proof = readAllocationJournal(owner);
        if (!proof.bytes.startsWith(owner.historyBytes)) throw new Error("allocation history lost/rewritten");
        owner.historyBytes = proof.bytes;
    } catch (error) { owner.coverageError ??= String(error).slice(0, 512); }
}
function observedOperation<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
    owner.activeRequests++;
    const finish = () => { retainAllocationHistory(owner); owner.activeRequests--; };
    try {
        return operation().then(value => { finish(); return value; }, error => { finish(); throw error; });
    } catch (error) { finish(); throw error; } // Preserve synchronous native exception behavior too.
}
export function observeFakeIosFixtureAllocation<T>(context: FakeIosMcpContext, operation: () => Promise<T>): Promise<T> {
    const owner = owners.get(context);
    if (!owner || !contextMatches(context, owner) || !ownedRoots(owner)) throw new Error("fake iOS allocation context unavailable");
    return observedOperation(owner, operation);
}
function instrumentRequests(owner: Owner, includeRequest: boolean): void {
    if (includeRequest) owner.client.request = new Proxy(owner.client.request, {
        apply(target, receiver, args) { return observedOperation(owner, () => Reflect.apply(target, receiver, args)); },
    });
    owner.client.callTool = new Proxy(owner.client.callTool, {
        apply(target, receiver, args) { return observedOperation(owner, () => Reflect.apply(target, receiver, args)); },
    });
}
export function fakeIosFixtureDiagnostics(context: FakeIosMcpContext): string {
    const owner = owners.get(context);
    if (!owner) return typeof context.lifetimeEvidence === "string" ? context.lifetimeEvidence.slice(0, 8192) : "unowned fake iOS context";
    if (!contextMatches(context, owner)) return JSON.stringify({ reason: "fixture context replaced", retainedPaths: [owner.homeDir, owner.binDir] });
    const path = join(owner.homeDir, "fake-ios-lifetime.jsonl");
    const events: unknown[] = [];
    if (existsSync(path) && plainFile(path)) {
        const size = lstatSync(path).size;
        if (size <= 8192) {
            for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-64)) {
                try {
                    const value = JSON.parse(line);
                    if (value.token === owner?.token && ["entry", "bind", "listening", "error", "uncaught", "unhandled", "signal", "exit"].includes(value.phase)) {
                        events.push({ phase: value.phase, pid: value.pid, port: value.port, code: value.code, token: value.token });
                    }
                } catch { /* malformed diagnostics convey no authority */ }
            }
        } else events.push({ phase: "diagnostics-over-limit", bytes: size });
    }
    return JSON.stringify({ events, retainedPaths: [owner.homeDir, owner.binDir] }).slice(0, 8192);
}
function instrumentOwnedTransport(owner: Owner): void {
    const transport = owner.transport;
    if (!transport) return;
    transport.close = new Proxy(transport.close, {
        apply(target, receiver, args) {
            owner.transportClosing = true;
            return Reflect.apply(target, receiver, args);
        },
    });
    transport.start = new Proxy(transport.start, {
        apply(target, receiver, args) {
            owner.transportStarted = true; owner.transportClosed = false; owner.transportClosing = false;
            owner.closeObserved = new Promise<void>(resolve => { owner.reportTransportClosed = resolve; });
            const previous = transport.onclose;
            transport.onclose = function(this: StdioClientTransport) {
                owner.transportClosed = true; owner.transportClosing = false; owner.reportTransportClosed?.();
                previous?.call(this);
            };
            return Reflect.apply(target, receiver, args).then((value: unknown) => { captureMcp(owner); return value; });
        },
    });
}
function captureMcp(owner: Owner): void {
    const pid = owner.transport?.pid;
    if (!pid) return;
    const identity = readProcessIdentity(pid) as Identity | null;
    const commandHash = nodeInvocationHash([process.execPath, join(repoRoot, "device-lab-mcp/server.mjs")]);
    if (identity?.commandHash === commandHash) owner.mcp = { pid, identity, commandHash };
}
async function bounded<T>(promise: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("fake iOS aggregate teardown deadline")), Math.max(0, deadline - Date.now()));
    })]); } finally { if (timer) clearTimeout(timer); }
}
export async function joinFakeIosFixtureChild(child: import("child_process").ChildProcess, deadline: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); });
    child.kill("SIGKILL"); // Exact returned ChildProcess handle, not an untrusted marker PID.
    await bounded(exited, deadline);
}
export async function createFakeIosMcpContext(options: {
    connect?: (client: Client, transport: StdioClientTransport) => Promise<void>;
    onAllocated?: (context: FakeIosMcpContext) => void;
} = {}): Promise<FakeIosMcpContext> {
    let client: Client | undefined;
    let homeDir = "";
    let binDir = "";
    let logPath = "";
    let context: FakeIosMcpContext | undefined;
    const token = randomUUID();
    try {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-bin-"));
        logPath = join(homeDir, "fake-ios.log");
        const allocationPath = join(homeDir, "fake-ios-allocation.jsonl");
        const header = JSON.stringify({ schema: 1, kind: "header", token }) + "\n";
        const journalDescriptor = openSync(allocationPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0));
        const journalStat = (() => {
            try {
                writeFileSync(journalDescriptor, header); // Authenticated known-empty before any spawn.
                const opened = fstatSync(journalDescriptor, { bigint: true });
                const pathname = lstatSync(allocationPath, { bigint: true });
                if (!opened.isFile() || opened.nlink !== 1n || opened.dev <= 0n || opened.ino <= 0n
                    || !pathname.isFile() || pathname.isSymbolicLink() || pathname.nlink !== 1n || pathname.ino !== opened.ino
                    || pathname.dev !== opened.dev && !(process.platform === "win32" && pathname.dev === 0n)) throw new Error("allocation journal creation identity unavailable");
                return opened;
            } finally { closeSync(journalDescriptor); }
        })();
        const journal = Object.freeze({ path: allocationPath, header, dev: String(journalStat.dev), ino: String(journalStat.ino),
            mtimeNs: String(journalStat.mtimeNs), ctimeNs: String(journalStat.ctimeNs) });
        const containerRoot = join(homeDir, "ios-app-container");

        const xcrunPath = join(binDir, "xcrun");
        writeFileSync(xcrunPath, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), home = process.env.HOME;
fs.appendFileSync(process.env.FAKE_IOS_LOG, 'xcrun ' + args.join(' ') + '\\n');
const file = name => path.join(home, name);
const present = name => { try { return fs.statSync(file(name)).isFile(); } catch { return false; } };
// Shell command substitution removes trailing newlines but does not trim spaces.
const read = name => fs.readFileSync(file(name), 'utf8').replace(/\\n+$/, '');
const remove = name => { try { fs.unlinkSync(file(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
function replaceState(command) {
  const requested = present('fake-ios-replace-state-command') ? read('fake-ios-replace-state-command') : 'bootstatus';
  if (requested === command && present('fake-ios-replace-state-target') && present('fake-ios-replace-state-source')) {
    fs.copyFileSync(file('fake-ios-replace-state-source'), read('fake-ios-replace-state-target'));
    fs.writeFileSync(file('fake-ios-replace-state-done'), '');
  }
}
const prefix = (...parts) => parts.every((part, index) => args[index] === part);
const output = text => process.stdout.write(text + '\\n');
if (prefix('simctl', 'list')) {
  const created = present('fake-ios-created-name') ? ',{"name":"' + read('fake-ios-created-name') + '","udid":"CREATED-IOS-UDID","state":"' + (present('fake-ios-created-booted') ? 'Booted' : 'Shutdown') + '"}' : '';
  output('{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"host iPhone","udid":"HOST-UDID","state":"Shutdown"}' + created + ']},"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","name":"iOS 17.0","isAvailable":true}],"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","name":"iPhone 15"}]}');
} else if (prefix('xctrace', 'list', 'devices')) {
  output('Devices:\\nBuild Mac (15.0) (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)\\nReal iPhone (17.5) (00008110-001C195E0E91801E)\\nNetwork Named USB iPhone (17.5) (00008111-001C195E0E91801F)\\nNetwork iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)\\nOther iPhone (16.7) (00008101-00DEADBEEFCAFE00)\\nSimulators:\\niPhone 15 Simulator (17.0) (SIM-UDID)');
} else if (prefix('devicectl', 'device', 'install', 'app')) {
  // Effective original success has no stdout.
} else if (prefix('devicectl', 'device', 'process', 'launch')) {
  output('launched ' + (args[7] || ''));
} else if (prefix('simctl', 'create')) {
  fs.writeFileSync(file('fake-ios-created-name'), args[2] || ''); output('CREATED-IOS-UDID');
} else if (prefix('simctl', 'boot')) {
  if (args[2] === 'CREATED-IOS-UDID') fs.writeFileSync(file('fake-ios-created-booted'), '');
} else if (prefix('simctl', 'bootstatus')) {
  replaceState('bootstatus'); output('Booted');
} else if (prefix('simctl', 'shutdown') || prefix('simctl', 'delete')) {
  const command = args[1], once = 'fake-ios-' + command + '-fail-once';
  if (present(once)) { remove(once); process.stderr.write('simulated ' + command + ' failure\\n'); process.exit(1); }
  replaceState(command);
  if (args[2] === 'CREATED-IOS-UDID') {
    if (command === 'delete') remove('fake-ios-created-name');
    remove('fake-ios-created-booted');
  }
} else if (prefix('simctl', 'get_app_container')) {
  fs.mkdirSync(process.env.FAKE_IOS_CONTAINER_ROOT, {recursive: true}); output(process.env.FAKE_IOS_CONTAINER_ROOT);
} else if (prefix('simctl', 'spawn')) {
  output('ok');
} else if (prefix('simctl', 'io') && args[3] === 'screenshot') {
  fs.writeFileSync(args[4], 'fakepng');
} else if (prefix('simctl', 'io') && args[3] === 'recordVideo') {
  if (present('fake-ios-record-fail-once')) { remove('fake-ios-record-fail-once'); process.exit(9); }
  fs.writeFileSync(args[4], 'fakevideo');
  const natural = present('fake-ios-record-natural-exit-once');
  if (natural) remove('fake-ios-record-natural-exit-once');
  // The returned Node process owns both the file and the exact original delay.
  setTimeout(() => {}, natural ? 800 : 20000);
} else if (prefix('simctl', 'launch')) {
  output((args[3] || '') + ': 123');
}
// erase/openurl/install and all unrecognized original commands succeed silently.
`);
        chmodSync(xcrunPath, 0o755);
        const appiumPath = join(binDir, "appium");
        writeFileSync(appiumPath, `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FAKE_IOS_LOG, 'appium ' + process.argv.slice(2).join(' ') + '\\n');
const http = require('http');
const fs = require('fs');
let requestedPort = '';
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--port') requestedPort = process.argv[++index] || '';
}
const port = Number(requestedPort);
const log = ${JSON.stringify(logPath)};
const stalePath = ${JSON.stringify(join(homeDir, "stale-ios-session"))};
const token = ${JSON.stringify(token)};
const events = process.env.HOME + '/fake-ios-lifetime.jsonl';
let eventCount = 0, eventBytes = 0;
function diagnostic(phase, code) {
  const line = JSON.stringify({phase, code: typeof code === 'string' ? code.slice(0, 64) : undefined, token, pid: process.pid, port}) + '\\n';
  const existing = fs.existsSync(events) ? fs.readFileSync(events, 'utf8') : '';
  if (existing.split('\\n').filter(Boolean).length < 64 && Buffer.byteLength(existing) + Buffer.byteLength(line) <= 8192 && eventCount < 64 && eventBytes + Buffer.byteLength(line) <= 8192) { fs.appendFileSync(events, line); eventCount++; eventBytes += Buffer.byteLength(line); }
}
diagnostic('entry');
process.on('uncaughtException', error => { diagnostic('uncaught', error.code || error.name); process.exit(1); });
process.on('unhandledRejection', error => { diagnostic('unhandled', error?.code || error?.name); process.exit(1); });
process.on('exit', () => diagnostic('exit'));
const allocationPath = ${JSON.stringify(join(homeDir, "fake-ios-allocation.jsonl"))};
const allocationId = require('crypto').randomUUID();
function publishAllocation(record) {
  function matchesPath() {
    const pathname = fs.lstatSync(allocationPath, {bigint: true});
    return pathname.isFile() && !pathname.isSymbolicLink() && pathname.nlink === 1n && pathname.ino > 0n
      && String(pathname.ino) === ${JSON.stringify(String(journalStat.ino))}
      && (String(pathname.dev) === ${JSON.stringify(String(journalStat.dev))} || process.platform === 'win32' && pathname.dev === 0n);
  }
  if (!matchesPath()) throw new Error('allocation journal pathname identity');
  const fd = fs.openSync(allocationPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd, {bigint: true});
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev <= 0n || stat.ino <= 0n || String(stat.dev) !== ${JSON.stringify(String(journalStat.dev))} || String(stat.ino) !== ${JSON.stringify(String(journalStat.ino))} || stat.size >= 32768n || !matchesPath()) throw new Error('allocation journal identity/bound');
    fs.writeFileSync(fd, JSON.stringify(record) + '\\n');
    const published = fs.fstatSync(fd, {bigint: true});
    if (!published.isFile() || published.nlink !== 1n || published.dev !== stat.dev || published.ino !== stat.ino || !matchesPath()) throw new Error('allocation journal changed during publication');
  } finally { fs.closeSync(fd); }
}
// Synchronous pending publication precedes every asynchronous identity/startup step.
publishAllocation({schema: 1, kind: 'pending', token, allocationId, pid: process.pid, port});
(async () => {
while (fs.existsSync(process.env.HOME + '/fake-ios-startup-pause')) await new Promise(resolve => setTimeout(resolve, 10));
const { readProcessIdentity } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'packages/device-lab/providers/state/process-identity.mjs')).href)});
const identity = readProcessIdentity(process.pid);
publishAllocation({schema: 1, kind: 'allocation', token, allocationId, pid: process.pid, port, identity});
fs.writeFileSync(process.env.HOME + '/fake-ios-appium-' + process.pid + '.pid', JSON.stringify({token, pid: process.pid, identity, port, log, stalePath, home: process.env.HOME}));
let sessionCounter = 0;
let sessionId = null;
function send(res, status, payload) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}
const server = http.createServer((req, res) => {
  fs.appendFileSync(log, 'appium-http ' + req.method + ' ' + req.url + '\\n');
  if (req.method === 'GET' && req.url === '/status') {
    const failedStatus = process.env.HOME + '/fail-ios-status-once';
    if (fs.existsSync(failedStatus)) { fs.unlinkSync(failedStatus); return send(res, 503, {value: {error: 'fixture status unavailable'}}); }
    return send(res, 200, {value: {ready: true}});
  }
  if (req.method === 'POST' && req.url === '/session') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-session-body ' + body + '\\n');
      sessionCounter += 1;
      sessionId = 'IOS-SESSION-' + sessionCounter;
      send(res, 200, {value: {sessionId}});
    });
    return;
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId) {
    if (fs.existsSync(stalePath)) {
      fs.unlinkSync(stalePath);
      send(res, 404, {value: {error: 'stale'}});
      return;
    }
    return send(res, 200, {value: {sessionId}});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/source') {
    if (fs.existsSync(stalePath + '-source-fail')) {
      return send(res, 500, {value: {error: 'source failed'}});
    }
    return send(res, 200, {value: '<AppiumAUT><XCUIElementTypeApplication name="Test"/></AppiumAUT>'});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/screenshot') {
    return send(res, 200, {value: Buffer.from('fake-real-ios-png').toString('base64')});
  }
  if (req.method === 'DELETE' && sessionId && req.url === '/session/' + sessionId) {
    const targetPathFile = process.env.HOME + '/fake-ios-real-state-conflict-path';
    const sourcePath = process.env.HOME + '/fake-ios-real-state-conflict.json';
    if (fs.existsSync(targetPathFile) && fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, fs.readFileSync(targetPathFile, 'utf8'));
      fs.unlinkSync(targetPathFile);
    }
    sessionId = null;
    return send(res, 200, {value: null});
  }
  if (req.method === 'POST' && sessionId && (
    req.url === '/session/' + sessionId + '/actions' ||
    req.url === '/session/' + sessionId + '/keys' ||
    req.url === '/session/' + sessionId + '/execute/sync' ||
    req.url === '/session/' + sessionId + '/orientation'
  )) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-command-body ' + req.url + ' ' + body + '\\n');
      if (body.includes('mobile: activeAppInfo')) {
        send(res, 200, {value: {bundleId: 'com.example.Real', name: 'Real'}});
        return;
      }
      send(res, 200, {value: null});
    });
    return;
  }
  send(res, 404, {value: {error: 'unknown route'}});
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  diagnostic('signal', signal);
  fs.appendFileSync(log, 'appium-server-sigint ' + port + '\\n');
  server.close(() => process.exit(0));
});
// A private, generation-bound shutdown control exercises ordinary Node exit
// diagnostics on Windows, whose native termination bypasses signal handlers.
const shutdownControl = process.env.HOME + '/fake-ios-shutdown-' + process.pid + '.json';
const shutdownTimer = setInterval(() => {
  if (!fs.existsSync(shutdownControl)) return;
  const control = JSON.parse(fs.readFileSync(shutdownControl, 'utf8'));
  if (control.token !== token || control.pid !== process.pid) throw Error('foreign fixture shutdown control');
  clearInterval(shutdownTimer);
  fs.unlinkSync(shutdownControl);
  server.close(() => process.exit(0));
}, 10);
shutdownTimer.unref();
server.on('error', error => { diagnostic('error', error.code); process.exit(1); });
diagnostic('bind');
server.listen(port, '127.0.0.1', () => diagnostic('listening'));
})().catch(error => { diagnostic('error', error.code || error.name); process.exit(1); });
`);
        chmodSync(appiumPath, 0o755);

        // The original final loop overwrote xcodebuild's version branch.
        for (const name of ["appium-xcuitest-driver", "xcodebuild"]) {
            const toolPath = join(binDir, name);
            writeFileSync(toolPath, `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FAKE_IOS_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
`);
            chmodSync(toolPath, 0o755);
        }
        const preload = join(homeDir, "node-provider-routing.cjs");
        writeFileSync(preload, nodeProviderFixturePreloadSource(binDir));

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                ...deviceLabTestHomeEnvironment(homeDir),
                PATH: binDir,
                NODE_ENV: "test",
                NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
                CCC_PROFILE: `test-${homeDir.split(/[\\/]/).pop()}`,
                FAKE_IOS_LOG: logPath,
                FAKE_IOS_CONTAINER_ROOT: containerRoot,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-ios-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        context = { client, homeDir, binDir, logPath };
        owners.set(context, { token, homeDir, binDir, logPath, client, journal, transport, snapshots: [], activeRequests: 0, historyBytes: header, transportStarted: false, transportClosed: false, transportClosing: false, roots: Object.freeze([homeDir, binDir].map(path => {
            const stat = lstatSync(path); return Object.freeze({ path, dev: stat.dev, ino: stat.ino });
        })) });
        instrumentOwnedTransport(owners.get(context)!);
        instrumentRequests(owners.get(context)!, true);
        options.onAllocated?.(context);
        await (options.connect ? options.connect(client, transport) : client.connect(transport));
        captureMcp(owners.get(context)!);
        installDefaultImplicitBroker(client, false);
        instrumentRequests(owners.get(context)!, false); // Cover the real implicit-broker callTool route too.
        return context;
    } catch (primary) {
        if (context) {
            try { await cleanupFakeIosMcpContext(context); }
            catch (cleanup) { if (primary instanceof Error) primary.message += "\n" + String(cleanup).slice(0, 8192); }
        } else {
            // No transport/server was reachable before context allocation.
            if (homeDir) rmSync(homeDir, { recursive: true, force: true });
            if (binDir) rmSync(binDir, { recursive: true, force: true });
        }
        throw primary;
    }
}

export async function cleanupFakeIosMcpContext(context: FakeIosMcpContext | undefined, options: {
    deadline?: number; effects?: FakeIosLifetimeEffects;
} = {}): Promise<void> {
    if (!context) return;
    const owner = owners.get(context);
    if (!owner || !contextMatches(context, owner) || !ownedRoots(owner)) throw new Error("fake iOS fixture root ownership unavailable");
    const deadline = Math.min(options.deadline ?? Date.now() + TIMEOUT, Date.now() + TIMEOUT);
    const effects = options.effects ?? nativeEffects;
    const failures: string[] = [];
    let allocationProof: ReturnType<typeof readAllocationJournal>;
    try {
        if (owner.activeRequests) { retainAllocationHistory(owner); throw new Error("owned request/allocation publication incomplete"); }
        if (owner.coverageError) throw new Error(owner.coverageError);
        allocationProof = readAllocationJournal(owner);
        if (allocationProof.bytes !== owner.historyBytes) throw new Error("allocation history lost/unobserved publication");
        if (allocationProof.pending.length) throw new Error("pending allocation generation incomplete");
    }
    catch (error) { throw new Error((String(error) + "; UNKNOWN allocation coverage; retained private fixture: " + owner.homeDir + " " + owner.binDir).slice(0, 8192)); }
    owner.snapshots.push(fakeIosFixtureDiagnostics(context)); // Pre-close evidence survives removal.
    captureMcp(owner);
    let verified = true;
    const observeTransport = () => {
        if (!owner.mcp || owner.transport?.pid !== owner.mcp.pid) throw new Error("SDK transport generation unavailable");
        const observation = effects.inspect(owner.mcp.identity, owner.mcp.pid);
        if (observation.status !== "match" && observation.status !== "exited") throw new Error("SDK transport generation " + observation.status);
        return observation.status;
    };
    // The captured SDK handle owns/reaps this child. Never drive its exit transition
    // with a naked PID polling/signal loop or interpret null identity as exit.
    try {
        if (owner.transportStarted && !owner.transportClosed) {
            const status = observeTransport();
            if (status === "match") {
                try { await bounded(owner.client.close(), deadline); }
                catch (error) { failures.push("client-close: " + String(error).slice(0, 512)); }
                if (!owner.transportClosed && !owner.transportClosing) {
                    // Partial connect may never attach the transport to Client.close.
                    // Authenticate again before allowing this exact handle to close.
                    if (observeTransport() === "match") await bounded(owner.transport!.close(), deadline);
                }
            }
            if (!owner.closeObserved) throw new Error("SDK close observation unavailable");
            await bounded(owner.closeObserved, deadline); // Actual SDK child 'close', not early pid-null alone.
            if (!owner.transportClosed || owner.transport?.pid !== null) throw new Error("SDK child join incomplete");
        } else {
            try { await bounded(owner.client.close(), deadline); }
            catch (error) { failures.push("client-close: " + String(error).slice(0, 512)); }
        }
    } catch (error) { verified = false; failures.push("transport: " + String(error).slice(0, 512)); }
    const runtimes: Runtime[] = [];
    const markerBytes = new Map<string, string>();
    const markerNames = readdirSync(owner.homeDir).filter(name => /^fake-ios-appium-.*\.pid$/.test(name)).sort();
    const markersUnchanged = () => {
        const current = readdirSync(owner.homeDir).filter(name => /^fake-ios-appium-.*\.pid$/.test(name)).sort();
        return JSON.stringify(current) === JSON.stringify(markerNames) && [...markerBytes].every(([file, bytes]) =>
            plainFile(file) && readFileSync(file, "utf8") === bytes);
    };
    for (const entry of readdirSync(owner.homeDir, { withFileTypes: true })) {
        if (!/^fake-ios-appium-.*\.pid$/.test(entry.name)) continue;
        try {
            const file = join(owner.homeDir, entry.name);
            if (!entry.isFile() || !plainFile(file) || lstatSync(file).size > 8192) throw new Error("marker not ordinary bounded file");
            const bytes = readFileSync(file, "utf8");
            const marker = JSON.parse(bytes);
            const expected = appiumInvocationHashes(owner, marker.port);
            const commandHash = expected.find(candidate => candidate === marker.identity?.commandHash);
            if (marker.token !== owner.token || marker.home !== owner.homeDir || marker.log !== owner.logPath
                || marker.stalePath !== join(owner.homeDir, "stale-ios-session") || !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535
                || !Number.isInteger(marker.pid) || marker.pid <= 0 || marker.pid === process.pid
                || entry.name !== `fake-ios-appium-${marker.pid}.pid` || marker.identity?.pid !== marker.pid
                || typeof marker.identity.startToken !== "string" || !commandHash) throw new Error("marker authority mismatch");
            markerBytes.set(file, bytes);
            runtimes.push({ pid: marker.pid, identity: marker.identity, commandHash });
        } catch (error) { verified = false; failures.push("marker: " + String(error).slice(0, 512)); }
    }
    if (!contextMatches(context, owner)) throw new Error("fixture context replaced; retained private fixture: " + owner.homeDir + " " + owner.binDir);
    const markerRuntimes = runtimes.filter(runtime => runtime !== owner.mcp);
    const missing = allocationProof.allocations.filter(allocation => !markerRuntimes.some(runtime => runtime.pid === allocation.pid
        && runtime.identity.startToken === allocation.identity.startToken && runtime.identity.commandHash === allocation.identity.commandHash));
    if (markerRuntimes.some(runtime => !allocationProof.allocations.some(allocation => allocation.pid === runtime.pid
        && allocation.identity.startToken === runtime.identity.startToken && allocation.identity.commandHash === runtime.identity.commandHash))) {
        throw new Error("Appium marker lacks authoritative allocation; retained private fixture: " + owner.homeDir + " " + owner.binDir);
    }
    const journalUnchanged = () => readAllocationJournal(owner).bytes === allocationProof.bytes;
    if (missing.length) {
        owner.snapshots.push(fakeIosFixtureDiagnostics(context));
        context.lifetimeEvidence = owner.snapshots.join("\n").slice(0, 8192);
        throw new Error(("unexplained missing Appium allocation marker; retained private fixture: " + owner.homeDir + " " + owner.binDir
            + "\n" + context.lifetimeEvidence).slice(0, 8192));
    }
    for (const runtime of runtimes) {
        try {
            let exitWitness: Promise<RuntimeExitObservation> | undefined;
            let observation = effects.inspect(runtime.identity, runtime.pid);
            if (observation.status === "exited") continue;
            if (observation.status !== "match") throw new Error("runtime generation " + observation.status);
            for (const signal of ["SIGTERM", "SIGKILL"] as const) {
                if (Date.now() >= deadline) throw new Error("aggregate teardown deadline");
                effects.beforeSignal?.(runtime.pid);
                observation = effects.inspect(runtime.identity, runtime.pid); // Recheck after any intervening change.
                if (observation.status === "exited") {
                    if (exitWitness && await exitWitness !== "ended") throw new Error("runtime exit observation unavailable");
                    break;
                }
                if (observation.status !== "match" || !contextMatches(context, owner) || !ownedRoots(owner) || !markersUnchanged() || !journalUnchanged()) throw new Error("runtime generation/marker changed before signal");
                effects.signal(runtime.pid, signal);
                const waitMs = deadline - Date.now();
                if (waitMs <= 0) throw new Error("aggregate teardown deadline");
                // Native exit proof owns the aggregate allowance. The short
                // cooperative grace only schedules another authenticated signal;
                // its expiry never proves exit or cancels an in-flight probe.
                exitWitness ??= bounded(effects.waitForExit(runtime.identity, waitMs), deadline);
                let graceTimer: ReturnType<typeof setTimeout> | undefined;
                let exited: RuntimeExitObservation | "grace-expired";
                try {
                    exited = signal === "SIGTERM" ? await Promise.race([
                        exitWitness,
                        new Promise<"grace-expired">(resolve => {
                            graceTimer = setTimeout(() => resolve("grace-expired"), Math.min(250, Math.max(0, deadline - Date.now())));
                        }),
                    ]) : await exitWitness;
                } finally { if (graceTimer) clearTimeout(graceTimer); }
                if (Date.now() > deadline) throw new Error("runtime exit observation exceeded teardown allowance");
                if (exited === "ended") { observation = { status: "exited", liveness: "exited" }; break; }
                if (exited !== "still-running" && exited !== "grace-expired") throw new Error("runtime exit observation unavailable");
            }
            if (observation.status !== "exited") throw new Error("runtime still live at teardown deadline");
        } catch (error) { verified = false; failures.push("runtime: " + String(error).slice(0, 512)); }
    }
    owner.snapshots.push(fakeIosFixtureDiagnostics(context)); // Post-close/exit evidence before removal.
    context.lifetimeEvidence = owner.snapshots.join("\n").slice(0, 8192);
    if (verified && contextMatches(context, owner) && ownedRoots(owner) && markersUnchanged() && journalUnchanged()) {
        effects.remove(owner.homeDir); effects.remove(owner.binDir);
        owners.delete(context);
    } else failures.push("retained private fixture: " + owner.homeDir + " " + owner.binDir);
    if (failures.length) throw new Error((failures.join("; ") + "\n" + owner.snapshots.join("\n")).slice(0, 8192));
}

// Exercise the external-server reuse branch while preserving ownership metadata
// for fixture cleanup after the assertion. No real provider is involved.
export async function exerciseStaleExternalIosSession(context: FakeIosMcpContext, backend: "ios" | "ios-device", deviceId: string) {
    const owner = owners.get(context);
    if (!owner || !contextMatches(context, owner) || !ownedRoots(owner)) throw new Error("fake iOS fixture root ownership unavailable");
    const ownerDirectory = join(owner.homeDir, ".ccc", "devices", "owners");
    const statePath = join(ownerDirectory, readdirSync(ownerDirectory)[0], backend, "devices.json");
    const original = JSON.parse(readFileSync(statePath, "utf8"));
    const device = original.devices.find((item: { id: string }) => item.id === deviceId);
    if (!device?.appium?.sessionId) throw new Error("Fixture requires an existing Appium session");
    const owned = structuredClone(device.appium);
    device.appium = { ...owned, processOwner: "external", startedBy: "existing-server" };
    writeFileSync(statePath, JSON.stringify(original));
    writeFileSync(join(owner.homeDir, "stale-ios-session"), "1");
    const before = readFileSync(owner.logPath, "utf8").length;
    try {
        const result = await owner.client.callTool({ name: "ui", arguments: { deviceId } });
        const log = readFileSync(owner.logPath, "utf8").slice(before);
        return { result, log, previousSessionId: owned.sessionId };
    } finally {
        const current = JSON.parse(readFileSync(statePath, "utf8"));
        const latest = current.devices.find((item: { id: string }) => item.id === deviceId);
        if (latest) latest.appium = { ...owned, sessionId: latest.appium?.sessionId || owned.sessionId };
        writeFileSync(statePath, JSON.stringify(current));
    }
}
