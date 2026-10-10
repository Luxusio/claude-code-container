import { createOwnerDeviceRepository } from "../../../packages/device-lab/providers/application/owner-device-repository.mjs";

type RecordValue = ReturnType<Ports["read"]>[number];
type Ports = Parameters<typeof createOwnerDeviceRepository>[0];

const devices: RecordValue[] = [{ id: "compile-consumer" }];
const ports: Ports = {
    read: () => devices,
    exists: () => true,
    validate: (_devices: unknown[]) => {},
    publish: (_devices: unknown[]) => {},
    withMutationLock: <T>(operation: () => T): T => operation(),
    equals: (left: unknown, right: unknown) => left === right,
};
const repository = createOwnerDeviceRepository(ports);
const read: RecordValue[] = repository.read();
const written: unknown[] = repository.write(read);
const mutated: unknown[] = repository.mutate(records => records);
const found: RecordValue | undefined = repository.find("compile-consumer");
const updated: RecordValue | null = repository.update("compile-consumer", record => ({ ...record, status: "ready" }));
const claimed = repository.claim({ id: "other" }, [["host", "serial"], "id"]);
const transitioned = repository.transition("compile-consumer", found, record => ({ ...record, status: "ready" }));
const foundTransition: boolean = transitioned.found;
const matchedTransition: boolean = transitioned.matched;
const currentTransition: RecordValue | null = transitioned.currentDevice;
const replacementTransition: RecordValue | null = transitioned.device;
const claimSuccess: boolean = claimed.ok;
// Consume inferred results directly: wider annotations alone also accept an
// incorrectly inferred null-only callback result.
const updatedStatus: unknown = repository.update("compile-consumer", record => record)?.status;
const transitionStatus: unknown = transitioned.device?.status;
const transitionCurrentStatus: unknown = transitioned.currentDevice?.status;
void [written, mutated, updated, foundTransition, matchedTransition, currentTransition, replacementTransition, claimSuccess];
void [updatedStatus, transitionStatus, transitionCurrentStatus];

// @ts-expect-error all six synchronous ports are required
createOwnerDeviceRepository({ read: () => devices });
// @ts-expect-error callers must supply ports; there are no ambient defaults
createOwnerDeviceRepository();
// @ts-expect-error read cannot be an asynchronous port
createOwnerDeviceRepository({ ...ports, read: async () => devices });
// @ts-expect-error mutation lock preserves the synchronous callback result
createOwnerDeviceRepository({ ...ports, withMutationLock: async <T>(operation: () => T) => operation() });
// @ts-expect-error update requires a record-returning callback
repository.update("compile-consumer", () => null);
// @ts-expect-error transition permits only records, null, or a record/null callback
repository.transition("compile-consumer", {}, "invalid-replacement");
