import * as processIdentity from "@ccc/device-lab/providers/state/process-identity.mjs";
import * as brokerOwnerSecret from "@ccc/device-lab/providers/state/broker-owner-secret.mjs";
import { installNodeProviderFixtureRouting } from "./node-provider-fixture.js";
import { isolateDeviceLabTestEnvironment } from "./device-lab-test-environment.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

const nativeIdentity = vi.hoisted(() => ({ call: undefined as (<T>(call: () => T) => T) | undefined }));

// Locks capture this delegate at import time, before a fixture selects Darwin.
vi.mock("@ccc/device-lab/providers/state/process-identity.mjs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@ccc/device-lab/providers/state/process-identity.mjs")>();
    return {
        ...actual,
        readProcessIdentityAsync: (...args: Parameters<typeof actual.readProcessIdentityAsync>) => {
            const read = () => actual.readProcessIdentityAsync(...args);
            return nativeIdentity.call ? nativeIdentity.call(read) : read();
        },
    };
});

export interface FakeMacosMcpContext {
    homeDir: string;
    binDir: string;
    logPath: string;
    oldHome: string | undefined;
    restoreEnvironment: () => void;
    restoreNodeRouting: () => void;
    oldPath: string | undefined;
    platformSpy: ReturnType<typeof vi.spyOn>;
    restoreNativeIdentity: () => void;
}

function writeExecutable(path: string, content: string) {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
}

export function createFakeMacosMcpContext(): FakeMacosMcpContext {
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-bin-"));
    const logPath = join(homeDir, "fake-tart.log");

    writeExecutable(join(binDir, "tart"), `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2), env = process.env;
fs.appendFileSync(env.FAKE_TART_LOG, "tart " + args.join(" ") + "\\n");
if (env.FAKE_TART_REPLACE_ON && args[0] === env.FAKE_TART_REPLACE_ON && env.FAKE_TART_REPLACEMENT_STATE && env.FAKE_TART_TARGET_STATE) {
    fs.copyFileSync(env.FAKE_TART_REPLACEMENT_STATE, env.FAKE_TART_TARGET_STATE + ".replacement");
    fs.renameSync(env.FAKE_TART_TARGET_STATE + ".replacement", env.FAKE_TART_TARGET_STATE);
}
if (args[0] === "clone") {
    if (args[1]?.includes("fail-restore")) process.exit(8);
    if (/restore-.*fail-activate/.test(args[1] || "")) process.exit(7);
    if (args[2]?.includes("fail-snapshot")) process.exit(9);
}
if (args[0] === "delete") {
    if (args[1] === env.FAKE_TART_PARTIAL_DELETE_INSTANCE) { console.error("primary delete failed"); process.exit(6); }
    if (args[1] === env.FAKE_TART_FAIL_DELETE_INSTANCE) { console.error("delete failed"); process.exit(6); }
}
if (args[0] === "run" && args[1] === "--help") { console.log("Usage: tart run [--with-softnet] [--no-graphics] VM"); process.exit(0); }
if (args[0] === "run" && env.FAKE_TART_RUN_EXIT_IMMEDIATELY !== "1") setTimeout(() => {}, 1000);
if (args[0] === "ip") {
    if (args.includes(env.FAKE_TART_ARP_INSTANCE)) {
        if (args.includes("--resolver=arp")) console.log("192.0.2.45");
        else { console.error("no IP address found"); process.exit(1); }
    } else console.log("192.0.2.44");
}
`);

    writeExecutable(join(binDir, "vz"), `#!${process.execPath}
require("node:fs").appendFileSync(process.env.FAKE_TART_LOG, "vz " + process.argv.slice(2).join(" ") + "\\n");
`);

    writeExecutable(join(binDir, "ssh"), `#!${process.execPath}
const args = process.argv.slice(2), command = args.join(" ");
require("node:fs").appendFileSync(process.env.FAKE_TART_LOG, "ssh " + command + "\\n");
if (command.includes("screencapture") && command.includes("-v")) { setTimeout(() => {}, 20000); }
else if (command.includes("screencapture") && command.includes("-x")) {}
else if (command.includes("-guest-helper.sh'")) {
    const result = { ok: true, provider: "macos-helper" };
    if (command.includes("' click '22' '33' 'right'")) result.clicked = { x: 22, y: 33, button: "right" };
    else if (command.includes("' double_click '44' '55' 'left'")) result.doubleClicked = { x: 44, y: 55, button: "left" };
    else if (command.includes("' key '0' 'command,shift'")) result.key = { keyCode: 0, modifiers: "command,shift" };
    else if (command.includes("' type")) result.typed = { text: "hello 'mac' {literal}" };
    else if (command.includes("' scroll 'left' '4'")) result.scrolled = { direction: "left", amount: 4 };
    else if (command.includes("' cursor_position")) result.cursor = { x: 101, y: 202 };
    else if (command.includes("' window_list")) { result.provider = "macos-system-events"; result.windows = [{ processName: "TextEdit", processId: 501, title: "Notes", role: "AXWindow", position: [10, 20], size: [300, 200] }]; }
    else if (command.includes("' accessibility_snapshot")) {
        const shallow = command.includes("' accessibility_snapshot '0' '1'");
        result.provider = "macos-system-events";
        result.accessibility = { provider: "macos-system-events", maxDepth: shallow ? 0 : 8, maxNodes: shallow ? 1 : 1000, nodeCount: shallow ? 1 : 3, root: { name: "macOS Desktop", role: "AXApplicationGroup", children: shallow ? [] : [{ name: "TextEdit", role: "AXApplication", processId: 501, children: [{ name: "Notes", role: "AXWindow", children: [] }] }] } };
    } else { console.log("ssh output"); process.exit(0); }
    console.log(JSON.stringify(result));
} else if (command.includes("pkill") || command.includes("rm -f")) {}
else if (command.includes("fail-command")) { console.log("ssh failure stdout"); console.error("ssh failure stderr"); process.exit(7); }
else console.log("ssh output");
`);

    writeExecutable(join(binDir, "scp"), `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), args = process.argv.slice(2), last = args.at(-1);
fs.appendFileSync(process.env.FAKE_TART_LOG, "scp " + args.join(" ") + "\\n");
if (process.env.FAKE_MACOS_FAIL_HELPER_ID && last.includes(process.env.FAKE_MACOS_FAIL_HELPER_ID)) { console.error("scp helper failure"); process.exit(5); }
// A Windows drive colon is local; SCP remote destinations have a host prefix.
if (/^[^/\\\\]+@[^:]+:/.test(last)) process.exit(0);
if (args.join(" ").includes("fail-once-recording-copy")) {
    const marker = path.join(process.env.HOME, "fake-macos-recording-copy-retried");
    if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ""); console.error("scp recording failure"); process.exit(5); }
}
fs.writeFileSync(last, "fakepng");
`);

    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const restoreEnvironment = isolateDeviceLabTestEnvironment(homeDir);
    process.env.PATH = binDir;
    process.env.FAKE_TART_LOG = logPath;
    const restoreNodeRouting = installNodeProviderFixtureRouting(binDir);
    const nativePlatform = process.platform;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    // Provider discovery requires Darwin, but recorder children are real native
    // processes. Keep identity matching and signaling real on the host OS.
    const nativeCall = <T>(call: () => T): T => {
        const previousPlatform = process.platform;
        platformSpy.mockReturnValue(nativePlatform);
        try { return call(); } finally { platformSpy.mockReturnValue(previousPlatform); }
    };
    nativeIdentity.call = nativeCall;
    const readIdentity = processIdentity.readProcessIdentity;
    const inspectIdentity = processIdentity.inspectProcessIdentity;
    const signalRuntime = processIdentity.signalOwnedRuntimeProcess;
    const readSecret = brokerOwnerSecret.readBrokerOwnerSecret;
    const identitySpies = [
        vi.spyOn(processIdentity, "readProcessIdentity").mockImplementation((...args) => nativeCall(() => readIdentity(...args))),
        vi.spyOn(processIdentity, "inspectProcessIdentity").mockImplementation((...args) => nativeCall(() => inspectIdentity(...args))),
        vi.spyOn(processIdentity, "signalOwnedRuntimeProcess").mockImplementation((...args) => nativeCall(() => signalRuntime(...args))),
        vi.spyOn(brokerOwnerSecret, "readBrokerOwnerSecret").mockImplementation((...args) => nativeCall(() => readSecret(...args))),
    ];
    const restoreNativeIdentity = () => {
        nativeIdentity.call = undefined;
        identitySpies.forEach(spy => spy.mockRestore());
    };

    return { homeDir, binDir, logPath, oldHome, oldPath, platformSpy, restoreEnvironment, restoreNodeRouting, restoreNativeIdentity };
}

export function cleanupFakeMacosMcpContext(context: FakeMacosMcpContext | undefined) {
    if (!context) return;
    context.restoreNodeRouting();
    context.restoreNativeIdentity();
    context.platformSpy.mockRestore();
    context.restoreEnvironment();
    if (context.oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = context.oldPath;
    delete process.env.FAKE_TART_LOG;
    delete process.env.FAKE_TART_REPLACE_ON;
    delete process.env.FAKE_TART_REPLACEMENT_STATE;
    delete process.env.FAKE_TART_TARGET_STATE;
    delete process.env.FAKE_TART_RUN_EXIT_IMMEDIATELY;
    delete process.env.FAKE_TART_FAIL_DELETE_INSTANCE;
    delete process.env.FAKE_TART_PARTIAL_DELETE_INSTANCE;
    delete process.env.FAKE_TART_ARP_INSTANCE;
    delete process.env.FAKE_MACOS_FAIL_HELPER_ID;
    rmSync(context.homeDir, { recursive: true, force: true });
    rmSync(context.binDir, { recursive: true, force: true });
}
