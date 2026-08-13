import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    clearHyperVOperationJournal,
    clearHyperVSnapshotJournal,
    hyperVOperationJournalPath,
    hyperVSnapshotJournalPath,
    readHyperVOperationJournal,
    readHyperVSnapshotJournal,
    writeHyperVOperationJournal,
    writeHyperVSnapshotJournal,
    type HyperVJournalPersistenceRuntime,
} from "../device-lab/broker/hyper-v/operation-journal.js";
import { hyperVSnapshotName, hyperVVmName } from "../host-control/hyper-v/index.js";

const OWNER_ID = "0123456789abcdef";
const DEVICE_ID = "journal-test";
const INCARNATION_ID = "a".repeat(32);
const VM_ID = "11111111-2222-3333-4444-555555555555";
const SNAPSHOT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function testRuntime(
    journalLimitBytes = 16 * 1024,
): {
    runtime: HyperVJournalPersistenceRuntime;
    privateRoot: string;
    deviceRoot: string;
    diskPath: string;
} {
    const root = mkdtempSync(join(tmpdir(), "ccc-hyper-v-journal-"));
    roots.push(root);
    const privateRoot = join(root, "private");
    const deviceRoot = join(privateRoot, "artifacts");
    const diskPath = join(deviceRoot, "disks", "root.vhdx");
    mkdirSync(join(deviceRoot, "disks"), { recursive: true });
    const device = {
        id: DEVICE_ID,
        incarnationId: INCARNATION_ID,
        vmId: VM_ID,
        vmName: hyperVVmName(OWNER_ID, DEVICE_ID, INCARNATION_ID),
        diskPath,
    };
    return {
        privateRoot,
        deviceRoot,
        diskPath,
        runtime: {
            deviceRoot: () => deviceRoot,
            ensurePrivateDeviceRoot: () => privateRoot,
            readDevices: () => [device],
            journalLimitBytes,
        },
    };
}

describe("Hyper-V operation journal persistence", () => {
    it("round-trips and clears a snapshot journal with a normalized snapshot id", () => {
        const { runtime } = testRuntime();
        const snapshotName = "before-upgrade";
        const providerName = hyperVSnapshotName(OWNER_ID, snapshotName);

        writeHyperVSnapshotJournal(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
            INCARNATION_ID,
            "device_snapshot_restore",
            snapshotName,
            providerName,
            SNAPSHOT_ID.toUpperCase(),
        );

        expect(readHyperVSnapshotJournal(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        )).toMatchObject({
            ownerId: OWNER_ID,
            deviceId: DEVICE_ID,
            incarnationId: INCARNATION_ID,
            tool: "device_snapshot_restore",
            snapshotName,
            providerName,
            snapshotId: SNAPSHOT_ID,
        });

        clearHyperVSnapshotJournal(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        );
        expect(existsSync(hyperVSnapshotJournalPath(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        ))).toBe(false);
    });

    it("persists the expected checkpoint policy before snapshot creation", () => {
        const { runtime } = testRuntime();
        const snapshotName = "production-checkpoint";
        writeHyperVSnapshotJournal(
            runtime,
            OWNER_ID,
            "linux-vm",
            DEVICE_ID,
            INCARNATION_ID,
            "device_snapshot_create",
            snapshotName,
            hyperVSnapshotName(OWNER_ID, snapshotName),
            undefined,
            "Production",
        );

        expect(readHyperVSnapshotJournal(runtime, OWNER_ID, "linux-vm", DEVICE_ID))
            .toMatchObject({ expectedCheckpointPolicy: "Production" });
    });

    it("rejects forged snapshot provider names and missing destructive ids", () => {
        const { runtime } = testRuntime();
        const path = hyperVSnapshotJournalPath(
            runtime,
            OWNER_ID,
            "linux-vm",
            DEVICE_ID,
        );
        writeFileSync(path, JSON.stringify({
            version: 1,
            operationId: VM_ID,
            ownerId: OWNER_ID,
            deviceId: DEVICE_ID,
            incarnationId: INCARNATION_ID,
            tool: "device_snapshot_delete",
            snapshotName: "baseline",
            providerName: "foreign-snapshot",
            startedAt: new Date().toISOString(),
        }));

        expect(() => readHyperVSnapshotJournal(
            runtime,
            OWNER_ID,
            "linux-vm",
            DEVICE_ID,
        )).toThrow(/hyper-v-snapshot-journal/);
    });

    it("round-trips a lifecycle journal and preserves its fenced disk path", () => {
        const { runtime, diskPath } = testRuntime();
        const written = writeHyperVOperationJournal(runtime, OWNER_ID, {
            backend: "windows-vm",
            stateKey: "windows-vm",
            command: "device_reboot",
            deviceId: DEVICE_ID,
        });

        expect(written.ok).toBe(true);
        expect(readHyperVOperationJournal(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        )).toMatchObject({
            ownerId: OWNER_ID,
            deviceId: DEVICE_ID,
            incarnationId: INCARNATION_ID,
            command: "device_reboot",
            vmId: VM_ID,
            vmName: hyperVVmName(OWNER_ID, DEVICE_ID, INCARNATION_ID),
            diskPath,
        });

        clearHyperVOperationJournal(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        );
        expect(existsSync(hyperVOperationJournalPath(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        ))).toBe(false);
    });

    it("rejects a lifecycle journal whose disk escapes the device root", () => {
        const { runtime } = testRuntime();
        const path = hyperVOperationJournalPath(
            runtime,
            OWNER_ID,
            "linux-vm",
            DEVICE_ID,
        );
        writeFileSync(path, JSON.stringify({
            version: 1,
            operationId: VM_ID,
            ownerId: OWNER_ID,
            deviceId: DEVICE_ID,
            incarnationId: INCARNATION_ID,
            command: "device_start",
            vmId: VM_ID,
            vmName: hyperVVmName(OWNER_ID, DEVICE_ID, INCARNATION_ID),
            diskPath: join(tmpdir(), "foreign-root.vhdx"),
            startedAt: new Date().toISOString(),
        }));

        expect(() => readHyperVOperationJournal(
            runtime,
            OWNER_ID,
            "linux-vm",
            DEVICE_ID,
        )).toThrow();
    });

    it("enforces the configured journal read limit", () => {
        const { runtime } = testRuntime(128);
        const path = hyperVSnapshotJournalPath(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        );
        writeFileSync(path, JSON.stringify({
            padding: "x".repeat(1024),
        }));

        expect(() => readHyperVSnapshotJournal(
            runtime,
            OWNER_ID,
            "windows-vm",
            DEVICE_ID,
        )).toThrow();
    });

    it("does not import the broker composition root", () => {
        const source = readFileSync(
            new URL(
                "../device-lab/broker/hyper-v/operation-journal.ts",
                import.meta.url,
            ),
            "utf8",
        );

        expect(source).not.toMatch(/device-lab-broker/);
    });
});
