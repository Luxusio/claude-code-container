import { createHash, randomBytes } from "crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "fs";
import type { BigIntStats } from "fs";
import { join, resolve } from "path";
import { withSharedMutationLock, withSharedMutationLockAsync, writeJsonFileAtomically } from "@ccc/device-lab/device-lab-shared-state.js";
import type { NativeRuntimeInvocation } from "../ports/container-runtime-invocation.js";
import type { RuntimeBindAuthorityFacts, RuntimeBindAuthoritySnapshot, RuntimeBindCreationTicket, RuntimeBindGuard, RuntimeBindHomePreparation } from "../ports/runtime-bind-authority.js";
import { validateNativeRuntimeInvocation } from "./container-runtime-invocation.js";

const HISTORY_LIMIT = 4 * 1024 * 1024;
const AUTHORITY_LIMIT = 64;
const DIRECTORY = "runtime-bind-authority";
const HISTORY = "history.json";
const REMOTE_BARRIER = "receiving-host-incomplete";

type Identity = { device: string; inode: string; birthtime: string };
type Directory = { path: string; canonical: string; identity: Identity };
type FileReceipt = { identity: Identity; digest: string; modified: string; changed: string; text: string };
type History = { version: 1; root: Identity; coverage: "complete" | "incomplete"; authorities: readonly NativeRuntimeInvocation[]; pending: string | null };
type GuardState = { active: boolean; root: Directory; directory: Directory; lock: FileReceipt };
type SnapshotState = { guard: RuntimeBindGuard; history: History; file: FileReceipt; barrier: FileReceipt | null };
const preparations = new WeakMap<RuntimeBindHomePreparation, { root: Directory; fresh: boolean; used: boolean }>();
const guards = new WeakMap<RuntimeBindGuard, GuardState>();
const snapshots = new WeakMap<RuntimeBindAuthoritySnapshot, SnapshotState>();
const tickets = new WeakMap<RuntimeBindCreationTicket, { guard: RuntimeBindGuard; token: string; snapshot: RuntimeBindAuthoritySnapshot }>();

function refuse(): never {
    throw Object.assign(new Error("Runtime bind authority is unavailable or changed; shared state was preserved."), { code: "runtime-bind-authority-unavailable" });
}

function absent(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function identity(stat: BigIntStats): Identity {
    if (stat.ino === 0n && stat.birthtimeNs <= 0n) return refuse();
    return { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeNs) };
}

function sameIdentity(left: Identity, right: Identity): boolean {
    return left.device === right.device && left.inode === right.inode && left.birthtime === right.birthtime;
}

function privateOwner(stat: BigIntStats, privateMode: boolean): void {
    if (process.platform !== "win32" && (stat.uid !== BigInt(process.getuid!())
        || (stat.mode & (privateMode ? 0o077n : 0o022n)) !== 0n)) return refuse();
}

function directory(path: string, privateMode: boolean): Directory {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return refuse();
    privateOwner(stat, privateMode);
    return { path, canonical: realpathSync(path), identity: identity(stat) };
}

function assertDirectory(before: Directory, privateMode: boolean): void {
    const current = directory(before.path, privateMode);
    if (current.canonical !== before.canonical || !sameIdentity(current.identity, before.identity)) return refuse();
}

function sameFile(left: FileReceipt | null, right: FileReceipt | null): boolean {
    if (left === null || right === null) return left === right;
    return sameIdentity(left.identity, right.identity) && left.digest === right.digest
        && left.modified === right.modified && left.changed === right.changed;
}

/** Nonblocking/no-follow open avoids waiting on FIFOs; both the descriptor and pathname remain qualified. */
function privateFile(path: string, maximum: number): FileReceipt {
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > BigInt(maximum)) return refuse();
    privateOwner(named, true);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(fd, { bigint: true });
        const openedIdentity = identity(opened);
        const namedIdentity = identity(named);
        const sameNamed = (stat: BigIntStats): boolean => {
            const value = identity(stat);
            return value.inode === openedIdentity.inode && value.birthtime === openedIdentity.birthtime
                && (value.device === openedIdentity.device || (process.platform === "win32" && value.device === "0"));
        };
        if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maximum) || !sameNamed(named)) return refuse();
        privateOwner(opened, true);
        if (process.platform === "win32" && namedIdentity.device === "0" && (opened.dev <= 0n || opened.ino <= 0n)) return refuse();
        const bytes = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (count === 0) break;
            length += count;
        }
        const after = fstatSync(fd, { bigint: true });
        const current = lstatSync(path, { bigint: true });
        if (length > maximum || BigInt(length) !== opened.size || !after.isFile() || after.nlink !== 1n
            || !sameIdentity(identity(after), openedIdentity) || after.size !== opened.size
            || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || !current.isFile() || current.nlink !== 1n || !sameNamed(current)
            || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) return refuse();
        privateOwner(current, true);
        const content = bytes.subarray(0, length);
        const text = content.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(content)) return refuse();
        return { identity: openedIdentity, digest: createHash("sha256").update(content).digest("hex"),
            modified: String(opened.mtimeNs), changed: String(opened.ctimeNs), text };
    } finally { closeSync(fd); }
}

function optionalFile(path: string, maximum: number): FileReceipt | null {
    try { return privateFile(path, maximum); }
    catch (error) { if (absent(error)) return null; throw error; }
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)
        || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return refuse();
    return value as Record<string, unknown>;
}

function decodedIdentity(value: unknown): Identity {
    const input = closed(value, ["device", "inode", "birthtime"]);
    if ([input.device, input.inode, input.birthtime].some(part => typeof part !== "string" || !/^[0-9]{1,40}$/.test(part))) return refuse();
    return input as Identity;
}

function decodeHistory(text: string, root: Identity): History {
    const input = closed(JSON.parse(text), ["version", "root", "coverage", "authorities", "pending"]);
    if (input.version !== 1 || !sameIdentity(decodedIdentity(input.root), root)
        || (input.coverage !== "complete" && input.coverage !== "incomplete")
        || !Array.isArray(input.authorities) || input.authorities.length > AUTHORITY_LIMIT
        || (input.pending !== null && (typeof input.pending !== "string" || !/^[a-f0-9]{32}$/.test(input.pending)))) return refuse();
    const authorities = input.authorities.map(validateNativeRuntimeInvocation);
    if (new Set(authorities.map(value => JSON.stringify(value))).size !== authorities.length) return refuse();
    return { version: 1, root, coverage: input.coverage, authorities: Object.freeze(authorities), pending: input.pending };
}

function held(guard: RuntimeBindGuard): GuardState {
    const state = guards.get(guard);
    if (!state?.active) return refuse();
    assertDirectory(state.root, false);
    assertDirectory(state.directory, true);
    if (!sameFile(state.lock, privateFile(join(state.root.path, "codex-state.lock"), 16384))) return refuse();
    return state;
}

function publish(guard: RuntimeBindGuard, value: History): RuntimeBindAuthoritySnapshot {
    const state = held(guard);
    const serialized = JSON.stringify(value, null, 2);
    if (value.authorities.length > AUTHORITY_LIMIT || Buffer.byteLength(serialized, "utf8") > HISTORY_LIMIT) return refuse();
    const path = join(state.directory.path, HISTORY);
    writeJsonFileAtomically(path, value);
    held(guard);
    const written = privateFile(path, HISTORY_LIMIT);
    if (written.text !== serialized) return refuse();
    const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        if (!sameIdentity(identity(fstatSync(fd, { bigint: true })), written.identity)) return refuse();
        fsyncSync(fd);
    } finally { closeSync(fd); }
    if (process.platform !== "win32") {
        const parent = openSync(state.directory.path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        try {
            if (!sameIdentity(identity(fstatSync(parent, { bigint: true })), state.directory.identity)) return refuse();
            fsyncSync(parent);
        } finally { closeSync(parent); }
    }
    held(guard);
    if (!sameFile(written, privateFile(path, HISTORY_LIMIT))) return refuse();
    const published = readRuntimeBindAuthority(guard);
    if (JSON.stringify(snapshots.get(published)?.history) !== JSON.stringify(value)) return refuse();
    assertRuntimeBindAuthorityCurrent(guard, published);
    return published;
}

/** Called before any recursive CCC-home writer. Existing roots never acquire fresh-origin evidence. */
export function prepareRuntimeBindHome(root: string): RuntimeBindHomePreparation {
    const path = resolve(root);
    let fresh = false;
    try { mkdirSync(path, { mode: 0o700 }); fresh = true; }
    catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
    }
    const prepared = Object.freeze({ root: path }) as RuntimeBindHomePreparation;
    preparations.set(prepared, { root: directory(path, false), fresh, used: false });
    return prepared;
}

function enter(home: string | RuntimeBindHomePreparation, callback: (guard: RuntimeBindGuard) => unknown) {
    const prepared = typeof home === "string" ? undefined : preparations.get(home);
    if (typeof home !== "string" && !prepared) return refuse();
    const root = prepared?.root ?? directory(resolve(home as string), false);
    return { root, run() {
        assertDirectory(root, false);
        const candidate = prepared?.fresh === true && !prepared.used;
        if (prepared) prepared.used = true;
        const path = join(root.path, DIRECTORY);
        let created = false;
        try { mkdirSync(path, { mode: 0o700 }); created = true; }
        catch (error) {
            if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
        }
        assertDirectory(root, false);
        const guard = Object.freeze({ root: root.path }) as RuntimeBindGuard;
        const state = { active: true, root, directory: directory(path, true), lock: privateFile(join(root.path, "codex-state.lock"), 16384) };
        guards.set(guard, state);
        try {
            let missing = false;
            try { lstatSync(join(path, HISTORY)); }
            catch (error) { if (absent(error)) missing = true; else throw error; }
            if (missing) {
                publish(guard, { version: 1, root: root.identity, coverage: candidate && created ? "complete" : "incomplete", authorities: [], pending: null });
            }
            return { guard, state, result: callback(guard) };
        } catch (error) { state.active = false; throw error; }
    } };
}

export function withRuntimeBindGuard<T>(home: string | RuntimeBindHomePreparation, operation: (guard: RuntimeBindGuard) => T, options: { waitMs?: number } = {}): T {
    const entry = enter(home, operation);
    return withSharedMutationLock(join(entry.root.path, "codex-state.lock"), () => {
        const current = entry.run();
        try {
            const result = current.result as T;
            if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) return refuse();
            return result;
        } finally { current.state.active = false; }
    }, { waitMs: options.waitMs ?? 600_000 });
}

export async function withRuntimeBindGuardAsync<T>(home: string | RuntimeBindHomePreparation, operation: (guard: RuntimeBindGuard) => Promise<T> | T, options: { waitMs?: number } = {}): Promise<T> {
    const entry = enter(home, operation);
    return withSharedMutationLockAsync(join(entry.root.path, "codex-state.lock"), async () => {
        const current = entry.run();
        try { return await current.result as T; }
        finally { current.state.active = false; }
    }, { waitMs: options.waitMs ?? 600_000 });
}

export function readRuntimeBindAuthority(guard: RuntimeBindGuard): RuntimeBindAuthoritySnapshot {
    const state = held(guard);
    try {
        const file = privateFile(join(state.directory.path, HISTORY), HISTORY_LIMIT);
        const history = decodeHistory(file.text, state.root.identity);
        const barrier = optionalFile(join(state.directory.path, REMOTE_BARRIER), 4096);
        held(guard);
        if (!sameFile(file, privateFile(join(state.directory.path, HISTORY), HISTORY_LIMIT))) return refuse();
        const snapshot = Object.freeze({ coverage: barrier ? "incomplete" : history.coverage,
            pending: history.pending !== null, authorities: history.authorities,
            ...(barrier ? { reason: "receiving-host-incomplete" as const } : history.coverage === "incomplete" ? { reason: "coverage-incomplete" as const } : {}),
        }) as RuntimeBindAuthoritySnapshot;
        snapshots.set(snapshot, { guard, history, file, barrier });
        return snapshot;
    } catch {
        const unknown: RuntimeBindAuthorityFacts = Object.freeze({
            coverage: "unknown", pending: true, authorities: Object.freeze([]), reason: "history-unknown",
        });
        return unknown as RuntimeBindAuthoritySnapshot;
    }
}

export function assertRuntimeBindAuthorityCurrent(guard: RuntimeBindGuard, snapshot: RuntimeBindAuthoritySnapshot): void {
    const state = held(guard);
    const captured = snapshots.get(snapshot);
    if (!captured || captured.guard !== guard
        || !sameFile(captured.file, privateFile(join(state.directory.path, HISTORY), HISTORY_LIMIT))
        || !sameFile(captured.barrier, optionalFile(join(state.directory.path, REMOTE_BARRIER), 4096))) return refuse();
    held(guard);
}

function append(snapshot: RuntimeBindAuthoritySnapshot, invocation: NativeRuntimeInvocation): History {
    const captured = snapshots.get(snapshot);
    if (!captured) return refuse();
    const value = validateNativeRuntimeInvocation(invocation);
    const equal = captured.history.authorities.some(previous => JSON.stringify(previous) === JSON.stringify(value));
    return { ...captured.history, coverage: snapshot.coverage === "complete" ? "complete" : "incomplete",
        authorities: equal ? captured.history.authorities : [...captured.history.authorities, value] };
}

export function recordRuntimeBindAuthority(guard: RuntimeBindGuard, invocation: NativeRuntimeInvocation): RuntimeBindAuthoritySnapshot {
    const current = readRuntimeBindAuthority(guard);
    assertRuntimeBindAuthorityCurrent(guard, current);
    const next = append(current, invocation);
    const previous = snapshots.get(current)!;
    return JSON.stringify(next) === JSON.stringify(previous.history) ? current : publish(guard, next);
}

export function beginRuntimeBindCreation(guard: RuntimeBindGuard, invocation: NativeRuntimeInvocation): RuntimeBindCreationTicket {
    const current = readRuntimeBindAuthority(guard);
    assertRuntimeBindAuthorityCurrent(guard, current);
    const next = append(current, invocation);
    const token = randomBytes(16).toString("hex");
    // A later successful request cannot erase uncertainty left by an interrupted earlier native effect.
    const published = publish(guard, { ...next, coverage: next.pending !== null ? "incomplete" : next.coverage, pending: token });
    const ticket = Object.freeze({}) as RuntimeBindCreationTicket;
    tickets.set(ticket, { guard, token, snapshot: published });
    return ticket;
}

/** Invoke only after this operation's exact native outcome has positively settled. */
export function settleRuntimeBindCreation(guard: RuntimeBindGuard, ticket: RuntimeBindCreationTicket): RuntimeBindAuthoritySnapshot {
    const owned = tickets.get(ticket);
    if (!owned || owned.guard !== guard) return refuse();
    assertRuntimeBindAuthorityCurrent(guard, owned.snapshot);
    const current = snapshots.get(owned.snapshot)!;
    if (current.history.pending !== owned.token) return refuse();
    const settled = publish(guard, { ...current.history, pending: null });
    tickets.delete(ticket);
    return settled;
}
