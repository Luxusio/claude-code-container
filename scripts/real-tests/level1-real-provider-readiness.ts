import assert from "assert";
import { deviceLabSmoke } from "../../dist/device-lab-admin.js";
import { commandPath } from "./helpers.ts";
import { parseToolPayload, parseToolResult, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { aggregateStepResult } from "./result-status.ts";

const lifecycleCommandPattern = /\b(start|run|launch|boot|delete|stop|shutdown)\b/i;
const expectedBackends = [
    { backend: "android-emulator", label: "Android emulator readiness" },
    { backend: "android-device", label: "Android physical device readiness" },
    { backend: "ios-simulator", label: "iOS Simulator readiness" },
    { backend: "ios-device", label: "iOS physical device readiness" },
    { backend: "windows-sandbox", label: "Windows Sandbox readiness" },
    { backend: "macos-vm", label: "macOS VM readiness" },
];

export const name = "level 1 real-provider readiness";

function commandArgsText(command) {
    const firstSpace = command.indexOf(" ");
    return firstSpace === -1 ? "" : command.slice(firstSpace + 1);
}

export async function runRealProviderReadiness(options: any = {}) {
    const smoke = deviceLabSmoke(process.cwd(), 5000, undefined, { mode: "real-provider" });
    assert.strictEqual(smoke.mode, "real-provider");
    assert.deepStrictEqual(smoke.results.map((result) => result.backend).sort(), expectedBackends.map((item) => item.backend).sort());
    const steps = expectedBackends.map((item) => {
        const result = smoke.results.find((candidate) => candidate.backend === item.backend);
        if (!result) return { name: item.label, status: "FAIL", reason: "missing readiness result" };
        if (result.status === "SKIP") return { name: item.label, status: "SKIP", reason: result.detail };
        if (result.status === "FAIL") return { name: item.label, status: "FAIL", reason: result.detail };
        for (const command of result.commands || []) {
            assert.strictEqual(lifecycleCommandPattern.test(commandArgsText(command.command)), false, command.command);
        }
        return { name: item.label, status: "PASS" };
    });

    await withDeviceLabMcp(async ({ callTool }) => {
        const androidWirelessResult = await callTool("device_wireless", {
            backend: "android-device",
            action: "status",
            timeoutMs: 5000,
        });
        const androidWireless = parseToolResult(androidWirelessResult, { expectedError: androidWirelessResult?.isError === true });
        if (androidWireless.ok === true) {
            assert.strictEqual(androidWireless.ok, true, JSON.stringify(androidWireless));
            assert.strictEqual(androidWireless.provider, "adb", JSON.stringify(androidWireless));
            steps.push({ name: "Android physical wireless status MCP", status: "PASS" });

            const missingSerial = parseToolResult(await callTool("device_wireless", {
                backend: "android-device",
                action: "usb-tcpip",
                timeoutMs: 5000,
            }), { expectedError: true });
            assert.strictEqual(missingSerial.error, "android-wireless-usb-tcpip-requires-serial", JSON.stringify(missingSerial));

            const missingPairTarget = parseToolResult(await callTool("device_wireless", {
                backend: "android-device",
                action: "pair",
                timeoutMs: 5000,
            }), { expectedError: true });
            assert.strictEqual(missingPairTarget.error, "android-wireless-pair-requires-host-port-code", JSON.stringify(missingPairTarget));

            const missingConnectTarget = parseToolResult(await callTool("device_wireless", {
                backend: "android-device",
                action: "connect",
                timeoutMs: 5000,
            }), { expectedError: true });
            assert.strictEqual(missingConnectTarget.error, "android-wireless-connect-requires-host", JSON.stringify(missingConnectTarget));
            steps.push({ name: "Android physical wireless action diagnostics MCP", status: "PASS" });
        } else {
            assert.strictEqual(androidWireless.error, "android-wireless-missing-adb", JSON.stringify(androidWireless));
            assert.deepStrictEqual(androidWireless.missing, ["adb"], JSON.stringify(androidWireless));
            for (const action of ["usb-tcpip", "pair", "connect"]) {
                const missingAdb = parseToolResult(await callTool("device_wireless", {
                    backend: "android-device",
                    action,
                    timeoutMs: 5000,
                }), { expectedError: true });
                assert.strictEqual(missingAdb.error, "android-wireless-missing-adb", JSON.stringify(missingAdb));
                assert.deepStrictEqual(missingAdb.missing, ["adb"], JSON.stringify(missingAdb));
            }
            steps.push({ name: "Android physical wireless status MCP", status: "SKIP", reason: "missing adb" });
            steps.push({ name: "Android physical wireless action diagnostics MCP", status: "PASS" });
        }

        if (process.platform === "darwin" && commandPath("xcrun")) {
            const iosWireless = parseToolPayload(await callTool("device_wireless", {
                backend: "ios-device",
                action: "status",
            }));
            assert.strictEqual(iosWireless.ok, true, JSON.stringify(iosWireless));
            assert.strictEqual(iosWireless.provider, "xcrun-xctrace", JSON.stringify(iosWireless));
            steps.push({ name: "iOS physical wireless status MCP", status: "PASS" });
        } else {
            steps.push({
                name: "iOS physical wireless status MCP",
                status: "SKIP",
                reason: process.platform === "darwin" ? "missing xcrun" : "not a macOS host",
            });
        }

        for (const action of ["pair", "connect"]) {
            const iosWirelessDiagnostic = parseToolResult(await callTool("device_wireless", {
                backend: "ios-device",
                action,
            }), { expectedError: true });
            assert.ok(
                ["ios-wireless-missing-xcrun", "ios-wireless-pairing-requires-xcode-trust"].includes(iosWirelessDiagnostic.error),
                JSON.stringify(iosWirelessDiagnostic),
            );
            assert.strictEqual(iosWirelessDiagnostic.ok, false, JSON.stringify(iosWirelessDiagnostic));
        }
        steps.push({ name: "iOS physical wireless action diagnostics MCP", status: "PASS" });
    }, providerMcpSessionOptions(options, "ccc-real-provider-readiness"));

    return { ...aggregateStepResult(steps), steps };
}

export async function run() {
    return runRealProviderReadiness();
}
