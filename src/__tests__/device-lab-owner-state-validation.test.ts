import { linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    OWNER_DEVICE_STATE_FILE_LIMIT_BYTES,
    readOwnerDeviceStateFile,
} from "../device-lab-owner-state.js";
import { readOwnerDeviceStateFile as readMcpOwnerDeviceStateFile } from "../../device-lab-mcp/src/state/owner-device-state.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import {
    mutateOwnerDevices,
    ownerStateFile,
    readOwnerDevices,
    transitionOwnerDeviceRecord,
    writeOwnerDevices,
} from "../../device-lab-mcp/src/state/device-store.mjs";

describe("owner device state validation", () => {
    let homeDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        homeDir = join(tmpdir(), `ccc-owner-state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        process.env.HOME = homeDir;
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    function expectStateError(operation: () => unknown, code: string) {
        try {
            operation();
            throw new Error("expected owner device state operation to fail");
        } catch (error) {
            expect(error).toEqual(expect.objectContaining({ name: "OwnerDeviceStateError", code }));
        }
    }

    it("treats only a missing state file as an empty owner state", () => {
        const file = join(homeDir, "missing", "devices.json");
        expect(readOwnerDeviceStateFile(file)).toEqual([]);
    });

    it.each([
        ["malformed JSON", "{not-json"],
        ["missing devices array", JSON.stringify({})],
        ["non-object entry", JSON.stringify({ devices: [null] })],
        ["missing id", JSON.stringify({ devices: [{ name: "missing" }] })],
        ["empty id", JSON.stringify({ devices: [{ id: "" }] })],
        ["dot id", JSON.stringify({ devices: [{ id: ".." }] })],
        ["path traversal id", JSON.stringify({ devices: [{ id: "../../outside" }] })],
        ["Windows path id", JSON.stringify({ devices: [{ id: "..\\outside" }] })],
        ["absolute path id", JSON.stringify({ devices: [{ id: "/tmp/outside" }] })],
        ["non-ASCII id", JSON.stringify({ devices: [{ id: "device-테스트" }] })],
        ["oversized id", JSON.stringify({ devices: [{ id: "a".repeat(129) }] })],
        ["duplicate id", JSON.stringify({ devices: [{ id: "same" }, { id: "same" }] })],
    ])("rejects %s without replacing the original bytes", (_label, contents) => {
        const file = ownerStateFile("android");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, contents);

        expectStateError(() => readOwnerDeviceStateFile(file), "owner-devices-state-invalid");
        expectStateError(() => readMcpOwnerDeviceStateFile(file), "owner-devices-state-invalid");
        expectStateError(() => readOwnerDevices("android"), "owner-devices-state-invalid");
        expectStateError(() => mutateOwnerDevices("android", () => [{ id: "replacement" }]), "owner-devices-state-invalid");
        expectStateError(() => writeOwnerDevices("android", [{ id: "replacement" }]), "owner-devices-state-invalid");
        expect(readFileSync(file, "utf8")).toBe(contents);
    });

    it("advertises the persisted device-id contract on every public deviceId input", () => {
        const properties = TOOLS.flatMap((tool) => {
            const deviceId = tool.inputSchema?.properties?.deviceId;
            return deviceId ? [{ tool: tool.name, deviceId }] : [];
        });
        expect(properties.length).toBeGreaterThan(60);
        for (const { tool, deviceId } of properties) {
            expect(deviceId, tool).toEqual(expect.objectContaining({
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^(?!\\.\\.?$)[A-Za-z0-9._-]+$",
            }));
        }
    });

    it("rejects oversized state before parsing and preserves it", () => {
        const file = ownerStateFile("android");
        const contents = "x".repeat(OWNER_DEVICE_STATE_FILE_LIMIT_BYTES + 1);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, contents);

        expectStateError(() => mutateOwnerDevices("android", () => []), "owner-devices-file-too-large");
        expect(readFileSync(file, "utf8")).toBe(contents);
    });

    it.runIf(process.platform === "linux")("bounds reads even when the filesystem reports a stale zero size", () => {
        const procFile = "/proc/self/status";
        expectStateError(() => readOwnerDeviceStateFile(procFile, 8), "owner-devices-file-too-large");
        expectStateError(() => readMcpOwnerDeviceStateFile(procFile, 8), "owner-devices-file-too-large");
    });

    it("rejects a mutation that would create an unreadable oversized state", () => {
        const file = ownerStateFile("android");
        const contents = JSON.stringify({ devices: [{ id: "existing" }] });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, contents);
        const replacement = [{ id: "replacement", payload: "x".repeat(OWNER_DEVICE_STATE_FILE_LIMIT_BYTES) }];

        expectStateError(() => mutateOwnerDevices("android", () => replacement), "owner-devices-file-too-large");
        expectStateError(() => writeOwnerDevices("android", replacement), "owner-devices-file-too-large");
        expect(readFileSync(file, "utf8")).toBe(contents);
    });

    it("atomically preserves a changed same-id successor", () => {
        const original = { id: "device-1", status: "starting", runtime: { runtimeId: "old" } };
        const successor = { id: "device-1", status: "running", runtime: { runtimeId: "successor" } };
        writeOwnerDevices("android", [successor]);

        const stale = transitionOwnerDeviceRecord("android", original.id, original, null);
        expect(stale).toEqual(expect.objectContaining({ found: true, matched: false, currentDevice: successor }));
        expect(readOwnerDevices("android")).toEqual([successor]);

        const current = transitionOwnerDeviceRecord("android", successor.id, successor, { ...successor, status: "stopped" });
        expect(current).toEqual(expect.objectContaining({ found: true, matched: true }));
        expect(readOwnerDevices("android")).toEqual([{ ...successor, status: "stopped" }]);
    });

    it("rejects symbolic and hard-linked state files without touching their targets", () => {
        const target = join(homeDir, "external.json");
        const contents = JSON.stringify({ devices: [{ id: "external" }] });
        mkdirSync(homeDir, { recursive: true });
        writeFileSync(target, contents);
        for (const kind of ["symbolic", "hard"] as const) {
            const file = join(homeDir, kind, "devices.json");
            mkdirSync(dirname(file), { recursive: true });
            if (kind === "symbolic") symlinkSync(target, file);
            else linkSync(target, file);
            expectStateError(() => readOwnerDeviceStateFile(file), "owner-devices-state-invalid");
            expect(readFileSync(target, "utf8")).toBe(contents);
        }
    });
});
