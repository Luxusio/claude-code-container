import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    devicesCli,
    formatDevicesSmoke,
} from "../device-lab-admin.js";
import { createDeviceLabAdminTestFixture } from "./helpers/device-lab-admin-fixture.js";

describe("device-lab admin smoke diagnostics", () => {
    const fixture = createDeviceLabAdminTestFixture();

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

        const smoke = formatDevicesSmoke(cwd, 250, undefined, {
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

        const smoke = formatDevicesSmoke(cwd, 250, undefined, {
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
        const recorder = `printf '%s %s\\n' "$0" "$*" >> "${logPath}"; echo ok; exit 0`;
        fixture.writeTool(binDir, "adb", recorder);
        fixture.writeTool(binDir, "emulator", recorder);
        fixture.writeTool(binDir, "xcrun", recorder);
        fixture.writeTool(binDir, "xcodebuild", recorder);
        fixture.writeTool(binDir, "wsb", recorder);
        fixture.writeTool(binDir, "tart", recorder);
        fixture.writeTool(binDir, "ssh", recorder);
        fixture.writeTool(binDir, "scp", recorder);

        const smoke = formatDevicesSmoke(cwd, 250, undefined, { mode: "real-provider" });

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
        expect(smoke).toContain(`${join(binDir, "scp")} path-check -> 0`);
        const commandLog = readFileSync(logPath, "utf-8");
        expect(commandLog).toContain("adb version");
        expect(commandLog).toContain("emulator -list-avds");
        expect(commandLog).toContain("xcrun simctl list -j");
        expect(commandLog).toContain("xcrun xctrace list devices");
        expect(commandLog).not.toContain("xcodebuild -version");
        expect(commandLog).toContain("wsb --help");
        expect(commandLog).toContain("tart --version");
        expect(commandLog).toContain("ssh -V");
        expect(commandLog).not.toMatch(/\b(start|run|launch|boot|delete|stop|shutdown)\b/);
    });

    it("passes macOS VM smoke when Tart is the only installed VM provider", () => {
        const cwd = "/project/admin-smoke-tart-provider-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "tart", "echo tart 2.24.0; exit 0");
        fixture.writeTool(binDir, "ssh", "echo OpenSSH; exit 0");
        fixture.writeTool(binDir, "scp", "echo scp; exit 0");

        const smoke = formatDevicesSmoke(cwd, 250, undefined, { mode: "real-provider" });

        expect(smoke).toContain("macos-vm: PASS - real provider macOS VM CLI and SSH bridge responded; SCP bridge tool found; no VM started");
        expect(smoke).toContain(`${join(binDir, "tart")} --version -> 0`);
        expect(smoke).not.toContain("missing tart, vz, utmctl");
    });

    it("reports missing macOS SSH/SCP bridge tools in real provider smoke without starting VMs", () => {
        const cwd = "/project/admin-smoke-real-provider-macos-bridge-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "tart", "echo tart-ok; exit 0");

        const smoke = formatDevicesSmoke(cwd, 250, undefined, { mode: "real-provider" });

        expect(smoke).toContain("macos-vm: SKIP - missing ssh, scp");
        expect(smoke).toContain(`${join(binDir, "tart")} --version -> 0`);
        expect(smoke).not.toMatch(/\b(tart|vz|utmctl) (start|run|launch|boot|delete|stop|shutdown)\b/);
    });

    it("treats xcrun developer-tool lookup failures as skipped iOS prerequisites", () => {
        const cwd = "/project/admin-smoke-real-provider-ios-xcrun-missing-tool-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "xcrun", `case "$1" in
  simctl) echo 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH' >&2; exit 72 ;;
  xctrace) echo 'xcrun: error: unable to find utility "xctrace", not a developer tool or in PATH' >&2; exit 72 ;;
  *) echo ok; exit 0 ;;
esac`);
        fixture.writeTool(binDir, "xcodebuild", "echo Xcode; exit 0");

        const smoke = formatDevicesSmoke(cwd, 250, undefined, { mode: "real-provider" });

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
        fixture.writeTool(binDir, "adb", "echo Android Debug Bridge version 1.0.41; exit 0");
        fixture.writeTool(binDir, "emulator", `"${process.execPath}" -e 'setTimeout(() => {}, 1000)'`);

        const smoke = formatDevicesSmoke(cwd, 50, undefined, { mode: "real-provider" });

        expect(smoke).toContain("android-emulator: SKIP - emulator inventory timed out");
        expect(smoke).toContain(`${join(binDir, "emulator")} -list-avds -> unknown`);
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
        fixture.writeTool(binDir, "tart", "echo tart-ok; exit 0");
        fixture.writeTool(binDir, presentTool, "echo bridge-ok; exit 0");

        const smoke = formatDevicesSmoke(cwd, 250, undefined, { mode: "real-provider" });

        expect(smoke).toContain(`macos-vm: SKIP - ${missingDetail}`);
        expect(smoke).toContain(`${join(binDir, "tart")} --version -> 0`);
        expect(smoke).not.toMatch(/\b(tart|vz|utmctl) (start|run|launch|boot|delete|stop|shutdown)\b/);
    });

    it("routes opt-in real provider smoke through the CLI with bounded timeout parsing", () => {
        const cwd = "/project/admin-smoke-real-cli-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo ok; exit 0");
        fixture.writeTool(binDir, "emulator", "echo ok; exit 0");
        const log = vi.spyOn(console, "log").mockImplementation(() => {});

        const exitCode = devicesCli(["smoke", "--real-lab", "--timeout-ms=123"], cwd);

        expect(exitCode).toBe(0);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("mode: real-provider (explicit opt-in)"));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("android-emulator: PASS - real provider adb/emulator readiness responded; no emulator started"));
    });

    it("rejects invalid smoke flags without running host tools", () => {
        const cwd = "/project/admin-smoke-invalid-flag-test";
        fixture.setupFixture(cwd);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        const exitCode = devicesCli(["smoke", "--timeout-ms", "0"], cwd);

        expect(exitCode).toBe(1);
        expect(error).toHaveBeenCalledWith("Usage: ccc devices smoke [--real-provider|--real-lab] [--timeout-ms 1..600000]");
    });

    it("reports smoke PASS and FAIL from fake non-destructive host commands", () => {
        const cwd = "/project/admin-smoke-fake-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", "echo adb-version; exit 0");
        fixture.writeTool(binDir, "emulator", "echo avd-one; exit 0");
        fixture.writeTool(binDir, "xcrun", "echo '{\"devices\":{}}'; exit 0");
        fixture.writeTool(binDir, "xcodebuild", "echo Xcode; exit 0");
        fixture.writeTool(binDir, "wsb", "echo wsb-help; exit 0");
        fixture.writeTool(binDir, "tart", "echo tart-version >&2; exit 7");

        const smoke = formatDevicesSmoke(cwd);

        expect(smoke).toContain("android-emulator: PASS - adb and emulator responded");
        expect(smoke).toContain("android-device: PASS - adb physical-device inventory responded");
        expect(smoke).toContain(`${join(binDir, "adb")} version -> 0`);
        expect(smoke).toContain(`${join(binDir, "emulator")} -list-avds -> 0`);
        expect(smoke).toContain("ios-simulator: PASS - xcrun simctl inventory responded");
        expect(smoke).toContain("ios-device: PASS - xcrun xctrace physical-device inventory responded");
        expect(smoke).toContain("windows-sandbox: PASS - wsb CLI responded");
        expect(smoke).toContain("macos-vm: FAIL - tart-version");
        expect(smoke).toContain(`${join(binDir, "tart")} --version -> 7`);
    });

    it("bounds smoke host command execution with a timeout", () => {
        const cwd = "/project/admin-smoke-timeout-test";
        fixture.setupFixture(cwd);
        const binDir = join(fixture.homeDir, "bin");
        mkdirSync(binDir, { recursive: true });
        process.env.PATH = binDir;
        fixture.writeTool(binDir, "adb", `"${process.execPath}" -e 'setTimeout(() => {}, 1000)'`);
        fixture.writeTool(binDir, "emulator", "echo avd-one; exit 0");

        const smoke = formatDevicesSmoke(cwd, 50);

        expect(smoke).toContain("android-emulator: FAIL -");
        expect(smoke).toContain(`${join(binDir, "adb")} version -> unknown`);
        expect(smoke).toMatch(/ETIMEDOUT|timed out|Timeout/i);
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
        fixture.writeTool(binDir, "adb", `case "$1" in
  devices) echo 'adb inventory unavailable' >&2; exit 70 ;;
  *) echo ok; exit 0 ;;
esac`);
        fixture.writeTool(binDir, "xcrun", `case "$1" in
  xctrace) echo 'xctrace inventory unavailable' >&2; exit 71 ;;
  *) echo ok; exit 0 ;;
esac`);
        try {
            delete process.env.CCC_REAL_ANDROID_DEVICE_SERIAL;
            delete process.env.CCC_REAL_ANDROID_SERIAL;
            delete process.env.CCC_REAL_IOS_DEVICE_UDID;

            const smoke = formatDevicesSmoke(cwd, 250, undefined, { mode: "real-provider" });

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
