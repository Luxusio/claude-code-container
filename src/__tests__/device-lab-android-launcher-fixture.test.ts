import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { androidWindowsHiddenLauncherScript } from "@ccc/device-lab/providers/backends/android.mjs";
import { fakeAndroidLauncherPreloadSource } from "./helpers/fake-android-provider-script.js";
import { nodeProviderFixturePreloadSource } from "./helpers/node-provider-fixture.js";

it("routes the generated Windows Android launcher to the exact fake emulator with intact arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-android-launcher-fixture-"));
    const bin = join(root, "SDK with spaces");
    mkdirSync(bin);
    const emulator = join(bin, "emulator");
    const preload = join(root, "routing.cjs");
    const launcher = join(root, "launcher.vbs");
    const args = ["-avd", "Pixel 8", "-port", "5582", "-netsim-args", "--no-cli-ui --no-web-ui"];
    writeFileSync(emulator, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`);
    writeFileSync(preload, nodeProviderFixturePreloadSource(bin) + fakeAndroidLauncherPreloadSource(bin));
    const launch = () => spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", `
        import { spawn } from 'node:child_process';
        const child = spawn('wscript.exe', ['//B', ${JSON.stringify(launcher)}], { stdio: 'inherit' });
        child.on('error', error => { console.error(error); process.exitCode = 1; });
        child.on('exit', code => { process.exitCode = code; });
    `], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: "" } });
    try {
        writeFileSync(launcher, androidWindowsHiddenLauncherScript(emulator, args));
        const result = launch();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(args);
        writeFileSync(launcher, androidWindowsHiddenLauncherScript(join(root, "foreign"), args));
        const refused = launch();
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain("foreign fake Android launcher");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it("models only the Windows AVD liveness query and leaves unrelated PowerShell commands untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-android-probe-fixture-"));
    const preload = join(root, "routing.cjs");
    const powershell = join(root, "powershell.exe");
    writeFileSync(powershell, `#!${process.execPath}\nprocess.exit(23);`);
    writeFileSync(preload, nodeProviderFixturePreloadSource(root) + fakeAndroidLauncherPreloadSource(root, powershell));
    try {
        const result = spawnSync(process.execPath, ["--require", preload, "-e", `
            const { spawnSync } = require('node:child_process');
            const query = "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(emulator|qemu-system-.*)\\\\.exe$' } | ForEach-Object { if ([string]::IsNullOrWhiteSpace([string]$_.CommandLine)) { throw 'android-emulator-process-command-unavailable' }; [string]$_.CommandLine }";
            const observed = spawnSync(${JSON.stringify(powershell)}, ['-WindowStyle', 'Hidden', '-NoProfile', '-NonInteractive', '-Command', query]);
            const unrelated = spawnSync(${JSON.stringify(powershell)}, ['-NoProfile', '-NonInteractive', '-Command', 'exit 23']);
            console.log(JSON.stringify({ observed: { status: observed.status, stdout: String(observed.stdout) }, unrelated: unrelated.status }));
        `], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: root, FAKE_ANDROID_LOG: join(root, "fixture.log") } });
        expect(result.status, result.stderr).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.observed).toEqual({ status: 0, stdout: "" });
        expect(parsed.unrelated).toBe(23);
    } finally { rmSync(root, { recursive: true, force: true }); }
});


it("deletes an owned AVD through the actual Windows provider command wrapper", { timeout: 30000 }, async () => {
    const { createFakeAndroidMcpContext, cleanupFakeAndroidMcpContext } = await import("./helpers/fake-android-mcp-fixture.js");
    const context = await createFakeAndroidMcpContext({ platform: "win32" });
    const call = async (name: string, args: Record<string, unknown>) => {
        const result = await context.client.callTool({ name, arguments: args });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    try {
        const choices = await call("devices", { view: "available", backend: "android-emulator" });
        const created = await call("create_android_emulator", {
            name: "Windows AVD Probe",
            avdName: `ccc-${choices.ownerId}-windows-probe`,
            systemImage: choices.systemImages[0], deviceProfile: choices.deviceProfiles[0],
        });
        await call("delete", { deviceId: created.device.deviceId, confirmDestructive: true });
    } finally { await cleanupFakeAndroidMcpContext(context); }
});
