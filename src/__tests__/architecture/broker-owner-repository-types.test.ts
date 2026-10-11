import { describe, expect, it } from "vitest";
import { createBrokerOwnerRepository } from "@ccc/device-lab/device-lab/application/broker-owner-repository.js";
import { ownerIdentityConflict } from "@ccc/device-lab/device-lab/domain/broker-owner-repository.js";
import type { BrokerOwnerRepositoryPorts } from "@ccc/device-lab/device-lab/ports/broker-owner-repository.js";

function consumedRepository(ports: BrokerOwnerRepositoryPorts): void {
    const app = createBrokerOwnerRepository(ports);
    const devices: unknown[] = app.mutate("owner", "android", current => current);
    const removed: undefined = app.removeDevice("owner", "android", "one");
    const { publish, ...withoutPublication } = ports;
    // @ts-expect-error There is no default native publication authority.
    createBrokerOwnerRepository(withoutPublication);
    // @ts-expect-error Owner reads must settle inside the synchronous mutation lock.
    createBrokerOwnerRepository({ ...ports, read: async () => [] });
    // @ts-expect-error Writable validation must finish before publication.
    createBrokerOwnerRepository({ ...ports, validate: async () => undefined });
    // @ts-expect-error Publication must settle before returning a repository result.
    createBrokerOwnerRepository({ ...ports, publish: async () => undefined });
    void [devices, removed, publish];
}
void consumedRepository;

describe("broker owner identity claims", () => {
    it("reports the occupied hardware identity independently of a new device ID", () => {
        const existing = { id: "one", serial: "occupied" };
        expect(ownerIdentityConflict([existing], { id: "two", serial: "occupied" }, ["id", "serial"])).toEqual({
            ok: false, error: "owner-device-identity-conflict", field: "serial", value: "occupied", existing,
        });
    });
});
