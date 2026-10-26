import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { createInputError } from "../../device-lab-mcp/src/creation-input.mjs";
import { toolOperation, CREATE_TOOL_BACKENDS } from "../../device-lab-mcp/src/tools.mjs";
import { createBrokerApiClient } from "./broker-api-client.ts";
import { ownerId } from "#device-lab/providers/context.mjs";
import assert from "assert";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { freePort, localCccPathEnv } from "./helpers.ts";
import { markExpectedFlowStepErrors, markExpectedToolError, parseToolPayload, parseToolResult, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { installedMcpSmokeSample } from "./installed-mcp-smoke.ts";
import { aggregateStepResult } from "./result-status.ts";

export const name = "level 2 host broker MCP E2E";

// Keep broker transport separate from the device's own creation fields.
export function missingWindowsImageProbe(route: Record<string, unknown>) {
    const args = { ...route };
    delete args.port;
    return {
        ...args,
        detail: true,
        name: "Level 2 missing-image diagnostic",
        image: "ccc-level2-missing-image",
        dryRun: true,
    };
}

export async function probeMissingMacosImage(callTool: (tool: string, args: Record<string, unknown>) => Promise<any>) {
    const inventory = async () => {
        const value = parseToolPayload(await callTool("devices", { detail: true, view: "owned", implicitBroker: false }));
        const devices = (value.result || value).devices;
        assert.ok(Array.isArray(devices) && devices.every(device => typeof device?.deviceId === "string" && device.deviceId), "missing-image probe requires owned inventory");
        return devices.map(device => device.deviceId).sort();
    };
    const before = await inventory();
    const args = { detail: true, implicitBroker: false, name: "Level 2 public missing base image", image: "missing-source" };
    assert.strictEqual(toolInputError("create_macos_vm", args), null, "missing-image probe must reach the provider");
    const create = markExpectedToolError(await callTool("create_macos_vm", args));
    assert.strictEqual(create?.isError, true, "missing image unexpectedly cloned during create");
    const diagnostic = String(create.content?.[0]?.text || "");
    let code = "";
    try { code = JSON.parse(diagnostic).error || ""; } catch { /* Native provider refusals can be plain text. */ }
    assert.ok(code === "macos-tart-clone-failed"
        || /^macOS VM backend missing prerequisites: .+/.test(diagnostic)
        || /(?:missing-source.*(?:does not exist|not found|no such)|(?:does not exist|not found|no such).*missing-source)/i.test(diagnostic),
    "missing image create must report its provider rejection");
    // A failed create has no public fixture ID. Verify no definition was published instead of guessing one.
    assert.deepStrictEqual(await inventory(), before, "missing image create published or replaced a device");
}

const expectedBackends = [
    "android-emulator",
    "android-device",
    "ios-simulator",
    "ios-device",
    "windows-sandbox",
    "windows-vm",
    ...(process.platform === "win32" ? ["linux-vm"] : []),
    "macos-vm",
];
const scriptedArgumentFacets = [
    "delete:confirmDestructive=true",
    "launch_app:appId=com.example.missing",
    "launch_app:component=com.example.missing/.MainActivity",
    "launch_app:appId=com.example.missing",
    "reset:confirmDestructive=true",
    "snapshot:confirmDestructive=true",
    "snapshot:snapshotId=missing-snapshot-id",
    "snapshot:snapshotName=missing",
    "snapshot:confirmDestructive=true",
    "snapshot:snapshotId=missing-snapshot-id",
    "snapshot:snapshotName=missing",
    "clear_app_data:confirmDestructive=true",
    "clear_app_data:appId=com.example.missing",
    "clear_app_data:appId=com.example.missing",
    "permission:appId=com.example.missing",
    "permission:appId=com.example.missing",
    "permission:permission=android.permission.CAMERA",
    "permission:permission=camera",
    "launch_app:appId=com.example.missing",
    "launch_app:component=com.example.missing/.MainActivity",
    "launch_app:appId=com.example.missing",
    "set_orientation:orientation=landscape",
    "set_orientation:orientation=portrait",
    "set_orientation:orientation=reverse-landscape",
    "set_orientation:orientation=reverse-portrait",
    "set_battery:confirmDestructive=true",
    "set_battery:charging=true",
    "set_battery:level=50",
    "set_battery:status=2",
    "set_network:data=true",
    "set_network:confirmDestructive=true",
    "set_network:wifi=true",
    "set_network:confirmDestructive=true",
    "set_network:airplaneMode=false",
    "uninstall_app:confirmDestructive=true",
    "uninstall_app:appId=com.example.missing",
    "uninstall_app:appId=com.example.missing",
    "permission:appId=com.example.missing",
    "permission:appId=com.example.missing",
    "permission:permission=android.permission.CAMERA",
    "permission:permission=camera",
    "stop_app:appId=com.example.missing",
    "stop_app:appId=com.example.missing",
    "wait_for_app:appId=com.example.missing",
    "wait_for_app:appId=com.example.missing",
];
const scriptedTools = new Set();

function scriptedToolCases(cases) {
    for (const [tool] of cases) scriptedTools.add(tool);
    return cases;
}

function failStep(name, error) {
    const message = String(error?.message || error || "unknown error");
    try {
        const payload = JSON.parse(message);
        const launch = payload?.launch || payload?.broker?.launch;
        const parts = [payload?.error || payload?.mode, launch?.detail, launch?.command].filter(Boolean);
        return { name, status: "FAIL", reason: parts.join(": ") || "broker operation failed" };
    } catch {
        const normalized = message.replace(/\s+/g, " ").trim();
        return { name, status: "FAIL", reason: normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized };
    }
}

const PUBLIC_DEVICE_LIFECYCLE_TOOLS = new Set([...Object.keys(CREATE_TOOL_BACKENDS), "start", "stop", "delete"]);
const PUBLIC_DEVICE_PHYSICAL_TOOLS = new Set(["attach", "detach"]);
const PUBLIC_DEVICE_READONLY_TOOLS = new Set([
    "window_list",
    "ui",
]);
const PUBLIC_MOBILE_DEVICE_BACKEND_TOOLS = new Set([
    "clear_app_data",
    "permission",
    "set_battery",
]);

function expectedPublicDeviceRoutedBy(tool, args: Record<string, unknown> = {}) {
    if (tool === "record_video") return args.action === "status" ? "device-readonly-broker-implicit" : "device-mutating-broker-implicit";
    if (PUBLIC_DEVICE_LIFECYCLE_TOOLS.has(tool)) return "device-lifecycle-broker";
    if (PUBLIC_DEVICE_PHYSICAL_TOOLS.has(tool)) return "device-physical-broker";
    if (PUBLIC_DEVICE_READONLY_TOOLS.has(tool)) return "device-readonly-broker";
    return "device-mutating-broker";
}

function assertFailureDiagnostic(tool, diagnostic, expectedRoutedBy = "") {
    assert.ok(typeof diagnostic === "object" && diagnostic !== null, `${tool}: ${JSON.stringify(diagnostic)}`);
    assert.strictEqual(diagnostic.ok, false, `${tool} unexpectedly succeeded against fake device: ${JSON.stringify(diagnostic)}`);
    assert.strictEqual(typeof diagnostic.error, "string", `${tool} returned no structured error: ${JSON.stringify(diagnostic)}`);
    assert.ok(diagnostic.error.length > 0, `${tool} returned an empty structured error: ${JSON.stringify(diagnostic)}`);
    if (expectedRoutedBy) assert.strictEqual(diagnostic.routedBy, expectedRoutedBy, `${tool} routedBy mismatch: ${JSON.stringify(diagnostic)}`);
}

function assertMissingTargetDiagnostic(tool, result, args) {
    assert.strictEqual(result?.isError, true, `${tool} unexpectedly succeeded for missing device ${args.deviceId}`);
    const diagnostic = parseToolResult(result, { expectedError: true });
    assertFailureDiagnostic(tool, diagnostic);
    assert.ok(["device-not-found", "device-backend-not-found"].includes(diagnostic.error), `${tool} did not reach ownership refusal: ${JSON.stringify(diagnostic)}`);
    assert.strictEqual(diagnostic.deviceId, args.deviceId, `${tool} refused a different device`);
    if (tool === "record_video") assert.strictEqual(diagnostic.routedBy, expectedPublicDeviceRoutedBy(tool, args));
}

function brokerEnumSample(toolName, route, facetKey, facetValue, index) {
    const args = {
        ...installedMcpSmokeSample(toolName),
        ...route,
        [facetKey]: facetValue,
    };
    delete args.implicitBroker;

    if (CREATE_TOOL_BACKENDS[toolName]) {
        // Creation reserves port for the device; brokerPort selects transport.
        delete args.port;
        // Every enum probe remains a broker plan, never resource creation.
        for (const key of ["avdName", "systemImage", "deviceType", "runtime", "udid", "image", "provider"]) delete args[key];
        args.name = `Level 2 enum ${facetKey} ${facetValue}`;
        if (["windows-vm", "linux-vm", "macos-vm"].includes(CREATE_TOOL_BACKENDS[toolName])) delete args.deviceId;
        else args.deviceId = `level2-enum-${facetKey}-${facetValue}-${index}`;
        args.dryRun = true;
        const backend = CREATE_TOOL_BACKENDS[toolName];
        if (facetKey === "provider") args.provider = facetValue;
        if (backend === "android-emulator") args.systemImage = "system-images;android-35;google_apis;x86_64";
        else if (backend === "ios-simulator") {
            args.deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
            args.runtime = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
        } else if (["windows-vm", "linux-vm", "macos-vm"].includes(backend)) args.image = "missing-image";
        if (args.provider === "container-qemu") {
            delete args.image;
            args.sourceImage = "/tmp/ccc-level2-missing-image.qcow2";
        }
    }
    if (toolName === "wireless") delete args.port; // brokerPort owns transport; port is Android pairing input.
    if (toolName === "attach" && args.backend === "ios-device") {
        delete args.serial;
        args.udid = "00000000-0000000000000000";
    }
    if (toolName === "delete") args.confirmDestructive = true;
    if (toolName === "snapshot") {
        args.confirmDestructive = true;
        args.snapshotName ||= "missing";
    }
    if (toolName === "reset") {
        args.confirmDestructive = true;
    }
    if (toolName === "permission" && /ios/.test(String(facetValue))) {
        args.permission = "camera";
    }
    return args;
}

export function backendProviderEnumDiagnostics(route) {
    const diagnostics = [];
    for (const tool of DEVICE_LAB_MCP_TOOLS) {
        const schemas = [tool.inputSchema, ...(tool.inputSchema?.oneOf || [])];
        for (const facetKey of ["backend", "provider"]) {
            const enumValues = [...new Set(schemas.flatMap(schema => schema?.properties?.[facetKey]?.enum || []).map(String))];
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
        // This private HOME/free-port fixture owns its own legacy runtime.json.
        CCC_DEVICE_BROKER_PORT: "",
        // Empty values still discover the container's conventional auth mount.
        // Both clients must use the secret created by this isolated test broker.
        CCC_DEVICE_BROKER_AUTH_FILE: join(testHome, ".ccc", "devices", "broker", "auth", `${ownerId()}.json`),
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
        // This suite asserts internal routing diagnostics; normal MCP calls stay compact.
        detail: true,
        autolaunch: true,
        brokerPort: port,
        port,
        hostCandidates: ["127.0.0.1"],
        timeoutMs: 1000,
        rpcTimeoutMs: 10000,
        launchTimeoutMs: 5000,
    };
    // Internal transport overrides differ between creation and read operations.
    // Creation probes below remove port and retain brokerPort.
    const publicReadRoute = { ...publicRoute, port };
    const steps = [];
    let mcpOwnedBrokerLaunched = false;
    let localBrokerPid = null;
    let preserveTestHome = false;
    const leaseHardwareId = `ccc-real-broker-e2e-${Date.now()}`;
    const internalBroker = createBrokerApiClient({ ...process.env, ...ccc.env });

    try {
        await withDeviceLabMcp(async ({ callTool }) => {
            const callInternal = (operation: string, args: Record<string, unknown>) => internalBroker.call(operation, args);
            let brokerReady = false;
            try {
                const status = parseToolPayload(await callTool("devices", { view: "backends", detail: true, ...route })).broker;
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
                const echo = parseToolPayload(await callInternal("brokerRpc", {
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
                const rpcStatus = parseToolPayload(await callInternal("brokerRpc", {
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
                const rpcInventory = parseToolPayload(await callInternal("brokerRpc", {
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
                const leases = parseToolPayload(await callInternal("brokerLease", {
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
                    const claim = parseToolPayload(await callInternal("brokerLease", {
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

                    const heartbeat = parseToolPayload(await callInternal("brokerLease", {
                        ...route,
                        action: "heartbeat",
                        backend: "android-device",
                        hardwareId: leaseHardwareId,
                        deviceId: "level2-broker-e2e-lease-device",
                        ttlMs: 120000,
                    }));
                    assert.strictEqual(heartbeat.ok, true, JSON.stringify(heartbeat));
                    assert.strictEqual(heartbeat.result?.heartbeat, true, JSON.stringify(heartbeat.result));

                    const listAfterClaim = parseToolPayload(await callInternal("brokerLease", {
                        ...route,
                        action: "list",
                        backend: "android-device",
                    }));
                    assert.strictEqual(listAfterClaim.ok, true, JSON.stringify(listAfterClaim));
                    assert.ok((listAfterClaim.result?.leases || []).some((lease) => lease.hardwareId === leaseHardwareId), JSON.stringify(listAfterClaim.result));

                    const prune = parseToolPayload(await callInternal("brokerLease", {
                        ...route,
                        action: "prune",
                        backend: "android-device",
                    }));
                    assert.strictEqual(prune.ok, true, JSON.stringify(prune));
                    assert.ok(Array.isArray(prune.result?.pruned), JSON.stringify(prune.result));

                    const release = parseToolPayload(await callInternal("brokerLease", {
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
                            await callInternal("brokerLease", {
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
                const attached = parseToolPayload(await callInternal("brokerPhysical", {
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
            const attachDiagnostic = parseToolResult(await callInternal("brokerPhysical", {
                ...route,
                action: "attach",
                backend: "android-device",
                name: "Level 2 Broker E2E Missing Android Device",
                deviceId: "level2-broker-e2e-missing-android-device",
                serial: "ccc-level2-definitely-missing-android-serial",
            }), { expectedError: true });
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
            const detachDiagnostic = parseToolResult(await callInternal("brokerPhysical", {
                ...route,
                action: "detach",
                backend: "android-device",
                deviceId: "level2-broker-e2e-missing-android-device",
            }), { expectedError: true });
            assert.strictEqual(detachDiagnostic.ok, false, JSON.stringify(detachDiagnostic));
            assert.strictEqual(detachDiagnostic.error, "owner-device-not-found", JSON.stringify(detachDiagnostic));
            steps.push({ name: "broker physical detach missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker physical detach missing-device diagnostic", error));
        }

            try {
            const apple = parseToolResult(await callInternal("brokerApple", {
                ...route,
                action: "status",
                backend: "ios-device",
            }), { expectedError: true });
            assert.ok(apple.result || apple.body?.result || apple.error, JSON.stringify(apple));
            steps.push({ name: "broker Apple trust status", status: "PASS", detail: apple.ok === false ? apple.error : "ok" });
        } catch (error) {
            steps.push(failStep("broker Apple trust status", error));
        }

            try {
            const applePair = parseToolResult(await callInternal("brokerApple", {
                ...route,
                action: "pair",
                backend: "ios-device",
                udid: "00000000-0000000000000000",
            }), { expectedError: true });
            assert.strictEqual(applePair.ok, false, JSON.stringify(applePair));
            assert.ok(["xctrace-inventory-failed", "ios-wireless-missing-xcrun", "ios-apple-pairing-manual-required"].includes(applePair.error), JSON.stringify(applePair));
            steps.push({ name: "broker Apple trust pair diagnostic", status: "PASS", detail: applePair.error });
        } catch (error) {
            steps.push(failStep("broker Apple trust pair diagnostic", error));
        }

            try {
            const appleConnect = parseToolResult(await callInternal("brokerApple", {
                ...route,
                action: "connect",
                backend: "ios-device",
                udid: "00000000-0000000000000000",
            }), { expectedError: true });
            assert.strictEqual(appleConnect.ok, false, JSON.stringify(appleConnect));
            assert.ok(["xctrace-inventory-failed", "ios-wireless-missing-xcrun", "ios-apple-pairing-manual-required"].includes(appleConnect.error), JSON.stringify(appleConnect));
            steps.push({ name: "broker Apple trust connect diagnostic", status: "PASS", detail: appleConnect.error });
        } catch (error) {
            steps.push(failStep("broker Apple trust connect diagnostic", error));
        }

            try {
            const appium = parseToolResult(await callInternal("brokerAppium", {
                ...route,
                action: "status",
                backend: "android-emulator",
                deviceId: "level2-broker-e2e-appium-status",
            }), { expectedError: true });
            assert.ok(appium.result || appium.error === "owner-device-not-found", JSON.stringify(appium));
            steps.push({ name: "broker Appium status", status: "PASS", detail: appium.ok === false ? appium.error : "ok" });
        } catch (error) {
            steps.push(failStep("broker Appium status", error));
        }

            try {
            const appiumList = parseToolPayload(await callInternal("brokerAppium", {
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
            const appiumRecord = parseToolResult(await callInternal("brokerAppium", {
                ...route,
                action: "record",
                backend: "android-emulator",
                deviceId: "level2-broker-e2e-appium-record",
                serverUrl: "http://127.0.0.1:4723",
                sessionId: "level2-broker-e2e-session",
                appiumPort: 4723,
                automationName: "UiAutomator2",
                provider: "appium",
            }), { expectedError: true });
            assert.strictEqual(appiumRecord.ok, false, JSON.stringify(appiumRecord));
            assert.strictEqual(appiumRecord.error, "owner-device-not-found", JSON.stringify(appiumRecord));
            steps.push({ name: "broker Appium record missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium record missing-device diagnostic", error));
        }

            try {
            const appiumClear = parseToolResult(await callInternal("brokerAppium", {
                ...route,
                action: "clear",
                backend: "android-emulator",
                deviceId: "level2-broker-e2e-appium-record",
            }), { expectedError: true });
            assert.strictEqual(appiumClear.ok, false, JSON.stringify(appiumClear));
            assert.strictEqual(appiumClear.error, "owner-device-not-found", JSON.stringify(appiumClear));
            steps.push({ name: "broker Appium clear missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium clear missing-device diagnostic", error));
        }

            try {
            for (const action of ["start", "stop", "ensure-session", "delete-session"]) {
                const appiumDiagnostic = parseToolResult(await callInternal("brokerAppium", {
                    ...route,
                    action,
                    backend: "android-emulator",
                    deviceId: `level2-broker-e2e-appium-${action}`,
                }), { expectedError: true });
                assert.strictEqual(appiumDiagnostic.ok, false, JSON.stringify(appiumDiagnostic));
                assert.strictEqual(appiumDiagnostic.error, "owner-device-not-found", JSON.stringify(appiumDiagnostic));
            }
            steps.push({ name: "broker Appium lifecycle/session missing-device diagnostics", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium lifecycle/session missing-device diagnostics", error));
        }

            try {
            for (const method of ["GET", "POST"]) {
                const appiumRequest = parseToolResult(await callInternal("brokerAppium", {
                    ...route,
                    action: "request",
                    backend: "android-emulator",
                    deviceId: `level2-broker-e2e-appium-request-${method.toLowerCase()}`,
                    method,
                    path: method === "GET" ? "/source" : "/actions",
                    body: method === "POST" ? { actions: [{ type: "pause", duration: 1 }] } : undefined,
                }), { expectedError: true });
                assert.strictEqual(appiumRequest.ok, false, JSON.stringify(appiumRequest));
                assert.strictEqual(appiumRequest.error, "owner-device-not-found", JSON.stringify(appiumRequest));
            }
            steps.push({ name: "broker Appium request method diagnostics", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker Appium request method diagnostics", error));
        }

            try {
            const plannedCommand = parseToolResult(await callInternal("brokerCommand", {
                ...route,
                action: "plan",
                backend: "android-emulator",
                command: "device_status",
                deviceId: "level2-broker-e2e-command-plan",
            }), { expectedError: true });
            assert.ok(plannedCommand.result || plannedCommand.error === "owner-device-not-found", JSON.stringify(plannedCommand));
            assert.strictEqual(plannedCommand.method, "broker.command.plan", JSON.stringify(plannedCommand));
            steps.push({ name: "broker lifecycle command plan", status: "PASS", detail: plannedCommand.ok === false ? plannedCommand.error : "ok" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command plan", error));
        }

            try {
            for (const command of ["device_create", "device_status", "device_start", "device_stop", "device_delete"]) {
                const planned = parseToolResult(await callInternal("brokerCommand", {
                    ...route,
                    action: "plan",
                    backend: "android-emulator",
                    command,
                    deviceId: `level2-broker-e2e-command-${command}`,
                    name: `level2-broker-e2e-command-${command}`,
                }), { expectedError: true });
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
            const plannedCreateOptions = parseToolPayload(await callInternal("brokerCommand", {
                ...route,
                action: "plan",
                backend: "android-emulator",
                command: "device_create",
                name: "level2-broker-e2e-command-options",
                systemImage: "system-images;android-35;google_apis;x86_64",
                    deviceProfile: "pixel_7",
                    createAvd: true,
                devicePort: 5598,
            }));
            assert.strictEqual(plannedCreateOptions.ok, true, JSON.stringify(plannedCreateOptions));
            assert.strictEqual(plannedCreateOptions.method, "broker.command.plan", JSON.stringify(plannedCreateOptions));
            assert.strictEqual(plannedCreateOptions.result?.create?.systemImage, "system-images;android-35;google_apis;x86_64", JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.create?.deviceProfile, "pixel_7", JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.create?.createAvd, true, JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.create?.port, 5598, JSON.stringify(plannedCreateOptions.result));
            assert.strictEqual(plannedCreateOptions.result?.execution?.mutatesHost, false, JSON.stringify(plannedCreateOptions.result));
            steps.push({ name: "broker lifecycle command flat arguments", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command flat arguments", error));
        }

            try {
            const invokedCommand = parseToolResult(await callInternal("brokerCommand", {
                ...route,
                action: "invoke",
                backend: "android-emulator",
                command: "device_status",
                deviceId: "level2-broker-e2e-command-invoke",
            }), { expectedError: true });
            assert.strictEqual(invokedCommand.ok, false, JSON.stringify(invokedCommand));
            assert.strictEqual(invokedCommand.error, "owner-device-not-found", JSON.stringify(invokedCommand));
            assert.strictEqual(invokedCommand.method, "broker.command.invoke", JSON.stringify(invokedCommand));
            steps.push({ name: "broker lifecycle command invoke missing-device diagnostic", status: "PASS" });
        } catch (error) {
            steps.push(failStep("broker lifecycle command invoke missing-device diagnostic", error));
        }

            try {
            const backends = parseToolPayload(await callInternal("brokerRpc", {
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
            const backends = parseToolPayload(await callTool("devices", { view: "backends", detail: true, ...publicReadRoute }));
            assert.strictEqual(backends.routedBy, "device-backends-broker", JSON.stringify(backends));
            assert.strictEqual(backends.source, "host-broker-provider-discovery", JSON.stringify(backends));
            assert.strictEqual(backends.broker?.available, true, JSON.stringify(backends.broker));
            steps.push({ name: "MCP devices view:backends routes through broker", status: "PASS" });
        } catch (error) {
            steps.push(failStep("MCP devices view:backends routes through broker", error));
        }

            try {
            const inventory = parseToolPayload(await callTool("devices", { view: "available", detail: true, ...publicReadRoute, backend: "android-emulator" }));
            assert.ok(["device-readonly-broker-implicit", "device-readonly-broker"].includes(inventory.routedBy), JSON.stringify(inventory));
            assert.strictEqual(inventory.ok, true, JSON.stringify(inventory));
            assert.strictEqual(inventory.result?.source, "host-broker-owner-state", JSON.stringify(inventory.result));
            steps.push({ name: "MCP devices view:available routes through broker", status: "PASS" });
        } catch (error) {
            steps.push(failStep("MCP devices view:available routes through broker", error));
        }

            try {
            const fakeAndroid = "level2-broker-e2e-public-android";
            const fakeWindows = "level2-broker-e2e-public-windows";
            const createPlan = parseToolResult(await callTool("create_windows_vm",
                missingWindowsImageProbe(publicRoute)), { expectedError: true });
            assert.strictEqual(createPlan.ok, false, JSON.stringify(createPlan));
            assert.strictEqual(createPlan.error, "hyper-v-base-image-not-prepared", JSON.stringify(createPlan));
            assert.strictEqual(createPlan.routedBy, "device-lifecycle-broker", JSON.stringify(createPlan));
            const publicDeviceDiagnostics = scriptedToolCases([
                ["start", { ...publicRoute, deviceId: fakeAndroid }],
                ["stop", { ...publicRoute, deviceId: fakeAndroid }],
                ["stop", { ...publicRoute, deviceId: fakeWindows }],
                ["delete", { ...publicRoute, deviceId: fakeAndroid, confirmDestructive: true }],
                ["delete", { ...publicRoute, deviceId: fakeWindows, confirmDestructive: true }],
                ["attach", { ...publicRoute, backend: "android-device", name: "Level 2 public attach diagnostic", deviceId: `${fakeAndroid}-attach`, serial: "ccc-level2-definitely-missing-android-serial" }],
                ["detach", { ...publicRoute, deviceId: `${fakeAndroid}-detach` }],
                ["exec", { ...publicRoute, deviceId: fakeAndroid, command: "true", timeoutMs: 1 }],
                ["record_video", { action: "start", ...publicRoute, deviceId: fakeAndroid, remotePath: "/sdcard/level2-public.mp4", timeLimitSec: 1 }],
                ["record_video", { action: "status", ...publicRoute, deviceId: fakeAndroid, timeoutMs: 1 }],
                ["record_video", { action: "stop", ...publicRoute, deviceId: fakeAndroid, timeoutMs: 1 }],
                ["upload", { ...publicRoute, deviceId: fakeAndroid, localPath: "/tmp/ccc-missing-public-upload.txt", remotePath: "/sdcard/ccc-missing-public-upload.txt", timeoutMs: 1 }],
                ["download", { ...publicRoute, deviceId: fakeAndroid, remotePath: "/sdcard/ccc-missing-public-download.txt", localPath: "/tmp/ccc-missing-public-download.txt", timeoutMs: 1 }],
                ["clear_app_data", { ...publicRoute, deviceId: fakeAndroid, appId: "com.example.missing", confirmDestructive: true }],
                ["clear_app_data", { ...publicRoute, deviceId: "level2-broker-e2e-public-ios", appId: "com.example.missing", confirmDestructive: true }],
                ["reset", { ...publicRoute, deviceId: "level2-broker-e2e-public-ios", confirmDestructive: true }],
                ["install_app", { ...publicRoute, deviceId: fakeAndroid, path: "/tmp/ccc-missing-public.apk" }],
                ["launch_app", { ...publicRoute, deviceId: fakeAndroid, appId: "com.example.missing" }],
                ["launch_app", { ...publicRoute, deviceId: fakeAndroid, appId: "com.example.missing" }],
                ["launch_app", { ...publicRoute, deviceId: fakeAndroid, component: "com.example.missing/.MainActivity" }],
                ["window_list", { ...publicRoute, deviceId: fakeWindows, timeoutMs: 1 }],
                ["ui", { ...publicRoute, deviceId: fakeWindows, maxDepth: 1, maxNodes: 1, timeoutMs: 1 }],
            ]);
            for (const [tool, args] of publicDeviceDiagnostics) {
                const result = await callTool(tool, { detail: true, ...args });
                if (tool === "attach") {
                    assert.strictEqual(result?.isError, true, `${tool} unexpectedly attached missing hardware`);
                    assertFailureDiagnostic(tool, parseToolResult(result, { expectedError: true }), expectedPublicDeviceRoutedBy(tool, args));
                } else assertMissingTargetDiagnostic(tool, result, args);
            }
            steps.push({ name: "public device wrapper missing-device diagnostics", status: "PASS", detail: `diagnostics=${publicDeviceDiagnostics.length}` });
        } catch (error) {
            steps.push(failStep("public device wrapper missing-device diagnostics", error));
        }

            try {
            const fakeMobile = "level2-broker-e2e-public-mobile";
            const publicMobileDiagnostics = scriptedToolCases([
                ["status", { ...publicRoute, deviceId: fakeMobile }],
                ["ui", { ...publicRoute, deviceId: fakeMobile }],
                ["click", { ...publicRoute, deviceId: fakeMobile, x: 1, y: 1 }],
                ["click", { count: 2, ...publicRoute, deviceId: fakeMobile, x: 1, y: 1 }],
                ["long_press", { ...publicRoute, deviceId: fakeMobile, x: 1, y: 1, durationMs: 1 }],
                ["swipe", { ...publicRoute, deviceId: fakeMobile, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 }],
                ["drag", { ...publicRoute, deviceId: fakeMobile, x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 1 }],
                ["type", { ...publicRoute, deviceId: fakeMobile, text: "ccc-public-mobile" }],
                ["key", { ...publicRoute, deviceId: fakeMobile, keyCode: 4 }],
                ["home", { ...publicRoute, deviceId: fakeMobile }],
                ["back", { ...publicRoute, deviceId: fakeMobile }],
                ["forward", { ...publicRoute, deviceId: fakeMobile }],
                ["recents", { ...publicRoute, deviceId: fakeMobile }],
                ["power", { ...publicRoute, deviceId: fakeMobile }],
                ["lock", { ...publicRoute, deviceId: fakeMobile }],
                ["unlock", { ...publicRoute, deviceId: fakeMobile }],
                ["set_orientation", { orientation: "landscape", ...publicRoute, deviceId: fakeMobile }],
                ["set_orientation", { orientation: "reverse-landscape", ...publicRoute, deviceId: fakeMobile }],
                ["set_orientation", { ...publicRoute, deviceId: fakeMobile, orientation: "landscape" }],
                ["set_orientation", { ...publicRoute, deviceId: fakeMobile, orientation: "portrait" }],
                ["set_orientation", { ...publicRoute, deviceId: fakeMobile, orientation: "reverse-landscape" }],
                ["set_orientation", { ...publicRoute, deviceId: fakeMobile, orientation: "reverse-portrait" }],
                ["open_url", { ...publicRoute, deviceId: fakeMobile, url: "https://example.invalid/" }],
                ["install_app", { ...publicRoute, deviceId: fakeMobile, path: "/tmp/ccc-missing-public.apk" }],
                ["launch_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing" }],
                ["launch_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing" }],
                ["launch_app", { ...publicRoute, deviceId: fakeMobile, component: "com.example.missing/.MainActivity" }],
                ["uninstall_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", confirmDestructive: true }],
                ["uninstall_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", confirmDestructive: true }],
                ["stop_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing" }],
                ["stop_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing" }],
                ["clear_app_data", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", confirmDestructive: true }],
                ["clear_app_data", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", confirmDestructive: true }],
                ["permission", { action: "grant", ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", permission: "android.permission.CAMERA" }],
                ["permission", { action: "grant", ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", permission: "camera" }],
                ["permission", { action: "revoke", ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", permission: "android.permission.CAMERA" }],
                ["permission", { action: "revoke", ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", permission: "camera" }],
                ["set_location", { ...publicRoute, deviceId: fakeMobile, latitude: 37.7749, longitude: -122.4194 }],
                ["set_battery", { ...publicRoute, deviceId: fakeMobile, level: 50, confirmDestructive: true }],
                ["set_battery", { ...publicRoute, deviceId: fakeMobile, status: 2, confirmDestructive: true }],
                ["set_battery", { ...publicRoute, deviceId: fakeMobile, charging: true, confirmDestructive: true }],
                ["set_network", { ...publicRoute, deviceId: fakeMobile, wifi: true, confirmDestructive: true }],
                ["set_network", { ...publicRoute, deviceId: fakeMobile, data: true, confirmDestructive: true }],
                ["set_network", { ...publicRoute, deviceId: fakeMobile, airplaneMode: false, confirmDestructive: true }],
                ["clipboard", { ...publicRoute, deviceId: fakeMobile, text: "ccc-public-clipboard" }],
                ["clipboard", { ...publicRoute, deviceId: fakeMobile }],
                ["wait_for_text", { ...publicRoute, deviceId: fakeMobile, text: "missing", timeoutMs: 1, intervalMs: 50 }],
                ["wait_for_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", timeoutMs: 1, intervalMs: 50 }],
                ["wait_for_app", { ...publicRoute, deviceId: fakeMobile, appId: "com.example.missing", timeoutMs: 1, intervalMs: 50 }],
                ["screenshot", { ...publicRoute, deviceId: fakeMobile }],
            ]);
            for (const [tool, args] of publicMobileDiagnostics) {
                assertMissingTargetDiagnostic(tool, await callTool(tool, { detail: true, ...args }), args);
            }
            const flow = parseToolResult(markExpectedFlowStepErrors(await callTool("run_flow", { detail: true,
                stopOnError: false,
                steps: [
                    { tool: "status", arguments: { ...publicRoute, deviceId: fakeMobile } },
                    { tool: "click", arguments: { ...publicRoute, deviceId: fakeMobile, x: 1, y: 1 } },
                ],
            }), ["status", "click"]), { expectedError: true });
            assert.strictEqual(flow.ok, false, JSON.stringify(flow));
            assert.strictEqual(flow.results?.[0]?.tool, "status", JSON.stringify(flow));
            assert.strictEqual(flow.results?.[1]?.tool, "click", JSON.stringify(flow));
            steps.push({ name: "public mobile wrapper missing-device diagnostics", status: "PASS", detail: `tools=${publicMobileDiagnostics.length + 1}` });
        } catch (error) {
            steps.push(failStep("public mobile wrapper missing-device diagnostics", error));
        }

            try {
            const wirelessStatus = markExpectedToolError(await callTool("wireless", { detail: true,
                ...publicRoute,
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
                ["snapshot", { action: "create", ...publicRoute, deviceId: "level2-public-missing-macos", snapshotName: "missing" }],
                ["snapshot", { action: "restore", ...publicRoute, deviceId: "level2-public-missing-macos", snapshotName: "missing", confirmDestructive: true }],
                ["snapshot", { action: "restore", ...publicRoute, deviceId: "level2-public-missing-macos", snapshotId: "missing-snapshot-id", confirmDestructive: true }],
                ["snapshot", { action: "delete", ...publicRoute, deviceId: "level2-public-missing-macos", snapshotName: "missing", confirmDestructive: true }],
                ["snapshot", { action: "delete", ...publicRoute, deviceId: "level2-public-missing-macos", snapshotId: "missing-snapshot-id", confirmDestructive: true }],
            ]);
            for (const [tool, args] of publicMacosDiagnostics) {
                const result = await callTool(tool, { detail: true, ...args });
                if (tool === "attach") {
                    assert.strictEqual(result?.isError, true, `${tool} unexpectedly attached missing hardware`);
                    assertFailureDiagnostic(tool, parseToolResult(result, { expectedError: true }), expectedPublicDeviceRoutedBy(tool, args));
                } else assertMissingTargetDiagnostic(tool, result, args);
            }
            await probeMissingMacosImage(callTool);
            const directMacosImageDiagnostics = scriptedToolCases([
                ["create_macos_vm", { implicitBroker: false, name: "Level 2 public missing clone", sourceDeviceId: "level2-public-missing-source" }],
            ]);
            for (const [tool, args] of directMacosImageDiagnostics) {
                const diagnostic = markExpectedToolError(await callTool(tool, { detail: true, ...args }));
                assert.strictEqual(diagnostic?.isError, true, `${tool} unexpectedly succeeded: ${diagnostic?.content?.[0]?.text || ""}`);
                assert.strictEqual(String(diagnostic.content?.[0]?.text || ""), "Unknown source macOS device: level2-public-missing-source", `${tool}: clone must reach exact missing-source refusal`);
            }
            steps.push({ name: "public macOS image and snapshot diagnostics", status: "PASS", detail: `tools=${publicMacosDiagnostics.length + directMacosImageDiagnostics.length}` });
        } catch (error) {
            steps.push(failStep("public macOS image and snapshot diagnostics", error));
        }

            try {
            const diagnostics = scriptedToolCases(backendProviderEnumDiagnostics(publicRoute));
            let inputRejections = 0;
            for (const [tool, args, facet] of diagnostics) {
                const creationBackend = CREATE_TOOL_BACKENDS[tool];
                if (creationBackend && !["windows-vm", "linux-vm"].includes(creationBackend)) {
                    // These backends cannot promise direct-provider dry-run behavior.
                    // Prove rejection rather than creating resources for enum coverage.
                    assert.strictEqual(createInputError({ ...args, backend: creationBackend }), `create ${creationBackend} does not support dryRun`);
                    inputRejections++;
                    continue;
                }
                if (creationBackend === "linux-vm" && args.provider !== "hyper-v") {
                    assert.strictEqual(toolInputError(tool, args), args.provider === "container-qemu"
                        ? "create container-qemu does not support dryRun:true"
                        : "create_linux_vm dryRun requires provider:hyper-v; container QEMU does not support dryRun");
                    inputRejections++;
                    continue;
                }
                assert.strictEqual(toolInputError(tool, args), null, `${facet}: enum probe must reach provider diagnostics`);
                const result = markExpectedToolError(await callTool(tool, { detail: true, ...args }));
                const text = result?.content?.map((item) => item?.text || "").join("\n") || "";
                assert.ok(Array.isArray(result?.content) && result.content.length > 0, `${facet}: missing MCP response content`);
                if (!result?.isError && /^[\[{]/.test(text.trim())) {
                    const payload = JSON.parse(result.content?.[0]?.text || "{}");
                    assert.ok(typeof payload === "object" && payload !== null, `${facet}: ${text}`);
                }
            }
            steps.push({ name: "public backend/provider enum diagnostics and input validation", status: "PASS", detail: `facets=${diagnostics.length}, inputRejections=${inputRejections}; local-only create validation is not MCP or provider execution proof` });
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
        await internalBroker.close();
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
