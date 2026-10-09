import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAndroidMcpContext, cleanupFakeAndroidMcpContext, type FakeAndroidMcpContext } from "./fake-android-mcp-fixture.js";

// Original provenance only. Current tests never require an ignored archive or
// reject a candidate because its complete policy source hash changed.
export const ORIGINAL_ANDROID_LIFECYCLE_SOURCE = "da5c4bd2ff4121c8ca2ab0f8ff9d0e3332007c8d";
export const ANDROID_SYSTEM_IMAGE = "system-images;android-35;google_apis;x86_64";
export const ANDROID_PORT_ALLOWED = "even integer 5554-5682";
// Minimal immutable values observed against the reconciled ORIGINAL public and
// native bindings in capture run03. Full receipts are diagnostic evidence, not
// a dependency of these durable tests. Keep variant differences explicit.
export const ORIGINAL_ANDROID_LIFECYCLE = Object.freeze({
    allocationOwner: "0123456789abcdef", allocationId: "android-original-allocation", firstPort: 5630, nextPort: 5632,
    directOddPortError: "create Android port must be even and from 5554 to 5682",
    directAllocatedDuplicateError: "android-emulator-port-conflict: port-5670-already-allocated",
    directDuplicateError: "Device already exists for this owner: android-duplicate",
    brokerSuccessorStatus: 409, brokerSuccessorError: "owner-device-state-conflict",
    directAccessorReads: Object.freeze(["deviceId", "deviceId", "backend", "backend", "backend", "name", "deviceId", "avdName", "port"]),
});
// Capture configuration belongs to this controller, before the existing owner
// isolation deliberately clears inherited CCC settings from native requests.
const observationRoot = process.env.CCC_ANDROID_LIFECYCLE_CAPTURE_DIR;

export function toolText(result: unknown): string {
    if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) throw Error("Missing MCP content");
    const first: unknown = result.content[0];
    if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") throw Error("Missing MCP text");
    return first.text;
}
export function toolJson(result: unknown): Record<string, unknown> {
    const value: unknown = JSON.parse(toolText(result));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error("Expected MCP JSON object");
    return value as Record<string, unknown>;
}
export function originalObservation(name: string, value: unknown): void {
    const capture = observationRoot;
    if (!capture) return;
    if (!/^[a-z0-9-]+$/.test(name)) throw Error("Unsafe observation name");
    mkdirSync(capture, { recursive: true });
    writeFileSync(join(capture, name + ".json"), JSON.stringify({ source: ORIGINAL_ANDROID_LIFECYCLE_SOURCE, value }, null, 2) + "\n", { flag: "wx" });
}
export function androidStatePath(home: string, ownerId: string): string {
    return join(home, ".ccc", "devices", "owners", ownerId, "android", "devices.json");
}
export function androidRawState(home: string, ownerId: string): { devices: Record<string, unknown>[] } {
    const path = androidStatePath(home, ownerId);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { devices: Record<string, unknown>[] } : { devices: [] };
}

// Reuse the existing fake SDK and real MCP/native storage/locks. Preserve the
// first assertion failure even when teardown also fails. This wrapper adds no
// syscall sandbox; PATH and existing native identity/file guards remain the
// authorities, with provider counters in the broker tests reported separately.
export async function withAndroidLifecycleFixture(name: string, check: (context: FakeAndroidMcpContext, ownerId: string) => Promise<void>): Promise<void> {
    const context = await createFakeAndroidMcpContext();
    const failures: unknown[] = [];
    let ownerId: string | undefined;
    const unknown = join(context.homeDir, "unknown-retained");
    writeFileSync(unknown, "unallocated resource retained\n", { flag: "wx" });
    try {
        const inventory = toolJson(await context.client.callTool({ name: "devices", arguments: { view: "available", backend: "android-emulator" } }));
        if (typeof inventory.ownerId !== "string") throw Error("Missing fixture owner");
        ownerId = inventory.ownerId;
        await check(context, ownerId);
    } catch (error) { failures.push(error); }
    finally {
        try {
            if (ownerId) for (const device of androidRawState(context.homeDir, ownerId).devices) {
                // Only a genuine runtime allocated by this direct fixture needs
                // joining. Metadata-only successor/refusal controls stay intact.
                if (device.runtime && typeof device.id === "string") {
                    await context.client.callTool({ name: "stop", arguments: { deviceId: device.id } });
                }
            }
            if (readFileSync(unknown, "utf8") !== "unallocated resource retained\n") throw Error("Unknown resource changed");
            originalObservation(name + "-terminal", {
                log: readFileSync(context.logPath, "utf8"), state: ownerId && androidRawState(context.homeDir, ownerId),
                unknownRetained: true, assertionFailures: failures.map(error => String(error)),
            });
        } catch (error) { failures.push(error); }
        try { await cleanupFakeAndroidMcpContext(context); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, name + ": assertion precedes cleanup failures");
}

export function privateBrokerHome(): { home: string; remove: () => void } {
    const home = mkdtempSync(join(tmpdir(), "ccc-android-lifecycle-broker-"));
    return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}
