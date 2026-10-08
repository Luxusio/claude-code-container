import type { MetadataDeviceRequest } from "../domain/broker-observation.js";
import type { MetadataObservationPorts } from "../ports/broker-observation.js";

export function createAppiumObservations(ports: MetadataObservationPorts) {
    function status(ownerId: string, parsed: MetadataDeviceRequest) {
        let devices: unknown[];
        try { devices = ports.read(ownerId, parsed.stateKey); }
        catch (error) { return { kind: "read-failed" as const, error }; }
        const device = devices.find(candidate => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        if (!device) return { kind: "not-found" as const };
        const appium = device && typeof device === "object" ? (device as { appium?: unknown }).appium ?? null : null;
        return { kind: "observed" as const, value: { ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, device, appium } };
    }
    function list(ownerId: string, parsed: Pick<MetadataDeviceRequest, "backend" | "stateKey">) {
        let devices: unknown[];
        try { devices = ports.read(ownerId, parsed.stateKey); }
        catch (error) { return { kind: "read-failed" as const, error }; }
        const sessions = devices.filter(device => device && typeof device === "object").map(device => {
            const record = device as Record<string, unknown>;
            return { deviceId: record.id, status: record.status ?? null, appium: record.appium ?? null };
        }).filter(session => typeof session.deviceId === "string");
        return { kind: "observed" as const, value: { ownerId, backend: parsed.backend, stateKey: parsed.stateKey, sessions } };
    }
    return { status, list };
}
