import { afterEach, describe, expect, it, vi } from "vitest";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { realMcpToolRequestTimeoutMs } from "../../scripts/real-tests/device-lab-mcp-client.ts";
import { repoRoot } from "../../scripts/real-tests/helpers.ts";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import {
    macosVmE2ECapability,
    parseTartListImages,
    runMacosVmE2E,
    selectAutoTartSourceImage,
    selectAutoTartSourceImageFromListResults,
    sshConfig,
    sourceImage,
} from "../../scripts/real-tests/macos-vm-e2e.ts";

const macosFixture = vi.hoisted(() => ({ active: false, callTool: null as any, instances: new Map<string, string>(), stateWrites: [] as any[], commandCalls: [] as any[][] }));
vi.mock("child_process", async (original) => {
    const actual = await original<typeof import("child_process")>();
    return { ...actual, spawnSync: (...args: any[]) => {
        if (!macosFixture.active) return actual.spawnSync.apply(null, args as any);
        macosFixture.commandCalls.push(args);
        return { status: 0, stdout: "/fixture/tart\n", stderr: "" };
    } };
});
vi.mock("../../scripts/real-tests/device-lab-mcp-client.ts", async (original) => {
    const actual = await original<typeof import("../../scripts/real-tests/device-lab-mcp-client.ts")>();
    return { ...actual, withDeviceLabMcp: (operation: any, options: any) => macosFixture.active
        ? operation({ callTool: macosFixture.callTool }) : actual.withDeviceLabMcp(operation, options) };
});
vi.mock("../../scripts/real-tests/providers/tart.ts", async (original) => {
    const actual = await original<typeof import("../../scripts/real-tests/providers/tart.ts")>();
    return { ...actual, inspectTartInstance: (tart: any, instance: string) => macosFixture.active
        ? { found: macosFixture.instances.has(instance), image: { state: macosFixture.instances.get(instance) } }
        : actual.inspectTartInstance(tart, instance) };
});
vi.mock("#device-lab/providers/state/macos-state.mjs", async (original) => {
    const actual = await original<any>();
    return { ...actual, readMacosDevices: () => macosFixture.active ? [] : actual.readMacosDevices(),
        writeMacosDevices: (devices: any) => macosFixture.active ? macosFixture.stateWrites.push(devices) : actual.writeMacosDevices(devices) };
});
afterEach(() => { macosFixture.active = false; macosFixture.callTool = null; macosFixture.instances.clear(); macosFixture.stateWrites.length = 0; macosFixture.commandCalls.length = 0; });

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const cap = macosVmE2ECapability(level);
const destructiveMacosE2EWillRun = level >= 3 && cap.available;
const title = cap.available
    ? `creates, boots, observes, stops, and deletes a real macOS VM through device-lab MCP Tart backend (${cap.source})`
    : `skips macOS VM Tart E2E (${cap.reason})`;

function withPrivateSshEnvironment<T>(environment: Record<string, string>, operation: (home: string) => T): T {
    const home = mkdtempSync(join(tmpdir(), "ccc-macos-e2e-ssh-home-"));
    const restoreEnvironment = isolateDeviceLabTestEnvironment(home);
    const previousPath = process.env.PATH;
    try {
        const sshKeygen = join(home, "ssh-keygen");
        writeFileSync(sshKeygen, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then shift; key="$1"; fi
  shift
done
printf 'private-key' > "$key"
printf 'public-key' > "$key.pub"
`);
        chmodSync(sshKeygen, 0o700);
        process.env.PATH = home;
        Object.assign(process.env, environment);
        return operation(home);
    } finally {
        restoreEnvironment();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(home, { recursive: true, force: true });
    }
}

describe("macOS VM Tart E2E source image auto-selection", () => {
    it("parses Tart list output variants and selects a single safe base image", () => {
        expect(parseTartListImages(JSON.stringify([
            { name: "ccc-real-old-e2e", state: "stopped" },
            { name: "sonoma-base", state: "stopped", source: "local" },
        ]))).toEqual([
            { name: "ccc-real-old-e2e", state: "stopped", source: "" },
            { name: "sonoma-base", state: "stopped", source: "local" },
        ]);
        expect(parseTartListImages('{"name":"ventura-template","state":"stopped"}\n')).toEqual([
            { name: "ventura-template", state: "stopped", source: "" },
        ]);
        expect(parseTartListImages("NAME STATE\nmacos-base stopped\n")).toEqual([
            { name: "macos-base", state: "stopped", source: "" },
        ]);
        expect(parseTartListImages("Source Name State\nlocal local-base stopped\nregistry remote-base stopped\n")).toEqual([
            { name: "local-base", state: "stopped", source: "local" },
            { name: "remote-base", state: "stopped", source: "registry" },
        ]);

        expect(selectAutoTartSourceImage([
            { name: "ccc-level2-e2e-stale", state: "stopped" },
            { name: "registry-base", state: "stopped", source: "registry" },
            { name: "macos-base", state: "stopped" },
        ])).toEqual(expect.objectContaining({
            source: "macos-base",
            auto: true,
        }));
    });

    it("does not auto-select when multiple local Tart image candidates are ambiguous", () => {
        expect(selectAutoTartSourceImage([
            { name: "macos-base-a", state: "stopped" },
            { name: "work-vm", state: "stopped" },
        ])).toEqual(expect.objectContaining({
            source: "",
            reason: expect.stringContaining("multiple local Tart images"),
            candidates: ["macos-base-a", "work-vm"],
        }));
    });

    it("prefers a stopped CCC macOS base without selecting unrelated user VMs or registry entries", () => {
        expect(selectAutoTartSourceImage([
            { name: "ccc-macos-base", state: "stopped", source: "local" },
            { name: "ccc-525bceb2afd55cdb-user-device", state: "stopped", source: "local" },
            { name: "work-vm", state: "stopped", source: "local" },
            { name: "ghcr.io/cirruslabs/macos-sonoma-base:latest", state: "stopped", source: "OCI" },
        ])).toEqual({
            source: "ccc-macos-base",
            candidates: ["ccc-macos-base"],
            auto: true,
        });
    });

    it("falls through to later Tart list variants when an earlier successful command has no parseable images", () => {
        expect(selectAutoTartSourceImageFromListResults([
            { command: "tart list --source=local --format=json", status: 0, stdout: "Usage: tart list [options]\nOptions:\n  --help\n" },
            { command: "tart list", status: 0, stdout: "Name Source State\nlocal-base local stopped\n" },
        ])).toEqual(expect.objectContaining({
            source: "local-base",
            command: "tart list",
        }));
    });

    it.skipIf(process.platform === "win32")("auto-selects a single local Tart image by default when no source env is configured", () => {
        const previousSource = process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE;
        const previousCompatSource = process.env.CCC_REAL_TART_SOURCE_IMAGE;
        const dir = mkdtempSync(join(tmpdir(), "ccc-fake-tart-"));
        const tart = join(dir, "tart");
        try {
            delete process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE;
            delete process.env.CCC_REAL_TART_SOURCE_IMAGE;
            writeFileSync(tart, "#!/bin/sh\nprintf 'Name Source State\\nlocal-base local stopped\\n'\n");
            chmodSync(tart, 0o700);

            expect(sourceImage(tart)).toEqual(expect.objectContaining({
                source: "local-base",
                auto: true,
            }));

            process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE = "  ";
            expect(sourceImage(tart)).toEqual(expect.objectContaining({
                source: "local-base",
                auto: true,
            }));

            process.env.CCC_REAL_TART_SOURCE_IMAGE = "compat-base";
            expect(sourceImage(tart)).toEqual({
                source: "compat-base",
                auto: false,
                candidates: [],
            });
        } finally {
            if (previousSource === undefined) delete process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE;
            else process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE = previousSource;
            if (previousCompatSource === undefined) delete process.env.CCC_REAL_TART_SOURCE_IMAGE;
            else process.env.CCC_REAL_TART_SOURCE_IMAGE = previousCompatSource;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === "win32")("uses the project name as the default SSH user and generates an owner-scoped key", () => {
        withPrivateSshEnvironment({}, () => {
            const ssh = sshConfig();
            expect(ssh).toEqual(expect.objectContaining({
                available: true,
                sshUser: "claudecodecontainer",
                generatedSshKey: true,
            }));
            expect(ssh.sshKeyPath).toContain(join(".ccc", "devices", "real-tests", "macos-vm-ssh", "id_ed25519"));
            expect(readFileSync(ssh.sshKeyPath, "utf-8")).toBe("private-key");
            expect(readFileSync(`${ssh.sshKeyPath}.pub`, "utf-8")).toBe("public-key");
        });
    });
});

describe.skipIf(process.platform === "win32")("macOS E2E SSH image policy", () => {
    it.each([
        "ccc-macos-base",
        "ghcr.io/cirruslabs/macos-sonoma-base:latest",
        "ghcr.io/cirruslabs/macos-tahoe-base@sha256:fixture",
        "macos-sonoma-base",
    ])("keeps the existing image user without generating a host key for %s", (image) => {
        withPrivateSshEnvironment({}, (home) => {
            const ssh = sshConfig(image);
            expect(ssh).toEqual(expect.objectContaining({ available: true, sshUser: "admin", sshPort: 22 }));
            for (const key of ["sshKeyPath", "generatedSshKeyPath", "generatedSshPublicKeyPath", "sshKeyGenerationError", "sshPassword", "password"]) {
                expect(ssh).not.toHaveProperty(key);
            }
            expect(existsSync(join(home, ".ccc"))).toBe(false);
        });
    });

    it.each([
        { label: "primary SSH settings before compatibility settings", environment: {
            CCC_REAL_MACOS_VM_SSH_USER: "primary-user", CCC_REAL_TART_SSH_USER: "compat-user",
            CCC_REAL_MACOS_VM_SSH_HOST: "primary-host", CCC_REAL_TART_SSH_HOST: "compat-host",
            CCC_REAL_MACOS_VM_SSH_PORT: "2201", CCC_REAL_TART_SSH_PORT: "2202",
            CCC_REAL_MACOS_VM_SSH_KEY_PATH: "/fixture/primary-key", CCC_REAL_TART_SSH_KEY_PATH: "/fixture/compat-key",
            CCC_REAL_MACOS_VM_DEFAULT_SSH_USER: "default-user",
        }, expected: { sshUser: "primary-user", sshHost: "primary-host", sshPort: 2201, sshKeyPath: "/fixture/primary-key" } },
        { label: "compatibility SSH settings before the default user", environment: {
            CCC_REAL_TART_SSH_USER: "compat-user", CCC_REAL_TART_SSH_HOST: "compat-host",
            CCC_REAL_TART_SSH_PORT: "2202", CCC_REAL_TART_SSH_KEY_PATH: "/fixture/compat-key",
            CCC_REAL_MACOS_VM_DEFAULT_SSH_USER: "default-user",
        }, expected: { sshUser: "compat-user", sshHost: "compat-host", sshPort: 2202, sshKeyPath: "/fixture/compat-key" } },
    ])("preserves $label on a recognized image", ({ environment, expected }) => {
        withPrivateSshEnvironment(environment as Record<string, string>, (home) => {
            expect(sshConfig("ccc-macos-base")).toEqual(expect.objectContaining({ available: true, ...expected }));
            expect(existsSync(join(home, ".ccc"))).toBe(false);
        });
    });

    it.each([
        ["CCC_REAL_MACOS_VM_SSH_USER", "selected-user", { sshUser: "selected-user" }],
        ["CCC_REAL_TART_SSH_USER", "compat-user", { sshUser: "compat-user" }],
        ["CCC_REAL_MACOS_VM_SSH_HOST", "selected-host", { sshHost: "selected-host", sshUser: "claudecodecontainer" }],
        ["CCC_REAL_TART_SSH_HOST", "compat-host", { sshHost: "compat-host", sshUser: "claudecodecontainer" }],
        ["CCC_REAL_MACOS_VM_SSH_PORT", "2201", { sshPort: 2201, sshUser: "claudecodecontainer" }],
        ["CCC_REAL_TART_SSH_PORT", "2202", { sshPort: 2202, sshUser: "claudecodecontainer" }],
        ["CCC_REAL_MACOS_VM_DEFAULT_SSH_USER", "default-user", { sshUser: "default-user" }],
    ] as const)("retains the explicit %s override and legacy key generation", (key, value, expected) => {
        withPrivateSshEnvironment({ [key]: value }, () => {
            const ssh = sshConfig("ccc-macos-base");
            expect(ssh).toEqual(expect.objectContaining({ available: true, generatedSshKey: true, ...expected }));
            expect(readFileSync(ssh.sshKeyPath, "utf8")).toBe("private-key");
        });
    });

    it.each(["CCC_REAL_MACOS_VM_SSH_KEY_PATH", "CCC_REAL_TART_SSH_KEY_PATH"])("retains an explicit %s without generating another key", (key) => {
        withPrivateSshEnvironment({ [key]: "/fixture/configured-key" }, (home) => {
            expect(sshConfig("ccc-macos-base")).toEqual(expect.objectContaining({
                available: true, sshUser: "claudecodecontainer", sshKeyPath: "/fixture/configured-key",
            }));
            expect(existsSync(join(home, ".ccc"))).toBe(false);
        });
    });

    it("keeps the project user and generated key for an unrecognized custom image", () => {
        withPrivateSshEnvironment({}, () => {
            const ssh = sshConfig("custom-private-macos-image");
            expect(ssh).toEqual(expect.objectContaining({ available: true, sshUser: "claudecodecontainer", generatedSshKey: true }));
            expect(readFileSync(ssh.sshKeyPath, "utf8")).toBe("private-key");
        });
    });
});

describe.runIf(level >= 2)("level 2 real macOS VM Tart E2E", () => {
    it.skipIf(!cap.available || destructiveMacosE2EWillRun)(
        destructiveMacosE2EWillRun
            ? `skips duplicate macOS VM Tart E2E because level 3 snapshot E2E covers lifecycle (${cap.source})`
            : title,
        async () => {
            const result = await runMacosVmE2E({ level });
            console.info(`[macOS VM E2E] ${result.detail}`);
            expect(result).toEqual(expect.objectContaining({
                status: "PASS",
                provider: "tart",
                source: cap.source,
                deviceId: expect.stringMatching(/^macos-[a-f0-9-]+$/),
                providerInstance: expect.any(String),
                boot: expect.objectContaining({
                    ready: expect.any(Boolean),
                }),
                guest: expect.objectContaining({
                    exercised: expect.any(Boolean),
                }),
                timings: expect.objectContaining({
                    createMs: expect.any(Number),
                    startMs: expect.any(Number),
                    stopMs: expect.any(Number),
                    deleteMs: expect.any(Number),
                }),
            }));
        },
        1200000,
    );
});


describe("macOS E2E returned fixture identity", () => {
    async function fixtureRun(failClone = false, options: { sshHost?: string | null; bootTimeoutEnv?: string; bootTimeoutMs?: number; failUpload?: boolean; imageDefaults?: boolean; helperUser?: string } = {}) {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        const home = mkdtempSync(join(tmpdir(), "ccc-macos-e2e-run-home-"));
        const restoreEnvironment = isolateDeviceLabTestEnvironment(home);
        const calls: Array<{ tool: string; args: any }> = [];
        const devices = new Map<string, any>();
        const transfers = new Map<string, string>();
        const ids = ["macos-13579bdf-2468-4ace-8bdf-13579bdf2468", "macos-2468ace0-1357-4bdf-8ace-2468ace01357", "macos-abcdef12-3456-4789-8abc-def123456789"];
        let createCount = 0;
        const reply = (value: any) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
        macosFixture.active = true;
        macosFixture.callTool = async (tool: string, args: any) => {
            calls.push({ tool, args });
            expect(toolInputError(tool, args), `${tool} input`).toBeNull();
            expect(args).not.toHaveProperty("incarnationId");
            if (tool === "create_macos_vm") {
                expect(args).not.toHaveProperty("deviceId");
                const id = ids[createCount++];
                if (failClone && args.sourceDeviceId) throw new Error("fixture-clone-failed");
                const device = { deviceId: id, name: args.name, status: "stopped", provider: "tart", providerInstance: `native-${id}`, helper: { ssh: { host: "fixture-host", user: options.helperUser || (options.imageDefaults ? "admin" : "fixture-user") } } };
                devices.set(id, device); macosFixture.instances.set(device.providerInstance, "stopped");
                return reply({ ok: true, operation: args.sourceDeviceId ? "base-image-clone" : "create", device });
            }
            if (tool === "devices") return reply({ devices: [...devices.values()] });
            expect(devices.has(args.deviceId), `${tool} targets a returned ID`).toBe(true);
            const device = devices.get(args.deviceId);
            if (tool === "start") {
                device.status = "running"; macosFixture.instances.set(device.providerInstance, "running");
                return reply({ device, boot: { ready: true, ip: "fixture-host" }, helper: { status: "provisioned" } });
            }
            if (tool === "status") return reply({ device });
            if (tool === "stop") { device.status = "stopped"; macosFixture.instances.set(device.providerInstance, "stopped"); return reply({ device }); }
            if (tool === "delete") { devices.delete(args.deviceId); macosFixture.instances.delete(device.providerInstance); return reply({ deleted: args.deviceId, providerDeleted: [device.providerInstance] }); }
            if (tool === "exec") return reply({ stdout: "ccc-macos-vm-e2e-ok" });
            if (tool === "upload") {
                expect(dirname(dirname(args.localPath))).toBe(realpathSync(join(repoRoot, "results", ".tmp")));
                expect(readdirSync(dirname(args.localPath))).toEqual(["upload.txt"]);
                const contents = readFileSync(args.localPath, "utf8");
                if (options.failUpload) throw new Error("fixture-upload-failed");
                transfers.set(args.remotePath, contents);
                return reply({ provider: "scp", uploaded: { localPath: args.localPath, remotePath: args.remotePath } });
            }
            if (tool === "list_files") return reply({ entries: [...transfers.keys()].map(path => ({ name: path.split("/").at(-1), type: "file" })) });
            if (tool === "download") { writeFileSync(args.localPath, transfers.get(args.remotePath)!); return reply({ provider: "scp", downloaded: { localPath: args.localPath, remotePath: args.remotePath } }); }
            if (tool === "screenshot") return { content: [{ type: "image", mimeType: "image/png", data: "a".repeat(80) }] };
            if (tool === "click") return reply({ provider: "ssh-macos-helper", [args.count === 2 ? "doubleClicked" : "clicked"]: { x: args.x, y: args.y, button: args.button } });
            if (tool === "key") return reply({ provider: "ssh-macos-helper", key: { key: args.key, keyCode: 53, modifiers: [] } });
            if (tool === "type") return reply({ provider: "ssh-macos-helper", typed: { text: args.text } });
            if (tool === "scroll") return reply({ provider: "ssh-macos-helper", scrolled: { direction: args.direction, amount: args.amount } });
            if (tool === "window_list") return reply({ windows: [] });
            if (tool === "cursor_position") return reply({ provider: "ssh-macos-helper", cursor: null });
            if (tool === "ui") return reply({ provider: "macos-system-events", accessibility: null });
            if (tool === "record_video") return reply({ provider: "ssh-screencapture-video", deviceId: args.deviceId });
            if (tool === "snapshot") {
                if (args.action === "create") return reply({ snapshot: { id: "private-snapshot", name: args.snapshotName, providerInstance: "native-snapshot" } });
                if (args.action === "restore") return reply({ device: { ...device, restoredFrom: { id: "private-snapshot", name: args.snapshotName } } });
                return reply({ deleted: "private-snapshot" });
            }
            throw new Error(`unexpected fixture tool ${tool}`);
        };
        try {
            Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
            process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE = options.imageDefaults ? "ccc-macos-base" : "registry/base";
            if (!options.imageDefaults) {
                process.env.CCC_REAL_MACOS_VM_SSH_USER = "fixture-user";
                if (options.sshHost !== null) process.env.CCC_REAL_MACOS_VM_SSH_HOST = options.sshHost ?? "fixture-host";
                process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH = "/fixture/id_ed25519";
            }
            if (options.bootTimeoutEnv === undefined) delete process.env.CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS;
            else process.env.CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS = options.bootTimeoutEnv;
            const result = await runMacosVmE2E({ level: 2, imageTools: true, snapshot: true, bootTimeoutMs: options.bootTimeoutMs });
            return { result, calls, devices, ids, generatedKeyDirectoryExists: existsSync(join(home, ".ccc", "devices", "real-tests", "macos-vm-ssh")) };
        } catch (error) { Object.assign(error as object, { calls, devices, ids }); throw error; }
        finally {
            Object.defineProperty(process, "platform", platform);
            restoreEnvironment();
            rmSync(home, { recursive: true, force: true });
            macosFixture.active = false;
        }
    }
    it("omits recognized-image SSH overrides while exercising guest controls with the policy user", async () => {
        const { result, calls, devices, generatedKeyDirectoryExists } = await fixtureRun(false, { imageDefaults: true });
        const create = calls.find(call => call.tool === "create_macos_vm")!.args;
        expect(create.image).toBe("ccc-macos-base");
        expect(create).not.toHaveProperty("ssh");
        expect(result).toMatchObject({ status: "PASS", guest: { exercised: true, sshUser: "admin", sshKeyPath: null, generatedSshPublicKeyPath: null, uploadDownloaded: true } });
        expect(calls.find(call => call.tool === "start")!.args.waitForBoot).toBe(true);
        for (const tool of ["exec", "upload", "download", "screenshot", "click", "key", "type", "scroll", "window_list", "cursor_position", "ui", "record_video"]) {
            expect(calls.some(call => call.tool === tool), `${tool} guest control remains enabled`).toBe(true);
        }
        expect(macosFixture.commandCalls.some(call => call[0] === "ssh-keygen" || call[1]?.includes("command -v ssh-keygen"))).toBe(false);
        expect(generatedKeyDirectoryExists).toBe(false);
        expect(devices.size).toBe(0);
    });
    it("still rejects a guest reporting a different user from the recognized image policy", async () => {
        const error = await fixtureRun(false, { imageDefaults: true, helperUser: "unexpected-guest-user" }).catch(error => error);
        expect(error).toMatchObject({ actual: "unexpected-guest-user", expected: "admin" });
        expect(error.calls.filter((call: any) => call.tool === "stop").map((call: any) => call.args.deviceId)).toEqual([error.ids[0]]);
        expect(error.calls.filter((call: any) => call.tool === "delete").map((call: any) => call.args.deviceId)).toEqual([error.ids[0]]);
        expect(error.devices.size).toBe(0);
    });
    it("uses returned IDs for guest controls, snapshots, image create, clone and deletion", async () => {
        const { result, calls, devices, ids } = await fixtureRun();
        expect(result.deviceId).toBe(ids[0]);
        expect(devices.size).toBe(0);
        const creates = calls.filter(call => call.tool === "create_macos_vm");
        expect(creates).toHaveLength(3);
        expect(creates[2].args.sourceDeviceId).toBe(ids[0]);
        expect(calls.filter(call => call.tool === "delete").map(call => call.args.deviceId).sort()).toEqual([...ids].sort());
        expect(calls.filter(call => ["exec", "upload", "download", "click", "type", "snapshot"].includes(call.tool)).every(call => call.args.deviceId === ids[0])).toBe(true);
        const upload = calls.find(call => call.tool === "upload")!.args;
        const download = calls.find(call => call.tool === "download")!.args;
        const transferDirectory = dirname(upload.localPath);
        expect(dirname(transferDirectory)).toBe(realpathSync(join(repoRoot, "results", ".tmp")));
        expect(dirname(download.localPath)).toBe(transferDirectory);
        expect(basename(upload.localPath)).toBe("upload.txt");
        expect(basename(download.localPath)).toBe("download.txt");
        expect(existsSync(upload.localPath)).toBe(false);
        expect(existsSync(download.localPath)).toBe(false);
        expect(existsSync(transferDirectory)).toBe(false);
        const secondRun = await fixtureRun();
        const nextTransferDirectory = dirname(secondRun.calls.find(call => call.tool === "upload")!.args.localPath);
        expect(nextTransferDirectory).not.toBe(transferDirectory);
        expect(existsSync(nextTransferDirectory)).toBe(false);
    });
    it("cleans local transfer directory and the exact returned device when upload fails", async () => {
        const error = await fixtureRun(false, { failUpload: true }).catch(error => error);
        expect(error.message).toContain("fixture-upload-failed");
        const upload = error.calls.find((call: any) => call.tool === "upload").args;
        expect(dirname(dirname(upload.localPath))).toBe(realpathSync(join(repoRoot, "results", ".tmp")));
        expect(existsSync(upload.localPath)).toBe(false);
        expect(existsSync(dirname(upload.localPath))).toBe(false);
        expect(error.calls.some((call: any) => call.tool === "download")).toBe(false);
        expect(error.calls.filter((call: any) => call.tool === "stop").map((call: any) => call.args.deviceId)).toEqual([error.ids[0]]);
        expect(error.calls.filter((call: any) => call.tool === "delete").map((call: any) => call.args.deviceId)).toEqual([error.ids[0]]);
        expect(error.calls.filter((call: any) => call.tool === "exec" && call.args.command.startsWith("rm -f ")).map((call: any) => call.args)).toEqual([
            expect.objectContaining({ deviceId: error.ids[0], command: `rm -f '${upload.remotePath}'` }),
        ]);
        expect(error.devices.size).toBe(0);
    });
    it("cleans every successfully returned fixture ID when a later clone fails", async () => {
        const error = await fixtureRun(true).catch(error => error);
        expect(error.message).toContain("fixture-clone-failed");
        expect(error.devices.size).toBe(0);
        expect(error.calls.filter((call: any) => call.tool === "delete").map((call: any) => call.args.deviceId).sort()).toEqual(error.ids.slice(0, 2).sort());
    });
    it.each([
        { label: "default allowance", bootTimeoutEnv: undefined, bootTimeoutMs: undefined, expected: 300000 },
        { label: "configured environment allowance", bootTimeoutEnv: "45000", bootTimeoutMs: undefined, expected: 45000 },
        { label: "malformed environment fallback", bootTimeoutEnv: "not-a-timeout", bootTimeoutMs: undefined, expected: 300000 },
        { label: "zero environment fallback", bootTimeoutEnv: "0", bootTimeoutMs: undefined, expected: 300000 },
        { label: "negative environment fallback", bootTimeoutEnv: "-1000", bootTimeoutMs: undefined, expected: 300000 },
        { label: "nonfinite environment fallback", bootTimeoutEnv: "Infinity", bootTimeoutMs: undefined, expected: 300000 },
        { label: "explicit option precedence", bootTimeoutEnv: "90000", bootTimeoutMs: 42000, expected: 42000 },
    ])("waits for boot with the $label when SSH host is absent", async ({ bootTimeoutEnv, bootTimeoutMs, expected }) => {
        const { result, calls, devices, ids } = await fixtureRun(false, { sshHost: null, bootTimeoutEnv, bootTimeoutMs });
        const creates = calls.filter(call => call.tool === "create_macos_vm");
        expect(creates[0].args.ssh).not.toHaveProperty("host");
        expect(calls.filter(call => call.tool === "start").map(call => call.args)).toEqual([
            expect.objectContaining({ deviceId: ids[0], headless: true, waitForBoot: true, bootTimeoutMs: expected }),
        ]);
        const startArgs = calls.find(call => call.tool === "start")!.args;
        expect(realMcpToolRequestTimeoutMs("start", startArgs)).toBe(Math.max(120000, expected + 30000));
        expect(result.status).toBe("PASS");
        expect(devices.size).toBe(0);
    });
});
