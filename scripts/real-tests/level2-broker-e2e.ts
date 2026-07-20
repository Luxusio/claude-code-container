import assert from "assert";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { freePort, localCccPathEnv } from "./helpers.ts";
import { markExpectedFlowStepErrors, markExpectedToolError, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { installedMcpSmokeSample } from "./installed-mcp-smoke.ts";
import { aggregateStepResult } from "./result-status.ts";

export const name = "level 2 host broker MCP E2E";

const expectedBackends = [
    "android-emulator",
    "android-device",
    "ios-simulator",
    "ios-device",
    "windows-sandbox",
    "macos-vm",
];
const scriptedArgumentFacets = [
    "device_delete:confirmDestructive=true",
    "device_launch_app:bundleId=com.example.missing",
    "device_launch_app:component=com.example.missing/.MainActivity",
    "device_launch_app:packageName=com.example.missing",
    "device_reset:confirmDestructive=true",
    "device_reset:bundleId=com.example.missing",
    "device_reset:eraseSimulator=true",
    "device_reset:packageName=com.example.missing",
    "device_snapshot_delete:confirmDestructive=true",
    "device_snapshot_delete:snapshotId=missing-snapshot-id",
    "device_snapshot_delete:snapshotName=missing",
    "device_snapshot_restore:confirmDestructive=true",
    "device_snapshot_restore:snapshotId=missing-snapshot-id",
    "device_snapshot_restore:snapshotName=missing",
    "mobile_clear_app_data:confirmDestructive=true",
    "mobile_clear_app_data:bundleId=com.example.missing",
    "mobile_clear_app_data:packageName=com.example.missing",
    "mobile_grant_permission:bundleId=com.example.missing",
    "mobile_grant_permission:packageName=com.example.missing",
    "mobile_grant_permission:permission=android.permission.CAMERA",
    "mobile_grant_permission:service=camera",
    "mobile_launch_app:bundleId=com.example.missing",
    "mobile_launch_app:component=com.example.missing/.MainActivity",
    "mobile_launch_app:packageName=com.example.missing",
    "mobile_set_orientation:orientation=landscape",
    "mobile_set_orientation:orientation=portrait",
    "mobile_set_orientation:orientation=reverse-landscape",
    "mobile_set_orientation:orientation=reverse-portrait",
    "mobile_set_battery:confirmDestructive=true",
    "mobile_set_battery:charging=true",
    "mobile_set_battery:level=50",
    "mobile_set_battery:status=2",
    "mobile_set_network:data=true",
    "mobile_set_network:confirmDestructive=true",
    "mobile_set_network:wifi=true",
    "mobile_toggle_airplane_mode:confirmDestructive=true",
    "mobile_toggle_airplane_mode:enabled=false",
    "mobile_uninstall_app:confirmDestructive=true",
    "mobile_uninstall_app:bundleId=com.example.missing",
    "mobile_uninstall_app:packageName=com.example.missing",
    "mobile_revoke_permission:bundleId=com.example.missing",
    "mobile_revoke_permission:packageName=com.example.missing",
    "mobile_revoke_permission:permission=android.permission.CAMERA",
    "mobile_revoke_permission:service=camera",
    "mobile_stop_app:bundleId=com.example.missing",
    "mobile_stop_app:packageName=com.example.missing",
    "mobile_wait_for_app:bundleId=com.example.missing",
    "mobile_wait_for_app:packageName=com.example.missing",
];
const scriptedTools = new Set();

function scriptedToolCases(cases) {
    for (const [tool] of cases) scriptedTools.add(tool);
    return cases;
}

function failStep(name, error) {
    const message = String(error?.message || error || "unknown error");
    const firstLine = message.split(/\r?\n/).find(Boolean) || message;
    try {
        const payload = JSON.parse(firstLine);
        const launch = payload?.launch || payload?.broker?.launch;
        const parts = [payload?.error || payload?.mode, launch?.detail, launch?.command].filter(Boolean);
        return { name, status: "FAIL", reason: parts.join(": ") || "broker operation failed" };
    } catch {
        const normalized = firstLine.replace(/\s+/g, " ").trim();
        return { name, status: "FAIL", reason: normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized };
    }
}

const PUBLIC_DEVICE_LIFECYCLE_TOOLS = new Set(["device_create", "device_start", "device_stop", "device_delete"]);
const PUBLIC_DEVICE_PHYSICAL_TOOLS = new Set(["device_attach", "device_detach"]);
const PUBLIC_DEVICE_READONLY_TOOLS = new Set([
    "device_record_video_status",
    "device_window_list",
    "device_accessibility_snapshot",
]);
const PUBLIC_MOBILE_DEVICE_BACKEND_TOOLS = new Set([
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_battery",
]);

function expectedPublicDeviceRoutedBy(tool) {
    if (PUBLIC_DEVICE_LIFECYCLE_TOOLS.has(tool)) return "device-lifecycle-broker";
    if (PUBLIC_DEVICE_PHYSICAL_TOOLS.has(tool)) return "device-physical-broker";
    if (PUBLIC_DEVICE_READONLY_TOOLS.has(tool)) return "device-readonly-broker";
    return "device-mutating-broker";
}

function expectedPublicMobileRoutedBy(tool) {
    if (tool === "mobile_session_status") return "";
    if (PUBLIC_MOBILE_DEVICE_BACKEND_TOOLS.has(tool)) return "mobile-device-broker";
    return "mobile-broker-appium";
}

function assertFailureDiagnostic(tool, diagnostic, expectedRoutedBy = "") {
    assert.ok(typeof diagnostic === "object" && diagnostic !== null, `${tool}: ${JSON.stringify(diagnostic)}`);
    assert.strictEqual(diagnostic.ok, false, `${tool} unexpectedly succeeded against fake device: ${JSON.stringify(diagnostic)}`);
    assert.strictEqual(typeof diagnostic.error, "string", `${tool} returned no structured error: ${JSON.stringify(diagnostic)}`);
    assert.ok(diagnostic.error.length > 0, `${tool} returned an empty structured error: ${JSON.stringify(diagnostic)}`);
    if (expectedRoutedBy) assert.strictEqual(diagnostic.routedBy, expectedRoutedBy, `${tool} routedBy mismatch: ${JSON.stringify(diagnostic)}`);
}

function brokerEnumSample(toolName, route, facetKey, facetValue, index) {
    const args = {
        ...installedMcpSmokeSample(toolName),
        ...route,
        [facetKey]: facetValue,
    };
    delete args.implicitBroker;

    if (toolName === "device_create") {
        args.name = `Level 2 enum ${facetKey} ${facetValue}`;
        args.deviceId = `level2-enum-${facetKey}-${facetValue}-${index}`;
        args.dryRun = true;
        if (facetKey === "provider") {
            args.backend = "macos-vm";
            args.provider = facetValue;
            args.image = "missing-image";
        }
    }
    if (toolName === "device_delete") args.confirmDestructive = true;
    if (toolName === "device_snapshot_restore" || toolName === "device_snapshot_delete") {
        args.confirmDestructive = true;
        args.snapshotName ||= "missing";
    }
    if (toolName === "device_reset") {
        args.confirmDestructive = true;
        args.packageName ||= "com.example.missing";
    }
    if (toolName.startsWith("mobile_") && /ios/.test(String(facetValue))) {
        if ("packageName" in args && !("bundleId" in args)) {
            delete args.packageName;
            args.bundleId = "com.example.missing";
        }
        if ("permission" in args && !("service" in args)) {
            delete args.permission;
            args.service = "camera";
        }
    }
    return args;
}

function backendProviderEnumDiagnostics(route) {
    const diagnostics = [];
    for (const tool of DEVICE_LAB_MCP_TOOLS) {
        const properties = tool.inputSchema?.properties || {};
        for (const facetKey of ["backend", "provider"]) {
            const enumValues = Array.isArray(properties[facetKey]?.enum) ? properties[facetKey].enum.map(String) : [];
            for (const facetValue of enumValues) {
                diagnostics.push([
                    tool.name,
                    brokerEnumSample(tool.name, route, facetKey, facetValue, diagnostics.length),
                    `${tool.name}:${facetKey}=${facetValue}`,
                ]);
            }
        }
    }
    return diagnostics;
}

function cleanupTestBrokerRuntime(pid, port, homeDir = homedir()) {
    const runtimeFile = join(homeDir, ".ccc/devices/broker/runtime.json");
    if (!Number.isInteger(pid) || !Number.isInteger(port) || !existsSync(runtimeFile)) return false;
    try {
        const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
        if (
            ["ccc-host", "device-lab-mcp"].includes(runtime?.managedBy)
            && Number(runtime.pid) === pid
            && Number(runtime.port) === port
        ) {
            unlinkSync(runtimeFile);
            return true;
        }
    } catch {
        return false;
    }
    return false;
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        if (state === "Z") return false;
    } catch {
        // Non-Linux hosts or already-exited processes fall through to kill(0).
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForPidExit(pid, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!pidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !pidAlive(pid);
}

async function stopWindowsTestBroker(pid, port, homeDir) {
    if (!pidAlive(pid)) return { exited: true, runtimeRemoved: cleanupTestBrokerRuntime(pid, port, homeDir), taskkillStatus: null };
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf-8",
        windowsHide: true,
    });
    const exited = await waitForPidExit(pid, 3000);
    const runtimeRemoved = cleanupTestBrokerRuntime(pid, port, homeDir);
    if (!exited) throw new Error(`test broker pid ${pid} survived taskkill: ${result.stderr || result.stdout || result.status}`);
    return { exited, runtimeRemoved, taskkillStatus: result.status };
}

export async function runBrokerE2E(options: any = {}) {
    const testHome = mkdtempSync(join(tmpdir(), "ccc-broker-e2e-home-"));
    const ccc = localCccPathEnv({
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
    });
    if (!ccc.ok) {
        rmSync(testHome, { recursive: true, force: true });
        return {
            status: "PASS",
            steps: [{
                name: "broker autolaunch prerequisite",
                status: "SKIP",
                reason: ccc.reason,
            }],
        };
    }

    const port = await freePort();
    const route = {
        autolaunch: true,
        port,
        hostCandidates: ["127.0.0.1"],
        timeoutMs: 1000,
        rpcTimeoutMs: 10000,
        launchTimeoutMs: 5000,
    };
    const publicRoute = {
        autolaunch: true,
        brokerPort: port,
        hostCandidates: ["127.0.0.1"],
        timeoutMs: 1000,
        rpcTimeoutMs: 10000,
        launchTimeoutMs: 5000,
    };
    // Public lifecycle tools reserve `port` for a device port and therefore
    // use brokerPort. Read-only broker discovery still consumes the broker
    // transport's `port` field directly.
    const publicReadRoute = { ...publicRoute, port };
    const steps = [];
    let mcpOwnedBrokerLaunched = false;
    let localBrokerPid = null;
    let preserveTestHome = false;
    const leaseHardwareId = `ccc-real-broker-e2e-${Date.now()}`;

    try {
        await withDeviceLabMcp(async ({ callTool }) => {
            let brokerReady = false;
            try {
                const status = parseToolPayload(await callTool("device_broker_status", { ...route, probe: true }));
                assert.strictEqual(status.available, true, JSON.stringify(status));
                assert.strictEqual(status.launch?.ok ?? true, true, JSON.stringify(status.launch));
                brokerReady = true;
                mcpOwnedBrokerLaunched = (process.platform === "win32" || ccc.source !== "local-dist")
                    && status.launch?.launched === true
                    && status.launch?.runtime?.managedBy === "device-lab-mcp";
                localBrokerPid = status.launch?.runtime?.pid || status.runtime?.pid || null;
                steps.push({
                    name: "autolaunch or reuse host broker",
                    status: "PASS",
                    detail: `owner=${status.ownerId || status.launch?.ownerId || "unknown"}`,
                });
            } catch (error) {
                steps.push(failStep("autolaunch or reuse host broker", error));
            }
            if (!brokerReady) return;

            try {
                const echo = parseToolPayload(await callTool("device_broker_rpc", {
                    ...route,
                    method: "broker.echo",
                    params: { source: "level2-broker-e2e" },
                }));
                assert.strictEqual(echo.ok, true, JSON.stringify(echo));
                assert.deepStrictEqual(echo.result?.params, { source: "level2-broker-e2e" });
                assert.ok(echo.result?.ownerId, JSON.stringify(echo.result));
                steps.push({ name: "broker RPC owner-authenticated echo", status: "PASS", detail: `owner=${echo.result.ownerId}` });
            } catch (error) {
                steps.push(failStep("broker RPC owner-authenticated echo", error));
            }

            try {
                const rpcStatus = parseToolPayload(await callTool("device_broker_rpc", {
                    ...route,
                    method: "broker.status",
                }));
                assert.strictEqual(rpcStatus.ok, true, JSON.stringify(rpcStatus));
                assert.strictEqual(rpcStatus.result?.mode, "host-broker-daemon", JSON.stringify(rpcStatus.result));
                assert.strictEqual(rpcStatus.result?.containerContract?.ownerResolution, "host-broker-resolve", JSON.stringify(rpcStatus.result?.containerContract));
                steps.push({ name: "broker RPC status", status: "PASS" });
            } catch (error) {
                steps.push(failStep("broker RPC status", error));
            }

            try {
                const rpcInventory = parseToolPayload(await callTool("device_broker_rpc", {
                    ...route,
                    method: "broker.inventory",
                }));
                assert.strictEqual(rpcInventory.ok, true, JSON.stringify(rpcInventory));
                assert.ok(rpcInventory.result?.ownerId, JSON.stringify(rpcInventory.result));
                assert.ok(Array.isArray(rpcInventory.result?.backends), JSON.stringify(rpcInventory.result));
                steps.push({ name: "broker RPC inventory", status: "PASS" });
            } catch (error) {
                steps.push(failStep("broker RPC inventory", error));
            }

            try {
                const leases = parseToolPayload(await callTool("device_broker_lease", {
                    ...route,
                    action: "list",
                    backend: "android-device",
                }));
                assert.notStrictEqual(leases.ok, false, JSON.stringify(leases));
                steps.push({ name: "broker lease list", status: "PASS" });
            } catch (error) {
                steps.push(failStep("broker lease list", error));
            }

            try {
                let leaseClaimed = false;
                try {
                    const claim = parseToolPayload(await callTool("device_broker_lease", {
                        ...route,
                        action: "claim",
                        backend: "android-device",
                        hardwareId: leaseHardwareId,
                        deviceId: "level2-broker-e2e-lease-device",
                        connection: "unknown",
                        ttlMs: 120000,
                        transport: { source: "level2-broker-e2e" },
                    }));
                    assert.strictEqual(claim.ok, true, JSON.stringify(claim));
                    assert.strictEqual(claim.result?.lease?.hardwareId, leaseHardwareId, JSON.stringify(claim.result));
                    leaseClaimed = true;

                    const heartbeat = parseToolPayload(await callTool("device_broker_lease", {
                        ...route,
                        action: "heartbeat",
                        backend: "android-device",
                        hardwareId: leaseHardwareId,
                        deviceId: "level2-broker-e2e-lease-device",
                        ttlMs: 120000,
                    }));
                    assert.strictEqual(heartbeat.ok, true, JSON.stringify(heartbeat));
                    assert.strictEqual(heartbeat.result?.heartbeat, true, JSON.stringify(heartbeat.result));

                    const listAfterClaim = parseToolPayload(await callTool("device_broker_lease", {
                        ...route,
                        action: "list",
                        backend: "android-device",
                    }));
                    assert.strictEqual(listAfterClaim.ok, true, JSON.stringify(listAfterClaim));
                    assert.ok((listAfterClaim.result?.leases || []).some((lease) => lease.hardwareId === leaseHardwareId), JSON.stringify(listAfterClaim.result));

                    const prune = parseToolPayload(await callTool("device_broker_lease", {
                        ...route,
                        action: "prune",
                        backend: "android-device",
                    }));
                    assert.strictEqual(prune.ok, true, JSON.stringify(prune));
                    assert.ok(Array.isArray(prune.result?.pruned), JSON.stringify(prune.result));

                    const release = parseToolPayload(await callTool("device_broker_lease", {
                        ...route,
                        action: "release",
                        backend: "android-device",
                        hardwareId: leaseHardwareId,
                    }));
                    assert.strictEqual(release.ok, true, JSON.stringify(release));
                    assert.strictEqual(release.result?.released, true, JSON.stringify(release.result));
                    leaseClaimed = false;
                    steps.push({ name: "broker lease claim heartbeat prune release", status: "PASS" });
                } finally {
                    if (leaseClaimed) {
                        try {
                            await callTool("device_broker_lease", {
                                ...route,
                                action: "release",
                                backend: "android-device",
                                hardwareId: leaseHardwareId,
                            });
                        } catch {
                            // Preserve primary failure.
                        }
                    }
                }
            } catch (error) {
                steps.push(failStep("broker lease claim heartbeat prune release", error));
            }

            try {
                const attached = parseToolPayload(await callTool("device_broker_attach", {
                    ...route,
                    action: "list",
                    backend: "android-device",
                }));
                assert.notStrictEqual(attached.ok, false, JSON.stringify(attached));
                steps.push({ name: "broker physical attach list", status: "PASS" });
            } catch (error) {
                steps.push(failStep("broker physical attach list", error));
            }

            try {
            const attachDiagnostic = parseToolPayload(await callTool("device_broker_attach", {
                ...route,
                action: "attach",
                backend: "android-device",
                name: "Level 2 Broker E2E Missing Android Device",
                deviceId: "level2-broker-e2e-missing-android-device",
                serial: "ccc-level2-definitely-missing-android-serial",
            }));
            assert.strictEqual(attachDiagnostic.ok, false, JSON.stringify(attachDiagnostic));
            assert.ok([
                "missing-android-serial",
                "adb-inventory-failed",
                "android-device-not-visible",
                "android-device-not-attachable",
                "service-manager-failed",
            ].includes(attachDiagnostic.error), JSON.stringify(attachDiagnostic));
            steps.push({ name: "broker physical attach missing-device diagnostic", status: "PASS", detail: attachDiagnostic.error });
        } catch (error) {
            steps.push(failStep("broker physical attach missing-device diagnostic", error));
        }

            try {
            const detachDiagnostic = parseToolPayload(await callTool("device_broker_attach", {
                ...route,
                action: "detach",
                backend: "android-device",
                deviceId: "level2-broker-e2e-missing-android-device",
            }));
            assert.strictEqual(detachDiagnostic.ok, false, JSON.stringify(detachDiagnostic));
            assert.strictEqual(detachDiagnostic.error, "owner-device-not-found", JSON.stringify(detachDiagnostic));
            steps.push({ name: "broker physical detach missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker physical detach missing-device diagnostic", error));
        }

            try {
            const apple = parseToolPayload(await callTool("device_broker_apple", {
                ...route,
                action: "status",
                backend: "ios-device",
            }));
            assert.ok(apple.result || apple.body?.result || apple.error, JSON.stringify(apple));
            steps.push({ name: "broker Apple trust status", status: "PASS", detail: apple.ok === false ? apple.error : "ok" });
        } catch (error) {
            steps.push(failStep("broker Apple trust status", error));
        }

            try {
            const applePair = parseToolPayload(await callTool("device_broker_apple", {
                ...route,
                action: "pair",
                backend: "ios-device",
                udid: "00000000-0000000000000000",
            }));
            assert.strictEqual(applePair.ok, false, JSON.stringify(applePair));
            assert.ok(["xctrace-inventory-failed", "ios-wireless-missing-xcrun", "ios-apple-pairing-manual-required"].includes(applePair.error), JSON.stringify(applePair));
            steps.push({ name: "broker Apple trust pair diagnostic", status: "PASS", detail: applePair.error });
        } catch (error) {
            steps.push(failStep("broker Apple trust pair diagnostic", error));
        }

            try {
            const appleConnect = parseToolPayload(await callTool("device_broker_apple", {
                ...route,
                action: "connect",
                backend: "ios-device",
                udid: "00000000-0000000000000000",
            }));
            assert.strictEqual(appleConnect.ok, false, JSON.stringify(appleConnect));
            assert.ok(["xctrace-inventory-failed", "ios-wireless-missing-xcrun", "ios-apple-pairing-manual-required"].includes(appleConnect.error), JSON.stringify(appleConnect));
            steps.push({ name: "broker Apple trust connect diagnostic", status: "PASS", detail: appleConnect.error });
        } catch (error) {
            steps.push(failStep("broker Apple trust connect diagnostic", error));
        }

            try {
            const appium = parseToolPayload(await callTool("device_broker_appium", {
                ...route,
                action: "status",
                backend: "android-emulator",
                deviceId: "level2-broker-e2e-appium-status",
            }));
            assert.ok(appium.result || appium.error === "owner-device-not-found", JSON.stringify(appium));
            steps.push({ name: "broker Appium status", status: "PASS", detail: appium.ok === false ? appium.error : "ok" });
        } catch (error) {
            steps.push(failStep("broker Appium status", error));
        }

            try {
            const appiumList = parseToolPayload(await callTool("device_broker_appium", {
                ...route,
                action: "list",
                backend: "android-emulator",
            }));
            assert.strictEqual(appiumList.ok, true, JSON.stringify(appiumList));
            assert.strictEqual(appiumList.result?.backend, "android-emulator", JSON.stringify(appiumList.result));
            assert.ok(Array.isArray(appiumList.result?.sessions), JSON.stringify(appiumList.result));
            steps.push({ name: "broker Appium session list", status: "PASS", detail: `sessions=${appiumList.result.sessions.length}` });
        } catch (error) {
            steps.push(failStep("broker Appium session list", error));
        }

            try {
            const appiumRecord = parseToolPayload(await callTool("device_broker_appium", {
                ...route,
                action: "record",
                backend: "android-emulator",
                deviceId: "level2-broker-e2e-appium-record",
                serverUrl: "http://127.0.0.1:4723",
                sessionId: "level2-broker-e2e-session",
                appiumPort: 4723,
                automationName: "UiAutomator2",
                provider: "appium",
            }));
            assert.strictEqual(appiumRecord.ok, false, JSON.stringify(appiumRecord));
            assert.strictEqual(appiumRecord.error, "owner-device-not-found", JSON.stringify(appiumRecord));
            steps.push({ name: "broker Appium record missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium record missing-device diagnostic", error));
        }

            try {
            const appiumClear = parseToolPayload(await callTool("device_broker_appium", {
                ...route,
                action: "clear",
                backend: "android-emulator",
                deviceId: "level2-broker-e2e-appium-record",
            }));
            assert.strictEqual(appiumClear.ok, false, JSON.stringify(appiumClear));
            assert.strictEqual(appiumClear.error, "owner-device-not-found", JSON.stringify(appiumClear));
            steps.push({ name: "broker Appium clear missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium clear missing-device diagnostic", error));
        }

            try {
            for (const action of ["start", "stop", "ensure-session", "delete-session"]) {
                const appiumDiagnostic = parseToolPayload(await callTool("device_broker_appium", {
                    ...route,
                    action,
                    backend: "android-emulator",
                    deviceId: `level2-broker-e2e-appium-${action}`,
                }));
                assert.strictEqual(appiumDiagnostic.ok, false, JSON.stringify(appiumDiagnostic));
                assert.strictEqual(appiumDiagnostic.error, "owner-device-not-found", JSON.stringify(appiumDiagnostic));
            }
            steps.push({ name: "broker Appium lifecycle/session missing-device diagnostics", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium lifecycle/session missing-device diagnostics", error));
        }

            try {
            for (const method of ["GET", "POST"]) {
                const appiumRequest = parseToolPayload(await callTool("device_broker_appium", {
                    ...route,
                    action: "request",
                    backend: "android-emulator",
                    deviceId: `level2-broker-e2e-appium-request-${method.toLowerCase()}`,
                    method,
                    path: method === "GET" ? "/source" : "/actions",
                    body: method === "POST" ? { actions: [{ type: "pause", duration: 1 }] } : undefined,
                }));
                assert.strictEqual(appiumRequest.ok, false, JSON.stringify(appiumRequest));
                assert.strictEqual(appiumRequest.error, "owner-device-not-found", JSON.stringify(appiumRequest));
            }
            steps.push({ name: "broker Appium request method diagnostics", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium request method diagnostics", error));
        }

            try {
            const plannedCommand = parseToolPayload(await callTool("device_broker_command", {
                ...route,
                action: "plan",
                backend: "android-emulator",
                command: "device_status",
                deviceId: "level2-broker-e2e-command-plan",
            }));
            assert.ok(plannedCommand.result || plannedCommand.error === "owner-device-not-found", JSON.stringify(plannedCommand));
            assert.strictEqual(plannedCommand.method, "broker.command.plan", JSON.stringify(plannedCommand));
            steps.push({ name: "broker lifecycle command plan", status: "PASS", detail: plannedCommand.ok === false ? plannedCommand.error : "ok" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command plan", error));
        }

            try {
            for (const command of ["device_create", "device_status", "device_start", "device_stop", "device_delete"]) {
                const planned = parseToolPayload(await callTool("device_broker_command", {
                    ...route,
                    action: "plan",
                    backend: "android-emulator",
                    command,
                    deviceId: `level2-broker-e2e-command-${command}`,
                    name: `level2-broker-e2e-command-${command}`,
                }));
                assert.strictEqual(planned.method, "broker.command.plan", JSON.stringify(planned));
                if (command === "device_create") {
                    assert.strictEqual(planned.ok, true, JSON.stringify(planned));
                    assert.strictEqual(planned.result.command, command, JSON.stringify(planned));
                    assert.strictEqual(planned.result.execution.mutatesHost, false, JSON.stringify(planned));
                } else {
                    assert.strictEqual(planned.ok, false, JSON.stringify(planned));
                    assert.strictEqual(planned.error, "owner-device-not-found", JSON.stringify(planned));
                }
            }
            steps.push({ name: "broker lifecycle command plan enum diagnostics", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command plan enum diagnostics", error));
        }

            try {
            const plannedCreateOptions = parseToolPayload(await callTool("device_broker_command", {
                ...route,
                action: "plan",
                backend: "android-emulator",
                command: "device_create",
                name: "level2-broker-e2e-command-options",
                options: {
                    systemImage: "system-images;android-35;google_apis;x86_64",
                    deviceProfile: "pixel_7",
                    createAvd: true,
                    devicePort: 5598,
                },
            }));
            assert.strictEqual(plannedCreateOptions.ok, true, JSON.stringify(plannedCreateOptions));
            assert.strictEqual(plannedCreateOptions.method, "broker.command.plan", JSON.stringify(plannedCreateOptions));
            assert.strictEqual(plannedCreateOptions.result?.create?.systemImage, "system-images;android-35;google_apis;x86_64", JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.create?.deviceProfile, "pixel_7", JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.create?.createAvd, true, JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.create?.port, 5598, JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.execution?.mutatesHost, false, JSON.stringify(plannedCreateOptions.result));
            steps.push({ name: "broker lifecycle command options flattening", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command options flattening", error));
        }

            try {
            const invokedCommand = parseToolPayload(await callTool("device_broker_command", {
                ...route,
                action: "invoke",
                backend: "android-emulator",
                command: "device_status",
                deviceId: "level2-broker-e2e-command-invoke",
            }));
            assert.strictEqual(invokedCommand.ok, false, JSON.stringify(invokedCommand));
            assert.strictEqual(invokedCommand.error, "owner-device-not-found", JSON.stringify(invokedCommand));
            assert.strictEqual(invokedCommand.method, "broker.command.invoke", JSON.stringify(invokedCommand));
            steps.push({ name: "broker lifecycle command invoke missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command invoke missing-device diagnostic", error));
        }

            try {
            const backends = parseToolPayload(await callTool("device_broker_rpc", {
                ...route,
                method: "broker.backends",
            }));
            assert.strictEqual(backends.ok, true, JSON.stringify(backends));
            assert.strictEqual(backends.result?.source, "host-broker-provider-discovery", JSON.stringify(backends.result));
            assert.strictEqual(backends.result?.startsDevices, false, JSON.stringify(backends.result));
            const names = (backends.result?.backends || []).map((backend) => backend.name).sort();
            assert.deepStrictEqual(names, expectedBackends.slice().sort());
            steps.push({
                name: "broker-backed provider discovery",
                status: "PASS",
                detail: `platform=${backends.result.platform || "unknown"}`,
            });
        } catch (error) {
            steps.push(failStep("broker-backed provider discovery", error));
        }

            try {
            const backends = parseToolPayload(await callTool("device_backends", publicReadRoute));
            assert.strictEqual(backends.routedBy, "device-backends-broker", JSON.stringify(backends));
            assert.strictEqual(backends.source, "host-broker-provider-discovery", JSON.stringify(backends));
            assert.strictEqual(backends.broker?.available, true, JSON.stringify(backends.broker));
            steps.push({ name: "MCP device_backends routes through broker", status: "PASS" });
        } catch (error) {
            steps.push(failStep("MCP device_backends routes through broker", error));
        }

            try {
            const inventory = parseToolPayload(await callTool("device_inventory", { ...publicReadRoute, backend: "android-emulator" }));
            assert.ok(["device-readonly-broker-implicit", "device-readonly-broker"].includes(inventory.routedBy), JSON.stringify(inventory));
            assert.strictEqual(inventory.ok, true, JSON.stringify(inventory));
            assert.strictEqual(inventory.result?.source, "host-broker-owner-state", JSON.stringify(inventory.result));
            steps.push({ name: "MCP device_inventory routes through broker", status: "PASS" });
        } catch (error) {
            steps.push(failStep("MCP device_inventory routes through broker", error));
        }

            try {
            const fakeAndroid = "level2-broker-e2e-public-android";
            const fakeWindows = "level2-broker-e2e-public-windows";
            const createPlan = parseToolPayload(await callTool("device_create", {
                ...publicRoute,
                backend: "android-emulator",
                name: "Level 2 public dry-run create",
                deviceId: fakeAndroid,
                dryRun: true,
            }));
            assert.strictEqual(createPlan.ok, true, JSON.stringify(createPlan));
            assert.strictEqual(createPlan.routedBy, "device-lifecycle-broker", JSON.stringify(createPlan));
            const publicDeviceDiagnostics = scriptedToolCases([
                ["device_start", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid }],
                ["device_stop", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid }],
                ["device_stop", { ...publicRoute, backend: "windows-sandbox", deviceId: fakeWindows }],
                ["device_delete", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, confirmDestructive: true }],
                ["device_delete", { ...publicRoute, backend: "windows-sandbox", deviceId: fakeWindows, confirmDestructive: true }],
                ["device_attach", { ...publicRoute, backend: "android-device", name: "Level 2 public attach diagnostic", deviceId: `${fakeAndroid}-attach`, serial: "ccc-level2-definitely-missing-android-serial" }],
                ["device_detach", { ...publicRoute, backend: "android-device", deviceId: `${fakeAndroid}-detach` }],
                ["device_exec", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, command: "true", helperTimeoutMs: 1 }],
                ["device_record_video_start", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, remotePath: "/sdcard/level2-public.mp4", timeLimitSec: 1 }],
                ["device_record_video_status", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, helperTimeoutMs: 1 }],
                ["device_record_video_stop", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, helperTimeoutMs: 1 }],
                ["device_upload", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, localPath: "/tmp/ccc-missing-public-upload.txt", remotePath: "/sdcard/ccc-missing-public-upload.txt", helperTimeoutMs: 1 }],
                ["device_download", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, remotePath: "/sdcard/ccc-missing-public-download.txt", localPath: "/tmp/ccc-missing-public-download.txt", helperTimeoutMs: 1 }],
                ["device_reset", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, packageName: "com.example.missing", confirmDestructive: true }],
                ["device_reset", { ...publicRoute, backend: "ios-simulator", deviceId: fakeAndroid, bundleId: "com.example.missing", confirmDestructive: true }],
                ["device_reset", { ...publicRoute, backend: "ios-simulator", deviceId: fakeAndroid, eraseSimulator: true, confirmDestructive: true }],
                ["device_install_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, path: "/tmp/ccc-missing-public.apk" }],
                ["device_launch_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, packageName: "com.example.missing" }],
                ["device_launch_app", { ...publicRoute, backend: "ios-simulator", deviceId: fakeAndroid, bundleId: "com.example.missing" }],
                ["device_launch_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeAndroid, component: "com.example.missing/.MainActivity" }],
                ["device_window_list", { ...publicRoute, backend: "windows-sandbox", deviceId: fakeWindows, helperTimeoutMs: 1 }],
                ["device_accessibility_snapshot", { ...publicRoute, backend: "windows-sandbox", deviceId: fakeWindows, maxDepth: 1, maxNodes: 1, helperTimeoutMs: 1 }],
            ]);
            for (const [tool, args] of publicDeviceDiagnostics) {
                const diagnostic = parseToolPayload(await callTool(tool, args));
                assertFailureDiagnostic(tool, diagnostic, expectedPublicDeviceRoutedBy(tool));
            }
            steps.push({ name: "public device wrapper dry-run create and missing-device diagnostics", status: "PASS", detail: `diagnostics=${publicDeviceDiagnostics.length}` });
        } catch (error) {
            steps.push(failStep("public device wrapper missing-device diagnostics", error));
        }

            try {
            const fakeMobile = "level2-broker-e2e-public-mobile";
            const publicMobileDiagnostics = scriptedToolCases([
                ["mobile_session_status", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_dump_ui", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_tap", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, x: 1, y: 1 }],
                ["mobile_double_tap", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, x: 1, y: 1 }],
                ["mobile_long_press", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, x: 1, y: 1, durationMs: 1 }],
                ["mobile_swipe", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 }],
                ["mobile_drag", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 }],
                ["mobile_type_text", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, text: "ccc-public-mobile" }],
                ["mobile_key", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, keyCode: 4 }],
                ["mobile_home", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_back", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_forward", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_recents", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_power", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_lock", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_unlock", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_rotate_left", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_rotate_right", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_set_orientation", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, orientation: "landscape" }],
                ["mobile_set_orientation", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, orientation: "portrait" }],
                ["mobile_set_orientation", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, orientation: "reverse-landscape" }],
                ["mobile_set_orientation", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, orientation: "reverse-portrait" }],
                ["mobile_open_url", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, url: "https://example.invalid/" }],
                ["mobile_install_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, path: "/tmp/ccc-missing-public.apk" }],
                ["mobile_launch_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing" }],
                ["mobile_launch_app", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing" }],
                ["mobile_launch_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, component: "com.example.missing/.MainActivity" }],
                ["mobile_uninstall_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing", confirmDestructive: true }],
                ["mobile_uninstall_app", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing", confirmDestructive: true }],
                ["mobile_stop_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing" }],
                ["mobile_stop_app", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing" }],
                ["mobile_clear_app_data", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing", confirmDestructive: true }],
                ["mobile_clear_app_data", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing", confirmDestructive: true }],
                ["mobile_grant_permission", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing", permission: "android.permission.CAMERA" }],
                ["mobile_grant_permission", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing", service: "camera" }],
                ["mobile_revoke_permission", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing", permission: "android.permission.CAMERA" }],
                ["mobile_revoke_permission", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing", service: "camera" }],
                ["mobile_set_location", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, latitude: 37.7749, longitude: -122.4194 }],
                ["mobile_set_battery", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, level: 50, confirmDestructive: true }],
                ["mobile_set_battery", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, status: 2, confirmDestructive: true }],
                ["mobile_set_battery", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, charging: true, confirmDestructive: true }],
                ["mobile_set_network", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, wifi: true, confirmDestructive: true }],
                ["mobile_set_network", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, data: true, confirmDestructive: true }],
                ["mobile_toggle_airplane_mode", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, enabled: false, confirmDestructive: true }],
                ["mobile_set_clipboard", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, text: "ccc-public-clipboard" }],
                ["mobile_get_clipboard", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
                ["mobile_wait_for_text", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, text: "missing", timeoutMs: 1, intervalMs: 50 }],
                ["mobile_wait_for_app", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, packageName: "com.example.missing", timeoutMs: 1, intervalMs: 50 }],
                ["mobile_wait_for_app", { ...publicRoute, backend: "ios-simulator", deviceId: fakeMobile, bundleId: "com.example.missing", timeoutMs: 1, intervalMs: 50 }],
                ["mobile_screenshot", { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile }],
            ]);
            for (const [tool, args] of publicMobileDiagnostics) {
                const diagnostic = parseToolPayload(await callTool(tool, args));
                assertFailureDiagnostic(tool, diagnostic, expectedPublicMobileRoutedBy(tool));
            }
            const flow = parseToolPayload(markExpectedFlowStepErrors(await callTool("mobile_run_flow", {
                stopOnError: false,
                steps: [
                    { tool: "mobile_session_status", arguments: { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile } },
                    { tool: "mobile_tap", arguments: { ...publicRoute, backend: "android-emulator", deviceId: fakeMobile, x: 1, y: 1 } },
                ],
            }), ["mobile_session_status", "mobile_tap"]));
            assert.strictEqual(flow.ok, false, JSON.stringify(flow));
            assert.strictEqual(flow.results?.[0]?.tool, "mobile_session_status", JSON.stringify(flow));
            assert.strictEqual(flow.results?.[1]?.tool, "mobile_tap", JSON.stringify(flow));
            steps.push({ name: "public mobile wrapper missing-device diagnostics", status: "PASS", detail: `tools=${publicMobileDiagnostics.length + 1}` });
        } catch (error) {
            steps.push(failStep("public mobile wrapper missing-device diagnostics", error));
        }

            try {
            const wirelessStatus = markExpectedToolError(await callTool("device_wireless", {
                backend: "android-device",
                action: "status",
                timeoutMs: 1,
            }));
            assert.ok(wirelessStatus?.content?.[0]?.text, "device_wireless status returned no diagnostic payload");
            steps.push({ name: "public wireless status diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("public wireless status diagnostic", error));
        }

            try {
            const publicMacosDiagnostics = scriptedToolCases([
                ["device_base_image_create", { backend: "macos-vm", name: "Level 2 public missing base image", sourceImage: "missing-source" }],
                ["device_base_image_clone", { backend: "macos-vm", name: "Level 2 public missing clone", sourceDeviceId: "level2-public-missing-source" }],
                ["device_snapshot_create", { backend: "macos-vm", deviceId: "level2-public-missing-macos", snapshotName: "missing" }],
                ["device_snapshot_restore", { backend: "macos-vm", deviceId: "level2-public-missing-macos", snapshotName: "missing", confirmDestructive: true }],
                ["device_snapshot_restore", { backend: "macos-vm", deviceId: "level2-public-missing-macos", snapshotId: "missing-snapshot-id", confirmDestructive: true }],
                ["device_snapshot_delete", { backend: "macos-vm", deviceId: "level2-public-missing-macos", snapshotName: "missing", confirmDestructive: true }],
                ["device_snapshot_delete", { backend: "macos-vm", deviceId: "level2-public-missing-macos", snapshotId: "missing-snapshot-id", confirmDestructive: true }],
            ]);
            for (const [tool, args] of publicMacosDiagnostics) {
                const diagnostic = markExpectedToolError(await callTool(tool, args));
                assert.strictEqual(diagnostic?.isError, true, `${tool} unexpectedly succeeded: ${diagnostic?.content?.[0]?.text || ""}`);
                assert.ok(String(diagnostic.content?.[0]?.text || "").length > 0, `${tool}: missing diagnostic text`);
            }
            steps.push({ name: "public macOS image and snapshot diagnostics", status: "PASS", detail: `tools=${publicMacosDiagnostics.length}` });
        } catch (error) {
            steps.push(failStep("public macOS image and snapshot diagnostics", error));
        }

            try {
            const diagnostics = scriptedToolCases(backendProviderEnumDiagnostics(publicRoute));
            for (const [tool, args, facet] of diagnostics) {
                const result = markExpectedToolError(await callTool(tool, args));
                const text = result?.content?.map((item) => item?.text || "").join("\n") || "";
                assert.ok(Array.isArray(result?.content) && result.content.length > 0, `${facet}: missing MCP response content`);
                if (!result?.isError && /^[\[{]/.test(text.trim())) {
                    const payload = JSON.parse(result.content?.[0]?.text || "{}");
                    assert.ok(typeof payload === "object" && payload !== null, `${facet}: ${text}`);
                }
            }
            steps.push({ name: "public backend/provider enum diagnostics", status: "PASS", detail: `facets=${diagnostics.length}` });
        } catch (error) {
            steps.push(failStep("public backend/provider enum diagnostics", error));
        }

            steps.push({
                name: "broker lifecycle remains session-owned",
                status: "PASS",
                detail: mcpOwnedBrokerLaunched
                    ? "MCP session cleanup owns the test broker"
                    : "reused or host-managed broker remains running",
            });
        }, {
            env: ccc.env,
            name: options.name || "ccc-level2-host-broker-mcp-e2e",
            ...(options.serverPath ? { serverPath: options.serverPath } : {}),
        });
    } catch (error) {
        steps.push(failStep("broker MCP session", error));
    } finally {
        if (process.platform === "win32" && mcpOwnedBrokerLaunched && Number.isInteger(localBrokerPid)) {
            try {
                const cleanup = await stopWindowsTestBroker(localBrokerPid, port, testHome);
                steps.push({
                    name: "Windows test broker process cleanup",
                    status: "PASS",
                    detail: `runtimeRemoved=${cleanup.runtimeRemoved}, exited=${cleanup.exited}, taskkillStatus=${cleanup.taskkillStatus}`,
                });
            } catch (error) {
                steps.push(failStep("Windows test broker process cleanup", error));
            }
        } else if (!mcpOwnedBrokerLaunched && ccc.source === "local-dist" && Number.isInteger(localBrokerPid)) {
            try {
                let signal = "SIGTERM";
                let exited = false;
                try {
                    process.kill(localBrokerPid, "SIGTERM");
                    exited = await waitForPidExit(localBrokerPid);
                } catch (error) {
                    if (error?.code !== "ESRCH") throw error;
                    exited = true;
                    signal = "already-exited";
                }
                if (!exited) {
                    process.kill(localBrokerPid, "SIGKILL");
                    signal = "SIGKILL";
                    exited = await waitForPidExit(localBrokerPid, 1000);
                }
                const runtimeRemoved = cleanupTestBrokerRuntime(localBrokerPid, port, testHome);
                assert.strictEqual(exited, true, `local test broker pid ${localBrokerPid} did not exit after SIGTERM`);
                steps.push({ name: "shutdown local-dist broker process", status: "PASS", detail: `runtimeRemoved=${runtimeRemoved}, exited=${exited}, signal=${signal}` });
            } catch (error) {
                steps.push(failStep("shutdown local-dist broker process", error));
            }
        }
        ccc.cleanup?.();
        preserveTestHome = steps.some((step) => step.status === "FAIL");
        if (!preserveTestHome) rmSync(testHome, { recursive: true, force: true });
    }

    const aggregate = aggregateStepResult(steps);
    return {
        ...aggregate,
        ...(preserveTestHome ? {
            reason: [aggregate.reason, `isolated broker state preserved at ${testHome}`].filter(Boolean).join("; "),
        } : {}),
        steps,
        scriptedTools: [...scriptedTools].sort(),
        scriptedArgumentFacets,
    };
}

export async function run() {
    return runBrokerE2E();
}
