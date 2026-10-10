import * as childProcess from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    devicesCli,
    formatDevicesSmoke,
} from "../device-lab-admin.js";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";
import { createDeviceAdminDiagnostics } from "../application/device-admin-diagnostics.js";
import type { DeviceAdminDiagnosticsInventory, DeviceAdminDiagnosticsPorts } from "../ports/device-admin-diagnostics.js";

function diagnosticsCapabilityContracts(
    ports: DeviceAdminDiagnosticsPorts,
    inventory: DeviceAdminDiagnosticsInventory<DeviceAdminDiagnosticsPorts["backends"][number]>,
): void {
    createDeviceAdminDiagnostics(ports, inventory);
    const { readPhysicalLease: _lease, ...withoutLeaseRead } = ports;
    // @ts-expect-error Physical bench ownership cannot be diagnosed without lease evidence.
    createDeviceAdminDiagnostics(withoutLeaseRead, inventory);
    // @ts-expect-error Synchronous diagnostics must receive a settled command result.
    const asynchronousCommand: DeviceAdminDiagnosticsPorts["runCommand"] = async () => null;
    void [_lease, asynchronousCommand];
}
void diagnosticsCapabilityContracts;

vi.mock("child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("child_process")>() }));

describe("device-lab admin smoke diagnostics", () => {
    const fixture = createDeviceLabAdminTestFixture();
    // This suite models a host without native Hyper-V; native setup has separate suites.
    beforeEach(() => vi.spyOn(process, "platform", "get").mockReturnValue("linux"));

    afterEach(() => {
        vi.restoreAllMocks();
        fixture.cleanup();
    });

    it("reports smoke SKIP for missing host prerequisites without starting devices", () => {
        const cwd = "/project/admin-smoke-skip-test";
        fixture.setupFixture(cwd);

        const smoke = formatDevicesSmoke(cwd);

        expect(smoke).toContain("=== CCC Devices Smoke ===");
        expect(smoke).toContain("Startup policy: lazy; smoke checks do not start devices");
        expect(smoke).not.toContain("warning: device-lab container wiring is incomplete");
        expect(smoke).toContain("android-emulator: SKIP - missing adb, emulator");
        expect(smoke).toContain("android-device: SKIP - missing adb");
        expect(smoke).toContain("ios-simulator: SKIP - missing xcrun");
        expect(smoke).toContain("ios-device: SKIP - missing xcrun");
        expect(smoke).toContain("windows-sandbox: SKIP - missing wsb");
        expect(smoke).toContain("windows-vm: SKIP - not a Windows host");
        expect(smoke).toContain("linux-vm: SKIP - not a Windows host");
        expect(smoke).toContain("macos-vm: SKIP - missing tart, vz, utmctl");
    });

    it("can include installed MCP surface smoke without starting devices", () => {
        const cwd = "/project/admin-smoke-installed-mcp-pass-test";
        fixture.setupFixture(cwd);
        const serverPath = join(fixture.homeDir, "server.mjs");
        const scriptPath = join(fixture.homeDir, "installed-mcp-smoke.ts");
        writeFileSync(serverPath, "export {};\n");
        writeFileSync(scriptPath, "console.log(JSON.stringify({ status: 'PASS' }));\n");

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, {
            mcpSurface: true,
            mcpServerPath: serverPath,
            mcpSmokeScriptPath: scriptPath,
        });

        expect(smoke).toContain("device-lab-mcp-installed: PASS - installed MCP advertised surface dispatches current-display aliases");
        expect(smoke).toContain(`${process.execPath} ${scriptPath} ${serverPath} -> 0`);
        expect(smoke).toContain("Startup policy: lazy; smoke checks do not start devices");
    });

    it("reports stale installed MCP surface failures in smoke output", () => {
        const cwd = "/project/admin-smoke-installed-mcp-fail-test";
        fixture.setupFixture(cwd);
        const serverPath = join(fixture.homeDir, "server.mjs");
        const scriptPath = join(fixture.homeDir, "installed-mcp-smoke.ts");
        writeFileSync(serverPath, "export {};\n");
        writeFileSync(scriptPath, [
            "console.error('AssertionError: x11-current-display must expose device_status alias capability');",
            "console.error('device_status dispatch mismatch: Unknown tool: device_status');",
            "process.exit(1);",
            "",
        ].join("\n"));

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, {
            mcpSurface: true,
            mcpServerPath: serverPath,
            mcpSmokeScriptPath: scriptPath,
        });

        expect(smoke).toContain("device-lab-mcp-installed: FAIL - AssertionError: x11-current-display must expose device_status alias capability");
        expect(smoke).toContain("device_status dispatch mismatch: Unknown tool: device_status");
        expect(smoke).toContain(`${process.execPath} ${scriptPath} ${serverPath} -> 1`);
    });

    it("omits stale-container warning from smoke when state root is present", () => {
        const cwd = "/project/admin-smoke-wired-test";
        fixture.setupFixture(cwd);

        const smoke = formatDevicesSmoke(cwd);

        expect(smoke).toContain("ownerResolution: host-broker-resolve");
        expect(smoke).toContain("environmentRequired: false");
        expect(smoke).not.toContain("ownerBasisEnv:");
        expect(smoke).not.toContain("ownerBasisMatches:");
        expect(smoke).not.toContain("warning: device-lab container wiring is incomplete");
    });

    it("reports opt-in real provider smoke mode without lifecycle commands", () => {
        const cwd = "/project/admin-smoke-real-provider-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        const logPath = join(fixture.homeDir, "smoke-real-provider.log");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        const recorder = `appendFileSync(${JSON.stringify(logPath)}, process.argv[1] + ' ' + args.join(' ') + '\\n'); console.log('ok');`;
        fixture.writeNodeTool(binDir, "adb", recorder);
        fixture.writeNodeTool(binDir, "emulator", recorder);
        fixture.writeNodeTool(binDir, "xcrun", recorder);
        fixture.writeNodeTool(binDir, "xcodebuild", recorder);
        fixture.writeNodeTool(binDir, "wsb", recorder);
        fixture.writeNodeTool(binDir, "tart", recorder);
        fixture.writeNodeTool(binDir, "ssh", recorder);
        fixture.writeNodeTool(binDir, "scp", recorder);

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

        expect(smoke).toContain("mode: real-provider (explicit opt-in)");
        expect(smoke).toContain("Real provider policy: bounded readiness/inventory commands only; no devices are created, started, stopped, or deleted");
        expect(smoke).toContain("android-emulator: PASS - real provider adb/emulator readiness responded; no emulator started");
        expect(smoke).toContain("android-device: PASS - real provider adb physical-device inventory responded; no device claimed");
        expect(smoke).toContain("ios-simulator: PASS - real provider simctl inventory responded; no simulator booted");
        expect(smoke).toContain("ios-device: PASS - real provider xctrace physical-device inventory responded; no device claimed");
        expect(smoke).toContain("windows-sandbox: PASS - real provider Windows Sandbox CLI responded; no sandbox started");
        expect(smoke).toContain("windows-vm: SKIP - not a Windows host");
        expect(smoke).toContain("linux-vm: SKIP - not a Windows host");
        expect(smoke).toContain("macos-vm: PASS - real provider macOS VM CLI and SSH bridge responded; SCP bridge tool found; no VM started");
        expect(smoke).toContain(`${join(binDir, "scp.mjs")} path-check -> 0`);
        const commandLog = readFileSync(logPath, "utf-8");
        expect(commandLog).toContain("adb.mjs version");
        expect(commandLog).toContain("emulator.mjs -list-avds");
        expect(commandLog).toContain("xcrun.mjs simctl list -j");
        expect(commandLog).toContain("xcrun.mjs xctrace list devices");
        expect(commandLog).not.toContain("xcodebuild.mjs -version");
        expect(commandLog).toContain("wsb.mjs --help");
        expect(commandLog).toContain("tart.mjs --version");
        expect(commandLog).toContain("ssh.mjs -V");
        expect(commandLog).not.toMatch(/\b(start|run|launch|boot|delete|stop|shutdown)\b/);
    });

    it("passes macOS VM smoke when Tart is the only installed VM provider", () => {
        const cwd = "/project/admin-smoke-tart-provider-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "tart", "console.log(\"tart 2.24.0\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "ssh", "console.log(\"OpenSSH\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "scp", "console.log(\"scp\"); process.exit(0);");

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

        expect(smoke).toContain("macos-vm: PASS - real provider macOS VM CLI and SSH bridge responded; SCP bridge tool found; no VM started");
        expect(smoke).toContain(`${join(binDir, "tart.mjs")} --version -> 0`);
        expect(smoke).not.toContain("missing tart, vz, utmctl");
    });

    it("reports missing macOS SSH/SCP bridge tools in real provider smoke without starting VMs", () => {
        const cwd = "/project/admin-smoke-real-provider-macos-bridge-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "tart", "console.log(\"tart-ok\"); process.exit(0);");

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

        expect(smoke).toContain("macos-vm: SKIP - missing ssh, scp");
        expect(smoke).toContain(`${join(binDir, "tart.mjs")} --version -> 0`);
        expect(smoke).not.toMatch(/\b(tart|vz|utmctl) (start|run|launch|boot|delete|stop|shutdown)\b/);
    });

    it("treats xcrun developer-tool lookup failures as skipped iOS prerequisites", () => {
        const cwd = "/project/admin-smoke-real-provider-ios-xcrun-missing-tool-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "xcrun", `if (['simctl', 'xctrace'].includes(args[0])) { console.error('xcrun: error: unable to find utility "' + args[0] + '", not a developer tool or in PATH'); process.exit(72); } console.log('ok');`);
        fixture.writeNodeTool(binDir, "xcodebuild", "console.log(\"Xcode\"); process.exit(0);");

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

        expect(smoke).toContain("ios-simulator: SKIP - missing simctl");
        expect(smoke).toContain("ios-device: SKIP - missing xctrace");
        expect(smoke).not.toContain("ios-simulator: FAIL");
        expect(smoke).not.toContain("ios-device: FAIL");
    });

    it("treats Android emulator inventory timeouts as skipped readiness", () => {
        const cwd = "/project/admin-smoke-real-provider-android-emulator-timeout-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "adb", "console.log(\"Android Debug Bridge version 1.0.41\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "emulator", "setTimeout(() => {}, 1000);");

        // Exercise timeout classification, without racing Node startup against
        // a 50ms deadline on busy Windows hosts. Other probes still execute.
        const routedSpawn = vi.mocked(childProcess.spawnSync).getMockImplementation()!;
        vi.mocked(childProcess.spawnSync).mockImplementation(((command: string, args: string[] = [], options: childProcess.SpawnSyncOptions = {}) => {
            if (command === join(binDir, "emulator.mjs") && args[0] === "-list-avds") {
                const error = Object.assign(new Error("emulator inventory timed out"), { code: "ETIMEDOUT" });
                return { status: null, signal: "SIGTERM", pid: 0, stdout: "", stderr: "", output: [null, "", ""], error };
            }
            return routedSpawn(command, args, options);
        }) as typeof childProcess.spawnSync);
        const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

        expect(smoke).toContain("android-emulator: SKIP - emulator inventory timed out");
        expect(smoke).toContain(`${join(binDir, "emulator.mjs")} -list-avds -> unknown`);
        expect(smoke).not.toContain("android-emulator: FAIL");
    });

    it.each([
        { presentTool: "ssh", missingDetail: "missing scp" },
        { presentTool: "scp", missingDetail: "missing ssh" },
    ])("reports missing macOS $missingDetail bridge tool in real provider smoke", ({ presentTool, missingDetail }) => {
        const cwd = `/project/admin-smoke-real-provider-macos-${presentTool}-only-test`;
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "tart", "console.log(\"tart-ok\"); process.exit(0);");
        fixture.writeNodeTool(binDir, presentTool, "console.log(\"bridge-ok\"); process.exit(0);");

        const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

        expect(smoke).toContain(`macos-vm: SKIP - ${missingDetail}`);
        expect(smoke).toContain(`${join(binDir, "tart.mjs")} --version -> 0`);
        expect(smoke).not.toMatch(/\b(tart|vz|utmctl) (start|run|launch|boot|delete|stop|shutdown)\b/);
    });

    it.each([
        ["--timeout-ms=123"],
        ["--timeout-ms", "123"],
    ])("routes opt-in real provider smoke through the CLI with bounded timeout parsing: %j", (...timeoutArgs) => {
        const cwd = "/project/admin-smoke-real-cli-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "adb", "console.log(\"ok\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "emulator", "console.log(\"ok\"); process.exit(0);");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        // Verify the parsed budget at the process boundary without making Node
        // fixture startup race a 123ms deadline. Real children run in other cases.
        const routedSpawn = vi.mocked(childProcess.spawnSync).getMockImplementation()!;
        const readiness = [
            [join(binDir, "adb.mjs"), ["version"]],
            [join(binDir, "emulator.mjs"), ["-list-avds"]],
            [join(binDir, "adb.mjs"), ["devices", "-l"]],
        ] as const;
        vi.mocked(childProcess.spawnSync).mockImplementation(((command: string, args: string[] = [], options: childProcess.SpawnSyncOptions = {}) => {
            if (readiness.some(([tool, expectedArgs]) => command === tool && JSON.stringify(args) === JSON.stringify(expectedArgs))) {
                return { status: 0, signal: null, pid: 0, stdout: "ok\n", stderr: "", output: [null, "ok\n", ""] };
            }
            return routedSpawn(command, args, options);
        }) as typeof childProcess.spawnSync);
        const exitCode = devicesCli(["smoke", "--real-lab", ...timeoutArgs], cwd);

        for (const [command, args] of readiness) {
            expect(childProcess.spawnSync).toHaveBeenCalledWith(command, args, expect.objectContaining({ timeout: 123 }));
        }

        expect(exitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("mode: real-provider (explicit opt-in)"));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("android-emulator: PASS - real provider adb/emulator readiness responded; no emulator started"));
    });

    it.each([
        ["--timeout-ms", "0"],
        ["--timeout-ms", "600001"],
        ["--timeout-ms", "1.5"],
        ["--timeout-ms", "Infinity"],
        ["--timeout-ms"],
        ["--timeout-ms=NaN"],
        ["--unknown"],
    ])("rejects invalid smoke flags without running host tools: %j", (...args) => {
        const cwd = "/project/admin-smoke-invalid-flag-test";
        fixture.setupFixture(cwd);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const spawn = vi.spyOn(childProcess, "spawnSync");
        spawn.mockClear();

        const exitCode = devicesCli(["smoke", ...args], cwd);

        expect(exitCode).toBe(1);
        expect(error).toHaveBeenCalledWith("Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]");
        expect(spawn).not.toHaveBeenCalled();
    });

    it("reports smoke PASS and FAIL from fake non-destructive host commands", () => {
        const cwd = "/project/admin-smoke-fake-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "adb", "console.log(\"adb-version\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "emulator", "console.log(\"avd-one\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "xcrun", "console.log(\"{\\\"devices\\\":{}}\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "xcodebuild", "console.log(\"Xcode\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "wsb", "console.log(\"wsb-help\"); process.exit(0);");
        fixture.writeNodeTool(binDir, "tart", "console.error(\"tart-version\"); process.exit(7);");

        const smoke = formatDevicesSmoke(cwd);

        expect(smoke).toContain("android-emulator: PASS - adb and emulator responded");
        expect(smoke).toContain("android-device: PASS - adb physical-device inventory responded");
        expect(smoke).toContain(`${join(binDir, "adb.mjs")} version -> 0`);
        expect(smoke).toContain(`${join(binDir, "emulator.mjs")} -list-avds -> 0`);
        expect(smoke).toContain("ios-simulator: PASS - xcrun simctl inventory responded");
        expect(smoke).toContain("ios-device: PASS - xcrun xctrace physical-device inventory responded");
        expect(smoke).toContain("windows-sandbox: PASS - wsb CLI responded");
        expect(smoke).toContain("macos-vm: FAIL - tart-version");
        expect(smoke).toContain(`${join(binDir, "tart.mjs")} --version -> 7`);
    });

    it("bounds smoke host command execution with a timeout", () => {
        const cwd = "/project/admin-smoke-timeout-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "adb", "setTimeout(() => {}, 1000);");
        fixture.writeNodeTool(binDir, "emulator", "console.log(\"avd-one\"); process.exit(0);");

        const smoke = formatDevicesSmoke(cwd, 50);

        expect(smoke).toContain("android-emulator: FAIL -");
        expect(smoke).toContain(`${join(binDir, "adb.mjs")} version -> unknown`);
        expect(smoke).toMatch(/ETIMEDOUT|timed out|Timeout/i);
    });

    it.each([
        ["android-device", "CCC_REAL_ANDROID_DEVICE_SERIAL", "R5CREAL123"],
        ["ios-device", "CCC_REAL_IOS_DEVICE_UDID", "REAL-IOS-UDID"],
    ])("fails unavailable inventory for an explicit %s target without changing its definition", (backend, targetVariable, target) => {
        const cwd = "/project/admin-smoke-explicit-inventory-failure";
        const files = fixture.setupFixture(cwd);
        const definition = backend === "android-device" ? files.androidDeviceFile : files.iosDeviceFile;
        const before = readFileSync(definition, "utf8");
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeNodeTool(binDir, "adb", "if (args[0] === 'devices') { console.error('inventory unavailable'); process.exit(70); } console.log('ok');");
        fixture.writeNodeTool(binDir, "xcrun", "if (args[0] === 'xctrace') { console.error('inventory unavailable'); process.exit(71); } console.log('ok');");
        const previous = process.env[targetVariable];
        try {
            process.env[targetVariable] = target;
            const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });
            expect(smoke).toContain(`${backend}: FAIL -`);
            expect(smoke).not.toContain(`${backend}: SKIP - physical-device inventory unavailable`);
            expect(readFileSync(definition, "utf8")).toBe(before);
        } finally {
            if (previous === undefined) delete process.env[targetVariable];
            else process.env[targetVariable] = previous;
        }
    });

    it("treats unavailable optional physical-device inventory as skipped without explicit device targets", () => {
        const cwd = "/project/admin-smoke-real-provider-physical-inventory-unavailable-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        const oldAndroidDeviceSerial = process.env.CCC_REAL_ANDROID_DEVICE_SERIAL;
        const oldAndroidSerial = process.env.CCC_REAL_ANDROID_SERIAL;
        const oldIosUdid = process.env.CCC_REAL_IOS_DEVICE_UDID;
        fixture.writeNodeTool(binDir, "adb", `if (args[0] === 'devices') { console.error('adb inventory unavailable'); process.exit(70); } console.log('ok');`);
        fixture.writeNodeTool(binDir, "xcrun", `if (args[0] === 'xctrace') { console.error('xctrace inventory unavailable'); process.exit(71); } console.log('ok');`);
        try {
            delete process.env.CCC_REAL_ANDROID_DEVICE_SERIAL;
            delete process.env.CCC_REAL_ANDROID_SERIAL;
            delete process.env.CCC_REAL_IOS_DEVICE_UDID;

            const smoke = formatDevicesSmoke(cwd, 5000, undefined, { mode: "real-provider" });

            expect(smoke).toContain("android-device: SKIP - physical-device inventory unavailable without an explicit leased device target");
            expect(smoke).toContain("ios-device: SKIP - physical-device inventory unavailable without an explicit leased device target");
            expect(smoke).not.toContain("android-device: FAIL");
            expect(smoke).not.toContain("ios-device: FAIL");
        } finally {
            if (oldAndroidDeviceSerial === undefined) delete process.env.CCC_REAL_ANDROID_DEVICE_SERIAL;
            else process.env.CCC_REAL_ANDROID_DEVICE_SERIAL = oldAndroidDeviceSerial;
            if (oldAndroidSerial === undefined) delete process.env.CCC_REAL_ANDROID_SERIAL;
            else process.env.CCC_REAL_ANDROID_SERIAL = oldAndroidSerial;
            if (oldIosUdid === undefined) delete process.env.CCC_REAL_IOS_DEVICE_UDID;
            else process.env.CCC_REAL_IOS_DEVICE_UDID = oldIosUdid;
        }
    });
});
