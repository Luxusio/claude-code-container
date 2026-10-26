import { afterEach, describe, expect, it, vi } from "vitest";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { realMcpToolRequestTimeoutMs } from "../../scripts/real-tests/device-lab-mcp-client.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    macosVmE2ECapability,
    parseTartListImages,
    runMacosVmE2E,
    selectAutoTartSourceImage,
    selectAutoTartSourceImageFromListResults,
    sshConfig,
    sourceImage,
} from "../../scripts/real-tests/macos-vm-e2e.ts";

const macosFixture = vi.hoisted(() => ({ active: false, callTool: null as any, instances: new Map<string, string>(), stateWrites: [] as any[] }));
vi.mock("child_process", async (original) => {
    const actual = await original<typeof import("child_process")>();
    return { ...actual, spawnSync: (...args: any[]) => macosFixture.active
        ? { status: 0, stdout: "/fixture/tart\n", stderr: "" } : actual.spawnSync.apply(null, args as any) };
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
afterEach(() => { macosFixture.active = false; macosFixture.callTool = null; macosFixture.instances.clear(); macosFixture.stateWrites.length = 0; });

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const cap = macosVmE2ECapability(level);
const destructiveMacosE2EWillRun = level >= 3 && cap.available;
const title = cap.available
    ? `creates, boots, observes, stops, and deletes a real macOS VM through device-lab MCP Tart backend (${cap.source})`
    : `skips macOS VM Tart E2E (${cap.reason})`;

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
        const previousHome = process.env.HOME;
        const previousPath = process.env.PATH;
        const previousUser = process.env.CCC_REAL_MACOS_VM_SSH_USER;
        const previousKey = process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH;
        const previousCompatKey = process.env.CCC_REAL_TART_SSH_KEY_PATH;
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-macos-e2e-home-"));
        const binDir = mkdtempSync(join(tmpdir(), "ccc-macos-e2e-bin-"));
        const sshKeygen = join(binDir, "ssh-keygen");
        try {
            writeFileSync(sshKeygen, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then shift; key="$1"; fi
  shift
done
printf 'private-key' > "$key"
printf 'public-key' > "$key.pub"
exit 0
`);
            chmodSync(sshKeygen, 0o700);
            process.env.HOME = homeDir;
            process.env.PATH = binDir;
            delete process.env.CCC_REAL_MACOS_VM_SSH_USER;
            delete process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH;
            delete process.env.CCC_REAL_TART_SSH_KEY_PATH;

            const ssh = sshConfig();

            expect(ssh).toEqual(expect.objectContaining({
                available: true,
                sshUser: "claudecodecontainer",
                generatedSshKey: true,
            }));
            expect(ssh.sshKeyPath).toContain(join(".ccc", "devices", "real-tests", "macos-vm-ssh", "id_ed25519"));
            expect(readFileSync(ssh.sshKeyPath, "utf-8")).toBe("private-key");
            expect(readFileSync(`${ssh.sshKeyPath}.pub`, "utf-8")).toBe("public-key");
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            if (previousUser === undefined) delete process.env.CCC_REAL_MACOS_VM_SSH_USER;
            else process.env.CCC_REAL_MACOS_VM_SSH_USER = previousUser;
            if (previousKey === undefined) delete process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH;
            else process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH = previousKey;
            if (previousCompatKey === undefined) delete process.env.CCC_REAL_TART_SSH_KEY_PATH;
            else process.env.CCC_REAL_TART_SSH_KEY_PATH = previousCompatKey;
            rmSync(homeDir, { recursive: true, force: true });
            rmSync(binDir, { recursive: true, force: true });
        }
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
    async function fixtureRun(failClone = false, options: { sshHost?: string | null; bootTimeoutEnv?: string; bootTimeoutMs?: number } = {}) {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        const envKeys = ["CCC_REAL_MACOS_VM_SOURCE_IMAGE", "CCC_REAL_MACOS_VM_SSH_USER", "CCC_REAL_MACOS_VM_SSH_HOST", "CCC_REAL_TART_SSH_HOST", "CCC_REAL_MACOS_VM_SSH_KEY_PATH", "CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS"] as const;
        const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
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
                const device = { deviceId: id, name: args.name, status: "stopped", provider: "tart", providerInstance: `native-${id}`, helper: { ssh: { host: "fixture-host", user: "fixture-user" } } };
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
            if (tool === "upload") { transfers.set(args.remotePath, readFileSync(args.localPath, "utf8")); return reply({ provider: "scp", uploaded: { localPath: args.localPath, remotePath: args.remotePath } }); }
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
            process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE = "registry/base";
            process.env.CCC_REAL_MACOS_VM_SSH_USER = "fixture-user";
            if (options.sshHost === null) delete process.env.CCC_REAL_MACOS_VM_SSH_HOST;
            else process.env.CCC_REAL_MACOS_VM_SSH_HOST = options.sshHost ?? "fixture-host";
            delete process.env.CCC_REAL_TART_SSH_HOST;
            process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH = "/fixture/id_ed25519";
            if (options.bootTimeoutEnv === undefined) delete process.env.CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS;
            else process.env.CCC_REAL_MACOS_VM_BOOT_TIMEOUT_MS = options.bootTimeoutEnv;
            const result = await runMacosVmE2E({ level: 2, imageTools: true, snapshot: true, bootTimeoutMs: options.bootTimeoutMs });
            return { result, calls, devices, ids };
        } catch (error) { Object.assign(error as object, { calls, devices, ids }); throw error; }
        finally {
            Object.defineProperty(process, "platform", platform);
            for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
            macosFixture.active = false;
        }
    }
    it("uses returned IDs for guest controls, snapshots, image create, clone and deletion", async () => {
        const { result, calls, devices, ids } = await fixtureRun();
        expect(result.deviceId).toBe(ids[0]);
        expect(devices.size).toBe(0);
        const creates = calls.filter(call => call.tool === "create_macos_vm");
        expect(creates).toHaveLength(3);
        expect(creates[2].args.sourceDeviceId).toBe(ids[0]);
        expect(calls.filter(call => call.tool === "delete").map(call => call.args.deviceId).sort()).toEqual([...ids].sort());
        expect(calls.filter(call => ["exec", "upload", "download", "click", "type", "snapshot"].includes(call.tool)).every(call => call.args.deviceId === ids[0])).toBe(true);
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
