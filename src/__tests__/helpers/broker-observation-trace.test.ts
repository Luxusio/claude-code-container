import * as fs from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerObservationTracePreloadSource, readBrokerObservationTrace } from "./broker-observation-trace.js";

const roots: string[] = [];
const port = 43219;
const pid = 919191191;
const nativeStart = "Thu Oct 22 08:41:12 2026 private-native-birth";
const processStartToken = `ps:${nativeStart}`;
const startedAt = "2026-10-22T08:41:12.123Z-private-generation";
const secretPath = "/private-marker-root/private-broker-entry.js";
const command = `/private-marker-node ${secretPath} devices broker serve --host 127.0.0.1 --port ${port} --runtime-managed-by-parent`;
const runtime = {
    name: "ccc-device-broker", managedBy: "device-lab-mcp", ownerId: "private-owner-marker",
    host: "127.0.0.1", port, pid, startedAt, processStartToken,
    command: "/private-marker-node", args: [secretPath, "devices", "broker", "serve", "--port", String(port)],
    token: "private-auth-token-marker",
};
const publicBody = {
    ok: true,
    broker: {
        name: "ccc-device-broker", mode: "host-broker-daemon", port, startedAt,
        process: { pid, startToken: processStartToken },
    },
    headers: { authorization: "private-header-marker" },
};
const lsofArgs = ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"];
const psArgs = (field: string, selectedPid = pid) => ["-p", String(selectedPid), "-o", field];
type NativeResult = { status: number | null; stdout: string; stderr?: string; signal?: string | null; error?: unknown };
type SpawnCall = { receiver: unknown; args: unknown[] };

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: { failWrites?: boolean; failRuntimeRead?: boolean } = {}) {
    const root = fs.mkdtempSync(join(tmpdir(), "ccc-broker-observation-"));
    roots.push(root);
    const runtimeFile = join(root, "private-runtime-marker.json");
    const traceFile = join(root, "private-trace-marker.jsonl");
    fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
    const nativeCalls: SpawnCall[] = [];
    const reads: string[] = [];
    const writes: string[] = [];
    const opened = new Map<number, string>();
    const parseCalls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const parseValues = new Map<string, unknown>();
    let nativeResult: NativeResult = { status: 0, stdout: `p${pid}\n` };
    let nativeError: unknown;
    const parseError = new SyntaxError("private-parser-error-marker");
    const childProcess = {
        spawnSync(this: unknown, ...args: unknown[]) {
            nativeCalls.push({ receiver: this, args });
            if (nativeError !== undefined) throw nativeError;
            return nativeResult;
        },
    };
    const json = {
        stringify: JSON.stringify,
        parse(this: unknown, ...args: unknown[]) {
            parseCalls.push({ receiver: this, args });
            if (args[0] === "private-parser-throw-marker") throw parseError;
            if (parseValues.has(String(args[0]))) return parseValues.get(String(args[0]));
            return JSON.parse(args[0] as string, args[1] as Parameters<typeof JSON.parse>[1]);
        },
    };
    const fileSystem = {
        ...fs,
        openSync(file: fs.PathLike, ...args: unknown[]) {
            if (String(file) !== runtimeFile && String(file) !== traceFile) throw new Error("unexpected fixture file open");
            const descriptor = Reflect.apply(fs.openSync, fs, [file, ...args]) as number;
            opened.set(descriptor, String(file));
            return descriptor;
        },
        closeSync(descriptor: number) {
            opened.delete(descriptor);
            return fs.closeSync(descriptor);
        },
        writeSync(descriptor: number, ...args: unknown[]) {
            const file = opened.get(descriptor);
            writes.push(String(file));
            if (options.failWrites) throw new Error("private-trace-write-error-marker");
            if (file !== traceFile) throw new Error("unexpected fixture descriptor write");
            return Reflect.apply(fs.writeSync, fs, [descriptor, ...args]);
        },
        readFileSync(file: fs.PathOrFileDescriptor, ...args: unknown[]) {
            reads.push(String(file));
            if (String(file) === runtimeFile && options.failRuntimeRead) throw new Error("private-runtime-read-error-marker");
            if (String(file) !== runtimeFile && String(file) !== traceFile) throw new Error("unexpected fixture file read");
            return Reflect.apply(fs.readFileSync, fs, [file, ...args]);
        },
        appendFileSync(file: fs.PathOrFileDescriptor, ...args: unknown[]) {
            writes.push(String(file));
            if (options.failWrites) throw new Error("private-trace-write-error-marker");
            if (String(file) !== traceFile) throw new Error("unexpected fixture file write");
            return Reflect.apply(fs.appendFileSync, fs, [file, ...args]);
        },
        writeFileSync(file: fs.PathOrFileDescriptor, ...args: unknown[]) {
            writes.push(String(file));
            if (options.failWrites) throw new Error("private-trace-write-error-marker");
            if (String(file) !== traceFile) throw new Error("unexpected fixture file write");
            return Reflect.apply(fs.writeFileSync, fs, [file, ...args]);
        },
    };
    const forbiddenEffect = vi.fn(() => { throw new Error("unexpected request or body read"); });
    const syncBuiltinESMExports = vi.fn();
    runInNewContext(brokerObservationTracePreloadSource({ port, runtimeFile, traceFile }), {
        Buffer, JSON: json,
        fetch: forbiddenEffect,
        require: (specifier: string) => {
            if (specifier === "node:child_process" || specifier === "child_process") return childProcess;
            if (specifier === "node:fs" || specifier === "fs") return fileSystem;
            if (specifier === "node:module" || specifier === "module") return { syncBuiltinESMExports };
            if (specifier === "node:os" || specifier === "os") return { constants };
            throw new Error(`unexpected preload dependency: ${specifier}`);
        },
    });
    return {
        childProcess, json, runtimeFile, traceFile, nativeCalls, reads, writes, parseCalls, parseValues, parseError,
        forbiddenEffect, syncBuiltinESMExports,
        result(value: NativeResult) { nativeResult = value; },
        throwNative(value: unknown) { nativeError = value; },
        trace() { return fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : ""; },
        records(): Array<Record<string, unknown>> {
            return this.trace().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        },
        observeProcess() {
            nativeResult = { status: 0, stdout: `p${pid}\n` };
            childProcess.spawnSync("/usr/sbin/lsof", lsofArgs);
            nativeResult = { status: 0, stdout: command };
            childProcess.spawnSync("/bin/ps", psArgs("command="));
            nativeResult = { status: 0, stdout: nativeStart };
            childProcess.spawnSync("/bin/ps", psArgs("lstart="));
        },
    };
}

describe("bounded broker fixture observation trace", () => {
    it("forwards exact spawn arguments, receiver, result identity and thrown errors", () => {
        const f = fixture();
        const result = Object.freeze({ status: 7, signal: "SIGTERM", stdout: "private-stdout-marker", stderr: "private-stderr-marker" });
        const options = Object.freeze({ encoding: "utf8", timeout: 913, env: { PRIVATE: "private-env-marker" } });
        const receiver = { private: "private-receiver-marker" };
        f.result(result);
        expect(f.childProcess.spawnSync.call(receiver, "/usr/sbin/lsof", lsofArgs, options)).toBe(result);
        expect(f.nativeCalls).toHaveLength(1);
        expect(f.nativeCalls[0].receiver).toBe(receiver);
        expect(f.nativeCalls[0].args).toEqual(["/usr/sbin/lsof", lsofArgs, options]);
        expect(f.nativeCalls[0].args[1]).toBe(lsofArgs);
        expect(f.nativeCalls[0].args[2]).toBe(options);
        const error = Object.freeze(new Error("private-native-error-marker"));
        f.throwNative(error);
        let caught: unknown;
        try { f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs); } catch (value) { caught = value; }
        expect(caught).toBe(error);
        expect(f.nativeCalls).toHaveLength(2);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("preserves parsed result identity and the original JSON parse exception", () => {
        const f = fixture();
        const text = JSON.stringify(publicBody);
        const parsed = structuredClone(publicBody);
        f.parseValues.set(text, parsed);
        const receiver = { private: "private-json-receiver-marker" };
        expect(f.json.parse.call(receiver, text)).toBe(parsed);
        expect(f.parseCalls.filter(call => call.args[0] === text)).toEqual([{ receiver, args: [text] }]);
        let caught: unknown;
        try { f.json.parse("private-parser-throw-marker"); } catch (value) { caught = value; }
        expect(caught).toBe(f.parseError);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("ignores unrelated executables, ports, argument shapes and unselected process IDs", () => {
        const f = fixture();
        const unrelated: Array<[string, string[]]> = [
            ["lsof", lsofArgs],
            ["/usr/sbin/lsof", ["-nP", `-iTCP:${port + 1}`, "-sTCP:LISTEN", "-Fp"]],
            ["/usr/sbin/lsof", [...lsofArgs, "private-extra-argument-marker"]],
            ["/bin/ps", psArgs("command=", pid + 1)],
            ["/bin/ps", psArgs("lstart=", pid + 1)],
        ];
        for (const [executable, args] of unrelated) f.childProcess.spawnSync(executable, args);
        expect(f.trace()).toBe("");
        expect(f.reads.every(file => file === f.runtimeFile)).toBe(true);
        expect(f.writes).toEqual([]);

        f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs);
        const observed = f.trace();
        expect(observed).not.toBe("");
        for (const [executable, args] of [
            ["ps", psArgs("command=")],
            ["/bin/ps", psArgs("command=", pid + 1)],
            ["/bin/ps", psArgs("pid=")],
            ["/bin/ps", [...psArgs("command="), "-ww"]],
        ] as Array<[string, string[]]>) f.childProcess.spawnSync(executable, args);
        expect(f.trace()).toBe(observed);
        f.result({ status: 0, stdout: command });
        f.childProcess.spawnSync("/bin/ps", psArgs("command="));
        expect(f.records()).toHaveLength(2);
        expect(f.nativeCalls).toHaveLength(unrelated.length + 6);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("replaces the selected listener generation and rejects PIDs from a failed listener probe", () => {
        const f = fixture();
        f.result({ status: 0, stdout: `p${pid + 10}\n` });
        f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs);
        f.result({ status: 0, stdout: `p${pid + 1}\np${pid + 2}\n` });
        f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs);
        const replacement = f.trace();
        f.childProcess.spawnSync("/bin/ps", psArgs("command=", pid + 10));
        f.childProcess.spawnSync("/bin/ps", psArgs("lstart=", pid + 2));
        expect(f.trace()).toBe(replacement);
        f.childProcess.spawnSync("/bin/ps", psArgs("command=", pid + 1));
        expect(f.records()).toHaveLength(3);

        f.result({ status: 1, stdout: `p${pid + 1}\n` });
        f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs);
        const failed = f.trace();
        f.childProcess.spawnSync("/bin/ps", psArgs("command=", pid + 1));
        expect(f.trace()).toBe(failed);
    });

    it("observes the own-port runtime PID without a listener probe and ignores a runtime for another port", () => {
        const f = fixture();
        f.result({ status: 0, stdout: nativeStart });
        f.childProcess.spawnSync("/bin/ps", psArgs("lstart="));
        expect(f.records()).toEqual([expect.objectContaining({
            stage: "ps-start", runtimeAvailable: true, pidMatches: true, startTokenMatches: true,
        })]);
        expect(f.nativeCalls).toHaveLength(1);
        fs.writeFileSync(f.runtimeFile, JSON.stringify({ ...runtime, port: port + 1 }));
        const previous = f.trace();
        f.childProcess.spawnSync("/bin/ps", psArgs("lstart="));
        expect(f.trace()).toBe(previous);
    });

    it("skips reviver observations while forwarding the exact reviver and result", () => {
        const f = fixture();
        const seen: string[] = [];
        const reviver = function (key: string, value: unknown) { seen.push(key); return value; };
        const text = JSON.stringify(publicBody);
        expect(f.json.parse(text, reviver)).toEqual(publicBody);
        expect(seen).toContain("broker");
        expect(f.parseCalls).toHaveLength(1);
        expect(f.parseCalls[0].args[1]).toBe(reviver);
        expect(f.trace()).toBe("");
        expect(f.reads).toEqual([]);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("does not trace unrelated parsed bodies or status tuples for another port", () => {
        const f = fixture();
        for (const body of [
            { ok: true },
            { broker: { ...publicBody.broker, port: port + 1 } },
            { secret: "private-unrelated-json-marker", headers: publicBody.headers },
        ]) expect(f.json.parse(JSON.stringify(body))).toEqual(body);
        expect(f.trace()).toBe("");
        expect(f.reads).toEqual([]);
    });

    it("keeps native and JSON results intact when the private trace cannot be written", () => {
        const f = fixture({ failWrites: true });
        const result = { status: 0, stdout: `p${pid}\n` };
        f.result(result);
        expect(f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs)).toBe(result);
        expect(f.json.parse(JSON.stringify(publicBody))).toEqual(publicBody);
        expect(f.nativeCalls).toHaveLength(1);
        expect(f.writes.length).toBeGreaterThan(0);
        expect(f.trace()).toBe("");
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("keeps a parsed status result intact when the private runtime cannot be read", () => {
        const f = fixture({ failRuntimeRead: true });
        const text = JSON.stringify(publicBody);
        const parsed = structuredClone(publicBody);
        f.parseValues.set(text, parsed);
        expect(f.json.parse(text)).toBe(parsed);
        expect(f.parseCalls.filter(call => call.args[0] === text)).toHaveLength(1);
        expect(f.reads).toEqual([f.runtimeFile]);
        expect(f.records()).toEqual([expect.objectContaining({
            stage: "status", runtimeAvailable: false, pidMatches: false,
            startTokenMatches: false, startedAtMatches: false,
        })]);
        expect(f.trace()).not.toContain("private-runtime-read-error-marker");
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("records generation comparisons from the already parsed public status without extra effects", () => {
        const f = fixture();
        f.observeProcess();
        const text = JSON.stringify(publicBody);
        const parsed = structuredClone(publicBody);
        f.parseValues.set(text, parsed);
        expect(f.json.parse(text)).toBe(parsed);
        expect(f.records().map(record => record.stage)).toEqual(["lsof", "ps-command", "ps-start", "status"]);
        expect(f.records().at(-1)).toEqual({
            stage: "status", runtimeAvailable: true, pidPresent: true, pidMatches: true,
            startTokenPresent: true, startTokenMatches: true, startedAtPresent: true, startedAtMatches: true,
        });
        expect(f.parseCalls.filter(call => call.args[0] === text)).toHaveLength(1);
        expect(f.nativeCalls).toHaveLength(3);
        expect(f.reads.every(file => file === f.runtimeFile)).toBe(true);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("reports mismatching generation fields as false while retaining the parsed body", () => {
        const f = fixture();
        const body = {
            ...publicBody,
            broker: { ...publicBody.broker, startedAt: "private-successor-start-marker",
                process: { pid: pid + 1, startToken: "private-successor-token-marker" } },
        };
        expect(f.json.parse(JSON.stringify(body))).toEqual(body);
        expect(f.records()).toEqual([{
            stage: "status", runtimeAvailable: true, pidPresent: true, pidMatches: false,
            startTokenPresent: true, startTokenMatches: false, startedAtPresent: true, startedAtMatches: false,
        }]);
        expect(f.nativeCalls).toHaveLength(0);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("distinguishes missing public generation fields from a matching runtime", () => {
        const f = fixture();
        const body = { broker: { name: "ccc-device-broker", mode: "host-broker-daemon", port } };
        expect(f.json.parse(JSON.stringify(body))).toEqual(body);
        expect(f.records()).toEqual([{
            stage: "status", runtimeAvailable: true, pidPresent: false, pidMatches: false,
            startTokenPresent: false, startTokenMatches: false, startedAtPresent: false, startedAtMatches: false,
        }]);
        expect(f.nativeCalls).toHaveLength(0);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("keeps observation receipts and rendered summaries free of native identity and credential values", () => {
        const f = fixture();
        f.observeProcess();
        f.json.parse(JSON.stringify(publicBody));
        const safeSummary = readBrokerObservationTrace(f.traceFile);
        expect(safeSummary).toContain("status");
        for (const secret of [
            String(pid), String(port), nativeStart, processStartToken, startedAt, secretPath,
            runtime.command, runtime.ownerId, runtime.token, publicBody.headers.authorization,
            f.runtimeFile, f.traceFile,
        ]) {
            expect(f.trace()).not.toContain(secret);
            expect(safeSummary).not.toContain(secret);
        }
        for (const record of f.records()) {
            expect(Object.keys(record).every(key => [
                "stage", "status", "signal", "errno", "threw", "stdoutBytes", "stderrBytes", "runtimeAvailable", "pidMatches",
                "pidPresent", "commandPresent", "entryMatches", "serveMatches", "portMatches", "startTokenPresent",
                "startTokenMatches", "startedAtPresent", "startedAtMatches",
            ].includes(key))).toBe(true);
        }
    });

    it("records bounded native failure classifications without exception text or output", () => {
        const f = fixture();
        f.result({ status: null, signal: "SIGTERM", stdout: "private-failed-stdout-marker",
            stderr: "private-failed-stderr-marker", error: { code: "EPERM", message: "private-native-message-marker" } });
        f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs);
        expect(f.records()[0]).toEqual(expect.objectContaining({
            stage: "lsof", status: null, signal: "SIGTERM", errno: "EPERM", threw: false, pidPresent: false,
        }));
        f.throwNative({ code: "private-hostile-errno-marker", message: "private-thrown-message-marker" });
        expect(() => f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs)).toThrow();
        expect(f.records().at(-1)).toEqual(expect.objectContaining({ stage: "lsof", errno: null, threw: true }));
        expect(f.trace()).not.toMatch(/private-(?:failed|native-message|hostile|thrown)/);
    });

    it("bounds the private trace while forwarding every native observation", () => {
        const f = fixture();
        const result = { status: 0, stdout: `p${pid}\n${"private-large-output-marker".repeat(1000)}` };
        f.result(result);
        for (let i = 0; i < 200; i += 1) expect(f.childProcess.spawnSync("/usr/sbin/lsof", lsofArgs)).toBe(result);
        expect(f.nativeCalls).toHaveLength(200);
        expect(fs.statSync(f.traceFile).size).toBeLessThanOrEqual(8192);
        expect(f.trace()).not.toBe("");
        expect(f.trace()).not.toContain("private-large-output-marker");
        expect(Buffer.byteLength(readBrokerObservationTrace(f.traceFile))).toBeLessThanOrEqual(8192);
        expect(f.forbiddenEffect).not.toHaveBeenCalled();
    });

    it("returns fixed safe diagnostics for missing or oversized trace files", () => {
        const f = fixture();
        expect(readBrokerObservationTrace(f.traceFile)).toBe("[broker observation trace unavailable]");
        fs.writeFileSync(f.traceFile, "private-oversized-trace-marker".repeat(1000));
        expect(readBrokerObservationTrace(f.traceFile)).toBe("[broker observation trace truncated]");
    });

    it("sanitizes persisted trace records before including them in an assertion message", () => {
        const f = fixture();
        fs.writeFileSync(f.traceFile, JSON.stringify({
            stage: "lsof", status: 0, signal: "private-malicious-signal-marker", errno: "private-malicious-errno-marker",
            threw: false, pidPresent: true, runtimeAvailable: true, pidMatches: true,
            stdoutBytes: 3, stderrBytes: 0,
            stdout: "private-persisted-output-marker", command: secretPath, token: runtime.token,
        }) + "\n");
        const summary = readBrokerObservationTrace(f.traceFile);
        expect(summary).not.toBe("");
        expect(summary).not.toMatch(/private-/);
        expect(summary).not.toContain("stdout\"");
        fs.writeFileSync(f.traceFile, "not-json-private-malformed-marker\n");
        expect(readBrokerObservationTrace(f.traceFile)).toBe("[broker observation trace unavailable]");
    });
});
