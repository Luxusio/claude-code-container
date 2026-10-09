import { describe, expect, it } from "vitest";
import * as vm from "node:vm";
import { createHash } from "node:crypto";
import * as current from "../../../packages/device-lab/providers/domain/android-wireless.mjs";
import { createAndroidWirelessApplication } from "../../../packages/device-lab/providers/application/android-wireless.mjs";

// Original pure declarations copied byte-for-byte before any candidate edit.
const ORIGINAL_PURE = "function parseAdbDevices(text) {\n    return String(text || \"\")\n        .split(/\\r?\\n/)\n        .map((line) => line.trim())\n        .filter((line) => line && !line.startsWith(\"List of devices\"))\n        .map((line) => {\n            const [serial, state, ...detailParts] = line.split(/\\s+/);\n            const details = Object.fromEntries(detailParts.map((part) => {\n                const index = part.indexOf(\":\");\n                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];\n            }));\n            const emulator = serial?.startsWith(\"emulator-\") || false;\n            const connection = !emulator && parseAndroidWifiEndpoint(serial) ? \"wifi\" : \"usb\";\n            return { serial, state: state || \"unknown\", details, emulator, connection };\n        })\n        .filter((device) => device.serial);\n}\n\nfunction parseAndroidWifiEndpoint(value, fallbackPort = null) {\n    const input = String(value || \"\").trim();\n    if (!input) return null;\n    const bracketed = input.match(/^\\[([^\\]]+)](?::(\\d+))?$/);\n    if (bracketed) {\n        const port = bracketed[2] ? Number(bracketed[2]) : Number(fallbackPort);\n        return Number.isInteger(port) && port > 0 && port <= 65535 ? { host: bracketed[1], port } : null;\n    }\n    const colonCount = (input.match(/:/g) || []).length;\n    if (colonCount === 1) {\n        const separator = input.lastIndexOf(\":\");\n        const port = Number(input.slice(separator + 1));\n        if (Number.isInteger(port) && port > 0 && port <= 65535) return { host: input.slice(0, separator), port };\n    }\n    const port = Number(fallbackPort);\n    if (colonCount !== 1 && Number.isInteger(port) && port > 0 && port <= 65535) return { host: input, port };\n    return null;\n}\n\nfunction androidWifiSerial(host, port = 5555) {\n    const endpoint = parseAndroidWifiEndpoint(host, port || 5555);\n    if (!endpoint) return null;\n    const formattedHost = endpoint.host.includes(\":\") ? `[${endpoint.host}]` : endpoint.host;\n    return `${formattedHost}:${endpoint.port}`;\n}\n\nfunction androidWifiTarget(host, port = 5555, serial = \"\") {\n    if (serial) return androidWifiSerial(serial, port);\n    if (!host) return null;\n    return androidWifiSerial(host, port);\n}\n\nfunction androidWifiTransport(serial, host, port) {\n    const endpoint = parseAndroidWifiEndpoint(serial, port || 5555);\n    return {\n        type: \"wifi\",\n        host: parseAndroidWifiEndpoint(host, port || 5555)?.host || endpoint?.host || null,\n        port: endpoint?.port || Number(port || 5555),\n    };\n}\n\nfunction androidWifiAttachNext(backend, target, fallbackPort = 5555) {\n    const endpoint = parseAndroidWifiEndpoint(target, fallbackPort);\n    return endpoint ? { tool: \"device_attach\", arguments: { backend, connection: \"wifi\", ...endpoint } } : null;\n}\n\nfunction androidWirelessCommandPayload(command, result, redactedIndices = []) {\n    const redacted = new Set(redactedIndices);\n    return {\n        provider: \"adb\",\n        args: command.map((value, index) => redacted.has(index) ? \"[redacted]\" : value),\n        status: result.status,\n        stdout: result.stdout,\n        stderr: result.stderr,\n        signal: result.signal || null,\n        error: result.error?.message || null,\n    };\n}\n\n";
const ORIGINAL_SOURCE_SHA = "b53b89ebcdbdeb8430dc2c739e86e9da196d8cd4a3a844296f06ac00d61de53a";
const original = vm.createContext({});
vm.runInContext(ORIGINAL_PURE, original);
const methods = ["parseAdbDevices", "parseAndroidWifiEndpoint", "androidWifiSerial", "androidWifiTarget", "androidWifiTransport", "androidWifiAttachNext", "androidWirelessCommandPayload"] as const;

describe("Android wireless original pure contracts", () => {
    it("pins the original source authority and exercises all seven original declarations", () => {
        expect(ORIGINAL_SOURCE_SHA).toMatch(/^[a-f0-9]{64}$/);
        expect(createHash("sha256").update(ORIGINAL_PURE).digest("hex")).toBe("94f1fd6724a0102786b8c13bc7333ada1576e298fa5a4a6279de5f40d836ae9f");
        for (const method of methods) expect(typeof current[method]).toBe("function");
    });
    it.each([
        ["", undefined], [null, undefined], [false, 5555], [0, 5555], [" host ", 5555],
        ["192.0.2.1:4321", 5555], ["192.0.2.1:0", 5555], [":5555", 1],
        ["host:word", 5555], ["host:65536", 5555], ["host:", 5555],
        ["[2001:db8::1]:4321", 5555], ["[2001:db8::1]", 5555], ["2001:db8::1", 5555],
        ["[::1]:0", 5555], ["[::1]:65536", 5555], ["host", 0], ["host", -1], ["host", "15"],
    ])("preserves endpoint and serial falsy/IPv4/IPv6 coercion for %j/%j", (value, port) => {
        expect(current.parseAndroidWifiEndpoint(value, port)).toEqual(original.parseAndroidWifiEndpoint(value, port));
        expect(current.androidWifiSerial(value, port)).toEqual(original.androidWifiSerial(value, port));
        expect(current.androidWifiTransport(value, value, port)).toEqual(original.androidWifiTransport(value, value, port));
        expect(current.androidWifiAttachNext("android-device", value, port)).toEqual(original.androidWifiAttachNext("android-device", value, port));
    });
    it("preserves serial priority and inventory detail parsing without tightening", () => {
        for (const args of [["host", 5555, "serial:4321"], ["bad:word", 0, ""], ["host", 0, false], [false, undefined, "[::1]:17"]]) {
            expect((current.androidWifiTarget as (...values: any[]) => unknown)(...args)).toEqual(original.androidWifiTarget(...args));
        }
        for (const text of ["", null, false, "List of devices attached\nUSB device usb:1 model:Pixel standalone\n192.0.2.1:5555 device\n[::1]:4444 offline\nemulator-5554 device\nNO_STATE\n"]) {
            expect(current.parseAdbDevices(text)).toEqual(original.parseAdbDevices(text));
        }
    });
    it("redacts only argv index2 and retains raw payload getter order and references", () => {
        for (const api of [original, current]) {
            const trace: string[] = [], stdout = { marker: "code:654321" }, stderr = { marker: "code:654321" };
            const result = Object.defineProperties({}, {
                status: { get() { trace.push("status"); return 17; } },
                stdout: { get() { trace.push("stdout"); return stdout; } },
                stderr: { get() { trace.push("stderr"); return stderr; } },
                signal: { get() { trace.push("signal"); return ""; } },
                error: { get() { trace.push("error"); return { get message() { trace.push("message"); return "654321 raw"; } }; } },
            });
            const payload = api.androidWirelessCommandPayload(["pair", "host:4321", "654321"], result, [2]);
            expect(payload.args).toEqual(["pair", "host:4321", "[redacted]"]);
            expect(payload.stdout).toBe(stdout); expect(payload.stderr).toBe(stderr);
            expect(payload.error).toBe("654321 raw"); expect(payload.signal).toBe(null);
            expect(trace).toEqual(["status", "stdout", "stderr", "signal", "error", "message"]);
        }
    });
    it("propagates original coercion and result getter exceptions unchanged", () => {
        const sentinel = new Error("original raw sentinel");
        for (const api of [original, current]) {
            expect(() => api.parseAndroidWifiEndpoint({ toString() { throw sentinel; } }, 5555)).toThrow(sentinel);
            expect(() => api.androidWirelessCommandPayload([], { get status() { throw sentinel; } })).toThrow(sentinel);
        }
    });
    it("requires every semantic step without native probes or getter calls at construction", () => {
        const calls: string[] = [];
        const ports = {
            discover: () => { calls.push("discover"); return { adb: "adb" }; },
            listDevices: () => ({ status: 0, stdout: "", stderr: "" }),
            tcpip: () => ({ status: 0, stdout: "", stderr: "" }),
            pair: () => ({ status: 0, stdout: "", stderr: "" }),
            connect: () => ({ status: 0, stdout: "", stderr: "" }),
            selectJsonPublisher: () => (value: unknown) => value,
            selectTextPublisher: () => (ok: boolean, text: string) => ({ ok, text }),
        };
        const app = createAndroidWirelessApplication(ports);
        expect(calls).toEqual([]);
        app.handle({ action: "status" }); expect(calls).toEqual(["discover"]);
        for (const name of Object.keys(ports)) {
            const incomplete: any = { ...ports }; delete incomplete[name];
            expect(() => createAndroidWirelessApplication(incomplete)).toThrow(TypeError);
            const asynchronous = { ...ports, [name]: async () => ({}) };
            expect(() => createAndroidWirelessApplication(asynchronous)).toThrow(TypeError);
        }
        let gets = 0;
        const accessor = { ...ports };
        Object.defineProperty(accessor, "discover", { get() { gets++; return ports.discover; } });
        const lazy = createAndroidWirelessApplication(accessor);
        expect(gets).toBe(0);
        lazy.handle({ action: "status" }); expect(gets).toBe(1);
    });
    it("rejects getter-returned async discovery and commands at lazy selection before invocation", () => {
        for (const capability of ["discover", "connect"] as const) {
            const trace: string[] = [];
            let asyncInvocations = 0;
            const ports = {
                discover: () => { trace.push("discover"); return { adb: "adb" }; },
                listDevices: () => { trace.push("list"); return { status: 0, stdout: "", stderr: "" }; },
                tcpip: () => ({ status: 0, stdout: "", stderr: "" }),
                pair: () => ({ status: 0, stdout: "", stderr: "" }),
                connect: () => ({ status: 0, stdout: "", stderr: "" }),
                selectJsonPublisher: () => { trace.push("json"); return (value: unknown) => value; },
                selectTextPublisher: () => { trace.push("text"); return (ok: boolean, text: string) => ({ ok, text }); },
            };
            Object.defineProperty(ports, capability, { get() {
                trace.push("select-" + capability);
                return async function () { asyncInvocations++; return { status: 0, adb: "adb" }; };
            } });
            const app = createAndroidWirelessApplication(ports);
            expect(trace).toEqual([]);
            const host = { toString() { trace.push("target"); return "host"; } };
            const timeoutMs = { valueOf() { trace.push("timeout"); return 15000; } };
            expect(() => app.handle({ action: capability === "discover" ? "status" : "connect", host, timeoutMs })).toThrow(TypeError);
            expect(asyncInvocations).toBe(0);
            expect(trace).toEqual(capability === "discover" ? ["select-discover"] : ["discover", "target", "select-connect"]);
        }
    });
    it("preserves synchronous getter selection, port receivers, argument order and bare publication", () => {
        const trace: string[] = [];
        const timeoutMs = { valueOf() { throw new Error("the application must leave timeout coercion to the native step"); } };
        const ports = {
            discover: () => ({ adb: "adb" }),
            listDevices: () => ({ status: 0, stdout: "", stderr: "" }),
            tcpip: () => ({ status: 0, stdout: "", stderr: "" }),
            pair: () => ({ status: 0, stdout: "", stderr: "" }),
            connect: (_adb: unknown, _argv: unknown[], _timeout: unknown) => ({ status: 0, stdout: "", stderr: "" }),
            selectJsonPublisher: () => (value: unknown) => value,
            selectTextPublisher: () => (ok: boolean, text: string) => ({ ok, text }),
        };
        Object.defineProperty(ports, "discover", { get() {
            trace.push("get-discover");
            return function (this: unknown) { expect(this).toBe(ports); trace.push("discover"); return { adb: "adb" }; };
        } });
        Object.defineProperty(ports, "connect", { get() {
            trace.push("get-connect");
            return function (this: unknown, adb: unknown, argv: unknown[], timeout: unknown) {
                expect(this).toBe(ports); expect(adb).toBe("adb"); expect(argv).toEqual(["connect", "host:5555"]);
                expect(timeout).toBe(timeoutMs); trace.push("connect"); return { status: 0, stdout: "", stderr: "" };
            };
        } });
        Object.defineProperty(ports, "selectJsonPublisher", { get() {
            trace.push("get-json-selector");
            return function (this: unknown) {
                expect(this).toBe(ports); trace.push("select-json");
                return function (this: unknown, value: unknown) { expect(this).toBeUndefined(); trace.push("publish"); return value; };
            };
        } });
        const app = createAndroidWirelessApplication(ports);
        expect(trace).toEqual([]);
        app.handle({ action: "connect", host: { toString() { trace.push("target"); return "host"; } }, timeoutMs });
        expect(trace).toEqual(["get-discover", "discover", "target", "get-connect", "connect", "get-json-selector", "select-json", "publish"]);
    });
    it("rejects lazy async discovery and command capabilities despite inspection mutation", () => {
        for (const capability of ["discover", "connect"] as const) {
            const sourceDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString")!;
            const testDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "test")!;
            const trace: string[] = [];
            let asyncInvocations = 0, failure: unknown;
            const ports = {
                discover: () => { trace.push("discover"); return { adb: "adb" }; },
                listDevices: () => { trace.push("list"); return { status: 0, stdout: "", stderr: "" }; },
                tcpip: () => ({ status: 0, stdout: "", stderr: "" }),
                pair: () => ({ status: 0, stdout: "", stderr: "" }),
                connect: () => ({ status: 0, stdout: "", stderr: "" }),
                selectJsonPublisher: () => { trace.push("json"); return (value: unknown) => value; },
                selectTextPublisher: () => { trace.push("text"); return (ok: boolean, text: string) => ({ ok, text }); },
            };
            Object.defineProperty(ports, capability, { get() {
                trace.push("select-" + capability);
                Object.defineProperty(Function.prototype, "toString", { ...sourceDescriptor, value: () => "function ordinary() {}" });
                Object.defineProperty(RegExp.prototype, "test", { ...testDescriptor, value: () => false });
                return async function () { asyncInvocations++; return { status: 0, adb: "adb" }; };
            } });
            const app = createAndroidWirelessApplication(ports);
            expect(trace).toEqual([]);
            try { app.handle({ action: capability === "discover" ? "status" : "connect", host: "host" }); }
            catch (error) { failure = error; }
            finally {
                Object.defineProperty(Function.prototype, "toString", sourceDescriptor);
                Object.defineProperty(RegExp.prototype, "test", testDescriptor);
            }
            expect(failure).toBeInstanceOf(TypeError); expect(asyncInvocations).toBe(0);
            expect(trace).toEqual(capability === "discover" ? ["select-discover"] : ["discover", "select-connect"]);
        }
    });
    it("rejects lazy async discovery and commands despite RegExp.exec throw or null mutation", () => {
        for (const capability of ["discover", "connect"] as const) for (const mutation of ["throw", "null"] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec")!;
            const trace: string[] = [];
            let asyncInvocations = 0, replacementInvocations = 0, failure: unknown;
            const ports = {
                discover: () => { trace.push("discover"); return { adb: "adb" }; },
                listDevices: () => { trace.push("list"); return { status: 0, stdout: "", stderr: "" }; },
                tcpip: () => ({ status: 0, stdout: "", stderr: "" }),
                pair: () => ({ status: 0, stdout: "", stderr: "" }),
                connect: () => ({ status: 0, stdout: "", stderr: "" }),
                selectJsonPublisher: () => { trace.push("json"); return (value: unknown) => value; },
                selectTextPublisher: () => { trace.push("text"); return (ok: boolean, text: string) => ({ ok, text }); },
            };
            Object.defineProperty(ports, capability, { get() {
                trace.push("select-" + capability);
                Object.defineProperty(RegExp.prototype, "exec", { ...descriptor, value: () => {
                    replacementInvocations++;
                    if (mutation === "throw") throw new Error("replacement RegExp.exec must not run");
                    return null;
                } });
                return async function () { asyncInvocations++; return { status: 0, adb: "adb" }; };
            } });
            const app = createAndroidWirelessApplication(ports);
            expect(trace).toEqual([]);
            try { app.handle({ action: capability === "discover" ? "status" : "connect", host: "host" }); }
            catch (error) { failure = error; }
            finally { Object.defineProperty(RegExp.prototype, "exec", descriptor); }
            expect(failure).toBeInstanceOf(TypeError);
            expect(asyncInvocations).toBe(0); expect(replacementInvocations).toBe(0);
            expect(trace).toEqual(capability === "discover" ? ["select-discover"] : ["discover", "select-connect"]);
        }
    });
});
