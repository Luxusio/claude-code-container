import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";

describe("macOS VM backend with fake Tart provider", () => {
    let homeDir: string;
    let binDir: string;
    let logPath: string;
    let oldHome: string | undefined;
    let oldPath: string | undefined;
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-bin-"));
        logPath = join(homeDir, "fake-tart.log");
        const tartPath = join(binDir, "tart");
        writeFileSync(tartPath, `#!/bin/sh
echo "tart $*" >> "$FAKE_TART_LOG"
if [ "$1" = "clone" ]; then
  case "$2" in
    *fail-restore*) exit 8 ;;
    *restore-*fail-activate*) exit 7 ;;
  esac
  case "$3" in
    *fail-snapshot*) exit 9 ;;
  esac
fi
if [ "$1" = "delete" ]; then
  case "$2" in
    *macos-partial-delete) echo "primary delete failed" >&2; exit 6 ;;
    *fail-delete*) echo "delete failed" >&2; exit 6 ;;
  esac
fi
exit 0
`);
        chmodSync(tartPath, 0o755);
        const vzPath = join(binDir, "vz");
        writeFileSync(vzPath, `#!/bin/sh
echo "vz $*" >> "$FAKE_TART_LOG"
exit 0
`);
        chmodSync(vzPath, 0o755);
        const sshPath = join(binDir, "ssh");
writeFileSync(sshPath, `#!/bin/sh
echo "ssh $*" >> "$FAKE_TART_LOG"
case "$*" in
  *screencapture*"-v"*) exec /bin/sleep 20 ;;
  *screencapture*"-x"*) exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' click '22' '33' 'right'"*) echo '{"ok":true,"clicked":{"x":22,"y":33,"button":"right"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' double_click '44' '55' 'left'"*) echo '{"ok":true,"doubleClicked":{"x":44,"y":55,"button":"left"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' key '0' 'command,shift'"*) echo '{"ok":true,"key":{"keyCode":0,"modifiers":"command,shift"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' type"*) echo '{"ok":true,"typed":{"text":"hello '\''mac'\'' {literal}"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' scroll 'left' '4'"*) echo '{"ok":true,"scrolled":{"direction":"left","amount":4},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' cursor_position"*) echo '{"ok":true,"cursor":{"x":101,"y":202},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' window_list"*) echo '{"ok":true,"provider":"macos-system-events","windows":[{"processName":"TextEdit","processId":501,"title":"Notes","role":"AXWindow","position":[10,20],"size":[300,200]}]}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '8' '1000'"*) echo '{"ok":true,"provider":"macos-system-events","accessibility":{"provider":"macos-system-events","maxDepth":8,"maxNodes":1000,"nodeCount":3,"root":{"name":"macOS Desktop","role":"AXApplicationGroup","children":[{"name":"TextEdit","role":"AXApplication","processId":501,"children":[{"name":"Notes","role":"AXWindow","children":[]}]}]}}}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '0' '1'"*) echo '{"ok":true,"provider":"macos-system-events","accessibility":{"provider":"macos-system-events","maxDepth":0,"maxNodes":1,"nodeCount":1,"root":{"name":"macOS Desktop","role":"AXApplicationGroup","children":[]}}}'; exit 0 ;;
  *pkill*) exit 0 ;;
  *rm\\ -f*) exit 0 ;;
  *fail-command*) echo "ssh failure stdout"; echo "ssh failure stderr" >&2; exit 7 ;;
  *) echo "ssh output"; exit 0 ;;
esac
`);
        chmodSync(sshPath, 0o755);
        const scpPath = join(binDir, "scp");
        writeFileSync(scpPath, `#!/bin/sh
echo "scp $*" >> "$FAKE_TART_LOG"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  *fail-helper*) echo "scp helper failure" >&2; exit 5 ;;
  *:*) exit 0 ;;
  *) printf 'fakepng' > "$last"; exit 0 ;;
esac
`);
        chmodSync(scpPath, 0o755);

        oldHome = process.env.HOME;
        oldPath = process.env.PATH;
        process.env.HOME = homeDir;
        process.env.PATH = binDir;
        process.env.FAKE_TART_LOG = logPath;
        platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    });

    afterAll(() => {
        platformSpy?.mockRestore();
        process.env.HOME = oldHome;
        process.env.PATH = oldPath;
        delete process.env.FAKE_TART_LOG;
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    });

    it("plans, starts, stops, and diagnoses helper-required operations without provider calls on create", async () => {
        const create = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fake Tart",
            provider: "auto",
            image: "ghcr.io/example/macos:latest",
            memoryMb: 4096,
            cpus: 2,
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(create?.isError).not.toBe(true);
        const created = JSON.parse(((create?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerPlan: { selectedProvider: string; providerInstance: string; startCommand: { args: string[] }; helper: { workspaceDir: string; hostHelperScript: string; remoteScriptPath: string }; implemented: string[]; deferred: string[] } };
        };
        expect(created.device.id).toBe("macos-fake-tart");
        expect(created.device.providerPlan.selectedProvider).toBe("tart");
        expect(created.device.providerPlan.providerInstance).toContain("macos-fake-tart");
        expect(created.device.providerPlan.startCommand.args).toEqual(["run", created.device.providerPlan.providerInstance]);
        expect(created.device.providerPlan.helper.workspaceDir).toContain("macos-fake-tart");
        expect(created.device.providerPlan.helper.remoteScriptPath).toBe("/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(created.device.providerPlan.implemented).toEqual(expect.arrayContaining(["image-clone", "snapshot-clone", "provider-delete"]));
        expect(created.device.providerPlan.deferred).toEqual([]);
        expect(existsSync(created.device.providerPlan.helper.hostHelperScript)).toBe(false);
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const inventory = await handleMacosTool("device_inventory", { backend: "macos-vm" });
        expect(inventory?.isError).not.toBe(true);
        const inventoryPayload = JSON.parse(((inventory?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; providerPlan: { selectedProvider: string; startCommand: { args: string[] } } }>;
            discovery: { available: boolean; providers: Array<{ name: string }> };
            hostVms: { lazy: boolean; providers: Array<{ name: string }> };
        };
        expect(inventoryPayload.discovery.available).toBe(true);
        expect(inventoryPayload.discovery.providers.map((provider) => provider.name)).toEqual(expect.arrayContaining(["tart", "vz"]));
        expect(inventoryPayload.hostVms).toEqual(expect.objectContaining({ lazy: true }));
        expect(inventoryPayload.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "macos-fake-tart",
                providerPlan: expect.objectContaining({
                    selectedProvider: "tart",
                    startCommand: expect.objectContaining({ args: ["run", created.device.providerPlan.providerInstance] }),
                }),
            }),
        ]));
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const imageCreate = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Base Image",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
            memoryMb: 4096,
            cpus: 2,
        });
        expect(imageCreate?.isError).not.toBe(true);
        const imageCreated = JSON.parse(((imageCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; provider: string; providerInstance: string; imageSource: string; provisioning: string };
        };
        expect(imageCreated.device).toEqual(expect.objectContaining({
            id: "macos-base-image",
            provider: "tart",
            imageSource: "ghcr.io/example/macos-base:latest",
            provisioning: "image-created",
        }));
        expect(imageCreated.device.providerInstance).toContain("macos-base-image");

        const imageClone = await handleMacosTool("device_image_clone", {
            backend: "macos-vm",
            name: "Base Clone",
            sourceDeviceId: "macos-base-image",
        });
        expect(imageClone?.isError).not.toBe(true);
        const imageCloned = JSON.parse(((imageClone?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; provider: string; providerInstance: string; clonedFrom: { deviceId: string; providerInstance: string }; provisioning: string };
        };
        expect(imageCloned.device).toEqual(expect.objectContaining({
            id: "macos-base-clone",
            provider: "tart",
            provisioning: "image-cloned",
        }));
        expect(imageCloned.device.clonedFrom.deviceId).toBe("macos-base-image");
        expect(imageCloned.device.clonedFrom.providerInstance).toBe(imageCreated.device.providerInstance);

        const imageSnapshotForCascadeDelete = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-base-image",
            snapshotName: "Delete Cascade",
        });
        expect(imageSnapshotForCascadeDelete?.isError).not.toBe(true);
        const imageSnapshotPayload = JSON.parse(((imageSnapshotForCascadeDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };

        const startBaseImage = await handleMacosTool("device_start", { deviceId: "macos-base-image" });
        expect(startBaseImage?.isError).not.toBe(true);
        const startedBaseImage = JSON.parse(((startBaseImage?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            helper: { status: string };
            device: { helper: { provisioning: { status: string } } };
        };
        expect(startedBaseImage.helper.status).toBe("skipped-missing-ssh");
        expect(startedBaseImage.device.helper.provisioning.status).toBe("skipped-missing-ssh");
        const baseStatusAfterSkippedHelper = await handleMacosTool("device_status", { deviceId: "macos-base-image" });
        const baseStatusAfterSkippedHelperPayload = JSON.parse(((baseStatusAfterSkippedHelper?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { status: string; provisioning: { status: string } } };
        };
        expect(baseStatusAfterSkippedHelperPayload.device.helper.status).toBe("skipped-missing-ssh");
        expect(baseStatusAfterSkippedHelperPayload.device.helper.provisioning.status).toBe("skipped-missing-ssh");
        const forceClone = await handleMacosTool("device_image_clone", {
            backend: "macos-vm",
            name: "Forced Clone",
            sourceDeviceId: "macos-base-image",
            force: true,
        });
        expect(forceClone?.isError).not.toBe(true);
        const baseStatusAfterForceClone = await handleMacosTool("device_status", { deviceId: "macos-base-image" });
        const baseAfterForceClone = JSON.parse(((baseStatusAfterForceClone?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string };
        };
        expect(baseAfterForceClone.device.status).toBe("stopped");

        const unsupportedProvider = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Unsupported VZ Image",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "vz",
        });
        expect(unsupportedProvider?.isError).toBe(true);
        expect((unsupportedProvider?.content as Array<{ text?: string }>)[0].text).toContain("Tart is currently required");

        const helperFailureCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fail Helper",
            provider: "auto",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(helperFailureCreate?.isError).not.toBe(true);
        const helperFailureStart = await handleMacosTool("device_start", { deviceId: "macos-fail-helper" });
        expect(helperFailureStart?.isError).toBe(true);
        const helperFailurePayload = JSON.parse((helperFailureStart?.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            command: { provider: string; status: number; stderr: string };
            device: { status: string; helper: { provisioning: { status: string; remoteScriptPath: string } } };
        };
        expect(helperFailurePayload).toEqual(expect.objectContaining({
            ok: false,
            error: "macos-helper-scp-failed",
        }));
        expect(helperFailurePayload.command).toEqual(expect.objectContaining({ status: 5, stderr: expect.stringContaining("scp helper failure") }));
        expect(helperFailurePayload.device.status).toBe("running");
        expect(helperFailurePayload.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "failed",
            remoteScriptPath: "/tmp/ccc-macos-fail-helper-guest-helper.sh",
        }));

        const localHelperFailureCreate = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Local Helper Failure",
            provider: "auto",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(localHelperFailureCreate?.isError).not.toBe(true);
        const localHelperFailureCreated = JSON.parse(((localHelperFailureCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { providerPlan: { helper: { hostHelperScript: string } } };
        };
        mkdirSync(localHelperFailureCreated.device.providerPlan.helper.hostHelperScript, { recursive: true });
        const localHelperFailureStart = await handleMacosTool("device_start", { deviceId: "macos-local-helper-failure" });
        expect(localHelperFailureStart?.isError).toBe(true);
        const localHelperFailurePayload = JSON.parse((localHelperFailureStart?.content as Array<{ text?: string }>)[0].text ?? "{}") as {
            ok: boolean;
            error: string;
            device: { status: string; helper: { provisioning: { status: string; provider: string } } };
        };
        expect(localHelperFailurePayload).toEqual(expect.objectContaining({
            ok: false,
            error: "macos-helper-write-failed",
        }));
        expect(localHelperFailurePayload.device.status).toBe("running");
        expect(localHelperFailurePayload.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "failed",
            provider: "local",
        }));

        const deleteFailureCreate = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Fail Delete",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
        });
        expect(deleteFailureCreate?.isError).not.toBe(true);
        const deleteFailureCreated = JSON.parse(((deleteFailureCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerInstance: string };
        };
        expect(deleteFailureCreated.device.providerInstance).toContain("fail-delete");
        const deleteFailure = await handleMacosTool("device_delete", { deviceId: "macos-fail-delete" });
        expect(deleteFailure?.isError).toBe(true);
        expect((deleteFailure?.content as Array<{ text?: string }>)[0].text).toContain("delete failed");
        const deleteFailureStillPresent = await handleMacosTool("device_status", { deviceId: "macos-fail-delete" });
        expect(deleteFailureStillPresent?.isError).not.toBe(true);

        const partialDeleteCreate = await handleMacosTool("device_image_create", {
            backend: "macos-vm",
            name: "Partial Delete",
            sourceImage: "ghcr.io/example/macos-base:latest",
            provider: "auto",
        });
        expect(partialDeleteCreate?.isError).not.toBe(true);
        const partialDeleteCreated = JSON.parse(((partialDeleteCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerInstance: string };
        };
        const partialDeleteSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-partial-delete",
            snapshotName: "Retry Safe",
        });
        expect(partialDeleteSnapshot?.isError).not.toBe(true);
        const partialDeleteSnapshotPayload = JSON.parse(((partialDeleteSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const partialDelete = await handleMacosTool("device_delete", { deviceId: "macos-partial-delete" });
        expect(partialDelete?.isError).toBe(true);
        expect((partialDelete?.content as Array<{ text?: string }>)[0].text).toContain("primary delete failed");
        const partialDeleteStatus = await handleMacosTool("device_status", { deviceId: "macos-partial-delete" });
        const partialDeleteStillPresent = JSON.parse(((partialDeleteStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { snapshots: unknown[] };
        };
        expect(partialDeleteStillPresent.device.snapshots).toEqual([]);
        const logBeforePartialRetry = readFileSync(logPath, "utf-8");
        const partialDeleteRetry = await handleMacosTool("device_delete", { deviceId: "macos-partial-delete" });
        expect(partialDeleteRetry?.isError).toBe(true);
        const partialRetryDelta = readFileSync(logPath, "utf-8").slice(logBeforePartialRetry.length);
        expect(partialRetryDelta).toContain(`tart delete ${partialDeleteCreated.device.providerInstance}`);
        expect(partialRetryDelta).not.toContain(partialDeleteSnapshotPayload.snapshot.providerInstance);

        const start = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(start?.isError).not.toBe(true);
        const started = JSON.parse(((start?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; provider: string; providerInstance: string; helper: { hostHelperScript: string; remoteScriptPath: string; provisioning: { status: string; provider: string; localScriptPath: string; remoteScriptPath: string } } };
            helper: { status: string; provider: string };
        };
        expect(started.device.status).toBe("running");
        expect(started.device.provider).toBe("tart");
        expect(started.helper).toEqual(expect.objectContaining({ status: "provisioned", provider: "ssh-scp" }));
        expect(started.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "provisioned",
            provider: "ssh-scp",
            localScriptPath: started.device.helper.hostHelperScript,
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
        }));
        const hostHelperScript = readFileSync(started.device.helper.hostHelperScript, "utf-8");
        expect(hostHelperScript).toContain("ccc macOS guest helper for macos-fake-tart");
        expect(hostHelperScript).toContain("window_list)");
        expect(hostHelperScript).toContain("accessibility_snapshot)");
        expect(hostHelperScript).toContain("macos-system-events");
        const startedStatus = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const startedStatusPayload = JSON.parse(((startedStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backend: { capabilities: string[] };
        };
        expect(startedStatusPayload.backend.capabilities).toEqual(expect.arrayContaining([
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_window_list",
            "device_accessibility_snapshot",
        ]));

        const snapshotWhileRunning = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(snapshotWhileRunning?.isError).toBe(true);
        expect((snapshotWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to snapshot");

        const failingSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Snapshot",
            force: true,
        });
        expect(failingSnapshot?.isError).toBe(true);
        const statusAfterFailingSnapshot = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const failingSnapshotStatus = JSON.parse(((statusAfterFailingSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: unknown[] };
        };
        expect(failingSnapshotStatus.device.status).toBe("stopped");
        expect(failingSnapshotStatus.device.snapshots || []).toEqual([]);

        const restartAfterFailedSnapshot = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterFailedSnapshot?.isError).not.toBe(true);

        const snapshotCreate = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
            force: true,
        });
        expect(snapshotCreate?.isError).not.toBe(true);
        const snapshotCreated = JSON.parse(((snapshotCreate?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: Array<{ id: string; name: string; providerInstance: string }> };
            snapshot: { id: string; name: string; providerInstance: string };
        };
        expect(snapshotCreated.device.status).toBe("stopped");
        expect(snapshotCreated.snapshot).toEqual(expect.objectContaining({
            id: "snapshot-before-install",
            name: "Before Install",
        }));
        expect(snapshotCreated.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-before-install", name: "Before Install" }),
        ]));

        const restartAfterSnapshot = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterSnapshot?.isError).not.toBe(true);

        const restoreWhileRunning = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(restoreWhileRunning?.isError).toBe(true);
        expect((restoreWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to restore");

        const failingRestore = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
            force: true,
        });
        expect(failingRestore?.isError).not.toBe(true);
        const restartBeforeFailRestore = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeFailRestore?.isError).not.toBe(true);
        const logBeforeFailedRestore = readFileSync(logPath, "utf-8");
        const restoreCloneFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
            force: true,
        });
        expect(restoreCloneFailure?.isError).toBe(true);
        const failedRestoreLogDelta = readFileSync(logPath, "utf-8").slice(logBeforeFailedRestore.length);
        expect(failedRestoreLogDelta).toContain("fail-restore");
        expect(failedRestoreLogDelta).not.toContain(`tart delete ${started.device.providerInstance}`);
        const statusAfterFailedRestore = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const failedRestoreStatus = JSON.parse(((statusAfterFailedRestore?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; snapshots: Array<{ name: string }> };
        };
        expect(failedRestoreStatus.device.status).toBe("stopped");
        expect(failedRestoreStatus.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "Fail Restore" }),
        ]));

        const activationFailureSnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
            force: true,
        });
        expect(activationFailureSnapshot?.isError).not.toBe(true);
        const activationSnapshotPayload = JSON.parse(((activationFailureSnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const restartBeforeActivationFailure = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeActivationFailure?.isError).not.toBe(true);
        const logBeforeActivationFailure = readFileSync(logPath, "utf-8");
        const activationFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
            force: true,
        });
        expect(activationFailure?.isError).toBe(true);
        expect((activationFailure?.content as Array<{ text?: string }>)[0].text).toContain("Restore candidate preserved");
        const activationFailureDelta = readFileSync(logPath, "utf-8").slice(logBeforeActivationFailure.length);
        expect(activationFailureDelta).toContain(activationSnapshotPayload.snapshot.providerInstance);
        expect(activationFailureDelta).toContain("fail-activate");
        const preservedCandidate = activationFailureDelta
            .split("\n")
            .find((line) => line.includes("fail-activate"))?.split(" ").pop() || "";
        expect(preservedCandidate).toContain("restore-");
        expect(activationFailureDelta).not.toContain(`tart delete ${preservedCandidate}`);
        const statusAfterActivationFailure = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const activationFailureStatus = JSON.parse(((statusAfterActivationFailure?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { restoreRecovery: { candidateProviderInstance: string; snapshotName: string } };
        };
        expect(activationFailureStatus.device.restoreRecovery).toEqual(expect.objectContaining({
            candidateProviderInstance: preservedCandidate,
            snapshotName: "Fail Activate",
        }));

        const snapshotRestore = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
            force: true,
        });
        expect(snapshotRestore?.isError).not.toBe(true);
        const restored = JSON.parse(((snapshotRestore?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; restoredFrom: { id: string; name: string } };
        };
        expect(restored.device.status).toBe("stopped");
        expect(restored.device.restoredFrom).toEqual(expect.objectContaining({
            id: "snapshot-before-install",
            name: "Before Install",
        }));

        const snapshotDelete = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Before Install",
        });
        expect(snapshotDelete?.isError).not.toBe(true);
        const snapshotDeleted = JSON.parse(((snapshotDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(snapshotDeleted.deleted).toBe("snapshot-before-install");
        expect(snapshotDeleted.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-fail-restore" }),
        ]));
        expect(snapshotDeleted.device.snapshots).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-before-install" }),
        ]));

        const failRestoreSnapshotDeleted = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Restore",
        });
        expect(failRestoreSnapshotDeleted?.isError).not.toBe(true);
        const failRestoreDeleted = JSON.parse(((failRestoreSnapshotDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(failRestoreDeleted.deleted).toBe("snapshot-fail-restore");
        expect(failRestoreDeleted.device.snapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "snapshot-fail-activate" }),
        ]));

        const failActivateSnapshotDeleted = await handleMacosTool("device_snapshot_delete", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate",
        });
        expect(failActivateSnapshotDeleted?.isError).not.toBe(true);
        const failActivateDeleted = JSON.parse(((failActivateSnapshotDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            device: { snapshots: unknown[] };
        };
        expect(failActivateDeleted.deleted).toBe("snapshot-fail-activate");
        expect(failActivateDeleted.device.snapshots).toEqual([]);

        const restartAfterRestore = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartAfterRestore?.isError).not.toBe(true);

        const cloneWhileRunning = await handleMacosTool("device_image_clone", {
            backend: "macos-vm",
            name: "Running Clone",
            sourceDeviceId: "macos-fake-tart",
        });
        expect(cloneWhileRunning?.isError).toBe(true);
        expect((cloneWhileRunning?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to clone");

        const exec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "whoami" });
        expect(exec?.isError).not.toBe(true);
        expect((exec?.content as Array<{ text?: string }>)[0].text).toContain("ssh output");

        const failedExec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "fail-command" });
        expect(failedExec?.isError).not.toBe(true);
        const failedExecPayload = JSON.parse(((failedExec?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stdout: string;
            stderr: string;
            status: number;
        };
        expect(failedExecPayload.stdout).toContain("ssh failure stdout");
        expect(failedExecPayload.stderr).toContain("ssh failure stderr");
        expect(failedExecPayload.status).toBe(7);

        const uploadSource = join(homeDir, "mac-upload.txt");
        writeFileSync(uploadSource, "upload");
        const upload = await handleMacosTool("device_upload", { deviceId: "macos-fake-tart", localPath: uploadSource, remotePath: "/tmp/mac-upload.txt" });
        expect(upload?.isError).not.toBe(true);

        const downloadTarget = join(homeDir, "mac-download.txt");
        const download = await handleMacosTool("device_download", { deviceId: "macos-fake-tart", remotePath: "/tmp/mac-download.txt", localPath: downloadTarget });
        expect(download?.isError).not.toBe(true);
        expect(readFileSync(downloadTarget, "utf-8")).toBe("fakepng");

        const screenshot = await handleMacosTool("device_screenshot", { deviceId: "macos-fake-tart" });
        expect(screenshot?.isError).not.toBe(true);
        expect((screenshot?.content as Array<{ type: string }>)[0].type).toBe("image");

        const click = await handleMacosTool("device_click", {
            deviceId: "macos-fake-tart",
            x: 22,
            y: 33,
            button: "right",
        });
        expect(click?.isError).not.toBe(true);
        expect(JSON.parse(((click?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "ssh-macos-helper",
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
            clicked: { x: 22, y: 33, button: "right" },
        }));

        const doubleClick = await handleMacosTool("device_double_click", {
            deviceId: "macos-fake-tart",
            x: 44,
            y: 55,
        });
        expect(doubleClick?.isError).not.toBe(true);
        expect(JSON.parse(((doubleClick?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "ssh-macos-helper",
            doubleClicked: { x: 44, y: 55, button: "left" },
        }));

        const key = await handleMacosTool("device_key", {
            deviceId: "macos-fake-tart",
            key: "Command+Shift+A",
        });
        expect(key?.isError).not.toBe(true);
        expect(JSON.parse(((key?.content as Array<{ text?: string }>)[0].text ?? "{}")).key).toEqual({
            key: "Command+Shift+A",
            keyCode: 0,
            modifiers: ["command", "shift"],
        });

        const unsupportedKey = await handleMacosTool("device_key", {
            deviceId: "macos-fake-tart",
            key: "Hyper+Nope",
        });
        expect(unsupportedKey?.isError).toBe(true);
        expect((unsupportedKey?.content as Array<{ text?: string }>)[0].text).toContain("Unsupported macOS key expression");
        const unsupportedModifier = await handleMacosTool("device_key", {
            deviceId: "macos-fake-tart",
            key: "Hyper+A",
        });
        expect(unsupportedModifier?.isError).toBe(true);
        expect((unsupportedModifier?.content as Array<{ text?: string }>)[0].text).toContain("Unsupported macOS key expression");

        const type = await handleMacosTool("device_type", {
            deviceId: "macos-fake-tart",
            text: "hello 'mac' {literal}",
        });
        expect(type?.isError).not.toBe(true);
        expect(JSON.parse(((type?.content as Array<{ text?: string }>)[0].text ?? "{}")).typed).toEqual({
            text: "hello 'mac' {literal}",
        });

        const scroll = await handleMacosTool("device_scroll", {
            deviceId: "macos-fake-tart",
            direction: "left",
            amount: 4,
        });
        expect(scroll?.isError).not.toBe(true);
        expect(JSON.parse(((scroll?.content as Array<{ text?: string }>)[0].text ?? "{}")).scrolled).toEqual({
            direction: "left",
            amount: 4,
        });

        const cursor = await handleMacosTool("device_cursor_position", { deviceId: "macos-fake-tart" });
        expect(cursor?.isError).not.toBe(true);
        expect(JSON.parse(((cursor?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "ssh-macos-helper",
            cursor: { x: 101, y: 202 },
        }));

        const windowList = await handleMacosTool("device_window_list", { deviceId: "macos-fake-tart" });
        expect(windowList?.isError).not.toBe(true);
        expect(JSON.parse(((windowList?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "macos-system-events",
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
            windows: [
                expect.objectContaining({
                    processName: "TextEdit",
                    processId: 501,
                    title: "Notes",
                    role: "AXWindow",
                    position: [10, 20],
                    size: [300, 200],
                }),
            ],
        }));

        const accessibilitySnapshot = await handleMacosTool("device_accessibility_snapshot", {
            deviceId: "macos-fake-tart",
            maxDepth: 99,
            maxNodes: 5000,
        });
        expect(accessibilitySnapshot?.isError).not.toBe(true);
        const accessibilitySnapshotPayload = JSON.parse(((accessibilitySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            remoteScriptPath: string;
            accessibility: {
                provider: string;
                maxDepth: number;
                maxNodes: number;
                nodeCount: number;
                root: { name: string; role: string; children: Array<{ name: string; role: string; children: Array<{ name: string; role: string }> }> };
            };
        };
        expect(accessibilitySnapshotPayload.provider).toBe("macos-system-events");
        expect(accessibilitySnapshotPayload.remoteScriptPath).toBe("/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(accessibilitySnapshotPayload.accessibility).toEqual(expect.objectContaining({
            provider: "macos-system-events",
            maxDepth: 8,
            maxNodes: 1000,
            nodeCount: 3,
        }));
        expect(accessibilitySnapshotPayload.accessibility.root.children[0]).toEqual(expect.objectContaining({
            name: "TextEdit",
            role: "AXApplication",
            children: [expect.objectContaining({ name: "Notes", role: "AXWindow" })],
        }));

        const minimumAccessibilitySnapshot = await handleMacosTool("device_accessibility_snapshot", {
            deviceId: "macos-fake-tart",
            maxDepth: -9,
            maxNodes: 0,
        });
        expect(minimumAccessibilitySnapshot?.isError).not.toBe(true);
        expect(JSON.parse(((minimumAccessibilitySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")).accessibility).toEqual(expect.objectContaining({
            maxDepth: 0,
            maxNodes: 1,
            nodeCount: 1,
            root: expect.objectContaining({ children: [] }),
        }));

        const initialRecordStatus = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(initialRecordStatus?.isError).not.toBe(true);
        expect(JSON.parse(((initialRecordStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopWithoutRecording = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(stopWithoutRecording?.isError).toBe(true);
        expect((stopWithoutRecording?.content as Array<{ text?: string }>)[0].text).toContain("No macOS VM recording active");

        const recordStart = await handleMacosTool("device_record_video_start", {
            deviceId: "macos-fake-tart",
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
            timeLimitSec: 3,
        });
        expect(recordStart?.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; provider: string; remotePath: string; localPath: string };
        };
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "ssh-screencapture-video",
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
        }));

        const duplicateRecordStart = await handleMacosTool("device_record_video_start", { deviceId: "macos-fake-tart" });
        expect(duplicateRecordStart?.isError).toBe(true);
        expect((duplicateRecordStart?.content as Array<{ text?: string }>)[0].text).toContain("macOS VM recording already active");

        const activeRecordStatus = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(activeRecordStatus?.isError).not.toBe(true);
        expect(JSON.parse(((activeRecordStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: true,
            provider: "ssh-screencapture-video",
        }));

        const recordStop = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(recordStop?.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            localPath: join(homeDir, "custom-macos-recording.mov"),
        }));
        expect(recordStopPayload.device.recording).toBeNull();
        expect(readFileSync(join(homeDir, "custom-macos-recording.mov"), "utf-8")).toBe("fakepng");

        const stop = await handleMacosTool("device_stop", { deviceId: "macos-fake-tart" });
        expect(stop?.isError).not.toBe(true);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`tart run ${started.device.providerInstance}`);
        expect(log).toContain(`tart stop ${started.device.providerInstance}`);
        expect(log).toContain(`tart clone ghcr.io/example/macos-base:latest ${imageCreated.device.providerInstance}`);
        expect(log).toContain(`tart clone ${imageCreated.device.providerInstance} ${imageCloned.device.providerInstance}`);
        expect(log).toContain(`tart clone ${imageCreated.device.providerInstance} `);
        expect(log).toContain(`tart clone ${started.device.providerInstance} ${snapshotCreated.snapshot.providerInstance}`);
        expect(log).toContain("tart clone ");
        expect(log).toContain("fail-snapshot");
        expect(log).toContain("fail-restore");
        expect(log).toContain(`tart delete ${started.device.providerInstance}`);
        expect(log).toContain(`tart clone ${snapshotCreated.snapshot.providerInstance} `);
        expect(log).toContain(`tart clone ${started.device.providerInstance}-restore-`);
        expect(log).toContain(`tart delete ${snapshotCreated.snapshot.providerInstance}`);
        expect(log).not.toContain("vz clone");
        expect(log).toContain("ssh -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no ccc@127.0.0.1 whoami");
        expect(log).toContain("scp -P 2222 -o BatchMode=yes -o StrictHostKeyChecking=no");
        expect(log).toContain("ccc-guest-helper.sh ccc@127.0.0.1:/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(log).toContain("chmod 700 '/tmp/ccc-macos-fake-tart-guest-helper.sh'");
        expect(log).toContain("screencapture -x /tmp/ccc-macos-fake-tart-screenshot.png");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' click '22' '33' 'right'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' double_click '44' '55' 'left'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' key '0' 'command,shift'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' type 'hello '\\''mac'\\'' {literal}'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' scroll 'left' '4'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' cursor_position");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' window_list");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '8' '1000'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '0' '1'");
        expect(log).toContain("screencapture -v '/tmp/custom-macos-recording.mov'");
        expect(log).toContain("pkill -INT -f");
        expect(log).toContain("ccc@127.0.0.1:/tmp/custom-macos-recording.mov");

        const startCloneBeforeDelete = await handleMacosTool("device_start", { deviceId: "macos-base-clone" });
        expect(startCloneBeforeDelete?.isError).not.toBe(true);
        const runningCloneDelete = await handleMacosTool("device_delete", { deviceId: "macos-base-clone" });
        expect(runningCloneDelete?.isError).toBe(true);
        expect((runningCloneDelete?.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete macos-base-clone while status is running");
        const clonedDeleted = await handleMacosTool("device_delete", { deviceId: "macos-base-clone", force: true });
        expect(clonedDeleted?.isError).not.toBe(true);
        const clonedDeletedPayload = JSON.parse(((clonedDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(clonedDeletedPayload.providerDeleted).toContain(imageCloned.device.providerInstance);
        const forcedClonedDeleted = await handleMacosTool("device_delete", { deviceId: "macos-forced-clone" });
        expect(forcedClonedDeleted?.isError).not.toBe(true);
        const imageDeleted = await handleMacosTool("device_delete", { deviceId: "macos-base-image" });
        expect(imageDeleted?.isError).not.toBe(true);
        const imageDeletedPayload = JSON.parse(((imageDeleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(imageDeletedPayload.providerDeleted).toContain(imageSnapshotPayload.snapshot.providerInstance);
        expect(imageDeletedPayload.providerDeleted).toContain(imageCreated.device.providerInstance);

        const recoverySnapshot = await handleMacosTool("device_snapshot_create", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate Delete",
        });
        expect(recoverySnapshot?.isError).not.toBe(true);
        const recoverySnapshotPayload = JSON.parse(((recoverySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            snapshot: { providerInstance: string };
        };
        const restartBeforeRecoveryDelete = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(restartBeforeRecoveryDelete?.isError).not.toBe(true);
        const recoveryRestoreFailure = await handleMacosTool("device_snapshot_restore", {
            deviceId: "macos-fake-tart",
            snapshotName: "Fail Activate Delete",
            force: true,
        });
        expect(recoveryRestoreFailure?.isError).toBe(true);
        const statusBeforeRecoveryDelete = await handleMacosTool("device_status", { deviceId: "macos-fake-tart" });
        const recoveryDeleteStatus = JSON.parse(((statusBeforeRecoveryDelete?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { restoreRecovery: { candidateProviderInstance: string } };
        };
        expect(recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance).toContain("restore-");
        const deleted = await handleMacosTool("device_delete", { deviceId: "macos-fake-tart" });
        expect(deleted?.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            providerDeleted: string[];
        };
        expect(deletedPayload.providerDeleted).toEqual(expect.arrayContaining([
            recoverySnapshotPayload.snapshot.providerInstance,
            recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance,
        ]));

        const deleteLog = readFileSync(logPath, "utf-8");
        expect(deleteLog).toContain(`tart stop ${imageCloned.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageCloned.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageSnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${imageCreated.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${deleteFailureCreated.device.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${partialDeleteSnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${recoverySnapshotPayload.snapshot.providerInstance}`);
        expect(deleteLog).toContain(`tart delete ${recoveryDeleteStatus.device.restoreRecovery.candidateProviderInstance}`);
    });
});
