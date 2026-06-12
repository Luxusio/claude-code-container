import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findMacosDevice, readMacosDevices, updateMacosDevice, writeMacosDevices } from "../state/macos-state.mjs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const PROVIDERS = [
    {
        name: "tart",
        command: "tart",
        startArgs: (instance) => ["run", instance],
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
    {
        name: "vz",
        command: "vz",
        startArgs: (instance) => ["start", instance],
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
    {
        name: "utmctl",
        command: "utmctl",
        startArgs: (instance) => ["start", instance],
        stopArgs: (instance) => ["stop", instance],
        deleteArgs: (instance) => ["delete", instance],
    },
];

function providerCandidates() {
    return PROVIDERS
        .map((provider) => ({ ...provider, command: commandPath(provider.command) }))
        .filter((provider) => provider.command);
}

export function macosDiscovery() {
    const hostSupported = process.platform === "darwin";
    const providers = hostSupported ? providerCandidates() : [];
    const missing = [];
    if (!hostSupported) missing.push("macos-host");
    if (hostSupported && providers.length === 0) missing.push("macos-vm-provider");
    return {
        hostSupported,
        providers,
        available: hostSupported && providers.length > 0,
        missing,
    };
}

export function macosBackend() {
    const discovery = macosDiscovery();
    return {
        name: "macos-vm",
        host: "macos-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        providers: discovery.providers,
        capabilities: [
            "device_inventory",
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
            "device_exec",
            "device_screenshot",
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_image_create",
            "device_image_clone",
            "device_snapshot_create",
            "device_snapshot_restore",
            "device_snapshot_delete",
            "device_record_video_start",
            "device_record_video_stop",
            "device_record_video_status",
            "device_upload",
            "device_download",
        ],
    };
}

function macosDeviceId(name) {
    return `macos-${slug(name)}`;
}

function macosSnapshotId(name) {
    return `snapshot-${slug(name)}`;
}

function macosWorkspaceDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "macos", device.id);
}

function macosToolsDir(device) {
    return join(macosWorkspaceDir(device), "tools");
}

function macosRecordingDir(device) {
    return join(macosWorkspaceDir(device), "recordings");
}

function macosRecordingLocalPath(device) {
    return join(macosRecordingDir(device), `recording-${Date.now()}.mov`);
}

function ensureMacosWorkspace(device) {
    mkdirSync(macosWorkspaceDir(device), { recursive: true });
    mkdirSync(macosToolsDir(device), { recursive: true });
    mkdirSync(macosRecordingDir(device), { recursive: true });
}

function macosHelperMetadata(device) {
    ensureMacosWorkspace(device);
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    const provisioning = device.helper?.provisioning || null;
    return {
        workspaceDir: macosWorkspaceDir(device),
        toolsDir: macosToolsDir(device),
        hostHelperScript: join(macosToolsDir(device), "ccc-guest-helper.sh"),
        remoteScriptPath,
        bridge: device.ssh ? "ssh" : "missing",
        ssh: device.ssh || null,
        status: provisioning?.status || (device.ssh ? "ssh-configured" : "planned"),
        provisioning,
        requiredFor: ["device_exec", "device_screenshot", "device_click", "device_double_click", "device_key", "device_type", "device_scroll", "device_cursor_position", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"],
    };
}

function providerByName(name) {
    return PROVIDERS.find((provider) => provider.name === name);
}

export function macosProviderPlan(device, discovery = macosDiscovery()) {
    const requestedProvider = device.provider || "auto";
    const selected = requestedProvider === "auto"
        ? discovery.providers[0]
        : discovery.providers.find((provider) => provider.name === requestedProvider);
    const catalog = selected ? providerByName(selected.name) : null;
    const instance = device.providerInstance || `ccc-${ownerId()}-${device.id}`;
    const missing = [...discovery.missing];
    if (discovery.hostSupported && !selected) {
        const providerMissing = requestedProvider === "auto" ? "macos-vm-provider" : `macos-vm-provider:${requestedProvider}`;
        if (!missing.includes(providerMissing)) missing.push(providerMissing);
    }
    const command = selected?.command || null;
    return {
        requestedProvider,
        selectedProvider: selected?.name || null,
        providerCommand: command,
        providerInstance: instance,
        workspaceDir: macosWorkspaceDir(device),
        image: device.image || null,
        memoryMb: device.memoryMb,
        cpus: device.cpus,
        helper: macosHelperMetadata(device),
        available: missing.length === 0 && Boolean(catalog && command),
        missing,
        startCommand: catalog && command ? { command, args: catalog.startArgs(instance) } : null,
        stopCommand: catalog && command ? { command, args: catalog.stopArgs(instance) } : null,
        deleteCommand: catalog && command ? { command, args: catalog.deleteArgs(instance) } : null,
        implemented: catalog?.name === "tart" ? [
            "base-image-create",
            "image-clone",
            "snapshot-clone",
            "snapshot-restore",
            "snapshot-delete",
            "provider-delete",
        ] : [],
        deferred: [
            ...(device.ssh ? [] : ["guest-helper-auto-provisioning-requires-ssh"]),
        ],
    };
}

function deviceWithPlan(device) {
    return {
        ...device,
        providerPlan: macosProviderPlan(device),
    };
}

function helperRequiredResult(device, toolName) {
    return textResult(false, `macOS VM ${toolName} requires SSH bridge metadata. Configure sshHost, sshUser, and optional sshPort/sshKeyPath on the device. Workspace: ${macosWorkspaceDir(device)}`);
}

function unsupportedProviderResult(deviceOrProvider, toolName) {
    const provider = typeof deviceOrProvider === "string" ? deviceOrProvider : deviceOrProvider.provider || "auto";
    return textResult(false, `macOS VM ${toolName} is not supported for provider ${provider}; Tart is currently required for image and snapshot operations.`);
}

function tartProviderPlan(device, toolName) {
    const plan = macosProviderPlan(device);
    if (!plan.available) return { error: textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`) };
    if (plan.selectedProvider !== "tart") return { error: unsupportedProviderResult({ ...device, provider: plan.selectedProvider || device.provider }, toolName) };
    return { plan };
}

function macosSshConfig({ sshHost, sshPort = 22, sshUser, sshKeyPath }) {
    return sshHost && sshUser ? {
        host: sshHost,
        port: sshPort,
        user: sshUser,
        keyPath: sshKeyPath || null,
    } : null;
}

function macosDeviceDefinition({ id, name, provider, image, memoryMb, cpus, ssh, extra = {} }) {
    return {
        id,
        name,
        backend: "macos-vm",
        kind: "desktop",
        platform: "macos",
        ownerId: ownerId(),
        provider,
        image,
        memoryMb,
        cpus,
        providerInstance: `ccc-${ownerId()}-${id}`,
        ssh,
        helper: macosHelperMetadata({ id, ssh }),
        status: "stopped",
        creatable: true,
        snapshots: [],
        recording: null,
        ...extra,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function findSnapshot(device, snapshotName, snapshotId) {
    const snapshots = Array.isArray(device.snapshots) ? device.snapshots : [];
    const wantedId = snapshotId || (snapshotName ? macosSnapshotId(snapshotName) : null);
    return snapshots.find((snapshot) => snapshot.id === wantedId || snapshot.name === snapshotName);
}

function markMacosStopped(deviceId) {
    return updateMacosDevice(deviceId, (item) => ({
        ...item,
        status: "stopped",
        updatedAt: new Date().toISOString(),
    }));
}

function managedProviderResource(device) {
    return Boolean(
        device.providerResourceManaged ||
        device.provisioning === "image-created" ||
        device.provisioning === "image-cloned" ||
        device.imageSource ||
        device.clonedFrom ||
        device.imageCreatedAt ||
        device.clonedAt
    );
}

function snapshotProviderInstances(device) {
    return (Array.isArray(device.snapshots) ? device.snapshots : [])
        .filter((snapshot) => snapshot.provider === "tart" && snapshot.providerInstance)
        .map((snapshot) => ({ kind: "snapshot", id: snapshot.id, instance: snapshot.providerInstance }));
}

function restoreRecoveryProviderInstance(device) {
    const recovery = device.restoreRecovery;
    if (!recovery?.candidateProviderInstance) return null;
    return { kind: "restore-recovery", instance: recovery.candidateProviderInstance };
}

function tartDeleteInstance(plan, instance) {
    return run(plan.providerCommand, ["delete", instance]);
}

function sshDiscovery() {
    const ssh = commandPath("ssh");
    const scp = commandPath("scp");
    const missing = [];
    if (!ssh) missing.push("ssh");
    if (!scp) missing.push("scp");
    return { ssh, scp, available: missing.length === 0, missing };
}

function sshTarget(device) {
    if (!device.ssh?.host || !device.ssh?.user) return null;
    return `${device.ssh.user}@${device.ssh.host}`;
}

function sshBaseArgs(device) {
    const args = [];
    if (device.ssh?.keyPath) args.push("-i", device.ssh.keyPath);
    if (device.ssh?.port) args.push("-p", String(device.ssh.port));
    args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no");
    return args;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function macosKeySpec(key) {
    const value = String(key || "");
    const keyCodes = {
        A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40, L: 37, M: 46,
        N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        Enter: 36, Return: 36, Tab: 48, Space: 49, Delete: 51, Backspace: 51, Escape: 53, Esc: 53,
        ArrowLeft: 123, Left: 123, ArrowRight: 124, Right: 124, ArrowDown: 125, Down: 125, ArrowUp: 126, Up: 126,
        Home: 115, End: 119, PageUp: 116, PageDown: 121,
        F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
    };
    const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
    const keyPart = parts.length > 0 ? parts[parts.length - 1] : value;
    const normalizedKey = keyPart.length === 1 ? keyPart.toUpperCase() : keyPart;
    const keyCode = keyCodes[normalizedKey];
    if (keyCode === undefined) return null;
    const modifiers = [];
    for (const part of parts.slice(0, -1).map((item) => item.toLowerCase())) {
        if (part === "cmd" || part === "command" || part === "meta") modifiers.push("command");
        else if (part === "ctrl" || part === "control") modifiers.push("control");
        else if (part === "alt" || part === "option") modifiers.push("option");
        else if (part === "shift") modifiers.push("shift");
        else return null;
    }
    return { key, keyCode, modifiers };
}

function macosHelperCommand(device, subcommand, args = []) {
    const bridge = sshBridge(device, subcommand);
    if (bridge.error) return { error: bridge.error };
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    const command = [shellQuote(remoteScriptPath), subcommand, ...args.map(shellQuote)].join(" ");
    const result = run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command]);
    return { result, remoteScriptPath };
}

function macosHelperJson(stdout) {
    try {
        return JSON.parse(stdout || "");
    } catch {
        return null;
    }
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRecorderProcess(child, label) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => done(null), 150);
        child.once("error", (error) => done(textResult(false, `${label} recorder failed to start: ${error.message}`)));
        child.once("exit", (code, signal) => done(textResult(false, `${label} recorder exited before it was ready: ${signal || `exit ${code}`}`)));
    });
}

function processIsAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (!processIsAlive(pid)) return true;
        await sleep(50);
    }
    return !processIsAlive(pid);
}

function reconcileMacosRecording(device) {
    if (!device?.recording?.active || !device.recording.pid || processIsAlive(device.recording.pid)) return device;
    return updateMacosDevice(device.id, (item) => ({
        ...item,
        recording: null,
        updatedAt: new Date().toISOString(),
    })) || { ...device, recording: null };
}

function monitorMacosRecordingExit(deviceId, pid) {
    return () => {
        const current = findMacosDevice(deviceId);
        if (current?.recording?.active && current.recording.pid === pid) {
            updateMacosDevice(deviceId, (item) => ({
                ...item,
                recording: null,
                updatedAt: new Date().toISOString(),
            }));
        }
    };
}

function scpBaseArgs(device) {
    const args = [];
    if (device.ssh?.keyPath) args.push("-i", device.ssh.keyPath);
    if (device.ssh?.port) args.push("-P", String(device.ssh.port));
    args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no");
    return args;
}

function macosGuestHelperScript(device) {
    return [
        "#!/bin/sh",
        "set -eu",
        `# ccc macOS guest helper for ${device.id}`,
        "case \"${1:-status}\" in",
        "  status) echo '{\"ok\":true,\"helper\":\"ccc-macos-guest-helper\"}' ;;",
        "  click)",
        "    osascript -l JavaScript - \"$2\" \"$3\" \"${4:-left}\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var x = Number(argv[0]); var y = Number(argv[1]); var buttonName = String(argv[2] || 'left');",
        "  var button = buttonName === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;",
        "  var down = buttonName === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;",
        "  var up = buttonName === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;",
        "  var point = $.CGPointMake(x, y);",
        "  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, down, point, button));",
        "  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, up, point, button));",
        "  return JSON.stringify({ok:true, clicked:{x:x, y:y, button:buttonName}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  double_click)",
        "    osascript -l JavaScript - \"$2\" \"$3\" \"${4:-left}\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var x = Number(argv[0]); var y = Number(argv[1]); var buttonName = String(argv[2] || 'left');",
        "  var button = buttonName === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;",
        "  var down = buttonName === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;",
        "  var up = buttonName === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;",
        "  var point = $.CGPointMake(x, y);",
        "  for (var i = 0; i < 2; i++) {",
        "    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, down, point, button));",
        "    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, up, point, button));",
        "    delay(0.08);",
        "  }",
        "  return JSON.stringify({ok:true, doubleClicked:{x:x, y:y, button:buttonName}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  key)",
        "    KEY_CODE=\"$2\"",
        "    MODIFIERS=\"${3:-}\"",
        "    USING=\"\"",
        "    [ -n \"$MODIFIERS\" ] && USING=\" using {$(printf '%s' \"$MODIFIERS\" | sed 's/,/ down, /g') down}\"",
        "    osascript -e \"tell application \\\"System Events\\\" to key code $KEY_CODE$USING\"",
        "    printf '{\"ok\":true,\"key\":{\"keyCode\":%s,\"modifiers\":\"%s\"},\"provider\":\"macos-helper\"}\\n' \"$KEY_CODE\" \"$MODIFIERS\"",
        "    ;;",
        "  type)",
        "    osascript -l JavaScript - \"$2\" <<'JXA'",
        "function run(argv) {",
        "  var text = String(argv[0] || '');",
        "  Application('System Events').keystroke(text);",
        "  return JSON.stringify({ok:true, typed:{text:text}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  scroll)",
        "    osascript -l JavaScript - \"${2:-down}\" \"${3:-1}\" <<'JXA'",
        "function run(argv) {",
        "  ObjC.import('ApplicationServices');",
        "  var direction = String(argv[0] || 'down'); var amount = Number(argv[1] || 1);",
        "  var delta = (direction === 'down' || direction === 'right') ? -amount : amount;",
        "  var axisCount = (direction === 'left' || direction === 'right') ? 2 : 1;",
        "  var event = axisCount === 2 ? $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, 0, delta) : $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, delta);",
        "  $.CGEventPost($.kCGHIDEventTap, event);",
        "  return JSON.stringify({ok:true, scrolled:{direction:direction, amount:amount}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  cursor_position)",
        "    osascript -l JavaScript <<'JXA'",
        "function run() {",
        "  ObjC.import('ApplicationServices');",
        "  var event = $.CGEventCreate(null); var point = $.CGEventGetLocation(event);",
        "  return JSON.stringify({ok:true, cursor:{x:point.x, y:point.y}, provider:'macos-helper'});",
        "}",
        "JXA",
        "    ;;",
        "  *) echo \"unsupported helper command: $1\" >&2; exit 64 ;;",
        "esac",
        "",
    ].join("\n");
}

function writeMacosGuestHelper(device) {
    ensureMacosWorkspace(device);
    const path = join(macosToolsDir(device), "ccc-guest-helper.sh");
    writeFileSync(path, macosGuestHelperScript(device), { mode: 0o700 });
    try { chmodSync(path, 0o700); } catch { /* write mode is enough on most filesystems */ }
    return path;
}

function provisionMacosGuestHelper(device) {
    const target = sshTarget(device);
    if (!target) {
        return {
            ok: true,
            skipped: true,
            provisioning: {
                status: "skipped-missing-ssh",
                updatedAt: new Date().toISOString(),
            },
        };
    }
    const discovery = sshDiscovery();
    if (!discovery.available) {
        return {
            ok: false,
            error: `macOS VM SSH bridge missing prerequisites: ${discovery.missing.join(", ")}`,
            provisioning: {
                status: "failed",
                missing: discovery.missing,
                updatedAt: new Date().toISOString(),
            },
        };
    }
    let localScriptPath;
    try {
        localScriptPath = writeMacosGuestHelper(device);
    } catch (error) {
        return {
            ok: false,
            error: "macos-helper-write-failed",
            detail: error instanceof Error ? error.message : String(error),
            provisioning: {
                status: "failed",
                provider: "local",
                detail: error instanceof Error ? error.message : String(error),
                updatedAt: new Date().toISOString(),
            },
        };
    }
    const remoteScriptPath = device.helper?.remoteScriptPath || `/tmp/ccc-${device.id}-guest-helper.sh`;
    const copy = run(discovery.scp, [...scpBaseArgs(device), localScriptPath, `${target}:${remoteScriptPath}`]);
    if (copy.status !== 0) {
        return {
            ok: false,
            error: "macos-helper-scp-failed",
            command: copy,
            provisioning: {
                status: "failed",
                localScriptPath,
                remoteScriptPath,
                provider: "scp",
                updatedAt: new Date().toISOString(),
            },
        };
    }
    const chmod = run(discovery.ssh, [...sshBaseArgs(device), target, `chmod 700 ${shellQuote(remoteScriptPath)} && ${shellQuote(remoteScriptPath)} status`]);
    if (chmod.status !== 0) {
        return {
            ok: false,
            error: "macos-helper-chmod-failed",
            command: chmod,
            provisioning: {
                status: "failed",
                localScriptPath,
                remoteScriptPath,
                provider: "ssh",
                updatedAt: new Date().toISOString(),
            },
        };
    }
    return {
        ok: true,
        skipped: false,
        provisioning: {
            status: "provisioned",
            localScriptPath,
            remoteScriptPath,
            provider: "ssh-scp",
            stdout: chmod.stdout,
            stderr: chmod.stderr,
            updatedAt: new Date().toISOString(),
        },
    };
}

function sshBridge(device, toolName) {
    const target = sshTarget(device);
    if (!target) return { error: helperRequiredResult(device, toolName) };
    const discovery = sshDiscovery();
    if (!discovery.available) {
        return { error: textResult(false, `macOS VM SSH bridge missing prerequisites: ${discovery.missing.join(", ")}`) };
    }
    return { target, discovery };
}

export function listMacosDevices() {
    return readMacosDevices().map((device) => ({ ...device, ownerId: ownerId(), providerPlan: macosProviderPlan(device) }));
}

export async function handleMacosTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "macos-vm" } = args;
            if (backend !== "macos-vm") return undefined;
            const discovery = macosDiscovery();
            return jsonResult({
                ownerId: ownerId(),
                backend,
                devices: readMacosDevices().map((device) => ({ ...device, ownerId: ownerId(), providerPlan: macosProviderPlan(device, discovery) })),
                discovery,
                hostVms: {
                    providers: discovery.providers.map((provider) => ({
                        name: provider.name,
                        command: provider.command,
                    })),
                    available: discovery.available,
                    missing: discovery.missing,
                    lazy: true,
                    note: "Provider discovery checks command availability only; VM list/start operations are not run by inventory.",
                },
            });
        }

        case "device_image_create": {
            const { backend = "macos-vm", name: deviceName, deviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath } = args;
            if (backend !== "macos-vm") return undefined;
            if (!sourceImage) return textResult(false, "device_image_create requires sourceImage");

            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath });
            const device = macosDeviceDefinition({
                id,
                name: deviceName,
                provider,
                image: sourceImage,
                memoryMb,
                cpus,
                ssh,
                extra: {
                    imageSource: sourceImage,
                    provisioning: "image-created",
                },
            });
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            const target = tart.plan.providerInstance;
            const r = run(tart.plan.providerCommand, ["clone", sourceImage, target]);
            if (r.status !== 0) return fail(r);

            const created = {
                ...device,
                provider: tart.plan.selectedProvider,
                providerInstance: target,
                providerResourceManaged: true,
                imageCreatedAt: new Date().toISOString(),
            };
            devices.push(created);
            writeMacosDevices(devices);
            return jsonResult({ device: deviceWithPlan(created), stdout: r.stdout, stderr: r.stderr, status: r.status });
        }

        case "device_image_clone": {
            const { backend = "macos-vm", name: deviceName, deviceId, sourceDeviceId, sourceImage, provider = "auto", memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath, force = false } = args;
            if (backend !== "macos-vm") return undefined;
            if (!sourceDeviceId && !sourceImage) return textResult(false, "device_image_clone requires sourceDeviceId or sourceImage");

            const sourceDevice = sourceDeviceId ? findMacosDevice(sourceDeviceId) : null;
            if (sourceDeviceId && !sourceDevice) return textResult(false, `Unknown source macOS device: ${sourceDeviceId}`);
            if (sourceDevice && sourceDevice.status !== "stopped" && !force) {
                return textResult(false, `Refusing to clone ${sourceDeviceId} while status is ${sourceDevice.status}; stop it first or pass force=true.`);
            }
            const sourceProvider = sourceDevice?.provider || provider;
            const sourceRef = sourceDevice?.providerInstance || sourceImage;
            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const ssh = macosSshConfig({ sshHost, sshPort, sshUser, sshKeyPath });
            const device = macosDeviceDefinition({
                id,
                name: deviceName,
                provider: sourceProvider,
                image: sourceImage || sourceDevice?.image || sourceRef,
                memoryMb: sourceDevice?.memoryMb || memoryMb,
                cpus: sourceDevice?.cpus || cpus,
                ssh,
                extra: {
                    clonedFrom: sourceDeviceId ? { deviceId: sourceDeviceId, providerInstance: sourceRef } : { image: sourceImage },
                    provisioning: "image-cloned",
                },
            });
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            if (sourceDevice && sourceDevice.status !== "stopped" && force) {
                const sourcePlan = tartProviderPlan(sourceDevice, name);
                if (sourcePlan.error) return sourcePlan.error;
                if (sourcePlan.plan.stopCommand) {
                    const stop = run(sourcePlan.plan.stopCommand.command, sourcePlan.plan.stopCommand.args);
                    if (stop.status !== 0) return fail(stop);
                    markMacosStopped(sourceDevice.id);
                }
            }
            const target = tart.plan.providerInstance;
            const r = run(tart.plan.providerCommand, ["clone", sourceRef, target]);
            if (r.status !== 0) return fail(r);

            const cloned = {
                ...device,
                provider: tart.plan.selectedProvider,
                providerInstance: target,
                providerResourceManaged: true,
                clonedAt: new Date().toISOString(),
            };
            writeMacosDevices([...readMacosDevices(), cloned]);
            return jsonResult({ device: deviceWithPlan(cloned), stdout: r.stdout, stderr: r.stderr, status: r.status });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, provider = "auto", image = null, memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath } = args;
            if (backend !== "macos-vm") return undefined;

            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "desktop",
                platform: "macos",
                ownerId: ownerId(),
                provider,
                image,
                memoryMb,
                cpus,
                providerInstance: `ccc-${ownerId()}-${id}`,
                ssh: sshHost && sshUser ? {
                    host: sshHost,
                    port: sshPort,
                    user: sshUser,
                    keyPath: sshKeyPath || null,
                } : null,
                helper: macosHelperMetadata({ id, ssh: sshHost && sshUser ? { host: sshHost, port: sshPort, user: sshUser, keyPath: sshKeyPath || null } : null }),
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeMacosDevices(devices);
            return jsonResult({ device: deviceWithPlan(device) });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readMacosDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            let forcedStopPlan = null;
            if (force && device.status !== "stopped") {
                const plan = macosProviderPlan(device);
                if (!plan.available) return textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
                if (plan.stopCommand) {
                    const stop = run(plan.stopCommand.command, plan.stopCommand.args);
                    if (stop.status !== 0) return fail(stop);
                    forcedStopPlan = plan;
                    markMacosStopped(deviceId);
                }
            }
            const managedInstances = [
                ...snapshotProviderInstances(device),
                restoreRecoveryProviderInstance(device),
                ...(managedProviderResource(device) && device.providerInstance ? [{ kind: "device", instance: device.providerInstance }] : []),
            ].filter(Boolean);
            const providerDeleted = [];
            if (managedInstances.length > 0) {
                const tart = forcedStopPlan?.selectedProvider === "tart" ? { plan: forcedStopPlan } : tartProviderPlan(device, name);
                if (tart.error) return tart.error;
                for (const resource of managedInstances) {
                    const deleted = tartDeleteInstance(tart.plan, resource.instance);
                    if (deleted.status !== 0) return fail(deleted);
                    providerDeleted.push(resource.instance);
                    if (resource.kind === "snapshot") {
                        updateMacosDevice(deviceId, (item) => ({
                            ...item,
                            snapshots: (item.snapshots || []).filter((snapshot) => snapshot.id !== resource.id),
                            updatedAt: new Date().toISOString(),
                        }));
                    } else if (resource.kind === "restore-recovery") {
                        updateMacosDevice(deviceId, (item) => ({
                            ...item,
                            restoreRecovery: null,
                            updatedAt: new Date().toISOString(),
                        }));
                    }
                }
            }
            writeMacosDevices(readMacosDevices().filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId, providerDeleted });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: deviceWithPlan(device), backend: macosBackend() });
        }

        case "device_snapshot_create": {
            const { deviceId, snapshotName, force = false } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!snapshotName) return textResult(false, "device_snapshot_create requires snapshotName");
            if (device.status !== "stopped" && !force) {
                return textResult(false, `Refusing to snapshot ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
            }
            const snapshotId = macosSnapshotId(snapshotName);
            if ((device.snapshots || []).some((snapshot) => snapshot.id === snapshotId || snapshot.name === snapshotName)) {
                return textResult(false, `Snapshot already exists for ${deviceId}: ${snapshotName}`);
            }
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            if (force && device.status !== "stopped" && tart.plan.stopCommand) {
                const stop = run(tart.plan.stopCommand.command, tart.plan.stopCommand.args);
                if (stop.status !== 0) return fail(stop);
                markMacosStopped(deviceId);
            }
            const snapshotInstance = `${tart.plan.providerInstance}-${snapshotId}`;
            const r = run(tart.plan.providerCommand, ["clone", tart.plan.providerInstance, snapshotInstance]);
            if (r.status !== 0) return fail(r);
            const snapshot = {
                id: snapshotId,
                name: snapshotName,
                provider: tart.plan.selectedProvider,
                providerInstance: snapshotInstance,
                sourceProviderInstance: tart.plan.providerInstance,
                createdAt: new Date().toISOString(),
            };
            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                provider: tart.plan.selectedProvider,
                providerInstance: tart.plan.providerInstance,
                status: "stopped",
                snapshots: [...(item.snapshots || []), snapshot],
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: deviceWithPlan(updated), snapshot, stdout: r.stdout, stderr: r.stderr, status: r.status });
        }

        case "device_snapshot_restore": {
            const { deviceId, snapshotName, snapshotId, force = false } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const snapshot = findSnapshot(device, snapshotName, snapshotId);
            if (!snapshot) return textResult(false, `Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
            if (device.status !== "stopped" && !force) {
                return textResult(false, `Refusing to restore ${deviceId} while status is ${device.status}; stop it first or pass force=true.`);
            }
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            if (force && device.status !== "stopped" && tart.plan.stopCommand) {
                const stop = run(tart.plan.stopCommand.command, tart.plan.stopCommand.args);
                if (stop.status !== 0) return fail(stop);
                markMacosStopped(deviceId);
            }
            const restoreCandidate = `${tart.plan.providerInstance}-restore-${snapshot.id}-${randomUUID()}`;
            const restore = run(tart.plan.providerCommand, ["clone", snapshot.providerInstance, restoreCandidate]);
            if (restore.status !== 0) return fail(restore);
            const remove = run(tart.plan.providerCommand, ["delete", tart.plan.providerInstance]);
            if (remove.status !== 0) {
                run(tart.plan.providerCommand, ["delete", restoreCandidate]);
                return fail(remove);
            }
            const activate = run(tart.plan.providerCommand, ["clone", restoreCandidate, tart.plan.providerInstance]);
            if (activate.status !== 0) {
                updateMacosDevice(deviceId, (item) => ({
                    ...item,
                    status: "stopped",
                    restoreRecovery: {
                        snapshotId: snapshot.id,
                        snapshotName: snapshot.name,
                        candidateProviderInstance: restoreCandidate,
                        failedAt: new Date().toISOString(),
                        error: activate.stderr || activate.stdout || `exit ${activate.status}`,
                    },
                    updatedAt: new Date().toISOString(),
                }));
                return textResult(false, `Error: ${activate.stderr || activate.stdout || `exit ${activate.status}`}. Restore candidate preserved: ${restoreCandidate}`);
            }
            run(tart.plan.providerCommand, ["delete", restoreCandidate]);
            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                provider: tart.plan.selectedProvider,
                providerInstance: tart.plan.providerInstance,
                status: "stopped",
                restoreRecovery: null,
                restoredFrom: { id: snapshot.id, name: snapshot.name, providerInstance: snapshot.providerInstance, restoredAt: new Date().toISOString() },
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: deviceWithPlan(updated), snapshot, stdout: activate.stdout, stderr: activate.stderr, status: activate.status });
        }

        case "device_snapshot_delete": {
            const { deviceId, snapshotName, snapshotId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const snapshot = findSnapshot(device, snapshotName, snapshotId);
            if (!snapshot) return textResult(false, `Unknown snapshot for ${deviceId}: ${snapshotName || snapshotId || "<missing>"}`);
            const tart = tartProviderPlan(device, name);
            if (tart.error) return tart.error;
            const r = run(tart.plan.providerCommand, ["delete", snapshot.providerInstance]);
            if (r.status !== 0) return fail(r);
            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                snapshots: (item.snapshots || []).filter((candidate) => candidate.id !== snapshot.id),
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: deviceWithPlan(updated), deleted: snapshot.id, stdout: r.stdout, stderr: r.stderr, status: r.status });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;

            const plan = macosProviderPlan(device);
            if (!plan.available) {
                return textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
            }

            const r = run(plan.startCommand.command, plan.startCommand.args);
            if (r.status !== 0) return fail(r);

            const startedDevice = {
                ...device,
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                status: "running",
            };
            const provision = provisionMacosGuestHelper(startedDevice);
            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                helper: macosHelperMetadata({ ...item, helper: { ...(item.helper || {}), provisioning: provision.provisioning } }),
                status: "running",
                updatedAt: new Date().toISOString(),
            }));
            if (!provision.ok) {
                return textResult(false, JSON.stringify({
                    ok: false,
                    error: provision.error,
                    command: provision.command,
                    device: deviceWithPlan(updated),
                    helper: provision.provisioning,
                    providerStart: { stdout: r.stdout, stderr: r.stderr, status: r.status },
                }));
            }
            return jsonResult({ device: deviceWithPlan(updated), helper: provision.provisioning });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;

            if (device.recording?.pid) {
                try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
            }
            if (device.recording?.active) {
                const bridge = sshBridge(device, "device_record_video_stop");
                if (!bridge.error) {
                    run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `pkill -INT -f ${shellQuote(`screencapture.*${device.recording.remotePath}`)} || true`]);
                }
            }
            if (device.recording?.pid) {
                await waitForProcessExit(device.recording.pid, 1000);
            }

            const plan = macosProviderPlan(device);
            if (plan.stopCommand && device.providerInstance) {
                const r = run(plan.stopCommand.command, plan.stopCommand.args);
                if (r.status !== 0) return fail(r);
            }

            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                recording: null,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: deviceWithPlan(updated) });
        }

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command]);
            return jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status, provider: "ssh" });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = run(bridge.discovery.scp, [...scpBaseArgs(device), localPath, `${bridge.target}:${remotePath}`]);
            return r.status === 0 ? jsonResult({ uploaded: { localPath, remotePath }, stdout: r.stdout, stderr: r.stderr, provider: "scp" }) : fail(r);
        }

        case "device_download": {
            const { deviceId, remotePath, localPath } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = run(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, localPath]);
            return r.status === 0 ? jsonResult({ downloaded: { remotePath, localPath }, stdout: r.stdout, stderr: r.stderr, provider: "scp" }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            ensureMacosWorkspace(device);
            const localPath = join(macosWorkspaceDir(device), `screenshot-${randomUUID()}.png`);
            const remotePath = `/tmp/ccc-${device.id}-screenshot.png`;
            const capture = run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `screencapture -x ${remotePath}`]);
            if (capture.status !== 0) return fail(capture);
            const copy = run(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, localPath]);
            if (copy.status !== 0) return fail(copy);
            if (!existsSync(localPath)) return textResult(false, `macOS VM screenshot output missing: ${localPath}`);
            return { content: [{ type: "image", data: readFileSync(localPath).toString("base64"), mimeType: "image/png" }] };
        }

        case "device_click":
        case "device_double_click": {
            const { deviceId, x, y, button = "left" } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return textResult(false, `${name} requires numeric x and y`);
            const subcommand = name === "device_double_click" ? "double_click" : "click";
            const helper = macosHelperCommand(device, subcommand, [String(Number(x)), String(Number(y)), button]);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                [name === "device_double_click" ? "doubleClicked" : "clicked"]: payload?.doubleClicked || payload?.clicked || { x: Number(x), y: Number(y), button },
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_key": {
            const { deviceId, key } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const spec = macosKeySpec(key);
            if (!spec) return textResult(false, `Unsupported macOS key expression: ${key}`);
            const helper = macosHelperCommand(device, "key", [String(spec.keyCode), spec.modifiers.join(",")]);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                key: spec,
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_type": {
            const { deviceId, text } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (text === undefined || text === null) return textResult(false, "device_type requires text");
            const literalText = String(text);
            const helper = macosHelperCommand(device, "type", [literalText]);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                typed: { text: literalText },
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_scroll": {
            const { deviceId, direction = "down", amount = 1 } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!["up", "down", "left", "right"].includes(direction)) return textResult(false, "device_scroll direction must be up, down, left, or right");
            const helper = macosHelperCommand(device, "scroll", [direction, String(Number(amount) || 1)]);
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                scrolled: payload?.scrolled || { direction, amount: Number(amount) || 1 },
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_cursor_position": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const helper = macosHelperCommand(device, "cursor_position");
            if (helper.error) return helper.error;
            if (helper.result.status !== 0) return fail(helper.result);
            const payload = macosHelperJson(helper.result.stdout);
            return jsonResult({
                provider: "ssh-macos-helper",
                remoteScriptPath: helper.remoteScriptPath,
                cursor: payload?.cursor || null,
                stdout: helper.result.stdout,
                stderr: helper.result.stderr,
                status: helper.result.status,
            });
        }

        case "device_record_video_status": {
            const { deviceId } = args;
            const device = reconcileMacosRecording(findMacosDevice(deviceId));
            if (!device) return undefined;
            return jsonResult({ deviceId, recording: device.recording || null, provider: "ssh-screencapture-video" });
        }

        case "device_record_video_start": {
            const { deviceId, remotePath, localPath, timeLimitSec } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (device.recording?.active) return textResult(false, `macOS VM recording already active for ${deviceId}`);
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            ensureMacosWorkspace(device);
            const resolvedRemotePath = remotePath || `/tmp/ccc-${device.id}-recording.mov`;
            const resolvedLocalPath = localPath || macosRecordingLocalPath(device);
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            const limitPrefix = timeLimitSec ? `sleep ${Number(timeLimitSec)}; pkill -INT -f ${shellQuote(`screencapture.*${resolvedRemotePath}`)}` : "wait";
            const command = [
                `rm -f ${shellQuote(resolvedRemotePath)}`,
                `(screencapture -v ${shellQuote(resolvedRemotePath)} &)`,
                limitPrefix,
            ].join("; ");
            const child = spawn(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command], {
                detached: true,
                stdio: "ignore",
                env: process.env,
            });
            const startError = await waitForRecorderProcess(child, "macOS VM screencapture");
            if (startError) return startError;
            child.once("exit", monitorMacosRecordingExit(deviceId, child.pid));
            child.unref();
            const recording = {
                active: true,
                provider: "ssh-screencapture-video",
                pid: child.pid,
                remotePath: resolvedRemotePath,
                localPath: resolvedLocalPath,
                timeLimitSec: timeLimitSec || null,
                startedAt: new Date().toISOString(),
            };
            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                recording,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ deviceId, recording: updated.recording });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording?.active) return textResult(false, `No macOS VM recording active for ${deviceId}`);
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            if (device.recording.pid) {
                try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
            }
            run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `pkill -INT -f ${shellQuote(`screencapture.*${device.recording.remotePath}`)} || true`]);
            if (device.recording.pid) {
                const exited = await waitForProcessExit(device.recording.pid, 3000);
                if (!exited) return textResult(false, `macOS VM recording did not exit within 3000ms for ${deviceId}; state remains active.`);
            }
            const previous = device.recording;
            const resolvedLocalPath = localPath || previous.localPath || macosRecordingLocalPath(device);
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            const copy = run(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${previous.remotePath}`, resolvedLocalPath]);
            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                recording: null,
                updatedAt: new Date().toISOString(),
            }));
            run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `rm -f ${shellQuote(previous.remotePath)}`]);
            if (copy.status !== 0) {
                return textResult(false, `Error: ${copy.stderr || copy.stdout || `exit ${copy.status}`}. macOS VM recording state cleared for ${deviceId}.`);
            }
            if (!existsSync(resolvedLocalPath)) return textResult(false, `macOS VM recording output missing: ${resolvedLocalPath}. macOS VM recording state cleared for ${deviceId}.`);
            return jsonResult({
                deviceId,
                stopped: true,
                provider: "ssh-screencapture-video",
                recording: { ...previous, active: false, localPath: resolvedLocalPath, stoppedAt: new Date().toISOString() },
                device: updated,
                stdout: copy.stdout,
                stderr: copy.stderr,
            });
        }

        default:
            return undefined;
    }
}
