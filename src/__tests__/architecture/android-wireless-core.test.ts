import { describe, expect, it } from "vitest";
import * as current from "../../../packages/device-lab/providers/domain/android-wireless.mjs";
import { createAndroidWirelessApplication } from "../../../packages/device-lab/providers/application/android-wireless.mjs";


describe("Android wireless current contracts", () => {
    it("parses usable endpoints and refuses invalid ports", () => {
        expect(current.parseAndroidWifiEndpoint("host:4321", 5555)).toEqual({host:"host",port:4321});
        expect(current.parseAndroidWifiEndpoint("host:65536", 5555)).toBeNull();
        expect(current.androidWirelessCommandPayload(["pair","host:4321","654321"], {status:0,stdout:"",stderr:""}, [2]).args).toEqual(["pair","host:4321","[redacted]"]);
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
