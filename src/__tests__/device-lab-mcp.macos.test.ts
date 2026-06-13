import { existsSync, mkdirSync, readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";
import { cleanupFakeMacosMcpContext, createFakeMacosMcpContext, type FakeMacosMcpContext } from "./helpers/fake-macos-mcp-fixture.js";

describe("macOS VM backend with fake Tart provider", () => {
    let context: FakeMacosMcpContext;
    let logPath: string;

    beforeAll(() => {
        context = createFakeMacosMcpContext();
        logPath = context.logPath;
    });

    afterAll(() => {
        cleanupFakeMacosMcpContext(context);
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
        expect(log).toContain("scp -P 2222 -o BatchMode=yes -o StrictHostKeyChecking=no");
        expect(log).toContain("ccc-guest-helper.sh ccc@127.0.0.1:/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(log).toContain("chmod 700 '/tmp/ccc-macos-fake-tart-guest-helper.sh'");

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
