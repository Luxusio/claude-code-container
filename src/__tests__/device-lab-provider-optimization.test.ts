import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import { handleAndroidTool, appiumDiscovery } from "@ccc/device-lab/providers/backends/android.mjs";
import { handleMacosTool, listMacosDevices } from "@ccc/device-lab/providers/backends/macos-vm.mjs";
import { handleIosTool, listIosDevices } from "@ccc/device-lab/providers/backends/ios-simulator.mjs";
import { handleIosRealTool } from "@ccc/device-lab/providers/backends/ios-device.mjs";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";
import { freePort } from "./helpers/fake-broker-mcp-fixture.js";
import { cleanupFakeMacosMcpContext, createFakeMacosMcpContext } from "./helpers/fake-macos-mcp-fixture.js";

function json(result: any) { return JSON.parse(result.content[0].text); }

const mobileCatalogTools = ["adb", "emulator", "avdmanager", "xcrun", "xcodebuild"];
function catalogLookups(log: string) {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line))
        .flatMap(({ command, args }) => command === "where" ? [String(args[0])] : command === "/bin/sh" && args?.[0] === "-c"
            ? [String(args[1]).replace(/^command -v /, "")] : []);
}
function mobileCatalogLookups(log: string) {
    return catalogLookups(log).filter(name => mobileCatalogTools.includes(name)).sort();
}

describe("provider discovery is shared only inside one inventory operation", () => {
    it("macOS lists three devices with one provider lookup round and refreshes the next call", async () => {
        const context = createFakeMacosMcpContext();
        const commandPath = vi.spyOn(commands, "commandPath");
        try {
            const deviceIds: string[] = [];
            for (let index = 0; index < 3; index++) {
                const result = await handleMacosTool("device_create", { backend: "macos-vm", name: `Audit ${index}`, provider: "tart" });
                expect(result?.isError).not.toBe(true);
                deviceIds.push(json(result).device.id);
            }
            commandPath.mockClear();
            expect(listMacosDevices()).toHaveLength(3);
            expect(commandPath.mock.calls.map(([name]) => name)).toEqual(["tart", "vz", "utmctl"]);
            commandPath.mockClear();
            expect(listMacosDevices()).toHaveLength(3);
            expect(commandPath.mock.calls.map(([name]) => name)).toEqual(["tart", "vz", "utmctl"]);
            commandPath.mockClear();
            const status = await handleMacosTool("device_status", { deviceId: deviceIds[0] });
            expect(json(status).device.id).toBe(deviceIds[0]);
            expect(commandPath.mock.calls.map(([name]) => name)).toEqual(["tart", "vz", "utmctl"]);
        } finally {
            commandPath.mockRestore();
            cleanupFakeMacosMcpContext(context);
        }
    });

    it("iOS uses one actual simctl process for multiple owned devices and observes new state on the next list", async () => {
        const context = createFakeMacosMcpContext();
        const xcrun = join(context.binDir, "xcrun");
        const inventoryPath = join(context.homeDir, "simulator-inventory.json");
        const logPath = join(context.homeDir, "simctl-count.log");
        const originalInventory = process.env.AUDIT_IOS_INVENTORY;
        const originalLog = process.env.AUDIT_IOS_LOG;
        process.env.AUDIT_IOS_INVENTORY = inventoryPath;
        process.env.AUDIT_IOS_LOG = logPath;
        writeFileSync(xcrun, `#!${process.execPath}\nconst fs=require("node:fs"); fs.appendFileSync(process.env.AUDIT_IOS_LOG, process.argv.slice(2).join(" ")+"\\n"); process.stdout.write(fs.readFileSync(process.env.AUDIT_IOS_INVENTORY));\n`);
        chmodSync(xcrun, 0o755);
        const devices: Array<{ name: string; udid: string; state: string }> = [];
        try {
            for (let index = 0; index < 3; index++) {
                const created = await handleIosTool("device_create", { backend: "ios-simulator", name: `Audit ${index}`, deviceId: `ios-audit-${index}`, udid: `AUDIT-UDID-${index}` });
                expect(created?.isError).not.toBe(true);
                const device = json(created).device;
                devices.push({ name: device.simulatorName, udid: device.udid, state: "Booted" });
            }
            writeFileSync(inventoryPath, JSON.stringify({ devices: { "ios-runtime": devices } }));
            writeFileSync(logPath, "");
            const running = listIosDevices();
            expect(running).toHaveLength(3);
            expect(running.map((device: any) => device.status)).toEqual(["booted", "booted", "booted"]);
            expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(["simctl list devices -j"]);

            writeFileSync(inventoryPath, JSON.stringify({ devices: { "ios-runtime": devices.map((device) => ({ ...device, state: "Shutdown" })) } }));
            writeFileSync(logPath, "");
            const stopped = listIosDevices();
            expect(stopped.map((device: any) => device.status)).toEqual(["stopped", "stopped", "stopped"]);
            expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(["simctl list devices -j"]);

            writeFileSync(logPath, "");
            const inventory = await handleIosTool("device_inventory", { backend: "ios-simulator" });
            expect(json(inventory).devices).toHaveLength(3);
            expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(["simctl list -j"]);

            writeFileSync(xcrun, `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.AUDIT_IOS_LOG, process.argv.slice(2).join(" ")+"\\n"); console.error("simctl unavailable"); process.exit(9);\n`);
            writeFileSync(logPath, "");
            const failed = await handleIosTool("device_inventory", { backend: "ios-simulator" });
            expect(json(failed).hostSimulators.available).toBe(false);
            expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(["simctl list -j"]);
        } finally {
            if (originalInventory === undefined) delete process.env.AUDIT_IOS_INVENTORY; else process.env.AUDIT_IOS_INVENTORY = originalInventory;
            if (originalLog === undefined) delete process.env.AUDIT_IOS_LOG; else process.env.AUDIT_IOS_LOG = originalLog;
            cleanupFakeMacosMcpContext(context);
        }
    });

    it("iOS wireless rejects unsupported action before discovery and surfaces xctrace failure", async () => {
        const context = createFakeMacosMcpContext();
        const commandPath = vi.spyOn(commands, "commandPath");
        const xcrun = join(context.binDir, "xcrun");
        writeFileSync(xcrun, `#!${process.execPath}\nconsole.error("device inventory failed"); process.exit(7);\n`);
        chmodSync(xcrun, 0o755);
        try {
            const unsupported = await handleIosRealTool("device_wireless", { backend: "ios-device", action: "pair", udid: "test-phone" });
            expect(unsupported?.isError).toBe(true);
            expect(json(unsupported)).not.toHaveProperty("networkVisible");
            expect(commandPath).not.toHaveBeenCalled();
            const status = await handleIosRealTool("device_wireless", { backend: "ios-device", action: "status" });
            expect(status?.isError).toBe(true);
            expect(json(status)).toMatchObject({ ok: false, error: "ios-wireless-inventory-failed" });
            expect(JSON.stringify(status)).toContain("device inventory failed");
        } finally {
            commandPath.mockRestore();
            cleanupFakeMacosMcpContext(context);
        }
    });
});


describe("broker-first backend discovery over the MCP wire", () => {
    it("does not probe unused local providers, while detail and explicit direct mode opt into them", { timeout: 30000 }, async () => {
        const env: Record<string, string> = {};
        let log = "";
        const context = await createDeviceLabMcpTestContext({ env, setupHome(home) {
            log = join(home, "discovery-processes.jsonl");
            writeFileSync(log, "");
            const preload = join(home, "trace-discovery.cjs");
            writeFileSync(preload, `const fs=require('fs'),cp=require('child_process');const original=cp.spawnSync;cp.spawnSync=function(command,args,...rest){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+'\\n');return original.call(this,command,args,...rest)};require('module').syncBuiltinESMExports();`);
            env.NODE_OPTIONS = `--require=${JSON.stringify(join(home, "isolate-broker-auth.cjs"))} --require=${JSON.stringify(preload)}`;
        } });
        try {
            const port = await freePort();
            const args = { implicitBroker: true, autolaunch: false, hostCandidates: ["127.0.0.1"], port, timeoutMs: 100 };
            writeFileSync(log, "");
            const minimal = await context.client.callTool({ name: "devices", arguments: { view: "backends", ...args, detail: false } });
            expect(json(minimal)).toMatchObject({ ok: false, error: "broker-unavailable" });
            expect(catalogLookups(log).filter(name => ["adb", "emulator", "avdmanager", "xcrun", "wsb", "tart"].includes(name))).toEqual([]);
            expect(mobileCatalogLookups(log)).toEqual([]);
            expect(catalogLookups(log)).toContain("qemu-system-x86_64");

            expect(json(minimal).backends.some((backend: any) => backend.name === "linux-vm")).toBe(true);

            writeFileSync(log, "");
            const detailed = await context.client.callTool({ name: "devices", arguments: { view: "backends", ...args, detail: true } });
            expect(json(detailed).localBackends.length).toBeGreaterThan(1);
            expect(catalogLookups(log)).toContain("adb");
            expect(catalogLookups(log)).toContain("qemu-system-x86_64");
            expect(mobileCatalogLookups(log)).toEqual([...mobileCatalogTools].sort());

            writeFileSync(log, "");
            const direct = await context.client.callTool({ name: "devices", arguments: { view: "backends", implicitBroker: false, detail: false } });
            expect(json(direct).backends.some((backend: any) => backend.name === "android-emulator")).toBe(true);
            expect(catalogLookups(log)).toContain("adb");
            expect(mobileCatalogLookups(log)).toEqual([...mobileCatalogTools].sort());
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });

    it.each(["direct", "detailed-broker"])("%s catalog refreshes executables each call and preserves physical-device availability", { timeout: 30000 }, async (route) => {
        const env: Record<string, string> = {};
        let statePath = "";
        const context = await createDeviceLabMcpTestContext({ env, setupHome(home) {
            statePath = join(home, "catalog-executables.json");
            writeFileSync(statePath, "{}");
            const preload = join(home, "catalog-executables.cjs");
            writeFileSync(preload, `const fs=require('fs'),cp=require('child_process');
const original=cp.spawnSync;
cp.spawnSync=function(command,args,...rest){
    const name=command==='where'?args?.[0]:command==='/bin/sh'&&args?.[0]==='-c'?/^command -v (.+)$/.exec(args[1])?.[1]:null;
    if(['adb','emulator','avdmanager','xcrun','xcodebuild'].includes(name)){const value=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'))[name];return {status:value?0:1,stdout:value?value+'\\n':'',stderr:''};}
    return original.call(this,command,args,...rest);
};require('module').syncBuiltinESMExports();`);
            env.NODE_OPTIONS = `--require=${JSON.stringify(join(home, "isolate-broker-auth.cjs"))} --require=${JSON.stringify(preload)}`;
        } });
        try {
            const port = await freePort();
            const args = route === "direct" ? { implicitBroker: false, detail: true }
                : { implicitBroker: true, detail: true, autolaunch: false, hostCandidates: ["127.0.0.1"], port, timeoutMs: 100 };
            async function catalog(executables: Record<string, string>) {
                writeFileSync(statePath, JSON.stringify(executables));
                const result = json(await context.client.callTool({ name: "devices", arguments: { view: "backends", ...args } }));
                return (route === "direct" ? result.backends : result.localBackends)
                    .filter((backend: any) => ["android-emulator", "android-device", "ios-simulator", "ios-device"].includes(backend.name));
            }
            const first = await catalog({ adb: "/sdk/adb", emulator: "/sdk/emulator", avdmanager: "/sdk/avdmanager", xcrun: "/xcode/xcrun" });
            expect(first).toHaveLength(4);
            for (const backend of first) {
                expect(backend).toMatchObject({ available: true, status: "available", missing: [], lazy: true });
                expect(backend.capabilities).toContain("devices");
            }
            expect(first.find((backend: any) => backend.name === "ios-device")).toMatchObject({
                host: "macos-host-usb-xcode", creatable: false, attachable: true,
                tools: { xcrun: "/xcode/xcrun", xcodebuild: null },
            });
            const second = await catalog({ adb: "/new-sdk/adb", xcodebuild: "/xcode/xcodebuild" });
            expect(second.find((backend: any) => backend.name === "android-device")).toMatchObject({
                host: "host-usb-adb", creatable: false, attachable: true, available: true, missing: [], tools: { adb: "/new-sdk/adb" },
            });
            expect(second.find((backend: any) => backend.name === "android-emulator")).toMatchObject({
                available: false, status: "missing-prerequisites", missing: ["emulator"],
                tools: { adb: "/new-sdk/adb", emulator: null, avdmanager: null }, provisioning: { available: false, missing: ["avdmanager"] },
            });
            for (const name of ["ios-simulator", "ios-device"]) {
                expect(second.find((backend: any) => backend.name === name)).toMatchObject({ available: false, status: "missing-prerequisites", missing: ["xcrun"], tools: { xcrun: null } });
            }
            expect(second.find((backend: any) => backend.name === "ios-device").tools.xcodebuild).toBe("/xcode/xcodebuild");
            expect(await catalog({ adb: "/sdk/adb", emulator: "/sdk/emulator", avdmanager: "/sdk/avdmanager", xcrun: "/xcode/xcrun" })).toEqual(first);
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    });
});


describe("Android discovery scope", () => {
    it("status resolves SDK tools once and standalone Appium discovery does not inspect emulator tools", async () => {
        const context = createFakeMacosMcpContext();
        const commandPath = vi.spyOn(commands, "commandPath");
        try {
            const created = await handleAndroidTool("device_create", { backend: "android-emulator", name: "Count fixture", deviceId: "android-count-fixture", avdName: "CountFixture", port: 5588 });
            expect(created?.isError).not.toBe(true);
            commandPath.mockClear();
            const status = await handleAndroidTool("device_status", { deviceId: "android-count-fixture" });
            expect(status?.isError).not.toBe(true);
            for (const tool of ["adb", "emulator", "avdmanager"]) {
                expect(commandPath.mock.calls.filter(([name]) => name === tool)).toHaveLength(1);
            }
            commandPath.mockClear();
            appiumDiscovery();
            expect(commandPath.mock.calls.map(([name]) => name)).not.toEqual(expect.arrayContaining(["emulator"]));
            expect(commandPath.mock.calls.map(([name]) => name)).not.toEqual(expect.arrayContaining(["avdmanager"]));
            expect(commandPath.mock.calls.filter(([name]) => name === "adb")).toHaveLength(1);
        } finally { commandPath.mockRestore(); cleanupFakeMacosMcpContext(context); }
    });
});
