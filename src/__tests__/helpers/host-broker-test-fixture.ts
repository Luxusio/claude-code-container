import { AddressInfo } from "net";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createDeviceBrokerServer, deviceBrokerOwnerToken } from "../../device-lab-broker.js";

export type DeviceBrokerTestServer = ReturnType<typeof createDeviceBrokerServer>;

export async function listen(server: DeviceBrokerTestServer): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

export async function close(server: DeviceBrokerTestServer): Promise<void> {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export function ownerRoot(ownerId: string) {
    return join(homedir(), ".ccc/devices/owners", ownerId);
}

export function backendRoot(ownerId: string, stateKey: string) {
    return join(ownerRoot(ownerId), stateKey);
}

export function ownerRpcEndpoint(baseUrl: string, ownerId: string) {
    return `${baseUrl}/v1/owners/${ownerId}/rpc`;
}

export function ownerRpcHeaders(ownerId: string) {
    return {
        "content-type": "application/json",
        "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
    };
}

export function writeBrokerDevices(ownerId: string, stateKey: string, devices: unknown[]) {
    const root = backendRoot(ownerId, stateKey);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "devices.json"), JSON.stringify({ devices }));
    return root;
}

export function cleanupOwner(ownerId: string) {
    rmSync(ownerRoot(ownerId), { recursive: true, force: true });
}
